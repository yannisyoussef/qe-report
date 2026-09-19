import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ApiKeyPrincipal } from 'qe-report-postgres';
import {
  DEFAULT_TRANSPORT_LIMITS,
  createQeReportApi,
  decodeRunRef,
  encodeRunRef,
  resolveLimits,
  type QeReportApiOptions,
} from '../src/index.js';
import {
  decodeHistoryCursor,
  decodeRunsCursor,
  encodeHistoryCursor,
  encodeRunsCursor,
} from '../src/cursors.js';
import { checkRoots } from '../src/staging.js';
import { Problem } from '../src/problems.js';

const roots: string[] = [];
function freshDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `qe-http-unit-${name}-`));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('runRef', () => {
  it('round-trips run ids that are awkward in a URL, and nothing else', () => {
    for (const runId of [
      'run-1',
      'a/b',
      'q?x=1',
      'frag#1',
      '100%',
      'a+b',
      'ns:run',
      '~!*()',
      'x'.repeat(128),
    ]) {
      const ref = encodeRunRef(runId);
      expect(ref).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(decodeRunRef(ref), runId).toBe(runId);
    }
    expect(encodeRunRef('a/b')).toBe('YS9i');
  });

  it('refuses padding, other alphabets, stray bits, and ids the protocol refuses', () => {
    const good = encodeRunRef('run-1');
    for (const bad of [
      '',
      `${good}=`,
      'YS9i=',
      'YS+i',
      'YS/i',
      'Y',
      // "ab" is YWI; YWJ decodes to the same bytes with stray bits set.
      'YWJ',
      encodeRunRef('has space'),
      encodeRunRef('café'),
      encodeRunRef('x'.repeat(129)),
      Buffer.from([0xff, 0xfe]).toString('base64url'),
      '%2F',
    ]) {
      expect(decodeRunRef(bad), bad).toBeUndefined();
    }
    expect(decodeRunRef('YWI')).toBe('ab');
  });
});

describe('cursors', () => {
  it('continue exactly where they were issued and nowhere else', () => {
    const runs = encodeRunsCursor('A', 42n);
    expect(decodeRunsCursor('A', runs)).toBe(42n);
    expect(() => decodeRunsCursor('B', runs)).toThrow(Problem);
    const after = {
      occurredAt: new Date('2026-12-31T23:59:59.999Z'),
      leap: 501,
      runId: 'run/1',
      executionId: 'e#1',
    };
    const history = encodeHistoryCursor('A', 'pw', 'h', after);
    expect(decodeHistoryCursor('A', 'pw', 'h', history)).toEqual(after);
    // Another project, another history, the other listing, or the wrong kind: all refused.
    expect(() => decodeHistoryCursor('B', 'pw', 'h', history)).toThrow(Problem);
    expect(() => decodeHistoryCursor('A', 'pw', 'other', history)).toThrow(Problem);
    expect(() => decodeHistoryCursor('A', 'other', 'h', history)).toThrow(Problem);
    expect(() => decodeRunsCursor('A', history)).toThrow(Problem);
    expect(() => decodeHistoryCursor('A', 'pw', 'h', runs)).toThrow(Problem);
    // The history key is not ambiguous at a separator.
    const split = encodeHistoryCursor('A', 'p', 'wh', after);
    expect(() => decodeHistoryCursor('A', 'pw', 'h', split)).toThrow(Problem);
  });

  it('refuse anything that is not exactly a cursor this server wrote', () => {
    const doc = (d: unknown): string => Buffer.from(JSON.stringify(d)).toString('base64url');
    const good = JSON.parse(
      Buffer.from(encodeRunsCursor('A', 7n), 'base64url').toString(),
    ) as Record<string, unknown>;
    for (const bad of [
      '',
      '!!!',
      'e30',
      `${encodeRunsCursor('A', 7n)}=`,
      doc({ ...good, v: 2 }),
      doc({ ...good, s: '-1' }),
      doc({ ...good, s: '07' }),
      doc({ ...good, s: '9223372036854775808' }),
      doc({ ...good, s: 7 }),
      doc({ ...good, extra: 1 }),
      doc([good]),
      'x'.repeat(4000),
    ]) {
      expect(() => decodeRunsCursor('A', bad), bad.slice(0, 40)).toThrow(Problem);
    }
    const history = JSON.parse(
      Buffer.from(
        encodeHistoryCursor('A', 'pw', 'h', {
          occurredAt: new Date(0),
          leap: 0,
          runId: 'r',
          executionId: 'e',
        }),
        'base64url',
      ).toString(),
    ) as Record<string, unknown>;
    for (const bad of [
      { ...history, l: 1001 },
      { ...history, l: 0.5 },
      { ...history, t: '1970-01-01T00:00:00Z' },
      { ...history, t: 'not a time' },
      { ...history, r: '' },
      { ...history, e: 'has space' },
    ]) {
      expect(() => decodeHistoryCursor('A', 'pw', 'h', doc(bad))).toThrow(Problem);
    }
  });
});

describe('limits and roots', () => {
  it('keeps every limit finite and the attachment limit within the blob store', () => {
    expect(resolveLimits()).toEqual(DEFAULT_TRANSPORT_LIMITS);
    expect(DEFAULT_TRANSPORT_LIMITS.maxAttachmentBytes).toBe(64 * 1024 * 1024);
    expect(() => resolveLimits({ maxEventParts: 0 })).toThrow(TypeError);
    expect(() => resolveLimits({ maxRequestBytes: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => resolveLimits({ maxAttachmentBytes: 65 * 1024 * 1024 })).toThrow(/blob store/u);
    expect(() => resolveLimits({ maxAttachmentBytes: 10 }, 5)).toThrow(/blob store/u);
  });

  it('refuses a staging root that is a link, missing, or shares ground with the blob root', () => {
    const base = freshDir('roots');
    const staging = join(base, 'staging');
    const blobs = join(base, 'blobs');
    mkdirSync(staging);
    mkdirSync(blobs);
    expect(checkRoots(staging, blobs)).toBe(staging.replace(/^\/var\//u, '/private/var/'));
    symlinkSync(staging, join(base, 'link'));
    expect(() => checkRoots(join(base, 'link'), blobs)).toThrow(/symbolic link/u);
    expect(() => checkRoots(join(base, 'missing'), blobs)).toThrow(/cannot be read/u);
    expect(() => checkRoots(blobs, blobs)).toThrow(/separate/u);
    mkdirSync(join(blobs, 'inner'));
    expect(() => checkRoots(join(blobs, 'inner'), blobs)).toThrow(/separate/u);
    expect(() => checkRoots(base, blobs)).toThrow(/separate/u);
  });
});

/** An API over fakes: nothing here reaches a database or a store. */
async function fakeApi(
  overrides: Partial<QeReportApiOptions> = {},
): Promise<Awaited<ReturnType<typeof createQeReportApi>>> {
  const base = freshDir('app');
  mkdirSync(join(base, 'staging'));
  mkdirSync(join(base, 'blobs'));
  const principals: Record<string, ApiKeyPrincipal> = {
    qer_k1_readerreaderread_x: {
      publicId: 'readerreaderread',
      projectId: 'P',
      scopes: ['runs:read'],
    },
    qer_k1_writerwriterwrit_x: {
      publicId: 'writerwriterwrit',
      projectId: 'P',
      scopes: ['runs:write'],
    },
  };
  const nothing = async (): Promise<never> => {
    throw new Error('not reachable in this test');
  };
  return createQeReportApi({
    runStore: { persistRunDirectory: nothing, openBlob: nothing },
    queries: {
      getRun: async () => undefined,
      listRuns: async () => ({ runs: [], next: undefined }),
      getTestHistoryPage: nothing,
      getFlakinessSummary: async (key) => ({
        ...key,
        totalOccurrences: 0,
        flakyOccurrences: 0,
        everFlaky: false,
      }),
    },
    apiKeys: { authenticate: async (token) => principals[token] },
    stagingRoot: join(base, 'staging'),
    blobRoot: join(base, 'blobs'),
    checkDatabase: async () => [],
    ...overrides,
  });
}

const READ = { authorization: 'Bearer qer_k1_readerreaderread_x' };
const WRITE = { authorization: 'Bearer qer_k1_writerwriterwrit_x' };

describe('the HTTP surface without a database', () => {
  it('answers health, and readiness from its dependencies', async () => {
    const app = await fakeApi();
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    const unready = await fakeApi({ checkDatabase: async () => ['migration 5 is not applied'] });
    const answer = await unready.inject({ method: 'GET', url: '/readyz' });
    expect(answer.statusCode).toBe(503);
    expect(answer.json()).toMatchObject({
      code: 'NOT_READY',
      problems: ['migration 5 is not applied'],
    });
    const unreachable = await fakeApi({
      checkDatabase: async () => {
        throw new Error('connect ECONNREFUSED postgres://user:secret@db');
      },
    });
    const refused = await unreachable.inject({ method: 'GET', url: '/readyz' });
    expect(refused.statusCode).toBe(503);
    expect(refused.body).not.toContain('secret');
    expect(refused.json()).toMatchObject({ problems: ['the database is not reachable'] });
  });

  it('asks for a bearer key the same way whatever is wrong with it, and never reads one elsewhere', async () => {
    const app = await fakeApi();
    for (const headers of [
      {},
      { authorization: '' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer ' },
      { authorization: 'Basic qer_k1_readerreaderread_x' },
      { authorization: 'Bearer qer_k1_unknown' },
      { authorization: 'Bearer  qer_k1_readerreaderread_x' },
      { authorization: 'Bearer qer_k1_readerreaderread_x extra' },
      { cookie: 'token=qer_k1_readerreaderread_x' },
    ]) {
      const answer = await app.inject({ method: 'GET', url: '/v1/runs', headers });
      expect(answer.statusCode, JSON.stringify(headers)).toBe(401);
      expect(answer.headers['www-authenticate']).toBe('Bearer realm="qe-report"');
      expect(answer.headers['content-type']).toBe('application/problem+json; charset=utf-8');
      expect(answer.json()).toMatchObject({
        type: 'urn:qe-report:problem:authentication-required',
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
        detail: 'a valid API key is required',
      });
    }
    for (const url of [
      '/v1/runs?access_token=qer_k1_readerreaderread_x',
      '/v1/runs?token=qer_k1_readerreaderread_x',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
    // The scheme is case-insensitive, as HTTP says.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/runs',
          headers: { authorization: 'bearer qer_k1_readerreaderread_x' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('keeps a key to its scope', async () => {
    const app = await fakeApi();
    const denied = await app.inject({ method: 'GET', url: '/v1/runs', headers: WRITE });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'FORBIDDEN' });
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { ...READ, 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x--\r\n',
    });
    expect(upload.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/flakiness/query',
          headers: WRITE,
          payload: { runnerName: 'pw', historicalId: 'h' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('gives every response its own request id and no cache, and ignores a caller-supplied id', async () => {
    const app = await fakeApi();
    const ids = new Set<string>();
    for (const url of ['/healthz', '/v1/runs', '/nowhere']) {
      const answer = await app.inject({
        method: 'GET',
        url,
        headers: { ...READ, 'x-request-id': 'caller-chosen' },
      });
      const id = answer.headers['x-request-id'] as string;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      expect(answer.headers['cache-control']).toBe('no-store');
      ids.add(id);
    }
    expect(ids.size).toBe(3);
    const missing = await app.inject({ method: 'GET', url: '/nowhere' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      code: 'NOT_FOUND',
      requestId: missing.headers['x-request-id'],
    });
  });

  it('validates query bodies strictly: no project, no extra member, JSON only, bounded', async () => {
    const app = await fakeApi();
    const post = async (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/v1/flakiness/query',
        headers: { ...READ, ...headers },
        payload: payload as string,
      });
    expect((await post({ runnerName: 'pw', historicalId: 'h' })).json()).toEqual({
      runnerName: 'pw',
      historicalId: 'h',
      totalOccurrences: 0,
      flakyOccurrences: 0,
      everFlaky: false,
    });
    for (const bad of [
      { runnerName: 'pw', historicalId: 'h', projectId: 'other' },
      { runnerName: 'pw' },
      { runnerName: '', historicalId: 'h' },
      { runnerName: 'pw', historicalId: 'x'.repeat(513) },
      { runnerName: 7, historicalId: 'h' },
    ]) {
      const answer = await post(bad);
      expect(answer.statusCode, JSON.stringify(bad)).toBe(400);
      expect(answer.json()).toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect((await post('{not json', { 'content-type': 'application/json' })).statusCode).toBe(400);
    const text = await post('runnerName=pw', {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(text.statusCode).toBe(415);
    expect(text.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    const huge = await post({ runnerName: 'pw', historicalId: 'h', pad: 'x'.repeat(70_000) });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('refuses a run reference that is not canonical, and answers an absent run with 404', async () => {
    const app = await fakeApi();
    for (const ref of ['YWJ', 'YS9i%3D', '%2Fetc', encodeRunRef('has space')]) {
      const answer = await app.inject({ method: 'GET', url: `/v1/runs/${ref}`, headers: READ });
      expect(answer.statusCode, ref).toBe(400);
    }
    const absent = await app.inject({
      method: 'GET',
      url: `/v1/runs/${encodeRunRef('x'.repeat(128))}`,
      headers: READ,
    });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toMatchObject({ code: 'NOT_FOUND' });
    const listing = await app.inject({
      method: 'GET',
      url: '/v1/runs?cursor=bogus',
      headers: READ,
    });
    expect(listing.statusCode).toBe(400);
    for (const limit of ['0', '1001', 'x', '1.5']) {
      expect(
        (await app.inject({ method: 'GET', url: `/v1/runs?limit=${limit}`, headers: READ }))
          .statusCode,
        limit,
      ).toBe(400);
    }
  });

  it('refuses an upload that is not multipart before reading it', async () => {
    const app = await fakeApi();
    const answer = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { ...WRITE, 'content-type': 'application/json' },
      payload: { events: [] },
    });
    expect(answer.statusCode).toBe(415);
    expect(answer.headers.connection).toBe('close');
  });
});
