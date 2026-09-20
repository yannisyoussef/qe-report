import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PostgresApiKeys, PostgresQueries, type ApiKeyScope } from 'qe-report-postgres';
import { createQeReportApi, type TransportLimits } from '../src/index.js';
import {
  NEVER,
  TestPostgres,
  rowsIn,
  type Database,
} from '../../postgres/test-integration/support.js';

export { NEVER };

/** One API v1 server on a fresh migrated database, listening on a loopback port. */
export interface Service {
  readonly db: Database;
  readonly app: FastifyInstance;
  readonly base: string;
  readonly stagingRoot: string;
  /** Every log line the server wrote, as JSON text. */
  readonly logs: string[];
  readonly keys: PostgresApiKeys;
  readonly queries: PostgresQueries;
  /** Issues a key and returns its bearer token. */
  key(projectId: string, scopes?: readonly ApiKeyScope[]): Promise<string>;
}

export class HttpHarness {
  readonly pg = new TestPostgres();
  private readonly apps: FastifyInstance[] = [];
  private readonly roots: string[] = [];

  start(): Promise<void> {
    return this.pg.start();
  }

  async stop(): Promise<void> {
    for (const app of this.apps) await app.close().catch(() => undefined);
    for (const root of this.roots) rmSync(root, { recursive: true, force: true });
    await this.pg.stop();
  }

  /** A fresh staging root, apart from every blob root. */
  stagingRoot(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `qe-http-staging-${name}-`));
    this.roots.push(root);
    return root;
  }

  async service(
    name: string,
    options: { readonly limits?: Partial<TransportLimits>; readonly db?: Database } = {},
  ): Promise<Service> {
    const db = options.db ?? (await this.pg.database(name));
    const stagingRoot = this.stagingRoot(name);
    const logs: string[] = [];
    const queries = new PostgresQueries(db.pool);
    const keys = new PostgresApiKeys(db.pool);
    const app = await createQeReportApi({
      runStore: db.store,
      queries,
      apiKeys: keys,
      stagingRoot,
      blobRoot: db.blobRoot,
      checkDatabase: async () => {
        await db.pool.query('SELECT 1');
        return [];
      },
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      logger: { level: 'trace', stream: { write: (line: string) => logs.push(line) } },
    });
    this.apps.push(app);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    return {
      db,
      app,
      base,
      stagingRoot,
      logs,
      keys,
      queries,
      key: async (projectId, scopes = ['runs:read', 'runs:write']) =>
        (await keys.create({ projectId, scopes: [...scopes] })).token,
    };
  }
}

export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

async function answer(response: Response): Promise<Answer> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text !== '') {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { text };
    }
  }
  return { status: response.status, headers: response.headers, body };
}

/** A JSON request with a bearer token; `undefined` sends no Authorization header. */
export async function call(
  base: string,
  token: string | undefined,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return answer(
    await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

/** The parts of an upload, in order; the default is a run directory's events and attachments. */
export type UploadPart =
  | { readonly name: string; readonly text: string }
  | {
      readonly name: string;
      readonly bytes: Buffer;
      readonly filename?: string;
      readonly type?: string;
    };

/** A run directory as upload parts: its expiry, every event stream, every attachment file. */
export function partsOf(runDirectory: string, expiresAt: Date = NEVER): UploadPart[] {
  const parts: UploadPart[] = [{ name: 'expiresAt', text: expiresAt.toISOString() }];
  for (const name of readdirSync(join(runDirectory, 'events')).sort()) {
    if (!name.endsWith('.ndjson')) continue;
    parts.push({
      name: 'events',
      bytes: readFileSync(join(runDirectory, 'events', name)),
      filename: name,
    });
  }
  const attachments = join(runDirectory, 'attachments');
  let names: string[] = [];
  try {
    names = readdirSync(attachments).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!statSync(join(attachments, name)).isFile()) continue;
    parts.push({
      name: 'attachment',
      bytes: readFileSync(join(attachments, name)),
      filename: name,
    });
  }
  return parts;
}

/** Uploads parts as multipart/form-data. */
export async function upload(
  base: string,
  token: string | undefined,
  parts: readonly UploadPart[],
): Promise<Answer> {
  const form = new FormData();
  for (const part of parts) {
    if ('text' in part) form.append(part.name, part.text);
    else {
      form.append(
        part.name,
        new Blob([part.bytes], { type: part.type ?? 'application/octet-stream' }),
        part.filename ?? 'part',
      );
    }
  }
  return answer(
    await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      body: form,
    }),
  );
}

/** Uploads a run directory as it is. */
export function uploadRun(
  base: string,
  token: string,
  runDirectory: string,
  expiresAt: Date = NEVER,
): Promise<Answer> {
  return upload(base, token, partsOf(runDirectory, expiresAt));
}

/** What the archive and its derived state hold, table by table. */
export async function archiveState(db: Database): Promise<Record<string, number>> {
  const tables = [
    'qe_runs',
    'qe_run_source_lines',
    'qe_run_retention',
    'qe_run_query_index',
    'qe_history_occurrences',
    'qe_blobs',
    'qe_run_blobs',
  ];
  const out: Record<string, number> = {};
  for (const table of tables) out[table] = await rowsIn(db.pool, table);
  return out;
}

/** Every durable object under a blob root, by hash. */
export function durableObjects(blobRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(entry);
    }
  };
  walk(join(blobRoot, 'sha256'));
  return out.sort();
}

/** Every page of the run listing, followed by cursor. */
export async function wholeListing(
  base: string,
  token: string,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const runs: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1000; guard += 1) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) query.set('cursor', cursor);
    const page = await call(base, token, 'GET', `/v1/runs?${query.toString()}`);
    if (page.status !== 200)
      throw new Error(`listing answered ${page.status}: ${JSON.stringify(page.body)}`);
    runs.push(...(page.body.runs as Record<string, unknown>[]));
    cursor = page.body.nextCursor as string | undefined;
    if (cursor === undefined) return runs;
  }
  throw new Error('the listing did not end');
}

/** Every page of one history, followed by cursor. */
export async function wholeHistory(
  base: string,
  token: string,
  runnerName: string,
  historicalId: string,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const occurrences: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await call(base, token, 'POST', '/v1/history/query', {
      runnerName,
      historicalId,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.status !== 200)
      throw new Error(`history answered ${page.status}: ${JSON.stringify(page.body)}`);
    occurrences.push(...(page.body.occurrences as Record<string, unknown>[]));
    cursor = page.body.nextCursor as string | undefined;
    if (cursor === undefined) return occurrences;
  }
  throw new Error('the history did not end');
}

/** The staging root's entries: empty whenever no request is in flight. */
export function stagingEntries(root: string): string[] {
  return readdirSync(root);
}
