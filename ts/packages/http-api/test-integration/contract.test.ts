import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../../protocol/test/helpers.js';
import {
  attemptFinished,
  attemptStarted,
  finished,
  freshRoot,
  started,
  testCase,
  writeRun,
} from '../../read-model/test/synthetic.js';
import { runAdmin } from '../src/admin.js';
import { encodeRunRef } from '../src/run-ref.js';
import {
  HttpHarness,
  archiveState,
  call,
  partsOf,
  stagingEntries,
  upload,
  uploadRun,
  type Answer,
  type Service,
} from './harness.js';

const harness = new HttpHarness();
beforeAll(() => harness.start());
afterAll(() => harness.stop());

const fixture = (name: string): string => join(FIXTURES_DIR, name);

/** The committed contract: what the API says it does. */
const contract = JSON.parse(
  readFileSync(new URL('../../../../openapi/qe-report-api-v1.json', import.meta.url), 'utf8'),
) as {
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<string, { headers?: Record<string, { schema?: { enum?: string[] } }> }>;
      }
    >
  >;
};

/**
 * Holds one real answer against the contract: the status must be an answer the document
 * declares for that operation, and every header the document declares with a fixed value must
 * be exactly that value. A status the API produces and the document omits fails here.
 */
function declares(method: string, path: string, answer: Answer): void {
  const operation = contract.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is in the contract`).toBeDefined();
  const responses = operation?.responses ?? {};
  const declared = responses[String(answer.status)];
  expect(
    declared,
    `${method} ${path} declares ${answer.status} (it declares ${Object.keys(responses).join(', ')})`,
  ).toBeDefined();
  for (const [header, spec] of Object.entries(declared?.headers ?? {})) {
    const value = answer.headers.get(header);
    expect(value, `${method} ${path} ${answer.status} sends ${header}`).not.toBeNull();
    const fixed = spec.schema?.enum;
    if (fixed !== undefined) expect(fixed, `${header}`).toContain(value);
  }
  // Every answer, whatever its status, carries these two.
  expect(answer.headers.get('x-request-id')).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(answer.headers.get('cache-control')).toBe('no-store');
}

describe('the contract describes what the API does', () => {
  it('answers every declared status with the headers it declares, and declares every status it answers', async () => {
    const service = await harness.service('contract');
    const token = await service.key('P');
    const writeOnly = await service.key('P', ['runs:write']);
    const dir = fixture('runs/flaky-session-passed');
    expect((await uploadRun(service.base, token, dir)).status).toBe(201);
    const ref = encodeRunRef('run-so-0008');
    const key = { runnerName: 'fixture-runner', historicalId: 'h-so-0008' };

    const checks: [string, string, () => Promise<Answer>][] = [
      ['GET', '/healthz', () => call(service.base, undefined, 'GET', '/healthz')],
      ['GET', '/readyz', () => call(service.base, undefined, 'GET', '/readyz')],
      // Authentication, authorisation, and the challenge that comes with a 401.
      ['GET', '/v1/runs', () => call(service.base, undefined, 'GET', '/v1/runs')],
      ['GET', '/v1/runs', () => call(service.base, 'qer_k1_nope', 'GET', '/v1/runs')],
      ['GET', '/v1/runs', () => call(service.base, writeOnly, 'GET', '/v1/runs')],
      ['GET', '/v1/runs', () => call(service.base, token, 'GET', '/v1/runs')],
      ['GET', '/v1/runs', () => call(service.base, token, 'GET', '/v1/runs?cursor=zz')],
      // A runRef the schema admits but the decoder refuses, and one that names nothing.
      ['GET', '/v1/runs/{runRef}', () => call(service.base, token, 'GET', `/v1/runs/${ref}`)],
      ['GET', '/v1/runs/{runRef}', () => call(service.base, token, 'GET', '/v1/runs/YWJ')],
      [
        'GET',
        '/v1/runs/{runRef}',
        () => call(service.base, token, 'GET', `/v1/runs/${encodeRunRef('run-nobody')}`),
      ],
      ['GET', '/v1/runs/{runRef}', () => call(service.base, undefined, 'GET', '/v1/runs/YWJ')],
      // The attachment route: a malformed hash, a runRef that is not canonical, a hash nothing
      // in this project references.
      [
        'GET',
        '/v1/runs/{runRef}/attachments/{sha256}',
        () => call(service.base, token, 'GET', `/v1/runs/${ref}/attachments/XYZ`),
      ],
      [
        'GET',
        '/v1/runs/{runRef}/attachments/{sha256}',
        () => call(service.base, token, 'GET', `/v1/runs/YWJ/attachments/${'0'.repeat(64)}`),
      ],
      [
        'GET',
        '/v1/runs/{runRef}/attachments/{sha256}',
        () => call(service.base, token, 'GET', `/v1/runs/${ref}/attachments/${'0'.repeat(64)}`),
      ],
      // The query bodies: an answer, a refusal, and a body too large.
      [
        'POST',
        '/v1/history/query',
        () => call(service.base, token, 'POST', '/v1/history/query', key),
      ],
      [
        'POST',
        '/v1/history/query',
        () => call(service.base, token, 'POST', '/v1/history/query', { ...key, cursor: 'zz' }),
      ],
      [
        'POST',
        '/v1/flakiness/query',
        () => call(service.base, token, 'POST', '/v1/flakiness/query', key),
      ],
      [
        'POST',
        '/v1/flakiness/query',
        () =>
          call(service.base, token, 'POST', '/v1/flakiness/query', {
            ...key,
            pad: 'x'.repeat(70_000),
          }),
      ],
      // The upload: already archived, a refusal, and a body that is not multipart.
      ['POST', '/v1/runs', () => uploadRun(service.base, token, dir)],
      ['POST', '/v1/runs', () => upload(service.base, token, partsOf(dir).slice(1))],
      [
        'POST',
        '/v1/runs',
        async () => {
          const response = await fetch(`${service.base}/v1/runs`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: '{}',
          });
          return {
            status: response.status,
            headers: response.headers,
            body: (await response.json()) as Record<string, unknown>,
          };
        },
      ],
    ];
    const seen = new Set<string>();
    for (const [method, template, ask] of checks) {
      const answer = await ask();
      declares(method, template, answer);
      seen.add(`${method} ${template} ${answer.status}`);
    }
    // The statuses this test actually drove, so a later reader can see what was covered.
    expect([...seen].sort()).toEqual([
      'GET /healthz 200',
      'GET /readyz 200',
      'GET /v1/runs 200',
      'GET /v1/runs 400',
      'GET /v1/runs 401',
      'GET /v1/runs 403',
      'GET /v1/runs/{runRef} 200',
      'GET /v1/runs/{runRef} 400',
      'GET /v1/runs/{runRef} 401',
      'GET /v1/runs/{runRef} 404',
      'GET /v1/runs/{runRef}/attachments/{sha256} 400',
      'GET /v1/runs/{runRef}/attachments/{sha256} 404',
      'POST /v1/flakiness/query 200',
      'POST /v1/flakiness/query 413',
      'POST /v1/history/query 200',
      'POST /v1/history/query 400',
      'POST /v1/runs 200',
      'POST /v1/runs 400',
      'POST /v1/runs 415',
    ]);
  });

  it('challenges with Bearer on every unauthenticated route', async () => {
    const service = await harness.service('challenge');
    const routes: [string, string, string, unknown][] = [
      ['GET', '/v1/runs', '/v1/runs', undefined],
      ['GET', '/v1/runs/{runRef}', `/v1/runs/${encodeRunRef('run-1')}`, undefined],
      [
        'GET',
        '/v1/runs/{runRef}/attachments/{sha256}',
        `/v1/runs/${encodeRunRef('run-1')}/attachments/${'0'.repeat(64)}`,
        undefined,
      ],
      ['POST', '/v1/history/query', '/v1/history/query', { runnerName: 'r', historicalId: 'h' }],
      [
        'POST',
        '/v1/flakiness/query',
        '/v1/flakiness/query',
        { runnerName: 'r', historicalId: 'h' },
      ],
      ['POST', '/v1/runs', '/v1/runs', undefined],
    ];
    for (const [method, template, path, body] of routes) {
      const answer = await call(service.base, undefined, method as 'GET' | 'POST', path, body);
      expect(answer.status, path).toBe(401);
      expect(answer.headers.get('www-authenticate'), path).toBe('Bearer realm="qe-report"');
      declares(method, template, answer);
    }
    // The operational routes are not authenticated and carry no challenge.
    for (const path of ['/healthz', '/readyz']) {
      const answer = await call(service.base, undefined, 'GET', path);
      expect(answer.status).toBe(200);
      expect(answer.headers.get('www-authenticate')).toBeNull();
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('lifecycle timestamps', () => {
  it('stores an expiry exactly as stated, and refuses one it could only move', async () => {
    const service = await harness.service('expiry');
    const token = await service.key('P');
    const root = freshRoot('expiry');
    const runOf = (name: string): string =>
      writeRun(root, name, `run-${name}`, [
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

    const accepted: [string, string][] = [
      ['2027-01-01T00:00:00Z', '2027-01-01T00:00:00.000Z'],
      ['2027-01-01T00:00:00.1Z', '2027-01-01T00:00:00.100Z'],
      ['2027-01-01T00:00:00.12Z', '2027-01-01T00:00:00.120Z'],
      ['2027-01-01T00:00:00.123Z', '2027-01-01T00:00:00.123Z'],
      ['2027-01-01T01:00:00+01:00', '2027-01-01T00:00:00.000Z'],
      ['2016-12-31T23:59:59.999Z', '2016-12-31T23:59:59.999Z'],
    ];
    for (const [i, [stated, instant]] of accepted.entries()) {
      const answer = await upload(service.base, token, [
        { name: 'expiresAt', text: stated },
        ...partsOf(runOf(`ok${i}`)).slice(1),
      ]);
      expect(answer.status, stated).toBe(201);
      // What the database holds is the instant the caller asked for, to its last millisecond.
      const stored = await service.db.store.loadRun('P', `run-ok${i}`);
      expect(stored?.expiresAt?.toISOString(), stated).toBe(instant);
      const listed = await call(service.base, token, 'GET', '/v1/runs?limit=1');
      expect((listed.body.runs as Record<string, string>[])[0]?.expiresAt, stated).toBe(instant);
      const row = await service.db.pool.query<{ at: string }>(
        `SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS at
           FROM qe_run_retention WHERE run_id = $1`,
        [`run-ok${i}`],
      );
      expect(row.rows[0]?.at, stated).toBe(`${instant.slice(0, -1)}000`);
    }

    const before = await archiveState(service.db);
    const refused = [
      // A protocol leap second: reading it as an instant would move the deadline earlier.
      '2016-12-31T23:59:60Z',
      '2016-12-31T23:59:60.500Z',
      '2017-01-01T00:59:60+01:00',
      // Finer than a millisecond: the rest would be dropped in silence.
      '2027-01-01T00:00:00.1234Z',
      '2027-01-01T00:00:00.123456789Z',
      // No offset, no calendar, no clock.
      '2027-01-01T00:00:00',
      '2027-02-30T00:00:00Z',
      '2027-01-01T00:00:00+24:00',
      '2027-01-01',
      '',
    ];
    for (const [i, stated] of refused.entries()) {
      const answer = await upload(service.base, token, [
        { name: 'expiresAt', text: stated },
        ...partsOf(runOf(`no${i}`)).slice(1),
      ]);
      expect(answer.status, stated).toBe(400);
      expect(answer.body, stated).toMatchObject({ code: 'BAD_REQUEST' });
      expect(String(answer.body.detail), stated).toMatch(/millisecond precision/u);
      declares('POST', '/v1/runs', answer);
    }
    expect(await archiveState(service.db)).toEqual(before);
    expect(stagingEntries(service.stagingRoot)).toEqual([]);
  });

  it('holds a key expiry to the same contract, in the operator command', async () => {
    const service: Service = await harness.service('expiry_cli');
    const out: string[] = [];
    const err: string[] = [];
    const streams = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    const create = (expiresAt: string): Promise<number> =>
      runAdmin(
        ['key', 'create', '--project', 'P', '--scope', 'runs:read', '--expires-at', expiresAt],
        service.db.pool,
        streams,
      );

    for (const stated of [
      '2016-12-31T23:59:60Z',
      '2017-01-01T00:59:60+01:00',
      '2027-01-01T00:00:00.1234Z',
      '2027-01-01T00:00:00',
      '2027-02-30T00:00:00Z',
      '2027-01-01T00:00:00+24:00',
      '2027-01-01',
    ]) {
      expect(await create(stated), stated).toBe(2);
      expect(err.join('')).toContain('--expires-at must be');
    }
    expect(out).toEqual([]);
    expect(await service.db.pool.query('SELECT 1 FROM qe_project_api_keys')).toMatchObject({
      rowCount: 0,
    });

    for (const [stated, instant] of [
      ['2027-01-01T00:00:00Z', '2027-01-01T00:00:00.000Z'],
      ['2027-01-01T00:00:00.123Z', '2027-01-01T00:00:00.123Z'],
      ['2027-01-01T01:00:00.5+01:00', '2027-01-01T00:00:00.500Z'],
    ] as [string, string][]) {
      expect(await create(stated), stated).toBe(0);
      const token = (out.pop() as string).trim();
      const publicId = token.split('_')[2] as string;
      const row = await service.db.pool.query<{ expires_at: Date }>(
        'SELECT expires_at FROM qe_project_api_keys WHERE public_id = $1',
        [publicId],
      );
      expect(row.rows[0]?.expires_at.toISOString(), stated).toBe(instant);
      // And the key it issued works until then.
      expect((await service.keys.authenticate(token))?.projectId).toBe('P');
    }
  });
});
