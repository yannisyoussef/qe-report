import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  QeReportHttpClient,
  UploadAborted,
  UploadRejectedError,
  UploadTransportError,
  expiryAfter,
  planUpload,
  resolveTarget,
  retryAfterMs,
} from '../src/index.js';
import {
  archived,
  cleanup,
  freshDir,
  partsOf,
  problem,
  service,
  sha256,
  writeRunDirectory,
  type SeenRequest,
  type TestService,
} from './support.js';

afterAll(cleanup);

const TOKEN = 'qer_k1_abcdefghijklmnop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EXPIRES = new Date('2027-01-01T00:00:00.000Z');

/** A client whose waiting is recorded rather than real, and whose jitter is fixed. */
function clientFor(
  target: TestService | string,
  options: Partial<ConstructorParameters<typeof QeReportHttpClient>[0]> = {},
): { client: QeReportHttpClient; slept: number[] } {
  const slept: number[] = [];
  const client = new QeReportHttpClient({
    baseUrl: typeof target === 'string' ? target : target.baseUrl,
    apiKey: TOKEN,
    sleep: async (ms, signal) => {
      slept.push(ms);
      if (signal?.aborted === true) throw new UploadAborted();
    },
    random: () => 1,
    attemptTimeoutMs: 5_000,
    ...options,
  });
  return { client, slept };
}

describe('where an upload may go', () => {
  it('takes an absolute URL, keeps a deployment path, and refuses a URL that could leak the key', () => {
    expect(resolveTarget('https://reports.example.com').runs.href).toBe(
      'https://reports.example.com/v1/runs',
    );
    expect(resolveTarget('https://reports.example.com/qe-report').runs.href).toBe(
      'https://reports.example.com/qe-report/v1/runs',
    );
    expect(resolveTarget('https://reports.example.com/qe-report/').runs.href).toBe(
      'https://reports.example.com/qe-report/v1/runs',
    );
    // Loopback may be plaintext: that is a development service on this machine.
    for (const url of ['http://localhost:8080', 'http://127.0.0.1:1/', 'http://[::1]:8080']) {
      expect(() => resolveTarget(url), url).not.toThrow();
    }
    for (const url of [
      'http://reports.example.com',
      'http://192.168.1.10:8080',
      'https://user:secret@reports.example.com',
      'https://reports.example.com#fragment',
      'https://reports.example.com?token=x',
      'ftp://reports.example.com',
      'file:///etc/passwd',
      'reports.example.com',
      '',
    ]) {
      expect(() => resolveTarget(url), url).toThrow(TypeError);
    }
    // Plaintext elsewhere only when the caller says so, deliberately.
    expect(resolveTarget('http://reports.example.test', true).runs.href).toBe(
      'http://reports.example.test/v1/runs',
    );
  });

  it('refuses a key or a retry policy it cannot use', () => {
    const base = { baseUrl: 'https://reports.example.com', apiKey: TOKEN };
    for (const apiKey of [
      '',
      ' ',
      'has space',
      7 as unknown as string,
      undefined as unknown as string,
    ]) {
      expect(() => new QeReportHttpClient({ ...base, apiKey })).toThrow(TypeError);
    }
    for (const maxAttempts of [0, -1, 1.5, Number.POSITIVE_INFINITY, 11]) {
      expect(() => new QeReportHttpClient({ ...base, retry: { maxAttempts } })).toThrow(TypeError);
    }
    for (const attemptTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => new QeReportHttpClient({ ...base, attemptTimeoutMs })).toThrow(TypeError);
    }
    expect(() => new QeReportHttpClient({ ...base, retry: { maxAttempts: 2 } })).not.toThrow();
  });
});

describe('what an upload sends', () => {
  it('sends exactly the API v1 parts, in a stable order, with the bytes the producer wrote', async () => {
    const root = freshDir('parts');
    const small = Buffer.from('an attachment');
    const other = Buffer.alloc(3 * 1024 * 1024, 7);
    const dir = writeRunDirectory(root, {
      events: { 'b.ndjson': '{"b":1}\n{"b":2}\n', 'a.ndjson': '{"a":1}\n' },
      attachments: [small, other],
      noise: { 'notes.txt': 'ignored', '.tmp-123': 'ignored' },
    });
    const server = await service((_request, response) => archived(response));
    const { client } = clientFor(server);
    const result = await client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    expect(result).toMatchObject({
      outcome: 'inserted',
      runId: 'run-1',
      runRef: 'cnVuLTE',
      ingestionSequence: '7',
      attempts: 1,
      requestId: '11111111-2222-4333-8444-555555555555',
    });

    expect(server.seen).toHaveLength(1);
    const request = server.seen[0] as SeenRequest;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/runs');
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The length is known before the first byte is sent, from the plan.
    expect(Number(request.headers['content-length'])).toBe(request.body.length);
    const parts = partsOf(request.body, String(request.headers['content-type']));
    expect(parts.map((p) => p.name)).toEqual([
      'expiresAt',
      'events',
      'events',
      'attachment',
      'attachment',
    ]);
    expect(parts[0]?.value.toString()).toBe('2027-01-01T00:00:00.000Z');
    // Event files in code-unit order, byte for byte, unparsed.
    expect(parts[1]?.filename).toBe('a.ndjson');
    expect(parts[1]?.value.toString()).toBe('{"a":1}\n');
    expect(parts[2]?.value.toString()).toBe('{"b":1}\n{"b":2}\n');
    // Attachments in hash order, and a 3 MiB one arrives whole.
    const hashes = [sha256(small), sha256(other)].sort();
    expect([parts[3]?.filename, parts[4]?.filename]).toEqual(hashes);
    const bySha = new Map(parts.slice(3).map((p) => [p.filename, p.value]));
    expect(sha256(bySha.get(sha256(other)) as Buffer)).toBe(sha256(other));
    expect(bySha.get(sha256(small))?.toString()).toBe('an attachment');
    // Nothing else of the directory is sent.
    expect(request.body.includes('ignored')).toBe(false);
    expect(request.body.includes('projectId')).toBe(false);
  });

  it('plans only what belongs to the run, and refuses a directory it cannot upload', async () => {
    const root = freshDir('plan');
    const dir = writeRunDirectory(root, {
      events: { 'a.ndjson': 'x\n' },
      noise: { 'a.txt': 'no', 'b.ndjson.bak': 'no' },
    });
    const plan = await planUpload(dir);
    expect(plan.events.map((f) => f.name)).toEqual(['events/a.ndjson']);
    expect(plan.attachments).toEqual([]);
    expect(plan.totalBytes).toBe(2);

    // Attachments that are not canonical names are passed over, including the SDK's temporaries.
    const withNoise = writeRunDirectory(freshDir('plan2'), { attachments: [Buffer.from('a')] });
    writeFileSync(join(withNoise, 'attachments', '.tmp-999-abc'), 'partial');
    writeFileSync(join(withNoise, 'attachments', 'README'), 'nope');
    expect((await planUpload(withNoise)).attachments.map((f) => f.sha256)).toEqual([
      sha256(Buffer.from('a')),
    ]);

    const empty = join(freshDir('plan3'), 'runs', 'run-1');
    mkdirSync(join(empty, 'events'), { recursive: true });
    await expect(planUpload(empty)).rejects.toMatchObject({ problem: 'NO_EVENTS' });
    await expect(planUpload(join(empty, 'nowhere'))).rejects.toMatchObject({
      problem: 'UNREADABLE',
    });
  });
});

describe('the local run directory is a boundary', () => {
  it('never reads through a symbolic link, and sends nothing when it finds one', async () => {
    const outside = join(freshDir('outside'), 'secret.txt');
    writeFileSync(outside, 'a secret that must never be uploaded');
    const server = await service((_request, response) => archived(response));
    const { client } = clientFor(server);

    const linkedEvent = writeRunDirectory(freshDir('link-event'), {
      events: { 'a.ndjson': 'x\n' },
    });
    symlinkSync(outside, join(linkedEvent, 'events', 'b.ndjson'));
    await expect(
      client.uploadRunDirectory({ runDirectory: linkedEvent, expiresAt: EXPIRES }),
    ).rejects.toMatchObject({ name: 'LocalRunDirectoryError', problem: 'UNSAFE_ENTRY' });

    const linkedAttachment = writeRunDirectory(freshDir('link-attachment'), {
      attachments: [Buffer.from('real')],
    });
    symlinkSync(outside, join(linkedAttachment, 'attachments', 'a'.repeat(64)));
    await expect(
      client.uploadRunDirectory({ runDirectory: linkedAttachment, expiresAt: EXPIRES }),
    ).rejects.toMatchObject({ name: 'LocalRunDirectoryError', problem: 'UNSAFE_ENTRY' });

    // A linked events directory is refused as a whole.
    const linkedDir = join(freshDir('link-dir'), 'runs', 'run-1');
    mkdirSync(linkedDir, { recursive: true });
    symlinkSync(join(linkedEvent, 'events'), join(linkedDir, 'events'));
    await expect(
      client.uploadRunDirectory({ runDirectory: linkedDir, expiresAt: EXPIRES }),
    ).rejects.toMatchObject({ problem: 'UNSAFE_ENTRY' });

    // Not one request was made, so no byte of the outside file left this machine.
    expect(server.seen).toEqual([]);
  });

  it('refuses an attachment whose bytes are not the hash its name claims', async () => {
    const dir = writeRunDirectory(freshDir('mismatch'), { attachments: [Buffer.from('real')] });
    writeFileSync(join(dir, 'attachments', 'b'.repeat(64)), 'not what the name says');
    const server = await service((_request, response) => archived(response));
    const { client } = clientFor(server);
    await expect(
      client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES }),
    ).rejects.toMatchObject({ problem: 'ATTACHMENT_HASH_MISMATCH' });
    expect(server.seen).toEqual([]);
  });

  it('stops rather than retrying a run directory that changed', async () => {
    const dir = writeRunDirectory(freshDir('mutate'), { events: { 'a.ndjson': '{"a":1}\n' } });
    const server = await service((_request, response, index) => {
      if (index === 0) {
        // Something to retry, so a second attempt reads the directory again.
        problem(response, 503, 'BUSY');
        return;
      }
      archived(response);
    });
    // The producer's output changes between attempts, which must never be uploaded as one run.
    const { client } = clientFor(server, {
      sleep: async () => {
        appendFileSync(join(dir, 'events', 'a.ndjson'), '{"a":2}\n');
      },
    });
    const upload = client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    await expect(upload).rejects.toMatchObject({
      name: 'LocalRunDirectoryError',
      problem: 'RUN_DIRECTORY_CHANGED',
    });
    expect(server.seen).toHaveLength(1);
  });
});

describe('what the service answers', () => {
  it('keeps a refusal, with its problem code and diagnostics, and does not ask again', async () => {
    const conflict = await service((_request, response) =>
      problem(response, 409, 'RUN_CONFLICT', { runId: 'run-1' }),
    );
    const dir = writeRunDirectory(freshDir('refusals'));
    const { client } = clientFor(conflict);
    const rejected = await client
      .uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES })
      .catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(UploadRejectedError);
    expect(rejected).toMatchObject({
      status: 409,
      code: 'RUN_CONFLICT',
      runId: 'run-1',
      requestId: '99999999-2222-4333-8444-555555555555',
    });
    expect(conflict.seen).toHaveLength(1);

    const invalid = await service((_request, response) =>
      problem(response, 422, 'RUN_INVALID', {
        diagnostics: [
          {
            severity: 'error',
            code: 'MALFORMED_JSON',
            message: 'line 2 is not JSON',
            file: 'events/000001.ndjson',
            line: 2,
          },
        ],
      }),
    );
    const invalidError = (await clientFor(invalid)
      .client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES })
      .catch((e: unknown) => e)) as UploadRejectedError;
    expect(invalidError.status).toBe(422);
    expect(invalidError.diagnostics[0]).toMatchObject({ code: 'MALFORMED_JSON', line: 2 });

    // Authentication, authorisation, and a limit are equally final.
    for (const [status, code] of [
      [401, 'AUTHENTICATION_REQUIRED'],
      [403, 'FORBIDDEN'],
      [413, 'PAYLOAD_TOO_LARGE'],
      [415, 'UNSUPPORTED_MEDIA_TYPE'],
      [400, 'BAD_REQUEST'],
    ] as [number, string][]) {
      const terminal = await service((_request, response) => problem(response, status, code));
      await expect(
        clientFor(terminal).client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES }),
      ).rejects.toMatchObject({ name: 'UploadRejectedError', status });
      expect(terminal.seen, code).toHaveLength(1);
    }
  });

  it('retries a delivery problem and reports the run the service finally archived', async () => {
    const dir = writeRunDirectory(freshDir('retry'));
    const server = await service((_request, response, index) => {
      if (index === 0) problem(response, 500, 'INTERNAL_ERROR');
      else if (index === 1) problem(response, 503, 'NOT_READY');
      else archived(response, 'already_present');
    });
    const { client, slept } = clientFor(server);
    const result = await client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    expect(result).toMatchObject({ outcome: 'already_present', attempts: 3 });
    expect(server.seen).toHaveLength(3);
    // Full jitter with a fixed random of 1: the whole doubling window each time.
    expect(slept).toEqual([250, 500]);
    // Every attempt sent the same bytes.
    expect(server.seen[0]?.body.length).toBe(server.seen[2]?.body.length);
  });

  it('runs out of attempts and says so, without a body or a key', async () => {
    const dir = writeRunDirectory(freshDir('exhausted'));
    const server = await service((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ code: 'INTERNAL_ERROR', detail: 'a secret detail' }));
    });
    const { client, slept } = clientFor(server, { retry: { maxAttempts: 3 } });
    const error = (await client
      .uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES })
      .catch((e: unknown) => e)) as UploadTransportError;
    expect(error).toBeInstanceOf(UploadTransportError);
    expect(error.attempts).toBe(3);
    expect(error.status).toBe(500);
    expect(server.seen).toHaveLength(3);
    expect(slept).toEqual([250, 500]);
    expect(error.message).not.toContain('a secret detail');
  });

  it('waits as long as the service asks, within its own bound', async () => {
    const dir = writeRunDirectory(freshDir('retry-after'));
    const seconds = await service((_request, response, index) => {
      if (index === 0) {
        response.writeHead(429, { 'retry-after': '2', 'content-type': 'application/problem+json' });
        response.end('{}');
        return;
      }
      archived(response);
    });
    const waited = clientFor(seconds);
    await waited.client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    expect(waited.slept).toEqual([2000]);

    // A service cannot make a producer wait for an hour.
    const forever = await service((_request, response, index) => {
      if (index === 0) {
        response.writeHead(503, { 'retry-after': '3600' });
        response.end();
        return;
      }
      archived(response);
    });
    const bounded = clientFor(forever, { retry: { maxDelayMs: 1000 } });
    await bounded.client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    expect(bounded.slept).toEqual([1000]);

    // An HTTP date is understood; nonsense is simply no answer.
    const at = new Date('2027-01-01T00:00:10.000Z');
    expect(retryAfterMs(at.toUTCString(), Date.parse('2027-01-01T00:00:00.000Z'))).toBe(10_000);
    expect(retryAfterMs('soon', 0)).toBeUndefined();
    expect(retryAfterMs(undefined, 0)).toBeUndefined();
    expect(retryAfterMs('-5', 0)).toBeUndefined();
  });

  it('treats an answer it cannot read as ambiguous, and never invents a result', async () => {
    const dir = writeRunDirectory(freshDir('unreadable'));
    const cases: [string, (response: import('node:http').ServerResponse) => void][] = [
      [
        'a success that is not JSON',
        (response) => {
          response.writeHead(201, { 'content-type': 'text/html' });
          response.end('<html>hello</html>');
        },
      ],
      [
        'a truncated JSON success',
        (response) => {
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end('{"outcome":"inserted","runId"');
        },
      ],
      [
        'a success without a run',
        (response) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ outcome: 'inserted' }));
        },
      ],
      [
        'a body larger than this client reads',
        (response) => {
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end('x'.repeat(2 * 1024 * 1024));
        },
      ],
    ];
    for (const [label, answer] of cases) {
      const server = await service((_request, response) => answer(response));
      const { client } = clientFor(server, { retry: { maxAttempts: 2 } });
      const error = await client
        .uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES })
        .catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(UploadTransportError);
      expect(server.seen, label).toHaveLength(2);
      expect(String((error as Error).message), label).not.toContain('hello');
      expect(String((error as Error).message).length, label).toBeLessThan(200);
    }
  });

  it('never follows a redirect, so the key never reaches another listener', async () => {
    const elsewhere = await service((_request, response) => archived(response));
    const dir = writeRunDirectory(freshDir('redirect'));
    const redirecting = await service((_request, response) => {
      response.writeHead(302, { location: `${elsewhere.baseUrl}/v1/runs` });
      response.end();
    });
    const { client } = clientFor(redirecting);
    await expect(
      client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES }),
    ).rejects.toMatchObject({ name: 'UploadRejectedError', status: 302 });
    expect(redirecting.seen).toHaveLength(1);
    // The second listener heard nothing at all.
    expect(elsewhere.seen).toEqual([]);
  });
});

describe('cancellation and time', () => {
  it('stops when the caller cancels, before, between, and during attempts', async () => {
    const dir = writeRunDirectory(freshDir('abort'));
    const server = await service((_request, response) => problem(response, 503, 'NOT_READY'));

    const already = new AbortController();
    already.abort();
    const { client } = clientFor(server);
    await expect(
      client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES, signal: already.signal }),
    ).rejects.toBeInstanceOf(UploadAborted);
    expect(server.seen).toEqual([]);

    // Cancelled while it waits to try again.
    const during = new AbortController();
    const waiting = clientFor(server, {
      sleep: async (_ms, signal) => {
        during.abort();
        if (signal?.aborted === true) throw new UploadAborted();
      },
    });
    await expect(
      waiting.client.uploadRunDirectory({
        runDirectory: dir,
        expiresAt: EXPIRES,
        signal: during.signal,
      }),
    ).rejects.toBeInstanceOf(UploadAborted);
    expect(server.seen).toHaveLength(1);
  });

  it('gives every attempt a finite time, and tries again when one runs out', async () => {
    const dir = writeRunDirectory(freshDir('timeout'));
    const server = await service((_request, response, index) => {
      // The first attempt is never answered; the second is.
      if (index === 0) return;
      archived(response);
    });
    const { client } = clientFor(server, { attemptTimeoutMs: 120 });
    const result = await client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    expect(result.attempts).toBe(2);
  });
});

describe('the key is never written down', () => {
  it('keeps the token out of every error, description, and serialisation', async () => {
    const dir = writeRunDirectory(freshDir('redaction'));
    const messages: string[] = [];
    const collect = async (run: Promise<unknown>): Promise<void> => {
      const e = (await run.catch((x: unknown) => x)) as Error;
      messages.push(e.message, e.stack ?? '', JSON.stringify(e, Object.getOwnPropertyNames(e)));
    };

    // A service that refuses, one that fails, and one that is not there at all.
    const refusing = await service((_request, response) =>
      problem(response, 401, 'AUTHENTICATION_REQUIRED'),
    );
    const failing = await service((_request, response) => problem(response, 500, 'INTERNAL_ERROR'));
    const gone = await service(() => undefined);
    gone.close();
    const client = clientFor(refusing).client;
    await collect(client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES }));
    await collect(
      clientFor(failing, { retry: { maxAttempts: 2 } }).client.uploadRunDirectory({
        runDirectory: dir,
        expiresAt: EXPIRES,
      }),
    );
    await collect(
      clientFor(gone, { retry: { maxAttempts: 2 } }).client.uploadRunDirectory({
        runDirectory: dir,
        expiresAt: EXPIRES,
      }),
    );
    await collect(
      clientFor(refusing).client.uploadRunDirectory({
        runDirectory: join(dir, 'nowhere'),
        expiresAt: EXPIRES,
      }),
    );
    messages.push(
      JSON.stringify(client),
      String(client),
      client.endpoint,
      JSON.stringify({ client }),
    );
    for (const message of messages) {
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain('qer_k1_');
      expect(message.toLowerCase()).not.toContain('authorization');
    }
  });
});

describe('retention', () => {
  it('is decided by the caller, stated once, in the form the service takes', async () => {
    const dir = writeRunDirectory(freshDir('retention'));
    const server = await service((_request, response) => archived(response));
    const { client } = clientFor(server);
    await client.uploadRunDirectory({
      runDirectory: dir,
      expiresAt: new Date('2027-06-01T12:30:45.123Z'),
    });
    const sent = server.seen[0] as SeenRequest;
    const parts = partsOf(sent.body, String(sent.headers['content-type']));
    expect(parts[0]?.value.toString()).toBe('2027-06-01T12:30:45.123Z');
    expect(parts[0]?.value.toString()).toMatch(
      /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u,
    );
    for (const bad of [
      new Date('nonsense'),
      '2027-01-01' as unknown as Date,
      undefined as unknown as Date,
    ]) {
      await expect(
        client.uploadRunDirectory({ runDirectory: dir, expiresAt: bad }),
      ).rejects.toThrow(TypeError);
    }
    // A relative retention becomes one absolute instant, computed by the caller before uploading.
    expect(expiryAfter(60_000, new Date('2027-01-01T00:00:00.000Z')).toISOString()).toBe(
      '2027-01-01T00:01:00.000Z',
    );
    for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => expiryAfter(bad)).toThrow(TypeError);
    }
  });
});

/** The run directory is the producer's; an upload reads it and leaves it alone. */
describe('the producer keeps its output', () => {
  it('changes nothing in the run directory', async () => {
    const dir = writeRunDirectory(freshDir('untouched'), {
      events: { 'a.ndjson': '{"a":1}\n' },
      attachments: [Buffer.from('bytes')],
    });
    const before = {
      event: readFileSync(join(dir, 'events', 'a.ndjson')),
      attachment: readFileSync(join(dir, 'attachments', sha256(Buffer.from('bytes')))),
    };
    const server = await service((_request, response) => archived(response));
    await clientFor(server).client.uploadRunDirectory({ runDirectory: dir, expiresAt: EXPIRES });
    expect(readFileSync(join(dir, 'events', 'a.ndjson'))).toEqual(before.event);
    expect(readFileSync(join(dir, 'attachments', sha256(Buffer.from('bytes'))))).toEqual(
      before.attachment,
    );
  });
});
