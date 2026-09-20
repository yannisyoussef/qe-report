import { createServer, type Server, type Socket } from 'node:net';
import { connect } from 'node:net';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresQueries } from 'qe-report-postgres';
import { FIXTURES_DIR } from '../../protocol/test/helpers.js';
import {
  attemptFinished,
  attemptStarted,
  finished,
  freshRoot,
  started,
  testCase,
  writeRun,
  type EventSpec,
} from '../../read-model/test/synthetic.js';
import { HttpHarness, call, type Service } from '../../http-api/test-integration/harness.js';
import {
  QeReportHttpClient,
  UploadRejectedError,
  UploadTransportError,
  runUpload,
} from '../src/index.js';

const harness = new HttpHarness();
beforeAll(() => harness.start());
afterAll(async () => {
  for (const server of proxies) server.close();
  await harness.stop();
});

const proxies: Server[] = [];
const EXPIRES = new Date('2099-01-01T00:00:00.000Z');
const fixture = (name: string): string => join(FIXTURES_DIR, name);

/** A client aimed at a service, with no real waiting between attempts. */
function clientFor(baseUrl: string, apiKey: string, maxAttempts = 4): QeReportHttpClient {
  return new QeReportHttpClient({
    baseUrl,
    apiKey,
    retry: { maxAttempts },
    sleep: async () => undefined,
    random: () => 1,
    attemptTimeoutMs: 60_000,
  });
}

/**
 * A TCP proxy in front of the service. `cutAfterRequest` lets the first connection's request
 * through in full, then drops the answer and closes the connection: the service has archived the
 * run, and the producer never learns it. Every later connection is proxied untouched.
 */
async function proxy(
  target: string,
  options: { readonly cutFirstAnswer?: boolean } = {},
): Promise<{ baseUrl: string; connections: () => number }> {
  const url = new URL(target);
  let connections = 0;
  const server = createServer((client: Socket) => {
    connections += 1;
    const first = connections === 1 && options.cutFirstAnswer === true;
    const upstream = connect({ host: url.hostname, port: Number(url.port) });
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
    client.pipe(upstream);
    if (first) {
      // The request reaches the service; its answer is thrown away and the producer's
      // connection is cut, which is exactly an ambiguous commit.
      upstream.once('data', () => {
        client.destroy();
        upstream.destroy();
      });
    } else {
      upstream.pipe(client);
    }
  });
  proxies.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, connections: () => connections };
}

/** One synthetic run directory, with an optional extra duplicate of its second line. */
function runDirectory(name: string, runId: string, duplicateLine = false): string {
  const events: EventSpec[] = [
    started('pw'),
    attemptStarted('a', 1, testCase('e', 'h')),
    attemptFinished('a', 'passed'),
    finished(),
  ];
  const dir = writeRun(freshRoot(name), name, runId, [{ sessionId: 's', events }]);
  if (duplicateLine) {
    const file = join(dir, 'events', 's.ndjson');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    writeFileSync(file, [lines[0], lines[1], lines[1], ...lines.slice(2)].join('\n') + '\n');
  }
  return dir;
}

/** How many upload requests the service itself has answered, from its own log. */
function uploadsSeen(service: Service): number {
  return service.logs.filter((line) => line.includes('"route":"/v1/runs"')).length;
}

async function archivedRuns(service: Service): Promise<number> {
  const rows = await service.db.pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM qe_runs',
  );
  return Number(rows.rows[0]?.n ?? 0);
}

describe('uploading to the real service', () => {
  it('delivers a producer directory, and says the same thing the second time', async () => {
    const service = await harness.service('upload');
    const token = await service.key('P');
    const client = clientFor(service.base, token);
    const dir = fixture('runs/forked');

    const first = await client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    expect(first).toMatchObject({ outcome: 'inserted', runId: 'run-fork-0001', attempts: 1 });
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.ingestionSequence).toMatch(/^[1-9][0-9]*$/u);

    // The archive holds what the producer wrote, under logical provenance.
    const stored = await service.db.store.loadRun('P', 'run-fork-0001');
    expect(stored?.sourceLocator).toMatch(/^http:[0-9a-f-]{36}$/u);
    expect(new Set(stored?.sourceLines.map((l) => l.sourceFile))).toEqual(
      new Set(['events/000001.ndjson', 'events/000002.ndjson', 'events/000003.ndjson']),
    );
    // Its attachments are downloadable from the service, byte for byte.
    const run = await call(service.base, token, 'GET', `/v1/runs/${first.runRef}`);
    const attachments = run.body.attachments as { sha256: string; href: string }[];
    expect(attachments.length).toBeGreaterThan(0);
    for (const attachment of attachments) {
      const bytes = await fetch(`${service.base}${attachment.href}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(
        readFileSync(join(dir, 'attachments', attachment.sha256)),
      );
    }

    const again = await client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    expect(again).toMatchObject({ outcome: 'already_present', runId: 'run-fork-0001' });
    expect(await archivedRuns(service)).toBe(1);
    // The producer keeps its directory: every event file it wrote is still there, unchanged.
    const files = readdirSync(join(dir, 'events')).sort();
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(readFileSync(join(dir, 'events', file)).length, file).toBeGreaterThan(0);
    }
  });

  it('retries an upload whose answer was lost, and archives the run exactly once', async () => {
    const service = await harness.service('ambiguous');
    const token = await service.key('P');
    const ahead = await proxy(service.base, { cutFirstAnswer: true });
    const dir = runDirectory('ambiguous', 'run-ambiguous');
    const client = clientFor(ahead.baseUrl, token);

    const result = await client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    // The first attempt archived the run and the answer never arrived; the second found it there.
    expect(result).toMatchObject({ outcome: 'already_present', runId: 'run-ambiguous' });
    expect(result.attempts).toBe(2);
    expect(ahead.connections()).toBe(2);
    expect(await archivedRuns(service)).toBe(1);

    const stored = await service.db.store.loadRun('P', 'run-ambiguous');
    expect(stored?.expiresAt).toEqual(EXPIRES);
    const locator = stored?.sourceLocator;
    // The second delivery changed nothing: not the source, not the expiry, not the provenance.
    const third = await client.uploadRunDirectory({
      runDirectory: dir,
      expiresAt: new Date('2098-01-01T00:00:00.000Z'),
    });
    expect(third.outcome).toBe('already_present');
    const after = await service.db.store.loadRun('P', 'run-ambiguous');
    expect(after?.expiresAt).toEqual(EXPIRES);
    expect(after?.sourceLocator).toBe(locator);
    expect(after?.sourceLines).toEqual(stored?.sourceLines);
    expect(await archivedRuns(service)).toBe(1);
  });

  it('carries a refusal back without trying again', async () => {
    const service = await harness.service('refusal');
    const token = await service.key('P');
    const ahead = await proxy(service.base);
    const client = clientFor(ahead.baseUrl, token);
    await client.uploadRunDirectory({
      runDirectory: runDirectory('conflict-a', 'run-conflict'),
      expiresAt: EXPIRES,
    });

    // The same run id, other content: the archive refuses, and asking again would not help.
    const other = writeRun(freshRoot('conflict-b'), 'b', 'run-conflict', [
      {
        sessionId: 's',
        events: [
          started('pw'),
          attemptStarted('a', 1, testCase('e', 'h')),
          attemptFinished('a', 'failed'),
          finished(),
        ],
      },
    ]);
    const before = uploadsSeen(service);
    const conflict = (await client
      .uploadRunDirectory({ runDirectory: other, expiresAt: EXPIRES })
      .catch((e: unknown) => e)) as UploadRejectedError;
    expect(conflict).toBeInstanceOf(UploadRejectedError);
    expect(conflict).toMatchObject({ status: 409, code: 'RUN_CONFLICT', runId: 'run-conflict' });
    // One request, one refusal: a conflict is never asked again.
    expect(uploadsSeen(service) - before).toBe(1);

    // An invalid run comes back with the service's own diagnostics, named as it named them.
    const invalid = (await client
      .uploadRunDirectory({
        runDirectory: fixture('runs/invalid/malformed-json'),
        expiresAt: EXPIRES,
      })
      .catch((e: unknown) => e)) as UploadRejectedError;
    expect(invalid).toMatchObject({ status: 422, code: 'RUN_INVALID' });
    expect(invalid.diagnostics.some((d) => d.code === 'MALFORMED_JSON')).toBe(true);
    expect(
      invalid.diagnostics.every((d) => d.file === undefined || d.file.startsWith('events/')),
    ).toBe(true);

    // A key that is not one, and a key for another project's scope, are equally final.
    const stranger = clientFor(
      ahead.baseUrl,
      'qer_k1_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    await expect(
      stranger.uploadRunDirectory({
        runDirectory: runDirectory('auth', 'run-auth'),
        expiresAt: EXPIRES,
      }),
    ).rejects.toMatchObject({ name: 'UploadRejectedError', status: 401 });
    const readOnly = await service.key('P', ['runs:read']);
    await expect(
      clientFor(ahead.baseUrl, readOnly).uploadRunDirectory({
        runDirectory: runDirectory('scope', 'run-scope'),
        expiresAt: EXPIRES,
      }),
    ).rejects.toMatchObject({ name: 'UploadRejectedError', status: 403 });
    expect(await archivedRuns(service)).toBe(1);
  });

  it('leaves the archive to decide what an idempotent re-upload means', async () => {
    const service = await harness.service('canonical');
    const token = await service.key('P');
    const client = clientFor(service.base, token);
    // The archived form has no duplicate line; the form uploaded later has one.
    const plain = runDirectory('canonical-a', 'run-canonical');
    const doubled = runDirectory('canonical-b', 'run-canonical', true);
    expect(
      (await client.uploadRunDirectory({ runDirectory: plain, expiresAt: EXPIRES })).outcome,
    ).toBe('inserted');
    await service.db.pool.query('DELETE FROM qe_history_occurrences');
    await service.db.pool.query('DELETE FROM qe_run_query_index');

    const repaired = await client.uploadRunDirectory({
      runDirectory: doubled,
      expiresAt: EXPIRES,
    });
    expect(repaired).toMatchObject({ outcome: 'already_present', queryIndexRebuilt: true });
    // The index describes the archived form, as it did before HTTP existed.
    const listed = await call(service.base, token, 'GET', '/v1/runs');
    expect((listed.body.runs as { duplicateEvents: number }[])[0]?.duplicateEvents).toBe(0);
    expect(
      await new PostgresQueries(service.db.pool).verifyIndexedRun('P', 'run-canonical'),
    ).toMatchObject({ agrees: true });
  });

  it('gives up after its attempts, saying nothing of the key', async () => {
    const service = await harness.service('exhausted');
    const token = await service.key('P');
    // A proxy that answers nothing and drops every connection.
    const dead = createServer((client) => client.destroy());
    proxies.push(dead);
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const address = dead.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const client = clientFor(`http://127.0.0.1:${port}`, token, 3);
    const error = (await client
      .uploadRunDirectory({ runDirectory: runDirectory('dead', 'run-dead'), expiresAt: EXPIRES })
      .catch((e: unknown) => e)) as UploadTransportError;
    expect(error).toBeInstanceOf(UploadTransportError);
    expect(error.attempts).toBe(3);
    expect(error.message).not.toContain(token);
    expect(await archivedRuns(service)).toBe(0);
  });
});

describe('the command against the real service', () => {
  it('uploads, reports, and separates a refusal from a delivery', async () => {
    const service = await harness.service('cli');
    const token = await service.key('P');
    const out: string[] = [];
    const err: string[] = [];
    const streams = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    const env = { QE_REPORT_API_KEY: token, QE_REPORT_URL: service.base };

    const dir = runDirectory('cli-run', 'run-cli');
    expect(await runUpload(['--run-dir', dir, '--retention-ms', '86400000'], env, streams)).toBe(0);
    expect(out.join('')).toBe('uploaded run run-cli (inserted)\n');
    // A run that is already there is still a successful upload.
    expect(
      await runUpload(['--run-dir', dir, '--expires-at', EXPIRES.toISOString()], env, streams),
    ).toBe(0);
    expect(out.join('')).toContain('(already_present)');
    const stored = await service.db.store.loadRun('P', 'run-cli');
    // The expiry of the first upload stands, and it is a whole number of milliseconds away.
    expect(stored?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    // A conflict is the service's refusal, not a delivery problem.
    const other = writeRun(freshRoot('cli-other'), 'o', 'run-cli', [
      {
        sessionId: 's',
        events: [
          started('pw'),
          attemptStarted('a', 1, testCase('e', 'other')),
          attemptFinished('a', 'passed'),
          finished(),
        ],
      },
    ]);
    expect(await runUpload(['--run-dir', other, '--retention-ms', '1000'], env, streams)).toBe(3);
    expect(err.join('')).toContain('RUN_CONFLICT');
    for (const text of [out.join(''), err.join('')]) {
      expect(text).not.toContain(token);
      expect(text.toLowerCase()).not.toContain('authorization');
    }
  });
});
