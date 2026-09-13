import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { FileBlobStore, type BlobDescriptor, type BlobStore } from 'qe-report-blob-fs';
import { PostgresRunStore, RetentionMaintenance, migrate } from '../src/index.js';
import { withIngestionLock } from '../src/locks.js';
import { persistArchive, type PersistResult } from '../src/store.js';
import { SCHEMA_MIGRATIONS_TABLE_SQL, migrationChecksum } from '../src/migrate.js';
import { MIGRATIONS } from '../src/migrations.js';
import type { RunArchive } from '../src/archive.js';
import {
  attachment,
  attemptFinished,
  attemptStarted,
  finished,
  sha256,
  started,
  testCase,
  writeRun,
  type EventSpec,
} from '../../read-model/test/synthetic.js';
import { materialiseBlobs } from '../src/materialise.js';

/** PostgreSQL 16, the version this store is exercised against. */
export const POSTGRES_IMAGE = 'postgres:16';

export interface Database {
  readonly pool: pg.Pool;
  readonly store: PostgresRunStore;
  readonly name: string;
  /** The blob store the run store publishes attachment bytes to; one fresh root per database. */
  readonly blobs: FileBlobStore;
  readonly blobRoot: string;
  readonly maintenance: RetentionMaintenance;
}

/** Far enough ahead that a test run never expires unless the test means it to. */
export const NEVER = new Date('2099-01-01T00:00:00.000Z');

/** One container per test file; each test group gets its own database inside it. */
export class TestPostgres {
  private container: StartedPostgreSqlContainer | undefined;
  private readonly pools: pg.Pool[] = [];
  private readonly roots: string[] = [];
  private counter = 0;

  async start(): Promise<void> {
    this.container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  }

  private started(): StartedPostgreSqlContainer {
    if (!this.container) throw new Error('container not started');
    return this.container;
  }

  /** A pool on a brand-new empty database, without migrations. */
  async emptyDatabase(prefix = 'db'): Promise<Database> {
    const c = this.started();
    // The prefix names the test; anything an identifier cannot hold becomes an underscore.
    const name = `${prefix.replace(/[^A-Za-z0-9_]/gu, '_')}_${++this.counter}`;
    const admin = new pg.Pool({ connectionString: c.getConnectionUri(), max: 1 });
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const pool = new pg.Pool({
      host: c.getHost(),
      port: c.getPort(),
      user: c.getUsername(),
      password: c.getPassword(),
      database: name,
      max: 8,
    });
    this.track(pool);
    const blobRoot = mkdtempSync(join(tmpdir(), `qe-pg-blobs-${prefix}-`));
    this.roots.push(blobRoot);
    const blobs = new FileBlobStore(blobRoot);
    return {
      pool,
      store: new PostgresRunStore(pool, blobs),
      name,
      blobs,
      blobRoot,
      maintenance: new RetentionMaintenance(pool, blobs),
    };
  }

  /** A second run store on the same database and blob root, for stores that wrap the blob store. */
  storeWith(db: Database, blobs: BlobStore, pool: pg.Pool = db.pool): PostgresRunStore {
    return new PostgresRunStore(pool, blobs);
  }

  /** A migrated database ready for the store. */
  async database(prefix = 'db'): Promise<Database> {
    const db = await this.emptyDatabase(prefix);
    await migrate(db.pool);
    return db;
  }

  /** A second pool on an existing database, for concurrency tests. */
  anotherPool(db: Database): pg.Pool {
    const c = this.started();
    const pool = new pg.Pool({
      host: c.getHost(),
      port: c.getPort(),
      user: c.getUsername(),
      password: c.getPassword(),
      database: db.name,
      max: 8,
    });
    this.track(pool);
    return pool;
  }

  /**
   * Keeps a pool for teardown and gives it an error listener: an idle client the server drops
   * while the container stops reports through the pool, and an unheard error fails the suite.
   */
  private track(pool: pg.Pool): void {
    pool.on('error', () => undefined);
    this.pools.push(pool);
  }

  /** A fresh directory removed at stop, for run copies a test deletes or mutates. */
  scratch(name: string): string {
    const d = mkdtempSync(join(tmpdir(), `qe-pg-${name}-`));
    this.roots.push(d);
    mkdirSync(join(d, 'runs'));
    return d;
  }

  /** A connection string for a database created here, for raw clients in interleaving tests. */
  connectionUriFor(db: Database): string {
    const c = this.started();
    return `postgresql://${encodeURIComponent(c.getUsername())}:${encodeURIComponent(c.getPassword())}@${c.getHost()}:${c.getPort()}/${db.name}`;
  }

  async stop(): Promise<void> {
    for (const p of this.pools) await p.end().catch(() => undefined);
    await this.container?.stop();
    for (const r of this.roots) rmSync(r, { recursive: true, force: true });
  }
}

/**
 * Archives one already built archive the way the store does: on a connection that holds the
 * shared maintenance lock, with an explicit expiry.
 */
export function archiveInto(
  pool: pg.Pool,
  projectId: string,
  sourceLocator: string,
  archive: RunArchive,
  published: readonly BlobDescriptor[],
  expiresAt: Date = NEVER,
): Promise<PersistResult> {
  return withIngestionLock(pool, (client) =>
    persistArchive(client, projectId, sourceLocator, archive, published, expiresAt),
  );
}

/** Publishes an archive's required blobs from its run directory, as the store does before its transaction. */
export function publish(
  db: Database,
  runDirectory: string,
  archive: RunArchive,
): Promise<BlobDescriptor[]> {
  return materialiseBlobs(db.blobs, runDirectory, archive.requiredBlobs);
}

/** The object path of a hash under a blob root. */
export function objectPath(root: string, sha256: string): string {
  return join(root, 'sha256', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export async function count(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

/** Polls a condition every 50 ms for up to 20 s; a test that waits for a lock uses it. */
export async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met within 20 s');
}

/** The projected run without its locator, the only field allowed to differ between copies. */
export function facts<T extends { runDirectory: string }>(run: T): Omit<T, 'runDirectory'> {
  const { runDirectory: _dir, ...rest } = run;
  void _dir;
  return rest;
}

/** Applies the migrations up to `version` exactly as the runner records them, to stage an older database. */
export async function applyThrough(pool: pg.Pool, version: number): Promise<void> {
  await pool.query(SCHEMA_MIGRATIONS_TABLE_SQL);
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
    await pool.query(m.sql);
    await pool.query(
      'INSERT INTO qe_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [m.version, m.name, migrationChecksum(m)],
    );
  }
}

/**
 * A pool whose clients fail one statement matching `pattern` with `message`, for driving the
 * store's failure paths end to end; everything else reaches the real database.
 */
export function failingPool(pool: pg.Pool, pattern: RegExp, message: string): pg.Pool {
  const wrapClient = (client: pg.PoolClient): pg.PoolClient =>
    new Proxy(client, {
      get(c, name) {
        const value = Reflect.get(c, name) as unknown;
        if (name === 'query') {
          return (text: unknown, ...rest: unknown[]): unknown =>
            typeof text === 'string' && pattern.test(text)
              ? Promise.reject(new Error(message))
              : (value as (...a: unknown[]) => unknown).call(c, text, ...rest);
        }
        return typeof value === 'function' ? (value as () => unknown).bind(c) : value;
      },
    });
  return new Proxy(pool, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'connect') {
        return async (): Promise<pg.PoolClient> => wrapClient(await target.connect());
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/** One session, one passed attempt, the given attachments on it, written as a run directory. */
export function runWithAttachments(
  root: string,
  dirName: string,
  runId: string,
  attachments: readonly { bytes: Buffer; extra?: Record<string, unknown> }[],
): string {
  const events: EventSpec[] = [
    started('pw'),
    attemptStarted('a', 1, testCase('e', 'h')),
    ...attachments.map((a) => attachment('a', a.bytes, a.extra ?? {})),
    attemptFinished('a', 'passed'),
    finished(),
  ];
  const bytes = [...new Map(attachments.map((a) => [sha256(a.bytes), a.bytes])).values()];
  return writeRun(root, dirName, runId, [{ sessionId: 's', events }], bytes);
}

/** How many rows a table holds, optionally restricted; the table name is a literal, never data. */
export function rowsIn(
  pool: pg.Pool,
  table: string,
  where?: string,
  params: unknown[] = [],
): Promise<number> {
  if (!/^[a-z_]+$/u.test(table)) throw new TypeError('table must be a plain identifier');
  return count(
    pool,
    `SELECT count(*)::text AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`,
    params,
  );
}

/** Moves an entry's modification time into the past, so an age cutoff can be exercised. */
export function ageEntry(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}
