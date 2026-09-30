import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_API_KEY_PAGE,
  MAX_API_KEY_PAGE,
  PostgresApiKeys,
  parseApiKeyToken,
} from '../src/index.js';
import { TestPostgres, waitFor } from './support.js';

const pgTest = new TestPostgres();
beforeAll(() => pgTest.start());
afterAll(() => pgTest.stop());

const TOKEN_SHAPE = /^qer_k1_[a-z2-7]{16}_[a-z2-7]{52}$/u;

describe('project-scoped API keys', () => {
  it('issues a token once, authenticates it, and stores nothing that could give it back', async () => {
    const db = await pgTest.database('keys');
    const keys = new PostgresApiKeys(db.pool);
    const created = await keys.create({
      projectId: 'P',
      scopes: ['runs:write', 'runs:read'],
      label: 'ci on main',
    });
    expect(created.token).toMatch(TOKEN_SHAPE);
    expect(created).toMatchObject({
      projectId: 'P',
      scopes: ['runs:read', 'runs:write'],
      label: 'ci on main',
      expiresAt: undefined,
    });
    expect(created.token.startsWith(`qer_k1_${created.publicId}_`)).toBe(true);
    expect(await keys.authenticate(created.token)).toEqual({
      publicId: created.publicId,
      projectId: 'P',
      scopes: ['runs:read', 'runs:write'],
    });

    const secret = created.token.slice(`qer_k1_${created.publicId}_`.length);
    const stored = await db.pool.query<Record<string, unknown>>(
      'SELECT *, secret_sha256::text AS digest_text FROM qe_project_api_keys',
    );
    expect(stored.rows).toHaveLength(1);
    const row = stored.rows[0] as Record<string, unknown>;
    const everything = JSON.stringify(row, (_, v: unknown) =>
      Buffer.isBuffer(v) ? v.toString('hex') : v,
    );
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(created.token);
    // What is stored is the SHA-256 of the secret's bytes, and nothing else about it.
    const parsed = parseApiKeyToken(created.token);
    expect(row.secret_sha256).toEqual(
      createHash('sha256')
        .update(parsed?.secret ?? Buffer.alloc(0))
        .digest(),
    );
    expect(Object.keys(row).sort()).toEqual([
      'created_at',
      'digest_text',
      'expires_at',
      'label',
      'project_id',
      'public_id',
      'revoked_at',
      'scopes',
      'secret_sha256',
    ]);
  });

  it('treats a malformed, unknown, or wrong token as nothing at all', async () => {
    const db = await pgTest.database('keys_invalid');
    const keys = new PostgresApiKeys(db.pool);
    const created = await keys.create({ projectId: 'P', scopes: ['runs:read'] });
    const [, , publicId, secret] = created.token.split('_') as [string, string, string, string];
    const other = await keys.create({ projectId: 'P', scopes: ['runs:read'] });
    const otherSecret = other.token.split('_')[3] as string;
    const flip = (s: string): string =>
      `${s.slice(0, -2)}${s.at(-2) === 'a' ? 'b' : 'a'}${s.at(-1)}`;
    const invalid = [
      '',
      'qer_k1_',
      created.token.toUpperCase(),
      ` ${created.token}`,
      `${created.token} `,
      `Bearer ${created.token}`,
      created.token.replace('qer_k1_', 'qer_k2_'),
      created.token.slice(0, -1),
      `${created.token}a`,
      // A secret whose final character carries bits past the 256: another spelling of nothing.
      `qer_k1_${publicId}_${secret.slice(0, -1)}${secret.at(-1) === 'a' ? 'b' : 'a'}`,
      `qer_k1_${publicId}_${flip(secret)}`,
      `qer_k1_${publicId}_${otherSecret}`,
      `qer_k1_${'a'.repeat(16)}_${secret}`,
      `qer_k1_${publicId.slice(0, 15)}1_${secret}`,
    ];
    for (const token of invalid) {
      expect(await keys.authenticate(token), JSON.stringify(token)).toBeUndefined();
    }
    for (const notText of [undefined, null, 7, {}, Buffer.from(created.token)]) {
      expect(await keys.authenticate(notText as unknown as string)).toBeUndefined();
    }
    expect(await keys.authenticate(created.token)).toBeDefined();
  });

  it('stops authenticating a key when it expires by the database clock, or is revoked', async () => {
    const db = await pgTest.database('keys_lifecycle');
    const keys = new PostgresApiKeys(db.pool);
    const expiring = await keys.create({
      projectId: 'P',
      scopes: ['runs:read'],
      expiresAt: new Date(Date.now() + 1500),
    });
    expect(await keys.authenticate(expiring.token)).toBeDefined();
    await waitFor(async () => (await keys.authenticate(expiring.token)) === undefined);
    await expect(
      keys.create({ projectId: 'P', scopes: ['runs:read'], expiresAt: new Date(Date.now() - 1) }),
    ).rejects.toThrow(/future/u);

    // Rotation: a new key first, then the old one revoked, and only the new one works.
    const old = await keys.create({ projectId: 'P', scopes: ['runs:write'] });
    const replacement = await keys.create({ projectId: 'P', scopes: ['runs:write'] });
    expect(await keys.revoke(old.publicId)).toBe(true);
    expect(await keys.authenticate(old.token)).toBeUndefined();
    expect(await keys.authenticate(replacement.token)).toMatchObject({ projectId: 'P' });
    expect(await keys.revoke(old.publicId)).toBe(false);
    expect(await keys.revoke('a'.repeat(16))).toBe(false);
    await expect(keys.revoke(old.token)).rejects.toThrow(TypeError);
  });

  it('issues keys for exactly the project ids the system accepts, with exactly the known scopes', async () => {
    const db = await pgTest.database('keys_contract');
    const keys = new PostgresApiKeys(db.pool);
    const e = String.fromCodePoint(0xe9);
    for (const projectId of ['x'.repeat(512), e.repeat(256), ' spaced ', `caf${e}`]) {
      const key = await keys.create({ projectId, scopes: ['runs:read'] });
      expect((await keys.authenticate(key.token))?.projectId).toBe(projectId);
    }
    for (const projectId of [
      '',
      'x'.repeat(513),
      e.repeat(257),
      String.fromCharCode(0xd800),
      'a\u0000',
    ]) {
      await expect(keys.create({ projectId, scopes: ['runs:read'] })).rejects.toThrow(TypeError);
    }
    const scopes: unknown[] = [[], ['runs:read', 'runs:read'], ['runs:admin'], ['*'], 'runs:read'];
    for (const bad of scopes) {
      await expect(keys.create({ projectId: 'P', scopes: bad as ['runs:read'] })).rejects.toThrow(
        TypeError,
      );
    }
    for (const label of ['', 'x'.repeat(201), 'line\nbreak']) {
      await expect(keys.create({ projectId: 'P', scopes: ['runs:read'], label })).rejects.toThrow(
        TypeError,
      );
    }
    // Nothing refused left a row behind.
    const rows = await db.pool.query('SELECT 1 FROM qe_project_api_keys');
    expect(rows.rowCount).toBe(4);
  });
});

describe('listing keys, for an operator deciding what to rotate', () => {
  it('returns metadata only, and nothing a token could be rebuilt from', async () => {
    const db = await pgTest.database('keys_list_metadata');
    const keys = new PostgresApiKeys(db.pool);
    const created = await keys.create({ projectId: 'P', scopes: ['runs:read'], label: 'ci' });
    const secret = created.token.slice(`qer_k1_${created.publicId}_`.length);

    const page = await keys.list();
    expect(page.keys).toHaveLength(1);
    expect(page.keys[0]).toEqual({
      publicId: created.publicId,
      projectId: 'P',
      scopes: ['runs:read'],
      label: 'ci',
      createdAt: created.createdAt,
      expiresAt: undefined,
      revokedAt: undefined,
      active: true,
    });
    // The whole answer, as text: no secret, no digest of one, nothing but the public id.
    const text = JSON.stringify(page);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(createHash('sha256').update(secret).digest('hex'));
    expect(text).not.toMatch(/secret/iu);
  });

  it('shows only working keys until asked for the rest, and says why each is not working', async () => {
    const db = await pgTest.database('keys_list_active');
    const keys = new PostgresApiKeys(db.pool);
    const live = await keys.create({ projectId: 'P', scopes: ['runs:read'] });
    const revoked = await keys.create({ projectId: 'P', scopes: ['runs:read'] });
    const expiring = await keys.create({
      projectId: 'P',
      scopes: ['runs:read'],
      expiresAt: new Date(Date.now() + 1_000),
    });
    expect(await keys.revoke(revoked.publicId)).toBe(true);

    // Expiry is the database's clock, so the test waits for it rather than deciding it has passed.
    await waitFor(async () => (await keys.authenticate(expiring.token)) === undefined);

    const working = await keys.list({ projectId: 'P' });
    expect(working.keys.map((k) => k.publicId)).toEqual([live.publicId]);

    const all = await keys.list({ projectId: 'P', includeInactive: true });
    const byId = new Map(all.keys.map((k) => [k.publicId, k]));
    expect(byId.size).toBe(3);
    // Revoked and expired are both inactive, and each says which it is: one has a revokedAt, the
    // other only an expiry that has passed.
    expect(byId.get(revoked.publicId)).toMatchObject({ active: false });
    expect(byId.get(revoked.publicId)?.revokedAt).toBeInstanceOf(Date);
    expect(byId.get(expiring.publicId)).toMatchObject({ active: false, revokedAt: undefined });
    expect(byId.get(expiring.publicId)?.expiresAt).toBeInstanceOf(Date);
    expect(byId.get(live.publicId)).toMatchObject({ active: true });
  });

  it('pages in public id order, continues exactly where it stopped, and ends without a cursor', async () => {
    const db = await pgTest.database('keys_list_paging');
    const keys = new PostgresApiKeys(db.pool);
    const issued: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      issued.push((await keys.create({ projectId: 'P', scopes: ['runs:read'] })).publicId);
    }
    const order = [...issued].sort();

    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await keys.list({ limit: 3, ...(after === undefined ? {} : { after }) });
      pages += 1;
      expect(page.keys.length).toBeLessThanOrEqual(3);
      seen.push(...page.keys.map((k) => k.publicId));
      after = page.next;
    } while (after !== undefined && pages < 10);

    // Every key once, in order, and the last page said there was nothing after it.
    expect(seen).toEqual(order);
    expect(pages).toBe(3);
    expect(after).toBeUndefined();
    // A cursor is only given when there is more; the final page of an exact fit gives none.
    expect((await keys.list({ limit: 7 })).next).toBeUndefined();
    expect((await keys.list({ limit: 6 })).next).toBe(order[5]);
  });

  it('bounds the page it will build, and refuses a cursor that is not a public id', async () => {
    const db = await pgTest.database('keys_list_bounds');
    const keys = new PostgresApiKeys(db.pool);
    await keys.create({ projectId: 'P', scopes: ['runs:read'] });

    // A caller asking for more than the ceiling gets the ceiling, not a statement that builds an
    // unbounded answer. Both are observed through the query itself rather than the returned rows.
    const asked: number[] = [];
    const recording = new PostgresApiKeys({
      query: (text: string, values: readonly unknown[]) => {
        asked.push(values[3] as number);
        return db.pool.query(text, [...values]);
      },
    } as unknown as Pool);
    await recording.list({});
    await recording.list({ limit: MAX_API_KEY_PAGE + 1_000 });
    await recording.list({ limit: 5 });
    // One more than the page size, which is how the cursor is decided.
    expect(asked).toEqual([DEFAULT_API_KEY_PAGE + 1, MAX_API_KEY_PAGE + 1, 6]);

    for (const bad of ['', 'not-a-public-id', 'A'.repeat(16), '1'.repeat(16), 'a'.repeat(17)]) {
      await expect(keys.list({ after: bad }), bad).rejects.toThrow(TypeError);
    }
    // A filter is checked by the same rule that governs a project id anywhere else, which admits
    // spaces and refuses an empty string or a NUL.
    await expect(keys.list({ projectId: '' })).rejects.toThrow(TypeError);
    await expect(keys.list({ projectId: 'web\u0000' })).rejects.toThrow(TypeError);
    expect((await keys.list({ projectId: 'a project with spaces' })).keys).toEqual([]);
  });
});
