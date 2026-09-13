import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlobStoreError, FileBlobStore } from '../src/index.js';
import { freshDir, objectPath, sha256, sourceFile, tempEntries } from './helpers.js';

const posix = process.platform === 'win32' ? it.skip : it;

function newStore(name: string): { store: FileBlobStore; root: string; sources: string } {
  const base = freshDir(name);
  const root = join(base, 'blobs');
  mkdirSync(root);
  return { store: new FileBlobStore(root), root, sources: join(base, 'run', 'attachments') };
}

async function failure(promise: Promise<unknown>): Promise<BlobStoreError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof BlobStoreError) return e;
    throw e;
  }
  throw new Error('expected a BlobStoreError');
}

/** Stores `count` distinct blobs and returns their hashes in hash order. */
async function fill(store: FileBlobStore, sources: string, count: number): Promise<string[]> {
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const src = sourceFile(sources, `a-${i}`, Buffer.from(`object number ${i}`));
    await store.put(src);
    hashes.push(src.sha256);
  }
  return hashes.sort();
}

/** Writes bytes straight into a canonical object path, as a foreign or damaged object would be. */
function plant(root: string, hash: string, bytes: Buffer): string {
  const path = objectPath(root, hash);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function writeTemp(root: string, name: string, bytes: Buffer, ageMs = 0): string {
  const dir = join(root, 'tmp');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }
  return path;
}

describe('enumerating the store', () => {
  it('lists canonical objects in hash order and pages deterministically', async () => {
    const { store, sources } = newStore('list');
    expect(await store.listObjects()).toEqual({ objects: [], next: undefined, problems: [] });
    const hashes = await fill(store, sources, 7);
    const all = await store.listObjects();
    expect(all.problems).toEqual([]);
    expect(all.next).toBeUndefined();
    expect(all.objects.map((o) => o.sha256)).toEqual(hashes);
    expect(all.objects.map((o) => o.storageKey)).toEqual(hashes.map((h) => store.storageKey(h)));
    expect(all.objects.every((o) => o.sizeBytes > 0)).toBe(true);

    const paged: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof store.listObjects>> =
        after === undefined
          ? await store.listObjects({ limit: 3 })
          : await store.listObjects({ limit: 3, after });
      expect(page.objects.length).toBeLessThanOrEqual(3);
      paged.push(...page.objects.map((o) => o.sha256));
      after = page.next;
      pages += 1;
    } while (after !== undefined && pages < 10);
    expect(paged).toEqual(hashes);
    // The same page twice gives the same answer, and a cursor past the end gives nothing.
    expect((await store.listObjects({ limit: 3 })).objects).toEqual(
      (await store.listObjects({ limit: 3 })).objects,
    );
    expect((await store.listObjects({ after: 'f'.repeat(64) })).objects).toEqual([]);
    await expect(store.listObjects({ after: 'not a hash' })).rejects.toThrow(BlobStoreError);
    await expect(store.listObjects({ limit: 0 })).rejects.toThrow(TypeError);
  });

  posix('reports every entry the layout does not define, and follows none of them', async () => {
    const { store, root, sources } = newStore('problems');
    const good = await fill(store, sources, 1);
    const hash = good[0] as string;
    const outside = sourceFile(join(root, '..', 'outside'), 'secret', Buffer.from('not a blob'));
    const objects = join(root, 'sha256');
    // A shard level holding things that are not shards.
    writeFileSync(join(objects, 'notashard'), '');
    mkdirSync(join(objects, 'zz'));
    writeFileSync(join(objects, 'ab'), '');
    // Inside a real shard: a link, a nested directory, a malformed name, a foreign shard.
    const leaf = dirname(objectPath(root, hash));
    symlinkSync(outside.path, join(leaf, 'a'.repeat(64)));
    mkdirSync(join(leaf, 'b'.repeat(64)));
    writeFileSync(join(leaf, 'not-a-hash'), '');
    writeFileSync(join(leaf, 'c'.repeat(64)), 'wrong shard');
    const listed = await store.listObjects();
    expect(listed.objects.map((o) => o.sha256)).toEqual([hash]);
    const byCode = new Map(listed.problems.map((p) => [p.code, p]));
    expect([...byCode.keys()].sort()).toEqual([
      'MALFORMED_NAME',
      'NOT_REGULAR',
      'UNEXPECTED_ENTRY',
      'WRONG_SHARD',
    ]);
    for (const p of listed.problems) {
      expect(p.path.startsWith('sha256/')).toBe(true);
      expect(p.path.includes(root)).toBe(false);
    }
    // Nothing was read through the link, and nothing was removed.
    expect(readFileSync(outside.path, 'utf8')).toBe('not a blob');
    expect(existsSync(join(leaf, 'a'.repeat(64)))).toBe(true);
    expect(existsSync(join(leaf, 'not-a-hash'))).toBe(true);
  });

  it('reports the size and age of each object, and caps what one call can return or describe', async () => {
    const { store, sources } = newStore('bounds');
    const hashes = await fill(store, sources, 3);
    const listed = await store.listObjects();
    expect(listed.objects.map((o) => o.sha256)).toEqual(hashes);
    for (const object of listed.objects) {
      expect(object.sizeBytes).toBeGreaterThan(0);
      expect(object.modifiedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(object.modifiedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    }
    // A limit beyond what the store will ever return in one call is clamped, not honoured.
    expect((await store.listObjects({ limit: Number.MAX_SAFE_INTEGER })).objects).toHaveLength(3);
  });

  it('stops describing problems once there are too many of them', async () => {
    const { store, sources, root } = newStore('flood');
    const hash = (await fill(store, sources, 1))[0] as string;
    const leaf = dirname(objectPath(root, hash));
    for (let i = 0; i < 140; i += 1) writeFileSync(join(leaf, `not-a-hash-${i}`), '');
    const listed = await store.listObjects();
    expect(listed.objects.map((o) => o.sha256)).toEqual([hash]);
    expect(listed.problems.length).toBeLessThanOrEqual(101);
    expect(listed.problems[listed.problems.length - 1]?.message).toMatch(/are not listed/u);
  });

  it('refuses to enumerate through anything that is not its own directory', async () => {
    const { store, root } = newStore('unsafe');
    writeFileSync(join(root, 'sha256'), 'not a directory');
    expect((await failure(store.listObjects())).code).toBe('ROOT_ENTRY_UNSAFE');
    rmSync(join(root, 'sha256'));
    writeFileSync(join(root, 'tmp'), 'not a directory');
    expect((await failure(store.listTemporaryFiles())).code).toBe('ROOT_ENTRY_UNSAFE');
  });
});

describe('removing an object', () => {
  it('verifies and unlinks it, and answers missing for one that is already gone', async () => {
    const { store, root, sources } = newStore('remove');
    const src = sourceFile(sources, 'a', randomBytes(200_000));
    await store.put(src);
    const leaf = dirname(objectPath(root, src.sha256));
    expect(await store.removeObject(src.sha256, src.sizeBytes)).toBe('removed');
    expect(existsSync(objectPath(root, src.sha256))).toBe(false);
    expect(readdirSync(leaf)).toEqual([]);
    expect(await store.stat(src.sha256)).toBeUndefined();
    expect(await store.removeObject(src.sha256, src.sizeBytes)).toBe('missing');
    expect(await store.removeObject('0'.repeat(64))).toBe('missing');
    await expect(store.removeObject('not a hash')).rejects.toThrow(BlobStoreError);
    // Removal is a lifecycle action, not a weakening of put: the same bytes store again cleanly.
    expect((await store.put(src)).outcome).toBe('stored');
    expect(await store.verify(src.sha256, src.sizeBytes)).toMatchObject({ sha256: src.sha256 });
    expect(tempEntries(root)).toEqual([]);
  });

  it('leaves a corrupt or wrongly sized object in place and says why', async () => {
    const { store, root, sources } = newStore('corrupt');
    const src = sourceFile(sources, 'a', Buffer.from('the declared bytes'));
    const planted = plant(root, src.sha256, Buffer.from('not the declared bytes'));
    expect((await failure(store.removeObject(src.sha256))).code).toBe('BLOB_HASH_MISMATCH');
    expect(existsSync(planted)).toBe(true);
    expect(readFileSync(planted, 'utf8')).toBe('not the declared bytes');
    // A size the caller knows is checked before the bytes are read at all.
    expect((await failure(store.removeObject(src.sha256, src.sizeBytes))).code).toBe(
      'BLOB_SIZE_MISMATCH',
    );
    expect(existsSync(planted)).toBe(true);
    // The real object, wrongly declared by the caller, is also kept.
    rmSync(planted);
    await store.put(src);
    expect((await failure(store.removeObject(src.sha256, src.sizeBytes + 1))).code).toBe(
      'BLOB_SIZE_MISMATCH',
    );
    expect(await store.verify(src.sha256, src.sizeBytes)).toMatchObject({ sha256: src.sha256 });
  });

  posix('refuses to unlink through a link or a special file at an object path', async () => {
    const { store, root } = newStore('unsafe-object');
    const target = sourceFile(join(root, '..', 'outside'), 'target', Buffer.from('kept'));
    const hash = sha256(Buffer.from('kept'));
    const path = objectPath(root, hash);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target.path, path);
    expect((await failure(store.removeObject(hash))).code).toBe('BLOB_NOT_REGULAR');
    expect(readFileSync(target.path, 'utf8')).toBe('kept');
    expect(existsSync(path)).toBe(true);
    rmSync(path);
    execFileSync('mkfifo', [path]);
    expect((await failure(store.removeObject(hash))).code).toBe('BLOB_NOT_REGULAR');
    rmSync(path);
  });

  posix('refuses when a link is planted at one of its directories', async () => {
    const { store, root, sources } = newStore('unsafe-dir');
    const src = sourceFile(sources, 'a', Buffer.from('behind a directory link'));
    await store.put(src);
    const leaf = dirname(objectPath(root, src.sha256));
    const moved = join(root, 'moved');
    renameSync(leaf, moved);
    symlinkSync(moved, leaf);
    expect((await failure(store.removeObject(src.sha256))).code).toBe('ROOT_ENTRY_UNSAFE');
    expect(existsSync(join(moved, src.sha256))).toBe(true);
  });
});

describe('temporary files', () => {
  it('lists only its own names, oldest first, and only before the cutoff', async () => {
    const { store, root } = newStore('temps');
    expect(await store.listTemporaryFiles()).toEqual({ files: [], problems: [] });
    const old = 'a'.repeat(32) + '.part';
    const recent = 'b'.repeat(32) + '.part';
    const older = 'c'.repeat(32) + '.part';
    writeTemp(root, old, Buffer.from('old'), 60 * 60 * 1000);
    writeTemp(root, older, Buffer.from('older'), 5 * 60 * 60 * 1000);
    writeTemp(root, recent, Buffer.from('recent'));
    writeTemp(root, 'unrelated.txt', Buffer.from('not mine'), 60 * 60 * 1000);
    writeTemp(root, 'zz.part', Buffer.from('not a name this store gives'), 60 * 60 * 1000);
    const all = await store.listTemporaryFiles();
    expect(all.problems).toEqual([]);
    expect(all.files.map((f) => f.name)).toEqual([older, old, recent]);
    expect(all.files[0]).toMatchObject({ sizeBytes: 5 });
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const stale = await store.listTemporaryFiles({ before: cutoff });
    expect(stale.files.map((f) => f.name)).toEqual([older, old]);
    expect((await store.listTemporaryFiles({ before: cutoff, limit: 1 })).files).toHaveLength(1);
    await expect(store.listTemporaryFiles({ before: new Date(Number.NaN) })).rejects.toThrow(
      TypeError,
    );
    // The unrelated names were never touched.
    expect(readdirSync(join(root, 'tmp')).sort()).toContain('unrelated.txt');
  });

  posix('reports a temporary name that is not a regular file and follows none of it', async () => {
    const { store, root } = newStore('temps-unsafe');
    const target = freshDir('temps-target');
    writeFileSync(join(target, 'kept'), 'kept');
    mkdirSync(join(root, 'tmp'), { recursive: true });
    symlinkSync(target, join(root, 'tmp', 'd'.repeat(32) + '.part'));
    mkdirSync(join(root, 'tmp', 'e'.repeat(32) + '.part'));
    const listed = await store.listTemporaryFiles();
    expect(listed.files).toEqual([]);
    expect(listed.problems.map((p) => p.code)).toEqual(['NOT_REGULAR', 'NOT_REGULAR']);
    expect(listed.problems.every((p) => p.path.startsWith('tmp/'))).toBe(true);
    expect((await failure(store.removeTemporaryFile('d'.repeat(32) + '.part'))).code).toBe(
      'BLOB_NOT_REGULAR',
    );
    expect((await failure(store.removeTemporaryFile('e'.repeat(32) + '.part'))).code).toBe(
      'BLOB_NOT_REGULAR',
    );
    expect(readdirSync(target)).toEqual(['kept']);
    expect(readdirSync(join(root, 'tmp')).length).toBe(2);
  });

  posix('refuses to remove anything when its own temporary directory is a link', async () => {
    const { store, root } = newStore('temps-linked-dir');
    // A link planted at `tmp` would otherwise make a removal unlink a file outside the store.
    const elsewhere = freshDir('temps-elsewhere');
    const name = 'a'.repeat(32) + '.part';
    writeFileSync(join(elsewhere, name), 'someone else\u2019s file');
    symlinkSync(elsewhere, join(root, 'tmp'));
    expect((await failure(store.removeTemporaryFile(name))).code).toBe('ROOT_ENTRY_UNSAFE');
    expect((await failure(store.listTemporaryFiles())).code).toBe('ROOT_ENTRY_UNSAFE');
    expect(existsSync(join(elsewhere, name))).toBe(true);
    expect(readFileSync(join(elsewhere, name), 'utf8')).toBe('someone else\u2019s file');
  });

  it('removes one by name and refuses any other name', async () => {
    const { store, root } = newStore('temps-remove');
    const name = 'f'.repeat(32) + '.part';
    writeTemp(root, name, Buffer.from('abandoned'), 60 * 60 * 1000);
    writeTemp(root, 'keepme.txt', Buffer.from('not mine'));
    expect(await store.removeTemporaryFile(name)).toBe('removed');
    expect(await store.removeTemporaryFile(name)).toBe('missing');
    for (const bad of ['keepme.txt', '../escape.part', 'g'.repeat(31) + '.part', '']) {
      expect((await failure(store.removeTemporaryFile(bad))).code).toBe('INVALID_TEMPORARY_NAME');
    }
    expect(existsSync(join(root, 'tmp', 'keepme.txt'))).toBe(true);
  });
});
