import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { PostgresRunStore, migrate } from '../src/index.js';

/** PostgreSQL 16, the version this store is exercised against. */
export const POSTGRES_IMAGE = 'postgres:16';

export interface Database {
  readonly pool: pg.Pool;
  readonly store: PostgresRunStore;
  readonly name: string;
}

/** One container per test file; each test group gets its own database inside it. */
export class TestPostgres {
  private container: StartedPostgreSqlContainer | undefined;
  private readonly pools: pg.Pool[] = [];
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
    const name = `${prefix}_${++this.counter}`;
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
    this.pools.push(pool);
    return { pool, store: new PostgresRunStore(pool), name };
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
    this.pools.push(pool);
    return pool;
  }

  /** A connection string for a database created here, for raw clients in interleaving tests. */
  connectionUriFor(db: Database): string {
    const c = this.started();
    return `postgresql://${encodeURIComponent(c.getUsername())}:${encodeURIComponent(c.getPassword())}@${c.getHost()}:${c.getPort()}/${db.name}`;
  }

  async stop(): Promise<void> {
    for (const p of this.pools) await p.end().catch(() => undefined);
    await this.container?.stop();
  }
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
