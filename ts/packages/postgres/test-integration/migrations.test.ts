import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY, migrate, migrationChecksum } from '../src/migrate.js';
import { MIGRATIONS } from '../src/migrations.js';
import pg from 'pg';
import { TestPostgres, waitFor } from './support.js';

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
    const db = await pgTest.emptyDatabase('checksum');
    await migrate(db.pool);
    await db.pool.query('UPDATE qe_schema_migrations SET checksum = $1 WHERE version = 1', [
      '0'.repeat(64),
    ]);
    await expect(migrate(db.pool)).rejects.toThrow(/never rewritten/u);
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
    const constraints = await a.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid IN ('qe_runs'::regclass, 'qe_run_source_lines'::regclass) ORDER BY conname`,
    );
    expect(constraints.rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        'qe_runs_pkey',
        'qe_runs_ingestion_sequence_key',
        'qe_run_source_lines_pkey',
        'qe_run_source_lines_run_fkey',
      ]),
    );
  });
});
