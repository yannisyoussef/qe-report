import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY, migrate, migrationChecksum, schemaStatus } from '../src/migrate.js';
import { MIGRATIONS } from '../src/migrations.js';
import pg from 'pg';
import { TestPostgres, applyThrough, waitFor } from './support.js';

const pgTest = new TestPostgres();
beforeAll(() => pgTest.start());
afterAll(() => pgTest.stop());

describe('migrations on PostgreSQL 16', () => {
  it('apply on a fresh database, record version and checksum, and are a no-op the second time', async () => {
    const db = await pgTest.emptyDatabase('mig');
    const first = await migrate(db.pool);
    expect(first.map((m) => [m.version, m.appliedNow])).toEqual(
      MIGRATIONS.map((m) => [m.version, true]),
    );
    const recorded = await db.pool.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM qe_schema_migrations ORDER BY version',
    );
    expect(recorded.rows).toEqual(
      MIGRATIONS.map((m) => ({ version: m.version, name: m.name, checksum: migrationChecksum(m) })),
    );
    const tables = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'qe_blobs',
      'qe_history_occurrences',
      'qe_project_api_keys',
      'qe_run_blobs',
      'qe_run_query_index',
      'qe_run_retention',
      'qe_run_source_lines',
      'qe_runs',
      'qe_schema_migrations',
    ]);
    const second = await migrate(db.pool);
    expect(second.map((m) => m.appliedNow)).toEqual(MIGRATIONS.map(() => false));
    const again = await db.pool.query('SELECT count(*)::text AS n FROM qe_schema_migrations');
    expect(Number(again.rows[0].n)).toBe(MIGRATIONS.length);
  });

  it('serialise concurrent invocations so one migration is applied once', async () => {
    const db = await pgTest.emptyDatabase('concurrent');
    const pools = [db.pool, pgTest.anotherPool(db), pgTest.anotherPool(db), pgTest.anotherPool(db)];
    const results = await Promise.all(pools.map((p) => migrate(p)));
    const appliedNow = results.flat().filter((m) => m.appliedNow).length;
    expect(appliedNow).toBe(MIGRATIONS.length);
    const rows = await db.pool.query('SELECT count(*)::text AS n FROM qe_schema_migrations');
    expect(Number(rows.rows[0].n)).toBe(MIGRATIONS.length);
  });

  it('wait for a concurrent holder of the migration lock instead of applying twice', async () => {
    const db = await pgTest.emptyDatabase('lockwait');
    const holder = new pg.Client({ connectionString: pgTest.connectionUriFor(db) });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const pending = migrate(db.pool);
    await waitFor(async () => {
      const r = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        [db.name],
      );
      return Number(r.rows[0]?.n) === 1;
    });
    const before = await holder.query('SELECT to_regclass($1)::text AS t', [
      'qe_schema_migrations',
    ]);
    expect(before.rows[0].t).toBeNull();
    await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    const applied = await pending;
    expect(applied.every((m) => m.appliedNow)).toBe(true);
    await holder.end();
  });

  it('refuse to continue when an applied migration has a different checksum', async () => {
    for (const version of MIGRATIONS.map((m) => m.version)) {
      const db = await pgTest.emptyDatabase('checksum');
      await migrate(db.pool);
      await db.pool.query('UPDATE qe_schema_migrations SET checksum = $1 WHERE version = $2', [
        '0'.repeat(64),
        version,
      ]);
      await expect(migrate(db.pool)).rejects.toThrow(/never rewritten/u);
    }
  });

  it('upgrade a database at migration 1 to migration 2, carrying the source validation claim and exposing legacy runs', async () => {
    const db = await pgTest.emptyDatabase('upgrade');
    await applyThrough(db.pool, 1);
    const tablesBefore = await tableNames(db.pool);
    expect(tablesBefore).toEqual(['qe_run_source_lines', 'qe_runs', 'qe_schema_migrations']);
    // A run archived under migration 1: its attachment events are in its lines, its bytes are not durable.
    await db.pool.query(
      `INSERT INTO qe_runs (project_id, run_id, source_locator, content_fingerprint, fingerprint_version,
         protocol_versions, source_line_count, attachments_verified, validation_summary)
       VALUES ('legacy', 'run-1', '/gone', $1, 1, '{0.3.0}', 1, true, '{}'::jsonb)`,
      ['a'.repeat(64)],
    );
    // A child row, so that replacing the foreign key is exercised against real data.
    await db.pool.query(
      `INSERT INTO qe_run_source_lines (project_id, run_id, storage_ordinal, event_id, session_id,
         sequence, event_type, protocol_version, canonical_sha256, disposition, raw_line,
         source_file, source_line)
       VALUES ('legacy', 'run-1', 0, 'e-1', 's', 1, 'session.started', '0.3.0', $1, 'accepted',
               '{}', 'f', 1)`,
      ['b'.repeat(64)],
    );
    const applied = await migrate(db.pool);
    expect(applied.map((m) => [m.version, m.appliedNow])).toEqual([
      [1, false],
      [2, true],
      [3, true],
      [4, true],
      [5, true],
    ]);
    expect(await tableNames(db.pool)).toEqual([
      'qe_blobs',
      'qe_history_occurrences',
      'qe_project_api_keys',
      'qe_run_blobs',
      'qe_run_query_index',
      'qe_run_retention',
      'qe_run_source_lines',
      'qe_runs',
      'qe_schema_migrations',
    ]);
    const columns = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'qe_runs' ORDER BY column_name`,
    );
    expect(columns.rows.map((c) => c.column_name)).toContain('source_attachments_verified');
    expect(columns.rows.map((c) => c.column_name)).not.toContain('attachments_verified');
    // Deleting the run now takes its source with it, which migration 1's key would have refused.
    expect(
      (await db.pool.query(`DELETE FROM qe_runs WHERE project_id = 'legacy' RETURNING run_id`))
        .rowCount,
    ).toBe(1);
    expect(
      Number(
        (await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM qe_run_source_lines'))
          .rows[0]?.n,
      ),
    ).toBe(0);
    await db.pool.query(
      `INSERT INTO qe_runs (project_id, run_id, source_locator, content_fingerprint, fingerprint_version,
         protocol_versions, source_line_count, source_attachments_verified, validation_summary)
       VALUES ('legacy', 'run-1', '/gone', $1, 1, '{0.3.0}', 1, true, '{}'::jsonb)`,
      ['a'.repeat(64)],
    );
    const legacy = await db.pool.query<{ source_attachments_verified: boolean; blobs: string }>(
      `SELECT r.source_attachments_verified,
              (SELECT count(*) FROM qe_run_blobs b WHERE b.project_id = r.project_id AND b.run_id = r.run_id)::text AS blobs
         FROM qe_runs r WHERE r.project_id = 'legacy'`,
    );
    expect(legacy.rows).toEqual([{ source_attachments_verified: true, blobs: '0' }]);
    // The checksum of migration 1 is the one recorded before the upgrade; nothing rewrote it.
    const recorded = await db.pool.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM qe_schema_migrations ORDER BY version',
    );
    expect(recorded.rows).toEqual(
      MIGRATIONS.map((m) => ({ version: m.version, checksum: migrationChecksum(m) })),
    );
    expect(await migrate(db.pool)).toEqual(applied.map((m) => ({ ...m, appliedNow: false })));
  });

  it('enforce the blob catalog constraints', async () => {
    const db = await pgTest.database('constraints');
    const sha = 'b'.repeat(64);
    await db.pool.query(
      `INSERT INTO qe_blobs (sha256, size_bytes, storage_key) VALUES ($1, 3, $2)`,
      [sha, `sha256/bb/bb/${sha}`],
    );
    await expect(
      db.pool.query(`INSERT INTO qe_blobs (sha256, size_bytes, storage_key) VALUES ($1, 3, 'x')`, [
        sha,
      ]),
    ).rejects.toThrow(/qe_blobs_pkey/u);
    for (const bad of ['', '/abs', '../up', 'sha256/../x', 'a/./b']) {
      await expect(
        db.pool.query(`INSERT INTO qe_blobs (sha256, size_bytes, storage_key) VALUES ($1, 1, $2)`, [
          'c'.repeat(64),
          bad,
        ]),
      ).rejects.toThrow(/storage_key_check/u);
    }
    await expect(
      db.pool.query(`INSERT INTO qe_blobs (sha256, size_bytes, storage_key) VALUES ($1, 1, 'k')`, [
        'C'.repeat(64),
      ]),
    ).rejects.toThrow(/sha256_check/u);
    await expect(
      db.pool.query(`INSERT INTO qe_blobs (sha256, size_bytes, storage_key) VALUES ($1, -1, 'k')`, [
        'd'.repeat(64),
      ]),
    ).rejects.toThrow(/size_bytes_check/u);
    await expect(
      db.pool.query(`INSERT INTO qe_run_blobs (project_id, run_id, sha256) VALUES ('p', 'r', $1)`, [
        sha,
      ]),
    ).rejects.toThrow(/run_fkey/u);
  });

  it('produce a deterministic schema', async () => {
    const a = await pgTest.database('schema');
    const b = await pgTest.database('schema');
    const columnsOf = async (pool: typeof a.pool): Promise<unknown[]> =>
      (
        await pool.query(
          `SELECT table_name, column_name, data_type, is_nullable, column_default
             FROM information_schema.columns WHERE table_schema = 'public'
            ORDER BY table_name, ordinal_position`,
        )
      ).rows;
    expect(await columnsOf(b.pool)).toEqual(await columnsOf(a.pool));
    const constraintsOf = async (pool: typeof a.pool): Promise<string[]> =>
      (
        await pool.query<{ conname: string }>(
          `SELECT conname FROM pg_constraint
            WHERE conrelid IN ('qe_runs'::regclass, 'qe_run_source_lines'::regclass, 'qe_blobs'::regclass,
                               'qe_run_blobs'::regclass, 'qe_run_retention'::regclass,
                               'qe_run_query_index'::regclass, 'qe_history_occurrences'::regclass,
                               'qe_project_api_keys'::regclass)
            ORDER BY conname`,
        )
      ).rows.map((r) => r.conname);
    const constraints = await constraintsOf(a.pool);
    expect(constraints).toEqual(await constraintsOf(b.pool));
    expect(constraints).toEqual(
      expect.arrayContaining([
        'qe_runs_pkey',
        'qe_runs_ingestion_sequence_key',
        'qe_run_source_lines_pkey',
        'qe_run_source_lines_run_fkey',
        'qe_blobs_pkey',
        'qe_blobs_storage_key_check',
        'qe_run_blobs_pkey',
        'qe_run_blobs_run_fkey',
        'qe_run_blobs_blob_fkey',
        'qe_run_retention_pkey',
        'qe_run_retention_run_fkey',
        'qe_run_query_index_pkey',
        'qe_run_query_index_run_fkey',
        'qe_run_query_index_version_check',
        'qe_history_occurrences_pkey',
        'qe_history_occurrences_run_fkey',
        'qe_history_occurrences_stability_check',
        'qe_runs_project_id_bound_check',
        'qe_project_api_keys_pkey',
        'qe_project_api_keys_project_id_check',
        'qe_project_api_keys_scopes_check',
        'qe_project_api_keys_secret_check',
      ]),
    );
    // What a run takes with it, and what it must not: the blob catalog is global and stays.
    const actions = await a.pool.query<{
      conname: string;
      confdeltype: string;
      convalidated: boolean;
    }>(
      `SELECT conname, confdeltype, convalidated FROM pg_constraint
        WHERE contype = 'f' AND conrelid IN ('qe_run_source_lines'::regclass,
                                             'qe_run_blobs'::regclass,
                                             'qe_run_retention'::regclass,
                                             'qe_run_query_index'::regclass,
                                             'qe_history_occurrences'::regclass)
        ORDER BY conname`,
    );
    expect(actions.rows).toEqual([
      { conname: 'qe_history_occurrences_run_fkey', confdeltype: 'c', convalidated: true },
      { conname: 'qe_run_blobs_blob_fkey', confdeltype: 'a', convalidated: true },
      { conname: 'qe_run_blobs_run_fkey', confdeltype: 'c', convalidated: true },
      { conname: 'qe_run_query_index_run_fkey', confdeltype: 'c', convalidated: true },
      { conname: 'qe_run_retention_run_fkey', confdeltype: 'c', convalidated: true },
      { conname: 'qe_run_source_lines_run_fkey', confdeltype: 'c', convalidated: true },
    ]);
    // The declared collation is what makes the durable history order the in-memory one.
    const collations = await a.pool.query<{ attname: string; collname: string }>(
      `SELECT a.attname, c.collname FROM pg_attribute a
         JOIN pg_collation c ON c.oid = a.attcollation
        WHERE a.attrelid = 'qe_history_occurrences'::regclass
          AND a.attname IN ('project_id', 'run_id', 'execution_id', 'runner_name', 'historical_id')
        ORDER BY a.attname`,
    );
    expect(collations.rows).toEqual([
      { attname: 'execution_id', collname: 'C' },
      { attname: 'historical_id', collname: 'C' },
      { attname: 'project_id', collname: 'C' },
      { attname: 'run_id', collname: 'C' },
      { attname: 'runner_name', collname: 'C' },
    ]);
  });
});

/** Every table in the public schema, sorted. */
async function tableNames(pool: pg.Pool): Promise<string[]> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return tables.rows.map((r) => r.table_name);
}

describe('upgrading a database that stopped earlier', () => {
  /** A run row as each version shapes it, so an upgrade meets real rows rather than none. */
  const seed = async (pool: pg.Pool, version: number): Promise<void> => {
    const verified = version >= 2 ? 'source_attachments_verified' : 'attachments_verified';
    await pool.query(
      `INSERT INTO qe_runs (project_id, run_id, source_locator, content_fingerprint,
         fingerprint_version, protocol_versions, source_line_count, ${verified}, validation_summary)
       VALUES ('legacy', 'run-1', '/gone', $1, 1, '{0.3.0}', 1, true, '{}'::jsonb)`,
      ['a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO qe_run_source_lines (project_id, run_id, storage_ordinal, event_id, session_id,
         sequence, event_type, protocol_version, canonical_sha256, disposition, raw_line,
         source_file, source_line)
       VALUES ('legacy', 'run-1', 0, 'e-1', 's', 1, 'session.started', '0.3.0', $1, 'accepted',
               '{}', 'f', 1)`,
      ['b'.repeat(64)],
    );
    if (version >= 3) {
      await pool.query(
        `INSERT INTO qe_run_retention (project_id, run_id, expires_at)
         VALUES ('legacy', 'run-1', now())`,
      );
    }
  };

  for (const from of [1, 2, 3, 4]) {
    it(`brings a database at migration ${from} up to the current schema`, async () => {
      const db = await pgTest.emptyDatabase(`from_v${from}`);
      await applyThrough(db.pool, from);
      await seed(db.pool, from);
      const applied = await migrate(db.pool);
      expect(applied.map((m) => [m.version, m.appliedNow])).toEqual(
        MIGRATIONS.map((m) => [m.version, m.version > from]),
      );
      expect(await tableNames(db.pool)).toEqual([
        'qe_blobs',
        'qe_history_occurrences',
        'qe_project_api_keys',
        'qe_run_blobs',
        'qe_run_query_index',
        'qe_run_retention',
        'qe_run_source_lines',
        'qe_runs',
        'qe_schema_migrations',
      ]);
      // Migration 4 indexes nothing: the archive is untouched and the derived tables are empty.
      const counts = await db.pool.query<{ runs: string; lines: string; indexed: string }>(
        `SELECT (SELECT count(*) FROM qe_runs)::text AS runs,
                (SELECT count(*) FROM qe_run_source_lines)::text AS lines,
                (SELECT count(*) FROM qe_run_query_index)::text AS indexed`,
      );
      expect(counts.rows[0]).toEqual({ runs: '1', lines: '1', indexed: '0' });
      // The run keeps its expiry only if it ever had one; nothing is invented on the way up.
      const retention = await db.pool.query('SELECT 1 FROM qe_run_retention');
      expect(retention.rowCount).toBe(from >= 3 ? 1 : 0);
      expect((await migrate(db.pool)).every((m) => !m.appliedNow)).toBe(true);
    });
  }
});

describe('migration 5: the project id bound and project-scoped keys', () => {
  /** Inserts a bare run row under a project id; the table's own checks decide whether it fits. */
  const insertRun = (pool: pg.Pool, projectId: string, runId = 'run-1'): Promise<unknown> =>
    pool.query(
      `INSERT INTO qe_runs (project_id, run_id, source_locator, content_fingerprint,
         fingerprint_version, protocol_versions, source_line_count, source_attachments_verified,
         validation_summary)
       VALUES ($1, $2, '/gone', $3, 1, '{0.3.0}', 1, true, '{}'::jsonb)`,
      [projectId, runId, 'a'.repeat(64)],
    );

  it('bounds an archived project id at 512 bytes of UTF-8, counted as bytes', async () => {
    const db = await pgTest.database('project_bound');
    const twoByte = String.fromCodePoint(0xe9);
    await insertRun(db.pool, 'x'.repeat(512));
    await insertRun(db.pool, twoByte.repeat(256));
    await expect(insertRun(db.pool, 'x'.repeat(513))).rejects.toThrow(
      /qe_runs_project_id_bound_check/u,
    );
    // 257 characters, 514 bytes: the character count would have let it through.
    await expect(insertRun(db.pool, twoByte.repeat(257))).rejects.toThrow(
      /qe_runs_project_id_bound_check/u,
    );
    await expect(insertRun(db.pool, '')).rejects.toThrow(/qe_runs_project_id_check/u);
  });

  it('refuses to migrate an archive holding a project id past the bound, and changes nothing', async () => {
    const db = await pgTest.emptyDatabase('project_bound_upgrade');
    await applyThrough(db.pool, 4);
    await insertRun(db.pool, 'y'.repeat(600));
    await insertRun(db.pool, 'fine', 'run-2');
    await expect(migrate(db.pool)).rejects.toThrow(
      /migration 5: 1 archived runs have a project id longer than 512 bytes/u,
    );
    const recorded = await db.pool.query<{ version: number }>(
      'SELECT version FROM qe_schema_migrations ORDER BY version',
    );
    expect(recorded.rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect(await tableNames(db.pool)).not.toContain('qe_project_api_keys');
    const kept = await db.pool.query<{ project_id: string }>(
      'SELECT project_id FROM qe_runs ORDER BY run_id',
    );
    expect(kept.rows.map((r) => r.project_id)).toEqual(['y'.repeat(600), 'fine']);
    expect((await schemaStatus(db.pool)).problems).toEqual(['migration 5 is not applied']);
    // Once the operator reconciles it, the same migration goes through.
    await db.pool.query(`DELETE FROM qe_runs WHERE run_id = 'run-1'`);
    expect((await migrate(db.pool)).filter((m) => m.appliedNow).map((m) => m.version)).toEqual([5]);
  });

  it('keeps a key row to its declared shape and immutable except for one revocation', async () => {
    const db = await pgTest.database('api_key_table');
    const digest = Buffer.alloc(32, 7);
    const insert = (values: {
      publicId?: string;
      projectId?: string;
      secret?: Buffer;
      scopes?: string[];
      label?: string | null;
    }): Promise<unknown> =>
      db.pool.query(
        `INSERT INTO qe_project_api_keys (public_id, project_id, secret_sha256, scopes, label)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          values.publicId ?? 'abcdefghijklmnop',
          values.projectId ?? 'P',
          values.secret ?? digest,
          values.scopes ?? ['runs:read'],
          values.label ?? null,
        ],
      );
    await insert({});
    await insert({ publicId: 'bbbbbbbbbbbbbbbb', scopes: ['runs:write'] });
    await insert({ publicId: 'cccccccccccccccc', scopes: ['runs:read', 'runs:write'] });
    await insert({ publicId: 'dddddddddddddddd', projectId: 'z'.repeat(512) });
    const refused: [Parameters<typeof insert>[0], RegExp][] = [
      [{ publicId: 'eeeeeeeeeeeeeeee', scopes: [] }, /scopes_check/u],
      [{ publicId: 'eeeeeeeeeeeeeeee', scopes: ['runs:write', 'runs:read'] }, /scopes_check/u],
      [{ publicId: 'eeeeeeeeeeeeeeee', scopes: ['runs:read', 'runs:read'] }, /scopes_check/u],
      [{ publicId: 'eeeeeeeeeeeeeeee', scopes: ['*'] }, /scopes_check/u],
      [{ publicId: 'eeeeeeeeeeeeeeee', scopes: ['runs:admin'] }, /scopes_check/u],
      [{ publicId: 'EEEEEEEEEEEEEEEE' }, /public_id_check/u],
      [{ publicId: 'eeee' }, /public_id_check/u],
      [{ publicId: 'eeeeeeeeeeeeeee1' }, /public_id_check/u],
      [{ publicId: 'eeeeeeeeeeeeeeee', projectId: '' }, /project_id_check/u],
      [{ publicId: 'eeeeeeeeeeeeeeee', projectId: 'z'.repeat(513) }, /project_id_check/u],
      [{ publicId: 'eeeeeeeeeeeeeeee', secret: Buffer.alloc(31) }, /secret_check/u],
      [{ publicId: 'eeeeeeeeeeeeeeee', label: '' }, /label_check/u],
      [{ publicId: 'abcdefghijklmnop' }, /qe_project_api_keys_pkey/u],
    ];
    for (const [values, error] of refused) {
      await expect(insert(values), JSON.stringify(values)).rejects.toThrow(error);
    }
    for (const change of [
      `project_id = 'Q'`,
      `scopes = ARRAY['runs:read', 'runs:write']`,
      `secret_sha256 = '\\x${'00'.repeat(32)}'::bytea`,
      `expires_at = now()`,
      `label = 'renamed'`,
    ]) {
      await expect(
        db.pool.query(
          `UPDATE qe_project_api_keys SET ${change} WHERE public_id = 'abcdefghijklmnop'`,
        ),
        change,
      ).rejects.toThrow(/immutable/u);
    }
    await db.pool.query(
      `UPDATE qe_project_api_keys SET revoked_at = now() WHERE public_id = 'abcdefghijklmnop'`,
    );
    await expect(
      db.pool.query(
        `UPDATE qe_project_api_keys SET revoked_at = NULL WHERE public_id = 'abcdefghijklmnop'`,
      ),
    ).rejects.toThrow(/immutable/u);
  });

  it('reports whether the schema is current without changing it', async () => {
    const db = await pgTest.emptyDatabase('schema_status');
    expect(await schemaStatus(db.pool)).toMatchObject({
      current: false,
      appliedVersions: [],
      problems: ['the database has never been migrated'],
    });
    expect(await tableNames(db.pool)).toEqual([]);
    await applyThrough(db.pool, 3);
    expect(await schemaStatus(db.pool)).toMatchObject({
      current: false,
      appliedVersions: [1, 2, 3],
      problems: ['migration 4 is not applied', 'migration 5 is not applied'],
    });
    await migrate(db.pool);
    const current = await schemaStatus(db.pool);
    expect(current).toEqual({
      current: true,
      expectedVersion: 5,
      appliedVersions: [1, 2, 3, 4, 5],
      problems: [],
    });
    await db.pool.query(`UPDATE qe_schema_migrations SET checksum = $1 WHERE version = 2`, [
      '0'.repeat(64),
    ]);
    await db.pool.query(
      `INSERT INTO qe_schema_migrations (version, name, checksum) VALUES (6, 'future', 'x')`,
    );
    expect((await schemaStatus(db.pool)).problems).toEqual([
      'migration 2 was applied with a different checksum',
      'migration 6 is applied but unknown to this code',
    ]);
  });
});
