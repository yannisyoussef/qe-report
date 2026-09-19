import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
} from '../../read-model/test/synthetic.js';
import { waitFor } from '../../postgres/test-integration/support.js';
import { runAdmin } from '../src/admin.js';
import { encodeRunRef } from '../src/run-ref.js';
import {
  HttpHarness,
  call,
  stagingEntries,
  upload,
  uploadRun,
  wholeHistory,
  wholeListing,
  partsOf,
  type Service,
} from './harness.js';

const harness = new HttpHarness();
beforeAll(() => harness.start());
afterAll(() => harness.stop());

const fixture = (name: string): string => join(FIXTURES_DIR, name);

/** The same run id in each project, with one attachment of the project's own bytes. */
function projectRun(root: string, name: string, bytes: Buffer, flaky: boolean): string {
  const failedFirst = flaky
    ? [attemptStarted('a-1', 1, testCase('e', 'shared')), attemptFinished('a-1', 'failed')]
    : [];
  return writeRun(
    root,
    name,
    'run-same-id',
    [
      {
        sessionId: 's',
        events: [
          started('pw'),
          ...failedFirst,
          attemptStarted('a-2', flaky ? 2 : 1, testCase('e', 'shared')),
          attachment('a-2', bytes),
          attemptFinished('a-2', 'passed'),
          finished(),
        ],
      },
    ],
    [bytes],
  );
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('project isolation', () => {
  it('keeps two projects apart with nothing but their keys, and makes the other project look empty', async () => {
    const service = await harness.service('isolation');
    const keyA = await service.key('A');
    const keyB = await service.key('B');
    const root = freshRoot('isolation');
    const bytesA = Buffer.from('bytes of project A');
    const bytesB = Buffer.from('bytes of project B');
    const runA = projectRun(root, 'a', bytesA, true);
    const runB = projectRun(root, 'b', bytesB, false);
    // The same raw run id is archived independently in each project.
    expect((await uploadRun(service.base, keyA, runA)).status).toBe(201);
    expect((await uploadRun(service.base, keyB, runB)).status).toBe(201);
    const ref = encodeRunRef('run-same-id');

    const listedA = await wholeListing(service.base, keyA);
    const listedB = await wholeListing(service.base, keyB);
    expect(listedA.map((r) => r.runId)).toEqual(['run-same-id']);
    expect(listedB.map((r) => r.runId)).toEqual(['run-same-id']);
    expect(listedA[0]?.ingestionSequence).not.toBe(listedB[0]?.ingestionSequence);

    const readA = await call(service.base, keyA, 'GET', `/v1/runs/${ref}`);
    const readB = await call(service.base, keyB, 'GET', `/v1/runs/${ref}`);
    expect((readA.body.attachments as { sha256: string }[])[0]?.sha256).toBe(sha(bytesA));
    expect((readB.body.attachments as { sha256: string }[])[0]?.sha256).toBe(sha(bytesB));

    // A knows B's hash, but no run of A references it: the same answer as a hash nobody has.
    const cross = await call(
      service.base,
      keyA,
      'GET',
      `/v1/runs/${ref}/attachments/${sha(bytesB)}`,
    );
    const nobody = await call(
      service.base,
      keyA,
      'GET',
      `/v1/runs/${ref}/attachments/${'1'.repeat(64)}`,
    );
    expect(cross.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect({ ...cross.body, requestId: '' }).toEqual({ ...nobody.body, requestId: '' });
    const own = await fetch(`${service.base}/v1/runs/${ref}/attachments/${sha(bytesA)}`, {
      headers: { authorization: `Bearer ${keyA}` },
    });
    expect(Buffer.from(await own.arrayBuffer())).toEqual(bytesA);

    // A run only B has is, for A, exactly as absent as a run nobody has.
    const rootC = freshRoot('isolation-only-b');
    const onlyB = writeRun(rootC, 'c', 'run-only-b', [
      {
        sessionId: 's',
        events: [
          started('pw'),
          attemptStarted('x', 1, testCase('x', 'x')),
          attemptFinished('x', 'passed'),
          finished(),
        ],
      },
    ]);
    expect((await uploadRun(service.base, keyB, onlyB)).status).toBe(201);
    const hidden = await call(service.base, keyA, 'GET', `/v1/runs/${encodeRunRef('run-only-b')}`);
    const absent = await call(service.base, keyA, 'GET', `/v1/runs/${encodeRunRef('run-nobody')}`);
    expect(hidden.status).toBe(404);
    expect({ ...hidden.body, requestId: '' }).toEqual({ ...absent.body, requestId: '' });
    const hiddenBytes = await call(
      service.base,
      keyA,
      'GET',
      `/v1/runs/${encodeRunRef('run-only-b')}/attachments/${sha(bytesB)}`,
    );
    expect(hiddenBytes.status).toBe(404);

    // History and flakiness never cross projects.
    const historyA = await wholeHistory(service.base, keyA, 'pw', 'shared');
    const historyB = await wholeHistory(service.base, keyB, 'pw', 'shared');
    expect(historyA.map((o) => o.flaky)).toEqual([true]);
    expect(historyB.map((o) => o.flaky)).toEqual([false]);
    const flakyA = await call(service.base, keyA, 'POST', '/v1/flakiness/query', {
      runnerName: 'pw',
      historicalId: 'shared',
    });
    const flakyB = await call(service.base, keyB, 'POST', '/v1/flakiness/query', {
      runnerName: 'pw',
      historicalId: 'shared',
    });
    expect(flakyA.body).toMatchObject({
      totalOccurrences: 1,
      flakyOccurrences: 1,
      everFlaky: true,
    });
    expect(flakyB.body).toMatchObject({
      totalOccurrences: 1,
      flakyOccurrences: 0,
      everFlaky: false,
    });

    // Nothing a request carries overrides the key's project.
    const override = await call(service.base, keyA, 'POST', '/v1/flakiness/query', {
      runnerName: 'pw',
      historicalId: 'shared',
      projectId: 'B',
    });
    expect(override.status).toBe(400);
    for (const path of ['/v1/runs?projectId=B', '/v1/runs?project=B']) {
      const listing = await call(service.base, keyA, 'GET', path);
      expect(listing.status === 400 || (listing.body.runs as unknown[]).length === 1, path).toBe(
        true,
      );
    }
    const headerOverride = await fetch(`${service.base}/v1/runs`, {
      headers: { authorization: `Bearer ${keyA}`, 'x-project-id': 'B' },
    });
    const body = (await headerOverride.json()) as { runs: { runRef: string }[] };
    expect(body.runs.map((r) => r.runRef)).toEqual([ref]);
    expect((await call(service.base, keyA, 'GET', `/v1/runs/${ref}`)).body.attachments).toEqual(
      readA.body.attachments,
    );
  });
});

describe('API keys over HTTP', () => {
  it('enforces scopes, revocation, expiry, and rotation, and never logs a token', async () => {
    const service = await harness.service('keys');
    const writer = await service.key('P', ['runs:write']);
    const reader = await service.key('P', ['runs:read']);
    const both = await service.key('P', ['runs:read', 'runs:write']);
    const dir = fixture('runs/flaky-session-passed');
    expect((await uploadRun(service.base, reader, dir)).status).toBe(403);
    expect(stagingEntries(service.stagingRoot)).toEqual([]);
    expect((await uploadRun(service.base, writer, dir)).status).toBe(201);
    expect((await call(service.base, writer, 'GET', '/v1/runs')).status).toBe(403);
    const ref = encodeRunRef('run-so-0008');
    expect((await call(service.base, writer, 'GET', `/v1/runs/${ref}`)).status).toBe(403);
    expect(
      (
        await call(service.base, writer, 'POST', '/v1/history/query', {
          runnerName: 'fixture-runner',
          historicalId: 'x',
        })
      ).status,
    ).toBe(403);
    expect((await call(service.base, reader, 'GET', '/v1/runs')).status).toBe(200);
    expect((await call(service.base, both, 'GET', `/v1/runs/${ref}`)).status).toBe(200);
    expect((await uploadRun(service.base, both, dir)).status).toBe(200);

    // Unknown, malformed, wrong, revoked, and expired keys all get the same answer.
    const created = await service.keys.create({ projectId: 'P', scopes: ['runs:read'] });
    const expiring = await service.keys.create({
      projectId: 'P',
      scopes: ['runs:read'],
      expiresAt: new Date(Date.now() + 1500),
    });
    const [, , publicId, secret] = created.token.split('_') as [string, string, string, string];
    expect(await service.keys.revoke(created.publicId)).toBe(true);
    await waitFor(async () => (await service.keys.authenticate(expiring.token)) === undefined);
    const refusals = [];
    for (const token of [
      undefined,
      'qer_k1_',
      `qer_k1_${publicId}_${secret.slice(0, -1)}b`,
      `qer_k1_${'a'.repeat(16)}_${secret}`,
      created.token,
      expiring.token,
      reader.toUpperCase(),
    ]) {
      const answer = await call(service.base, token, 'GET', '/v1/runs');
      expect(answer.status).toBe(401);
      expect(answer.headers.get('www-authenticate')).toBe('Bearer realm="qe-report"');
      refusals.push({ ...answer.body, requestId: '' });
    }
    expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(1);

    // Rotation: issue the new key, revoke the old, and only the new one works.
    const replacement = await service.key('P', ['runs:read']);
    const oldId = reader.split('_')[2] as string;
    expect(await service.keys.revoke(oldId)).toBe(true);
    expect((await call(service.base, reader, 'GET', '/v1/runs')).status).toBe(401);
    expect((await call(service.base, replacement, 'GET', '/v1/runs')).status).toBe(200);

    // The whole trace-level log holds no token, no secret, and no staging path.
    const log = service.logs.join('');
    expect(log.length).toBeGreaterThan(0);
    for (const token of [writer, reader, both, created.token, expiring.token, replacement]) {
      expect(log).not.toContain(token);
      expect(log).not.toContain(token.split('_')[3]);
    }
    expect(log).not.toContain(service.stagingRoot);
    expect(log).toContain('"keyId"');
    expect(log).toContain('"route":"/v1/runs"');
  });

  it('issues and revokes keys only through the operator command, printing the token once', async () => {
    const service = await harness.service('admin');
    const out: string[] = [];
    const err: string[] = [];
    const streams = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    expect(
      await runAdmin(
        [
          'key',
          'create',
          '--project',
          'P',
          '--scope',
          'runs:read',
          '--scope',
          'runs:write',
          '--label',
          'ci',
        ],
        service.db.pool,
        streams,
      ),
    ).toBe(0);
    expect(out).toHaveLength(1);
    const token = (out[0] as string).trim();
    expect(token).toMatch(/^qer_k1_[a-z2-7]{16}_[a-z2-7]{52}$/u);
    expect(err.join('')).not.toContain(token);
    expect(
      (await uploadRun(service.base, token, fixture('runs/flaky-session-passed'))).status,
    ).toBe(201);
    const publicId = token.split('_')[2] as string;
    expect(
      await runAdmin(['key', 'revoke', '--public-id', publicId], service.db.pool, streams),
    ).toBe(0);
    expect((await call(service.base, token, 'GET', '/v1/runs')).status).toBe(401);
    expect(
      await runAdmin(['key', 'revoke', '--public-id', publicId], service.db.pool, streams),
    ).toBe(1);
    for (const argv of [
      [],
      ['key'],
      ['key', 'create', '--scope', 'runs:read'],
      ['key', 'create', '--project', 'P'],
      ['key', 'create', '--project', 'P', '--scope', 'runs:admin'],
      ['key', 'create', '--project', 'P', '--scope', 'runs:read', '--expires-at', '2030-01-01'],
      ['key', 'create', '--project', 'x'.repeat(513), '--scope', 'runs:read'],
      ['key', 'revoke'],
      ['key', 'revoke', '--public-id', token],
      ['key', 'create', '--project', 'P', '--scope', 'runs:read', '--unknown'],
    ]) {
      expect(await runAdmin(argv, service.db.pool, streams), argv.join(' ')).toBe(2);
    }
    expect(out).toHaveLength(1);
    expect(await runAdmin(['schema'], service.db.pool, streams)).toBe(0);
    expect(await runAdmin(['migrate'], service.db.pool, streams)).toBe(0);
    // No route manages keys.
    for (const [method, path] of [
      ['POST', '/v1/keys'],
      ['POST', '/v1/api-keys'],
      ['GET', '/v1/keys'],
      ['POST', '/v1/maintenance'],
      ['POST', '/v1/index/rebuild'],
    ] as const) {
      expect((await call(service.base, undefined, method, path)).status, path).toBe(404);
    }
  });
});

describe('the project id contract through HTTP', () => {
  it('serves a project id of exactly 512 bytes of UTF-8 through every layer, and issues none past it', async () => {
    const service: Service = await harness.service('project_bytes');
    const atBound = `${String.fromCodePoint(0x1f600).repeat(127)}${String.fromCodePoint(0x20ac)}x`;
    expect(Buffer.byteLength(atBound, 'utf8')).toBe(512);
    const token = await service.key(atBound);
    const dir = fixture('runs/flaky-session-passed');
    expect((await upload(service.base, token, partsOf(dir))).status).toBe(201);
    const listing = await wholeListing(service.base, token);
    expect(listing.map((r) => r.runId)).toEqual(['run-so-0008']);
    expect(
      (await call(service.base, token, 'GET', `/v1/runs/${encodeRunRef('run-so-0008')}`)).status,
    ).toBe(200);
    expect((await service.db.store.loadRun(atBound, 'run-so-0008'))?.projectId).toBe(atBound);
    await expect(service.key(`${atBound}y`)).rejects.toThrow(TypeError);
  });
});
