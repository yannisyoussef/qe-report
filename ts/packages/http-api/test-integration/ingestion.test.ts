import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReadModel, type ProjectedRun } from 'qe-report-read-model';
import { FIXTURES_DIR } from '../../protocol/test/helpers.js';
import {
  attachment,
  attemptFinished,
  attemptStarted,
  finished,
  freshRoot,
  started,
  testCase,
  writeRun,
  type EventSpec,
} from '../../read-model/test/synthetic.js';
import { waitFor } from '../../postgres/test-integration/support.js';
import { runDto } from '../src/dto.js';
import { encodeRunRef } from '../src/run-ref.js';
import {
  HttpHarness,
  NEVER,
  archiveState,
  call,
  durableObjects,
  partsOf,
  stagingEntries,
  upload,
  uploadRun,
  type Service,
  type UploadPart,
} from './harness.js';

const harness = new HttpHarness();
beforeAll(() => harness.start());
afterAll(() => harness.stop());

const fixture = (name: string): string => join(FIXTURES_DIR, name);

/** The run as the local read model projects the directory, through the same DTO mapper. */
async function localDto(projectId: string, dir: string): Promise<Record<string, unknown>> {
  const built = await buildReadModel([{ projectId, runDirectory: dir }]);
  expect(built.problems).toEqual([]);
  return runDto(built.model.runs()[0] as ProjectedRun);
}

/** Proves a refused request left nothing: no archive rows, no durable bytes, no staging. */
async function nothingWritten(service: Service, durableBefore: string[]): Promise<void> {
  expect(await archiveState(service.db)).toEqual({
    qe_runs: 0,
    qe_run_source_lines: 0,
    qe_run_retention: 0,
    qe_run_query_index: 0,
    qe_history_occurrences: 0,
    qe_blobs: 0,
    qe_run_blobs: 0,
  });
  expect(durableObjects(service.db.blobRoot)).toEqual(durableBefore);
  await waitFor(async () => stagingEntries(service.stagingRoot).length === 0);
}

describe('uploading a run', () => {
  it('archives several event streams and their attachments, and reads them back as the local projection does', async () => {
    const service = await harness.service('upload_forked');
    const token = await service.key('P');
    const dir = fixture('runs/forked');
    const first = await uploadRun(service.base, token, dir);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      outcome: 'inserted',
      runId: 'run-fork-0001',
      runRef: encodeRunRef('run-fork-0001'),
      ingestionSequence: expect.stringMatching(/^[1-9][0-9]*$/u),
    });
    expect(first.headers.get('location')).toBe(`/v1/runs/${encodeRunRef('run-fork-0001')}`);
    expect(stagingEntries(service.stagingRoot)).toEqual([]);

    const run = await call(service.base, token, 'GET', first.headers.get('location') ?? '');
    expect(run.status).toBe(200);
    expect(run.body).toEqual(await localDto('P', dir));
    const text = JSON.stringify(run.body);
    for (const leak of [
      service.stagingRoot,
      'http:',
      'runDirectory',
      'sourceLocator',
      'fingerprint',
    ]) {
      expect(text).not.toContain(leak);
    }

    // The provenance stored is logical: no temporary path survives the request.
    const stored = await service.db.store.loadRun('P', 'run-fork-0001');
    expect(stored?.sourceLocator).toMatch(/^http:[0-9a-f-]{36}$/u);
    expect(new Set(stored?.sourceLines.map((l) => l.sourceFile))).toEqual(
      new Set(['events/000001.ndjson', 'events/000002.ndjson', 'events/000003.ndjson']),
    );

    // Every attachment is downloadable from the durable store once staging is gone.
    for (const name of readdirSync(join(dir, 'attachments'))) {
      const bytes = await fetch(
        `${service.base}/v1/runs/${first.body.runRef as string}/attachments/${name}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(bytes.status).toBe(200);
      expect(bytes.headers.get('content-type')).toBe('application/octet-stream');
      expect(bytes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(
        readFileSync(join(dir, 'attachments', name)),
      );
    }
  });

  it('is idempotent for the same run, conflicts for another under its id, and keeps the archived form', async () => {
    const service = await harness.service('upload_idempotent');
    const token = await service.key('P');
    const dir = fixture('runs/karate');
    expect((await uploadRun(service.base, token, dir)).status).toBe(201);
    const again = await uploadRun(service.base, token, dir, new Date('2020-01-01T00:00:00Z'));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      outcome: 'already_present',
      runId: 'run-karate-0001',
      blobRelationsAdded: 0,
      retentionAdded: false,
      queryIndexRebuilt: false,
    });
    // The first expiry stands.
    expect((await service.db.store.loadRun('P', 'run-karate-0001'))?.expiresAt).toEqual(NEVER);

    // Other content under the same run id: one event more, the same identity.
    const root = freshRoot('conflict');
    const other = writeRun(root, 'other', 'run-karate-0001', [
      {
        sessionId: 's',
        events: [
          started('pw'),
          attemptStarted('a', 1, testCase('e', 'h')),
          attemptFinished('a', 'passed'),
          finished(),
        ],
      },
    ]);
    const before = await archiveState(service.db);
    const conflict = await uploadRun(service.base, token, other);
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(conflict.body).toMatchObject({ code: 'RUN_CONFLICT', runId: 'run-karate-0001' });
    expect(JSON.stringify(conflict.body)).not.toMatch(/[0-9a-f]{64}/u);
    expect(await archiveState(service.db)).toEqual(before);
    expect(stagingEntries(service.stagingRoot)).toEqual([]);
  });

  it('keeps the archived physical form when an idempotent form with extra duplicate lines repairs its index', async () => {
    const service = await harness.service('upload_canonical');
    const token = await service.key('P');
    const root = freshRoot('http-canonical');
    const events: EventSpec[] = [
      started('pw'),
      attemptStarted('e-1', 1, testCase('e', 'canonical')),
      attemptFinished('e-1', 'passed'),
      finished(),
    ];
    const plain = writeRun(root, 'plain', 'run-canonical', [{ sessionId: 's', events }]);
    const doubled = writeRun(root, 'doubled', 'run-canonical', [{ sessionId: 's', events }]);
    const file = join(doubled, 'events', 's.ndjson');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    writeFileSync(
      file,
      [lines[0], lines[1], lines[1], lines[1], ...lines.slice(2)].join('\n') + '\n',
    );

    expect((await uploadRun(service.base, token, plain)).status).toBe(201);
    await service.db.pool.query('DELETE FROM qe_history_occurrences');
    await service.db.pool.query('DELETE FROM qe_run_query_index');
    const repaired = await uploadRun(service.base, token, doubled);
    expect(repaired.status).toBe(200);
    expect(repaired.body).toMatchObject({ outcome: 'already_present', queryIndexRebuilt: true });
    const listed = await call(service.base, token, 'GET', '/v1/runs');
    expect(listed.body.runs).toEqual([
      expect.objectContaining({ runId: 'run-canonical', duplicateEvents: 0 }),
    ]);
    expect(await service.queries.getRun('P', 'run-canonical')).toBeDefined();
    const { PostgresQueries } = await import('qe-report-postgres');
    expect(
      await new PostgresQueries(service.db.pool).verifyIndexedRun('P', 'run-canonical'),
    ).toMatchObject({
      agrees: true,
    });
    const run = await call(service.base, token, 'GET', `/v1/runs/${encodeRunRef('run-canonical')}`);
    expect((run.body.validator as Record<string, unknown>).duplicateEvents).toBe(0);
  });

  it('accepts a past expiry, and derives it from nothing but the part', async () => {
    const service = await harness.service('upload_expiry');
    const token = await service.key('P');
    const dir = fixture('runs/flaky-session-passed');
    const past = new Date('2001-02-03T04:05:06.789Z');
    const answer = await upload(service.base, token, [
      { name: 'expiresAt', text: '2001-02-03T05:05:06.789+01:00' },
      ...partsOf(dir).slice(1),
    ]);
    expect(answer.status).toBe(201);
    expect((await service.db.store.loadRun('P', 'run-so-0008'))?.expiresAt).toEqual(past);
  });
});

describe('refusing an upload', () => {
  it('answers invalid, incomplete, and empty runs with 422 and their diagnostics, writing nothing', async () => {
    const service = await harness.service('refusals');
    const token = await service.key('P');
    const durable = durableObjects(service.db.blobRoot);
    const cases: [string, string, string][] = [
      ['runs/invalid/malformed-json', 'RUN_INVALID', 'MALFORMED_JSON'],
      ['runs/invalid/schema-invalid-line', 'RUN_INVALID', 'SCHEMA_INVALID'],
      ['runs/invalid/sequence-gap', 'RUN_INVALID', 'LIFECYCLE_INVALID'],
      ['runs/invalid/mixed-sessions-in-file', 'RUN_INVALID', 'LIFECYCLE_INVALID'],
      ['runs/invalid/attachment-missing', 'RUN_INVALID', 'ATTACHMENT_MISSING'],
      // Bytes are staged under the hash they have, never the name they came with: bytes that do
      // not match their declaration leave the declared hash without a file.
      ['runs/invalid/attachment-hash-mismatch', 'RUN_INVALID', 'ATTACHMENT_MISSING'],
      ['runs/crashed', 'RUN_INCOMPLETE', 'INCOMPLETE_RUN'],
    ];
    for (const [dir, reason, code] of cases) {
      const answer = await uploadRun(service.base, token, fixture(dir));
      expect(answer.status, dir).toBe(422);
      expect(answer.body, dir).toMatchObject({ code: reason, status: 422 });
      const diagnostics = answer.body.diagnostics as Record<string, unknown>[];
      expect(
        diagnostics.some((d) => d.code === code),
        dir,
      ).toBe(true);
      for (const d of diagnostics) {
        if (d.file !== undefined) expect(d.file, dir).toMatch(/^events\/\d{6}\.ndjson$/u);
      }
      expect(JSON.stringify(answer.body)).not.toContain(service.stagingRoot);
      expect(JSON.stringify(answer.body)).not.toContain('/tmp');
      await nothingWritten(service, durable);
    }
    // A stream that holds no events at all is empty, not invalid.
    const empty = await upload(service.base, token, [
      { name: 'expiresAt', text: NEVER.toISOString() },
      { name: 'events', bytes: Buffer.alloc(0) },
    ]);
    expect(empty.status).toBe(422);
    expect(empty.body).toMatchObject({ code: 'RUN_EMPTY', diagnostics: [] });
    await nothingWritten(service, durable);
  });

  it('refuses malformed requests with 400, before anything is archived', async () => {
    const service = await harness.service('bad_requests');
    const token = await service.key('P');
    const durable = durableObjects(service.db.blobRoot);
    const dir = fixture('runs/flaky-session-passed');
    const good = partsOf(dir);
    const events = good.filter((p) => p.name === 'events');
    const bad: [string, UploadPart[]][] = [
      ['no expiry', events],
      ['no events', [good[0] as UploadPart]],
      ['two expiries', [good[0] as UploadPart, good[0] as UploadPart, ...events]],
      ['expiry without offset', [{ name: 'expiresAt', text: '2027-01-01T00:00:00' }, ...events]],
      ['expiry as a date', [{ name: 'expiresAt', text: '2027-01-01' }, ...events]],
      [
        'expiry as a file',
        [{ name: 'expiresAt', bytes: Buffer.from(NEVER.toISOString()) }, ...events],
      ],
      ['events as text', [good[0] as UploadPart, { name: 'events', text: 'x' }]],
      [
        'a project id part',
        [good[0] as UploadPart, { name: 'projectId', text: 'other' }, ...events],
      ],
      [
        'a run id part',
        [good[0] as UploadPart, ...events, { name: 'runId', bytes: Buffer.from('r') }],
      ],
      ['an archive', [good[0] as UploadPart, { name: 'archive', bytes: Buffer.from('PK') }]],
    ];
    for (const [label, parts] of bad) {
      const answer = await upload(service.base, token, parts);
      expect(answer.status, label).toBe(400);
      expect(answer.body, label).toMatchObject({ code: 'BAD_REQUEST' });
      await nothingWritten(service, durable);
    }
    // Framing that is not multipart at all, or broken multipart.
    for (const [contentType, body] of [
      ['multipart/form-data', 'no boundary'],
      [
        'multipart/form-data; boundary=zz',
        '--zz\r\nContent-Disposition: form-data; name="events"; filename="a"\r\n\r\nunterminated',
      ],
    ] as const) {
      const answer = await fetch(`${service.base}/v1/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        body,
      });
      expect(answer.status, contentType).toBe(400);
      await nothingWritten(service, durable);
    }
  });

  it('stops at every transport limit with 413, writing nothing', async () => {
    const service = await harness.service('limits', {
      limits: {
        maxRequestBytes: 64 * 1024,
        maxEventParts: 2,
        maxEventBytes: 16 * 1024,
        maxAttachmentParts: 2,
        maxAttachmentBytes: 1024,
        maxTotalAttachmentBytes: 1536,
      },
    });
    const token = await service.key('P');
    const durable = durableObjects(service.db.blobRoot);
    const dir = fixture('runs/flaky-session-passed');
    const [expiry, ...events] = partsOf(dir);
    const bytes = (n: number): Buffer => Buffer.alloc(n, 7);
    const cases: [string, UploadPart[]][] = [
      [
        'request',
        [expiry as UploadPart, ...events, { name: 'attachment', bytes: bytes(80 * 1024) }],
      ],
      ['event parts', [expiry as UploadPart, ...events, ...events, ...events]],
      ['event bytes', [expiry as UploadPart, { name: 'events', bytes: bytes(17 * 1024) }]],
      [
        'attachment parts',
        [
          expiry as UploadPart,
          ...events,
          ...[1, 2, 3].map(() => ({ name: 'attachment', bytes: bytes(10) })),
        ],
      ],
      [
        'one attachment',
        [expiry as UploadPart, ...events, { name: 'attachment', bytes: bytes(1025) }],
      ],
      [
        'attachments together',
        [
          expiry as UploadPart,
          ...events,
          { name: 'attachment', bytes: bytes(1000) },
          { name: 'attachment', bytes: bytes(1000) },
        ],
      ],
    ];
    for (const [label, parts] of cases) {
      const answer = await upload(service.base, token, parts);
      expect(answer.status, label).toBe(413);
      expect(answer.body, label).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      await nothingWritten(service, durable);
    }
    // The same run within every limit goes through.
    expect((await upload(service.base, token, [expiry as UploadPart, ...events])).status).toBe(201);
  });

  it('stops a body that grows past the limit without a declared length', async () => {
    const service = await harness.service('limits_chunked', {
      limits: { maxRequestBytes: 32 * 1024 },
    });
    const token = await service.key('P');
    const boundary = 'qeboundary';
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${service.base}/v1/runs`);
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="events"; filename="a"\r\n\r\n`,
      );
      let sent = 0;
      const pump = (): void => {
        while (sent < 256 * 1024) {
          sent += 8192;
          if (!req.write(Buffer.alloc(8192, 97))) {
            req.once('drain', pump);
            return;
          }
        }
        req.end(`\r\n--${boundary}--\r\n`);
      };
      pump();
    }).catch(() => 413);
    expect(status).toBe(413);
    await nothingWritten(service, durableObjects(service.db.blobRoot));
  });

  it('removes the staging directory of an upload the client abandons', async () => {
    const service = await harness.service('abort');
    const token = await service.key('P');
    const boundary = 'qeabort';
    const url = new URL(`${service.base}/v1/runs`);
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(10 * 1024 * 1024),
      },
    });
    req.on('error', () => undefined);
    req.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="expiresAt"\r\n\r\n${NEVER.toISOString()}\r\n--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="a"\r\n\r\n`,
    );
    req.write(Buffer.alloc(256 * 1024, 1));
    // The request directory exists while the upload is in flight...
    await waitFor(async () => stagingEntries(service.stagingRoot).length === 1);
    req.destroy();
    // ...and is gone once the server sees the client leave.
    await waitFor(async () => stagingEntries(service.stagingRoot).length === 0);
    await nothingWritten(service, durableObjects(service.db.blobRoot));
    // The server is still serving.
    expect((await call(service.base, undefined, 'GET', '/healthz')).status).toBe(200);
  });

  it('keeps unreferenced and repeated attachment parts out of the durable store', async () => {
    const service = await harness.service('extra_parts');
    const token = await service.key('P');
    const root = freshRoot('extra');
    const used = Buffer.from('bytes the run references');
    const dir = writeRun(
      root,
      'run',
      'run-extra',
      [
        {
          sessionId: 's',
          events: [
            started('pw'),
            attemptStarted('a', 1, testCase('e', 'h')),
            attachment('a', used),
            attemptFinished('a', 'passed'),
            finished(),
          ],
        },
      ],
      [used],
    );
    const unreferenced = Buffer.from('bytes no event mentions');
    const answer = await upload(service.base, token, [
      ...partsOf(dir),
      { name: 'attachment', bytes: used, filename: '../../etc/passwd', type: 'text/html' },
      { name: 'attachment', bytes: unreferenced, filename: 'evil' },
    ]);
    expect(answer.status).toBe(201);
    const { createHash } = await import('node:crypto');
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
    expect(durableObjects(service.db.blobRoot)).toEqual([sha(used)]);
    expect(stagingEntries(service.stagingRoot)).toEqual([]);
    // A declared attachment whose bytes were not uploaded is the validator's refusal, which
    // comes before any question of whether the run is already archived.
    const refused = await upload(
      service.base,
      token,
      partsOf(dir).filter((p) => p.name !== 'attachment'),
    );
    expect(refused.status).toBe(422);
    expect((refused.body.diagnostics as Record<string, unknown>[]).map((d) => d.code)).toContain(
      'ATTACHMENT_MISSING',
    );
  });
});

describe('run references and active content', () => {
  it('serves runs whose ids are awkward in a URL, and their attachments, only as octet streams', async () => {
    const service = await harness.service('run_refs');
    const token = await service.key('P');
    const root = freshRoot('refs');
    const html = Buffer.from('<script>alert(1)</script>');
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const ids = ['a/b', 'q?x=1', 'frag#1', '100%25', 'a+b', 'ns:run', 'x'.repeat(128)];
    for (const [i, runId] of ids.entries()) {
      const dir = writeRun(
        root,
        `r${i}`,
        runId,
        [
          {
            sessionId: 's',
            events: [
              started('pw'),
              attemptStarted('a', 1, testCase('e', 'h')),
              attachment('a', html, { mediaType: 'text/html', name: 'page.html' }),
              attachment('a', svg, { mediaType: 'image/svg+xml', name: 'image.svg' }),
              attemptFinished('a', 'passed'),
              finished(),
            ],
          },
        ],
        [html, svg],
      );
      const answer = await uploadRun(service.base, token, dir);
      expect(answer.status, runId).toBe(201);
      expect(answer.body.runRef, runId).toBe(encodeRunRef(runId));
    }
    const listed = await call(service.base, token, 'GET', '/v1/runs');
    const refs = new Map(
      (listed.body.runs as Record<string, string>[]).map((r) => [r.runId, r.runRef]),
    );
    for (const runId of ids) {
      const ref = refs.get(runId) as string;
      expect(ref).toBe(encodeRunRef(runId));
      const run = await call(service.base, token, 'GET', `/v1/runs/${ref}`);
      expect(run.status, runId).toBe(200);
      expect(run.body.runId).toBe(runId);
      for (const a of run.body.attachments as Record<string, string>[]) {
        const bytes = await fetch(`${service.base}${a.href}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(bytes.status, `${runId} ${a.mediaType}`).toBe(200);
        expect(bytes.headers.get('content-type')).toBe('application/octet-stream');
        expect(bytes.headers.get('x-content-type-options')).toBe('nosniff');
        expect(bytes.headers.get('content-disposition')).toBe(`attachment; filename="${a.sha256}"`);
        expect(bytes.headers.get('content-length')).toBe(String(a.sizeBytes));
        const body = Buffer.from(await bytes.arrayBuffer());
        expect(body).toEqual(a.mediaType === 'text/html' ? html : svg);
      }
    }
    // The raw id in the path, the padded form, and the standard alphabet are refused.
    // The raw id, a padded form, and the standard alphabet are not runRefs.
    expect(Buffer.from('q?x=1').toString('base64')).toBe('cT94PTE=');
    expect(Buffer.from('~~~').toString('base64')).toBe('fn5+');
    for (const bad of [`${encodeRunRef('a/b')}=`, 'cT94PTE%3D', 'fn5%2B', 'a%2Fb']) {
      const answer = await call(service.base, token, 'GET', `/v1/runs/${bad}`);
      expect(answer.status, bad).toBe(400);
      expect(answer.body.code, bad).toBe('BAD_REQUEST');
    }
    expect(
      (
        await call(
          service.base,
          token,
          'GET',
          `/v1/runs/${encodeRunRef('a/b')}/attachments/${'0'.repeat(64)}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call(service.base, token, 'GET', `/v1/runs/${encodeRunRef('a/b')}/attachments/XYZ`))
        .status,
    ).toBe(400);
  });
});
