import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** The child as it is spawned here: no standard input, both output streams captured. */
type Child = ChildProcessByStdio<null, Readable, Readable>;
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresApiKeys } from 'qe-report-postgres';
import { FIXTURES_DIR } from '../../protocol/test/helpers.js';
import { HttpHarness, NEVER, partsOf, type UploadPart } from './harness.js';

/**
 * Shutdown, against the process an operator actually stops.
 *
 * Everything else about the lifecycle is tested against an injected `close`, which is the right
 * way to test a state machine and the wrong way to learn what `SIGTERM` does to a running server.
 * These cases start the built binary, put a real request in flight, signal it, and look at what
 * the operating system and the deployment see: the answer to the request already running, the
 * refusal of anything new, the exit code, the staging root, and the one line written about it.
 *
 * They exist because the graceful behaviour is inherited from Fastify's own defaults. Nothing
 * here would notice if one of those defaults changed; a deployment would.
 */
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'server.js');

const harness = new HttpHarness();
beforeAll(() => harness.start(), 180_000);
afterAll(() => harness.stop());

const running: Child[] = [];
const roots: string[] = [];
afterAll(() => {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A port nothing is listening on, taken and released so the child can bind it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface Server {
  readonly child: Child;
  readonly base: string;
  readonly stagingRoot: string;
  /** Every line the process wrote, on either stream. */
  readonly lines: string[];
  /** Resolves with the exit code and signal once the process is gone. */
  readonly ended: Promise<{ code: number | null; signal: string | null }>;
}

/** The built server, on a real port, against a real database, ready to serve. */
async function serve(name: string, graceMs: number): Promise<Server> {
  const db = await harness.pg.database(name);
  const base = mkdtempSync(join(tmpdir(), `qe-shutdown-${name}-`));
  roots.push(base);
  const stagingRoot = join(base, 'staging');
  mkdirSync(stagingRoot);
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DATABASE_URL: harness.pg.connectionUriFor(db),
      QE_REPORT_BLOB_ROOT: db.blobRoot,
      QE_REPORT_STAGING_ROOT: stagingRoot,
      QE_REPORT_HOST: '127.0.0.1',
      QE_REPORT_PORT: String(port),
      QE_REPORT_SHUTDOWN_GRACE_MS: String(graceMs),
      QE_REPORT_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  const lines: string[] = [];
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) if (line !== '') lines.push(line);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  // The key the upload below will use, issued straight into the database the child is serving.
  const token = (
    await new PostgresApiKeys(db.pool).create({
      projectId: 'P',
      scopes: ['runs:read', 'runs:write'],
    })
  ).token;
  tokens.set(name, token);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (lines.some((l) => l.includes('server started'))) {
      return { child, base: `http://127.0.0.1:${port}`, stagingRoot, lines, ended };
    }
    if (child.exitCode !== null) throw new Error(`the server exited: ${lines.join('\n')}`);
    await sleep(100);
  }
  throw new Error(`the server did not start: ${lines.join('\n')}`);
}

const tokens = new Map<string, string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One multipart body, built here so that the test decides how fast it is written. */
function multipart(parts: readonly UploadPart[]): { boundary: string; body: Buffer } {
  const boundary = '----qeShutdownBoundary8f2c1d';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const head =
      'text' in part
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename ?? 'part'}"\r\nContent-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`;
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push('text' in part ? Buffer.from(part.text, 'utf8') : part.bytes);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

interface InFlight {
  readonly request: ClientRequest;
  /** The response, once the server answers; rejects if the connection dies instead. */
  readonly answered: Promise<{ status: number; body: string }>;
  /** Writes the rest of the body and ends the request. */
  finish(): void;
}

/**
 * An upload that has begun and has not finished: the headers and the first byte are on the wire,
 * so the server has a request in flight, and the rest is sent when the test says so.
 */
function beginUpload(base: string, token: string, body: Buffer, boundary: string): InFlight {
  const request = httpRequest(`${base}/v1/runs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  });
  const answered = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.on('response', (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', reject);
  });
  // Enough for the server to accept the request and start reading; never the whole body.
  request.write(body.subarray(0, 1));
  return {
    request,
    answered,
    finish: () => {
      request.write(body.subarray(1));
      request.end();
    },
  };
}

/** One request on a connection that is already open, which is how a drain is really tested. */
function onOpenConnection(
  base: string,
  agent: Agent,
  token: string,
): Promise<{ status: number } | { error: string }> {
  return new Promise((resolve) => {
    const request = httpRequest(
      `${base}/v1/runs?limit=1`,
      { method: 'GET', agent, headers: { authorization: `Bearer ${token}` } },
      (response) => {
        response.resume();
        response.on('end', () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    request.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    request.end();
  });
}

describe('a termination signal, against the process an operator stops', () => {
  it('answers the request already running, refuses a new one, exits 0, and leaves no staging', async () => {
    const server = await serve('shutdown_graceful', 20_000);
    const token = tokens.get('shutdown_graceful') as string;
    const { boundary, body } = multipart(partsOf(join(FIXTURES_DIR, 'runs', 'forked'), NEVER));

    // A keep-alive connection, established and left idle before the signal. It is the case a
    // closed listener alone would not cover, and what it proves below is that the drain does not
    // leave it usable either.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const warmed = await onOpenConnection(server.base, agent, token);
    expect(warmed).toEqual({ status: 200 });

    const upload = beginUpload(server.base, token, body, boundary);
    // The request is on the wire before the signal; without this the drain would have nothing to
    // wait for and the test would pass for the wrong reason.
    await sleep(500);
    expect(server.child.kill('SIGTERM')).toBe(true);
    await sleep(500);

    // Draining: nothing new is served. Today this is a refused connection, because the idle
    // keep-alive socket is closed and the listener is shut, so the agent's next attempt cannot
    // connect; a 503 from a socket that was still open would be equally correct. What must not
    // happen is the request being served.
    const duringDrain = await onOpenConnection(server.base, agent, token);
    expect(duringDrain).not.toMatchObject({ status: 200 });
    expect(
      'error' in duringDrain || duringDrain.status === 503,
      `a new request during the drain was answered ${JSON.stringify(duringDrain)}`,
    ).toBe(true);

    // And the request that was already running is answered, not dropped.
    upload.finish();
    const answer = await upload.answered;
    expect(answer.status, answer.body).toBe(201);
    expect(JSON.parse(answer.body)).toMatchObject({ outcome: 'inserted', runId: 'run-fork-0001' });

    const ended = await server.ended;
    expect(ended).toEqual({ code: 0, signal: null });
    // The request's own directory went with it: a clean shutdown leaves no staging behind.
    expect(readdirSync(server.stagingRoot)).toEqual([]);
    expect(server.lines.filter((l) => l.includes('shutdown requested'))).toHaveLength(1);
    expect(server.lines.filter((l) => l.includes('shutdown completed'))).toHaveLength(1);
    agent.destroy();
  }, 180_000);

  it('gives up on a drain that outlasts its grace, once, and exits non-zero', async () => {
    const server = await serve('shutdown_grace', 3_000);
    const token = tokens.get('shutdown_grace') as string;
    const { boundary, body } = multipart(partsOf(join(FIXTURES_DIR, 'runs', 'forked'), NEVER));

    // Begun and deliberately never finished: the server is reading a body that will not arrive,
    // so the drain cannot complete and the grace is what decides.
    const stuck = beginUpload(server.base, token, body, boundary);
    stuck.answered.catch(() => undefined);
    await sleep(500);
    server.child.kill('SIGTERM');

    const ended = await server.ended;
    expect(ended.code).toBe(1);
    expect(server.lines.filter((l) => l.includes('shutdown grace exceeded'))).toHaveLength(1);
    expect(server.lines.some((l) => l.includes('shutdown completed'))).toBe(false);
    stuck.request.destroy();
  }, 180_000);

  it('stops at once on a second signal, and says it was forced', async () => {
    const server = await serve('shutdown_forced', 60_000);
    const token = tokens.get('shutdown_forced') as string;
    const { boundary, body } = multipart(partsOf(join(FIXTURES_DIR, 'runs', 'forked'), NEVER));
    const stuck = beginUpload(server.base, token, body, boundary);
    stuck.answered.catch(() => undefined);
    await sleep(500);

    server.child.kill('SIGTERM');
    await sleep(500);
    // An operator who has waited long enough. The grace above is a minute; this must not take it.
    const startedForcing = Date.now();
    server.child.kill('SIGTERM');
    const ended = await server.ended;
    expect(ended.code).toBe(1);
    expect(Date.now() - startedForcing).toBeLessThan(30_000);
    expect(server.lines.filter((l) => l.includes('shutdown forced'))).toHaveLength(1);
    stuck.request.destroy();
  }, 180_000);
});
