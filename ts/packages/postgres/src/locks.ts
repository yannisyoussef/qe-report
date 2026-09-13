import type { Pool, PoolClient } from 'pg';

/**
 * The boundary between writing durable state and reclaiming it. Every mutating ingestion holds
 * it shared for as long as it may publish bytes or write rows; destructive retention holds it
 * exclusively for its whole window. Ingestions therefore run beside each other as before, while
 * retention and ingestion never overlap. It is a session-level lock on the connection that does
 * the work, so a process that dies releases it when PostgreSQL ends its session.
 *
 * One mutation takes exactly one lease. Nothing below the boundary acquires the lock again: a
 * second acquisition on the same session would only add a count to release, and a lease that
 * has to be counted is a lease nobody can reason about.
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
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`another writer held the maintenance lock for longer than ${timeoutMs} ms`);
    this.name = 'MaintenanceBusyError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Runs `fn` with a connection that already holds the shared maintenance lock, and gives the
 * connection back afterwards. One connection does the locking and the work, so an ingestion
 * never waits on itself for a second connection from the same pool, and this is the only place
 * a mutating ingestion takes the lock.
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
  if (options.lockTimeoutMs !== undefined) checkTimeout(options.lockTimeoutMs);
  return withLock(pool, ACQUIRE_EXCLUSIVE, RELEASE_EXCLUSIVE, fn, options.lockTimeoutMs);
}

/** Zero would mean "no timeout at all" to PostgreSQL, which is the opposite of asking for one. */
function checkTimeout(lockTimeoutMs: number): void {
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new TypeError('lockTimeoutMs must be a whole number of milliseconds, at least one');
  }
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
    await acquireLock(client, acquire, lockTimeoutMs);
  } catch (e) {
    // The connection may hold the lock, a changed setting, or an open transaction: discard it.
    client.release(asError(e));
    if (lockTimeoutMs !== undefined && (e as { code?: string }).code === LOCK_NOT_AVAILABLE) {
      throw new MaintenanceBusyError(lockTimeoutMs);
    }
    throw e;
  }
  try {
    return await fn(client);
  } finally {
    await releaseLock(client, release);
  }
}

/**
 * Takes the lock, waiting as long as it must, or no longer than the caller allows. A timeout is
 * set with `SET LOCAL` inside a transaction of its own, so it governs the acquisition and
 * nothing else: the setting disappears when that transaction commits, while the advisory lock,
 * being session-level, stays. The protected work then runs outside any transaction of ours.
 */
async function acquireLock(
  client: PoolClient,
  acquire: string,
  lockTimeoutMs: number | undefined,
): Promise<void> {
  if (lockTimeoutMs === undefined) {
    await client.query(acquire, [MAINTENANCE_LOCK_KEY]);
    return;
  }
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['lock_timeout', `${lockTimeoutMs}ms`]);
    await client.query(acquire, [MAINTENANCE_LOCK_KEY]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/**
 * Gives the connection back only when the release is proven: the statement must answer that the
 * lock was held and is now gone. Anything else -- a thrown error, a false answer, no answer at
 * all -- discards the connection instead, and ending that session releases whatever it still
 * holds. A connection returned to the pool carrying a lease would let the next borrower re-enter
 * it and run beside maintenance.
 */
async function releaseLock(client: PoolClient, release: string): Promise<void> {
  let failure: Error | undefined;
  try {
    const released = await client.query<{ released: boolean }>(release, [MAINTENANCE_LOCK_KEY]);
    if (released.rows[0]?.released !== true) {
      failure = new Error('the maintenance lock was not held when it was released');
    }
  } catch (e) {
    failure = asError(e);
  }
  if (failure === undefined) client.release();
  else client.release(failure);
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
