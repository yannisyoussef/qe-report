import type { Pool, PoolClient } from 'pg';

/**
 * The boundary between writing durable state and reclaiming it. Every mutating ingestion holds
 * it shared for as long as it may publish bytes or write rows; destructive retention holds it
 * exclusively for its whole window. Ingestions therefore run beside each other as before, while
 * retention and ingestion never overlap. It is a session-level lock on the connection that does
 * the work, so a process that dies releases it when PostgreSQL ends its session.
 */
export const MAINTENANCE_LOCK_KEY = 7_248_134_620_002;

/** PostgreSQL's own code for a lock that could not be taken within `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03';

const ACQUIRE_SHARED = 'SELECT pg_advisory_lock_shared($1)';
const RELEASE_SHARED = 'SELECT pg_advisory_unlock_shared($1) AS released';
const ACQUIRE_EXCLUSIVE = 'SELECT pg_advisory_lock($1)';
const RELEASE_EXCLUSIVE = 'SELECT pg_advisory_unlock($1) AS released';

/** Destructive maintenance could not take the lock in the time the caller allowed. */
export class MaintenanceBusyError extends Error {
  constructor(timeoutMs: number) {
    super(`another writer held the maintenance lock for longer than ${timeoutMs} ms`);
    this.name = 'MaintenanceBusyError';
  }
}

/**
 * Runs `fn` with a connection that already holds the shared maintenance lock, and gives the
 * connection back afterwards. One connection does the locking and the work, so an ingestion
 * never waits on itself for a second connection from the same pool.
 */
export function withIngestionLock<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withLock(pool, ACQUIRE_SHARED, RELEASE_SHARED, fn);
}

/** The counterpart: nothing may ingest while `fn` runs. */
export function withMaintenanceLock<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: { readonly lockTimeoutMs?: number } = {},
): Promise<T> {
  return withLock(pool, ACQUIRE_EXCLUSIVE, RELEASE_EXCLUSIVE, fn, options.lockTimeoutMs);
}

async function withLock<T>(
  pool: Pool,
  acquire: string,
  release: string,
  fn: (client: PoolClient) => Promise<T>,
  lockTimeoutMs?: number,
): Promise<T> {
  const client = await pool.connect();
  try {
    if (lockTimeoutMs !== undefined) {
      if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
        throw new TypeError('lockTimeoutMs must be a whole number of milliseconds');
      }
      await client.query('SELECT set_config($1, $2, false)', [
        'lock_timeout',
        `${lockTimeoutMs}ms`,
      ]);
    }
    await client.query(acquire, [MAINTENANCE_LOCK_KEY]);
  } catch (e) {
    // The connection carries a changed setting and may hold nothing or something; discard it.
    client.release(e instanceof Error ? e : new Error(String(e)));
    if (lockTimeoutMs !== undefined && (e as { code?: string }).code === LOCK_NOT_AVAILABLE) {
      throw new MaintenanceBusyError(lockTimeoutMs);
    }
    throw e;
  }
  try {
    return await fn(client);
  } finally {
    // A connection that may still hold a session lock must never go back to the pool: a later
    // ingestion dispatched onto it would re-enter the lock and run beside maintenance.
    let failure: Error | undefined;
    try {
      const released = await client.query<{ released: boolean }>(release, [MAINTENANCE_LOCK_KEY]);
      if (released.rows[0]?.released !== true) {
        failure = new Error('the maintenance lock was not held when it was released');
      }
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    }
    if (failure === undefined) client.release();
    else client.release(failure);
  }
}
