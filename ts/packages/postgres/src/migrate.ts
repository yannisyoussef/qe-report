import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { MIGRATIONS, type Migration } from './migrations.js';

/** Serialises concurrent migration runs across processes; any constant works, this one is ours. */
export const MIGRATION_LOCK_KEY = 7_248_134_620_001;

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  /** True when this call applied it; false when it was already there with the same checksum. */
  readonly appliedNow: boolean;
}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256')
    .update(`${migration.version}:${migration.name}\n`, 'utf8')
    .update(migration.sql, 'utf8')
    .digest('hex');
}

/**
 * Applies every pending migration in version order, each in its own transaction, under a
 * session-level advisory lock so two starting processes never apply one migration twice.
 * Running it again is a no-op; a recorded migration whose checksum no longer matches the code
 * stops the run with an error, because an applied migration is never rewritten.
 */
export async function migrate(pool: Pool): Promise<readonly AppliedMigration[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS qe_schema_migrations (
          version     integer     PRIMARY KEY,
          name        text        NOT NULL,
          checksum    text        NOT NULL,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )`);
      const recorded = new Map<number, { name: string; checksum: string }>();
      const rows = await client.query<{ version: number; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM qe_schema_migrations ORDER BY version',
      );
      for (const row of rows.rows) recorded.set(row.version, row);
      const result: AppliedMigration[] = [];
      for (const migration of MIGRATIONS) {
        const checksum = migrationChecksum(migration);
        const known = recorded.get(migration.version);
        if (known) {
          if (known.checksum !== checksum) {
            throw new Error(
              `migration ${migration.version} (${known.name}) was applied with checksum ${known.checksum} but the code now has ${checksum}; applied migrations are never rewritten`,
            );
          }
          result.push({
            version: migration.version,
            name: migration.name,
            checksum,
            appliedNow: false,
          });
          continue;
        }
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        try {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO qe_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [migration.version, migration.name, checksum],
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
        result.push({
          version: migration.version,
          name: migration.name,
          checksum,
          appliedNow: true,
        });
      }
      return result;
    } finally {
      // Releasing on a broken connection must not hide the error that broke it; the lock dies
      // with the session anyway.
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
