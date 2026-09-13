import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BlobStoreError, DEFAULT_MAX_BLOB_BYTES, FileBlobStore, isSha256 } from '../src/index.js';
import { copyAndHash } from '../src/file-blob-store.js';
import { freshDir, objectPath, sha256, sourceFile, tempEntries, type Source } from './helpers.js';

const posix = process.platform === 'win32' ? it.skip : it;
const run = promisify(execFile);

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

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Replaces a published object in place, as a corruption would; the object is read-only on POSIX. */
function overwriteObject(root: string, hash: string, bytes: Buffer): void {
  const path = objectPath(root, hash);
  chmodSync(path, 0o644);
  writeFileSync(path, bytes);
}

describe('FileBlobStore', () => {
  it('derives the key from the hash alone and refuses anything that is not a hash', () => {
    const { store, root } = newStore('keys');
    const hash = 'a'.repeat(64);
    expect(store.storageKey(hash)).toBe(`sha256/aa/aa/${hash}`);
    for (const bad of [
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      `../${'a'.repeat(61)}`,
      `${'a'.repeat(60)}/../x`,
      '',
      undefined,
      42,
    ]) {
      expect(() => store.storageKey(bad as string)).toThrow(BlobStoreError);
      expect(isSha256(bad)).toBe(false);
    }
    expect(isSha256(hash)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects a malformed hash or size before touching the filesystem', async () => {
    const { store, root, sources } = newStore('malformed');
    const src = sourceFile(sources, 'a', Buffer.from('a'));
    for (const bad of ['x'.repeat(64), src.sha256.toUpperCase(), `${src.sha256}\n`]) {
      expect((await failure(store.put({ ...src, sha256: bad }))).code).toBe('INVALID_SHA256');
      expect((await failure(store.stat(bad))).code).toBe('INVALID_SHA256');
      expect((await failure(store.open(bad))).code).toBe('INVALID_SHA256');
      expect((await failure(store.verify(bad, 1))).code).toBe('INVALID_SHA256');
    }
    for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number]) {
      expect((await failure(store.put({ ...src, sizeBytes: size }))).code).toBe('INVALID_SIZE');
      expect((await failure(store.verify(src.sha256, size))).code).toBe('INVALID_SIZE');
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('stores a first write under its content path and reuses it on a second identical write', async () => {
    const { store, root, sources } = newStore('first');
    const src = sourceFile(sources, 'log', Buffer.from('first attachment bytes'));
    const first = await store.put(src);
    expect(first).toEqual({
      sha256: src.sha256,
      sizeBytes: src.sizeBytes,
      storageKey: `sha256/${src.sha256.slice(0, 2)}/${src.sha256.slice(2, 4)}/${src.sha256}`,
      outcome: 'stored',
    });
    const path = objectPath(root, src.sha256);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path)).toEqual(src.bytes);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(tempEntries(root)).toEqual([]);
    const inode = statSync(path).ino;
    const second = await store.put(src);
    expect(second).toEqual({ ...first, outcome: 'existing' });
    expect(statSync(path).ino).toBe(inode);
    expect(readFileSync(path)).toEqual(src.bytes);
    expect(tempEntries(root)).toEqual([]);
    expect(await store.stat(src.sha256)).toEqual({
      sha256: src.sha256,
      sizeBytes: src.sizeBytes,
      storageKey: first.storageKey,
    });
    expect(await store.stat('0'.repeat(64))).toBeUndefined();
  });

  it('streams a source larger than one chunk without holding it whole', async () => {
    const { store, root, sources } = newStore('large');
    const bytes = randomBytes(5 * 1024 * 1024);
    const src = sourceFile(sources, 'video', bytes);
    expect((await store.put(src)).outcome).toBe('stored');
    expect(sha256(readFileSync(objectPath(root, src.sha256)))).toBe(src.sha256);
    const opened = await store.open(src.sha256, src.sizeBytes);
    expect(sha256(await readAll(opened.stream))).toBe(src.sha256);
    expect(await store.verify(src.sha256, src.sizeBytes)).toMatchObject({
      sizeBytes: bytes.length,
    });
  });

  it('publishes nothing when the declared size disagrees with the source', async () => {
    const { store, root, sources } = newStore('size');
    const src = sourceFile(sources, 'a', Buffer.from('twelve bytes'));
    const short = await failure(store.put({ ...src, sizeBytes: src.sizeBytes - 1 }));
    expect(short.code).toBe('SOURCE_SIZE_MISMATCH');
    expect(short.sha256).toBe(src.sha256);
    const long = await failure(store.put({ ...src, sizeBytes: src.sizeBytes + 1 }));
    expect(long.code).toBe('SOURCE_SIZE_MISMATCH');
    expect(existsSync(objectPath(root, src.sha256))).toBe(false);
    expect(tempEntries(root)).toEqual([]);
    expect(await store.stat(src.sha256)).toBeUndefined();
  });

  it('publishes nothing when the source hashes to something else, and leaves no temporary file', async () => {
    const { store, root, sources } = newStore('hash');
    const src = sourceFile(sources, 'a', randomBytes(300_000));
    const other = sha256(Buffer.from('other'));
    const e = await failure(store.put({ ...src, sha256: other }));
    expect(e.code).toBe('SOURCE_HASH_MISMATCH');
    expect(e.sha256).toBe(other);
    expect(existsSync(objectPath(root, other))).toBe(false);
    expect(existsSync(objectPath(root, src.sha256))).toBe(false);
    expect(tempEntries(root)).toEqual([]);
  });

  it('fails when the source disappeared after it was declared', async () => {
    const { store, root, sources } = newStore('gone');
    const src = sourceFile(sources, 'a', Buffer.from('gone'));
    unlinkSync(src.path);
    expect((await failure(store.put(src))).code).toBe('SOURCE_MISSING');
    rmSync(sources, { recursive: true });
    expect((await failure(store.put(src))).code).toBe('SOURCE_MISSING');
    expect(existsSync(objectPath(root, src.sha256))).toBe(false);
    expect(tempEntries(root)).toEqual([]);
  });

  posix('fails when the source became a link, even to the declared bytes', async () => {
    const { store, root, sources } = newStore('link');
    const src = sourceFile(sources, 'a', Buffer.from('linked'));
    const elsewhere = sourceFile(join(sources, '..', 'elsewhere'), 'target', src.bytes);
    unlinkSync(src.path);
    symlinkSync(elsewhere.path, src.path);
    const e = await failure(store.put(src));
    expect(e.code).toBe('SOURCE_NOT_REGULAR');
    expect(e.message).toContain('symbolic link');
    expect(existsSync(objectPath(root, src.sha256))).toBe(false);
  });

  it('fails when the source is a directory', async () => {
    const { store, root, sources } = newStore('dir');
    const src = sourceFile(sources, 'a', Buffer.from('dir'));
    unlinkSync(src.path);
    mkdirSync(src.path);
    expect((await failure(store.put(src))).code).toBe('SOURCE_NOT_REGULAR');
    expect(existsSync(objectPath(root, src.sha256))).toBe(false);
  });

  posix('fails on a special file without blocking on it', async () => {
    const { store, root, sources } = newStore('fifo');
    const src = sourceFile(sources, 'a', Buffer.from('fifo'));
    unlinkSync(src.path);
    execFileSync('mkfifo', [src.path]);
    const e = await failure(store.put(src));
    expect(e.code).toBe('SOURCE_NOT_REGULAR');
    expect(e.message).toContain('not a regular file');
    expect(existsSync(objectPath(root, src.sha256))).toBe(false);
  });

  it('reuses an existing correct object without rewriting it', async () => {
    const { store, root, sources } = newStore('existing');
    const src = sourceFile(sources, 'a', Buffer.from('already there'));
    const path = objectPath(root, src.sha256);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, src.bytes);
    const before = statSync(path);
    const r = await store.put(src);
    expect(r.outcome).toBe('existing');
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(tempEntries(root)).toEqual([]);
  });

  it('refuses an existing object of the wrong size and never overwrites it', async () => {
    const { store, root, sources } = newStore('wrongsize');
    const src = sourceFile(sources, 'a', Buffer.from('correct bytes'));
    const path = objectPath(root, src.sha256);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from('short'));
    const e = await failure(store.put(src));
    expect(e.code).toBe('BLOB_SIZE_MISMATCH');
    expect(e.sha256).toBe(src.sha256);
    expect(readFileSync(path, 'utf8')).toBe('short');
    expect((await failure(store.verify(src.sha256, src.sizeBytes))).code).toBe(
      'BLOB_SIZE_MISMATCH',
    );
    expect((await failure(store.open(src.sha256, src.sizeBytes))).code).toBe('BLOB_SIZE_MISMATCH');
    expect(tempEntries(root)).toEqual([]);
  });

  it('refuses an existing object of the right size and wrong hash and never overwrites it', async () => {
    const { store, root, sources } = newStore('wronghash');
    const src = sourceFile(sources, 'a', Buffer.from('correct bytes'));
    const path = objectPath(root, src.sha256);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from('xorrect bytes'));
    const e = await failure(store.put(src));
    expect(e.code).toBe('BLOB_HASH_MISMATCH');
    expect(readFileSync(path, 'utf8')).toBe('xorrect bytes');
    expect((await failure(store.verify(src.sha256, src.sizeBytes))).code).toBe(
      'BLOB_HASH_MISMATCH',
    );
    // stat and open do not hash: the size matches, so only verify tells.
    expect(await store.stat(src.sha256)).toMatchObject({ sizeBytes: src.sizeBytes });
    expect(tempEntries(root)).toEqual([]);
  });

  posix('refuses an object path that is a link, for every operation', async () => {
    const { store, root, sources } = newStore('objlink');
    const src = sourceFile(sources, 'a', Buffer.from('linked object'));
    const path = objectPath(root, src.sha256);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(src.path, path);
    expect((await failure(store.put(src))).code).toBe('BLOB_NOT_REGULAR');
    expect((await failure(store.stat(src.sha256))).code).toBe('BLOB_NOT_REGULAR');
    expect((await failure(store.open(src.sha256))).code).toBe('BLOB_NOT_REGULAR');
    expect((await failure(store.verify(src.sha256, src.sizeBytes))).code).toBe('BLOB_NOT_REGULAR');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(src.path, 'utf8')).toBe('linked object');
  });

  posix('refuses to create objects through a link planted in its own directories', async () => {
    const { store, root, sources } = newStore('dirlink');
    const src = sourceFile(sources, 'a', Buffer.from('planted'));
    const outside = freshDir('outside');
    mkdirSync(join(root, 'sha256'));
    symlinkSync(outside, join(root, 'sha256', src.sha256.slice(0, 2)));
    const e = await failure(store.put(src));
    expect(e.code).toBe('ROOT_ENTRY_UNSAFE');
    expect(readdirSync(outside)).toEqual([]);
    expect(tempEntries(root)).toEqual([]);
  });

  it('detects a missing, corrupted, or truncated object on verification and repairs nothing', async () => {
    const { store, root, sources } = newStore('verify');
    const src = sourceFile(sources, 'a', Buffer.from('to be damaged'));
    await store.put(src);
    expect(await store.verify(src.sha256, src.sizeBytes)).toEqual({
      sha256: src.sha256,
      sizeBytes: src.sizeBytes,
      storageKey: store.storageKey(src.sha256),
    });
    overwriteObject(root, src.sha256, Buffer.from('to be damaged!'));
    expect((await failure(store.verify(src.sha256, src.sizeBytes))).code).toBe(
      'BLOB_SIZE_MISMATCH',
    );
    overwriteObject(root, src.sha256, Buffer.from('to be Damaged'));
    expect((await failure(store.verify(src.sha256, src.sizeBytes))).code).toBe(
      'BLOB_HASH_MISMATCH',
    );
    expect(readFileSync(objectPath(root, src.sha256), 'utf8')).toBe('to be Damaged');
    rmSync(objectPath(root, src.sha256));
    expect((await failure(store.verify(src.sha256, src.sizeBytes))).code).toBe('BLOB_MISSING');
    expect((await failure(store.open(src.sha256))).code).toBe('BLOB_MISSING');
    expect(await store.stat(src.sha256)).toBeUndefined();
  });

  it('opens a stored object and keeps serving it after the source directory is gone', async () => {
    const { store, sources } = newStore('survives');
    const src = sourceFile(sources, 'a', Buffer.from('outlives the run directory'));
    await store.put(src);
    rmSync(join(sources, '..'), { recursive: true, force: true });
    const opened = await store.open(src.sha256);
    expect(opened).toMatchObject({ sha256: src.sha256, sizeBytes: src.sizeBytes });
    expect((await readAll(opened.stream)).toString()).toBe('outlives the run directory');
    expect(await store.verify(src.sha256, src.sizeBytes)).toMatchObject({ sha256: src.sha256 });
  });

  it('lets concurrent writers in one process publish one object and clean every temporary file', async () => {
    const { store, root, sources } = newStore('concurrent');
    const src = sourceFile(sources, 'a', randomBytes(2 * 1024 * 1024));
    const results = await Promise.all(Array.from({ length: 8 }, () => store.put(src)));
    expect(results.filter((r) => r.outcome === 'stored')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'existing')).toHaveLength(7);
    for (const r of results)
      expect(r).toMatchObject({ sha256: src.sha256, sizeBytes: src.sizeBytes });
    expect(sha256(readFileSync(objectPath(root, src.sha256)))).toBe(src.sha256);
    expect(tempEntries(root)).toEqual([]);
    expect(readdirSync(dirname(objectPath(root, src.sha256)))).toEqual([src.sha256]);
  });

  it('lets concurrent writer processes publish one object, each observing the same verified content', async () => {
    const { root, sources, store } = newStore('processes');
    const src = sourceFile(sources, 'a', randomBytes(3 * 1024 * 1024));
    const worker = join(dirname(fileURLToPath(import.meta.url)), 'worker', 'put.mjs');
    expect(existsSync(join(dirname(worker), '..', '..', 'dist', 'index.js')), 'build first').toBe(
      true,
    );
    const outputs = await Promise.all(
      Array.from({ length: 6 }, () =>
        run(process.execPath, [worker, root, src.path, src.sha256, String(src.sizeBytes)]),
      ),
    );
    const results = outputs.map(
      (o) => JSON.parse(o.stdout) as { outcome?: string; error?: string },
    );
    expect(results.filter((r) => r.error !== undefined)).toEqual([]);
    expect(results.filter((r) => r.outcome === 'stored')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'existing')).toHaveLength(5);
    expect(await store.verify(src.sha256, src.sizeBytes)).toMatchObject({ sha256: src.sha256 });
    expect(tempEntries(root)).toEqual([]);
    expect(readdirSync(dirname(objectPath(root, src.sha256)))).toEqual([src.sha256]);
  });

  it('shares one object between different declarations of the same bytes', async () => {
    const { store, root, sources } = newStore('shared');
    const bytes = Buffer.from('same bytes, two runs, two projects');
    const a = sourceFile(join(sources, 'run-a'), 'x', bytes);
    const b = sourceFile(join(sources, 'run-b'), 'y', bytes);
    expect((await store.put(a)).outcome).toBe('stored');
    expect((await store.put(b)).outcome).toBe('existing');
    expect(readdirSync(dirname(objectPath(root, a.sha256)))).toEqual([a.sha256]);
  });

  it('requires an existing directory as root and resolves a linked one once', () => {
    const base = freshDir('root');
    expect(() => new FileBlobStore(join(base, 'missing'))).toThrow(/cannot be resolved/u);
    writeFileSync(join(base, 'file'), '');
    expect(() => new FileBlobStore(join(base, 'file'))).toThrow(/not a directory/u);
    if (process.platform !== 'win32') {
      mkdirSync(join(base, 'real'));
      symlinkSync(join(base, 'real'), join(base, 'link'));
      expect(new FileBlobStore(join(base, 'link')).root).toBe(realpathSync(join(base, 'real')));
    }
  });

  it('stops the copy as soon as the source exceeds its declaration, without reading it to the end', async () => {
    const { root, sources } = newStore('grow');
    const src = sourceFile(sources, 'a', randomBytes(3 * 1024 * 1024));
    const sourceFd = openSync(src.path, 'r');
    const destination = join(root, 'scratch.part');
    const destinationFd = openSync(destination, 'wx', 0o600);
    try {
      const e = await failure(copyAndHash(sourceFd, destinationFd, 100_000, src.sha256));
      expect(e.code).toBe('SOURCE_SIZE_MISMATCH');
      expect(e.sha256).toBe(src.sha256);
      // Well short of the whole source: the copy stopped at the first chunk past the limit.
      expect(statSync(destination).size).toBeLessThan(512 * 1024);
    } finally {
      closeSync(destinationFd);
    }
    const again = openSync(src.path, 'r');
    const whole = openSync(join(root, 'whole.part'), 'wx', 0o600);
    try {
      expect(await copyAndHash(again, whole, src.sizeBytes, src.sha256)).toEqual({
        sha256: src.sha256,
        size: src.sizeBytes,
      });
    } finally {
      closeSync(whole);
    }
  });

  it('stores, opens, and verifies an empty blob', async () => {
    const { store, sources } = newStore('empty');
    const src = sourceFile(sources, 'a', Buffer.alloc(0));
    expect(src.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect((await store.put(src)).outcome).toBe('stored');
    expect((await store.put(src)).outcome).toBe('existing');
    expect(await store.verify(src.sha256, 0)).toMatchObject({ sizeBytes: 0 });
    const opened = await store.open(src.sha256, 0);
    expect((await readAll(opened.stream)).length).toBe(0);
    expect((await failure(store.verify(src.sha256, 1))).code).toBe('BLOB_SIZE_MISMATCH');
  });

  posix('refuses a regular file planted where one of its directories belongs', async () => {
    const { store, root, sources } = newStore('plantedfile');
    const src = sourceFile(sources, 'a', Buffer.from('planted file'));
    mkdirSync(join(root, 'sha256'));
    writeFileSync(join(root, 'sha256', src.sha256.slice(0, 2)), 'not a directory');
    expect((await failure(store.put(src))).code).toBe('ROOT_ENTRY_UNSAFE');
    expect((await failure(store.stat(src.sha256))).code).toBe('ROOT_ENTRY_UNSAFE');
    expect(tempEntries(root)).toEqual([]);
  });

  it('keeps a failed write from leaving a temporary file even when the source is large', async () => {
    const { store, root, sources } = newStore('cleanup');
    const src: Source = sourceFile(sources, 'a', randomBytes(1024 * 1024));
    const e = await failure(store.put({ ...src, sizeBytes: 100 }));
    expect(e.code).toBe('SOURCE_SIZE_MISMATCH');
    expect(tempEntries(root)).toEqual([]);
    expect(existsSync(objectPath(root, src.sha256))).toBe(false);
  });

  it('refuses a declaration above its size limit before reading anything', async () => {
    const base = freshDir('limit');
    const root = join(base, 'blobs');
    mkdirSync(root);
    const store = new FileBlobStore(root, { maxBlobBytes: 16 });
    const src = sourceFile(join(base, 'src'), 'a', Buffer.alloc(17, 1));
    const e = await failure(store.put(src));
    expect(e.code).toBe('BLOB_TOO_LARGE');
    expect(readdirSync(root)).toEqual([]);
    expect((await failure(store.verify(src.sha256, 17))).code).toBe('BLOB_TOO_LARGE');
    expect((await failure(store.open(src.sha256, 17))).code).toBe('BLOB_TOO_LARGE');
    const small = sourceFile(join(base, 'src'), 'b', Buffer.alloc(16, 2));
    expect((await store.put(small)).outcome).toBe('stored');
    expect(new FileBlobStore(root).maxBlobBytes).toBe(DEFAULT_MAX_BLOB_BYTES);
    expect(() => new FileBlobStore(root, { maxBlobBytes: -1 })).toThrow(TypeError);
  });

  posix('refuses to read an object through a link planted at one of its directories', async () => {
    const { store, root, sources } = newStore('readlink');
    const src = sourceFile(sources, 'a', Buffer.from('behind a directory link'));
    await store.put(src);
    const leaf = dirname(objectPath(root, src.sha256));
    const moved = join(root, 'moved');
    renameSync(leaf, moved);
    symlinkSync(moved, leaf);
    expect((await failure(store.stat(src.sha256))).code).toBe('ROOT_ENTRY_UNSAFE');
    expect((await failure(store.open(src.sha256))).code).toBe('ROOT_ENTRY_UNSAFE');
    expect((await failure(store.verify(src.sha256, src.sizeBytes))).code).toBe('ROOT_ENTRY_UNSAFE');
    expect((await failure(store.put(src))).code).toBe('ROOT_ENTRY_UNSAFE');
  });
});
