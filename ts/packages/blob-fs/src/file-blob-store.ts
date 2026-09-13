import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  readdirSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BlobStoreError } from './errors.js';
import { entryKind, kindOf, openRegular } from './fs-safety.js';
import { checkSha256, checkSize, isSha256 } from './sha256.js';
import type {
  BlobDescriptor,
  BlobMaintenance,
  BlobSource,
  BlobStore,
  CasProblem,
  ListObjectsOptions,
  ObjectEntry,
  ListTemporaryOptions,
  ObjectListing,
  OpenedBlob,
  PutResult,
  TemporaryFile,
  TemporaryListing,
} from './store.js';

const OBJECTS_DIR = 'sha256';
const TEMP_DIR = 'tmp';
/** One level of the object layout: two lower-case hex characters. */
const SHARD = /^[0-9a-f]{2}$/u;
/** Exactly the names `put` gives its temporary files; nothing else under `tmp` is one. */
const TEMPORARY_NAME = /^[0-9a-f]{32}\.part$/u;
/** Objects returned by one unbounded-looking listing call; enumeration is always paged. */
const DEFAULT_LIST_LIMIT = 1000;
/** No listing returns more than this, whatever the caller asks for. */
const MAX_LIST_LIMIT = 10_000;
/** Problems reported by one listing before it stops describing them individually. */
const MAX_PROBLEMS = 100;
const POSIX = process.platform !== 'win32';
/** Final objects are read-only where the platform honours modes; Windows would refuse to unlink them. */
const FINAL_MODE = POSIX ? 0o444 : undefined;
/** The protocol's attachment guidance (the file sinks' default limit); the store refuses more. */
export const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;

export interface FileBlobStoreOptions {
  /** Largest blob the store materialises or verifies; a declaration above it is refused before any read. */
  readonly maxBlobBytes?: number;
}

/**
 * An immutable content-addressed store on a local filesystem, under an operator-configured root:
 * `<root>/sha256/ab/cd/<sha256>`, the path derived from the validated hash and nothing else. A
 * blob is written to an exclusively created temporary file under `<root>/tmp`, hashed and counted
 * as it is copied, compared with its declaration, and only then published with an exclusive hard
 * link: an existing object is never replaced, a second writer that loses the race verifies what
 * the winner published, and the published entry is re-opened and checked to be the very file
 * that was verified. Everything under the root is read with the validator's posture: no link is
 * followed, only regular files are opened, the descriptor is re-checked.
 */
export class FileBlobStore implements BlobStore, BlobMaintenance {
  /** The resolved root; a link the operator chose is resolved once, here. */
  readonly root: string;
  readonly maxBlobBytes: number;

  constructor(root: string, options: FileBlobStoreOptions = {}) {
    let resolved: string;
    try {
      resolved = realpathSync(root);
    } catch (e) {
      throw new Error(`blob root ${root} cannot be resolved: ${(e as Error).message}`);
    }
    if (!lstatSync(resolved).isDirectory()) throw new Error(`blob root ${root} is not a directory`);
    this.root = resolved;
    const max = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    if (!Number.isSafeInteger(max) || max < 0)
      throw new TypeError('maxBlobBytes must be a byte count');
    this.maxBlobBytes = max;
  }

  storageKey(sha256: string): string {
    const hash = checkSha256(sha256);
    return `${OBJECTS_DIR}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
  }

  /** Where a temporary file of the given name sits, relative to the root; for reporting only. */
  temporaryKey(name: string): string {
    checkTemporaryName(name);
    return `${TEMP_DIR}/${name}`;
  }

  private objectPath(hash: string): string {
    return join(this.root, OBJECTS_DIR, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  private objectDirectory(hash: string): string {
    return join(this.root, OBJECTS_DIR, hash.slice(0, 2), hash.slice(2, 4));
  }

  /** The directories on the way to an object must be the store's own: absent, or real directories. */
  private checkObjectDirectories(hash: string): void {
    for (const path of [
      join(this.root, OBJECTS_DIR),
      join(this.root, OBJECTS_DIR, hash.slice(0, 2)),
      this.objectDirectory(hash),
    ]) {
      const kind = entryKind(path);
      if (kind === 'missing') return;
      if (kind !== 'directory') throw unsafeEntry(this.root, path, kind);
    }
  }

  /** The admission limit, applied where bytes enter the store and nowhere else. */
  private checkIncomingSize(size: unknown, hash: string): number {
    const checked = checkSize(size, hash);
    if (checked > this.maxBlobBytes) {
      throw new BlobStoreError(
        'BLOB_TOO_LARGE',
        `declared ${checked} bytes, the store accepts at most ${this.maxBlobBytes}`,
        hash,
      );
    }
    return checked;
  }

  async put(source: BlobSource): Promise<PutResult> {
    const hash = checkSha256(source.sha256);
    const size = this.checkIncomingSize(source.sizeBytes, hash);
    const key = this.storageKey(hash);
    const final = this.objectPath(hash);
    const already = await this.existing(hash, size);
    if (already) return { ...already, outcome: 'existing' };

    // The store's own directories first, so that a planted entry costs neither a source
    // descriptor nor a temporary file.
    this.ensureDirectory(join(this.root, TEMP_DIR), 0o700);
    this.ensureDirectory(join(this.root, OBJECTS_DIR), 0o755);
    this.ensureDirectory(join(this.root, OBJECTS_DIR, hash.slice(0, 2)), 0o755);
    this.ensureDirectory(this.objectDirectory(hash), 0o755);

    const sourceKind = entryKind(source.path);
    if (sourceKind === 'missing') {
      throw new BlobStoreError('SOURCE_MISSING', `no regular file at the attachment source`, hash);
    }
    if (sourceKind !== 'file') throw notRegularSource(sourceKind, hash);
    const opened = openRegular(source.path);
    if ('refused' in opened) {
      throw opened.refused === 'missing'
        ? new BlobStoreError('SOURCE_MISSING', `no regular file at the attachment source`, hash)
        : notRegularSource(opened.refused, hash);
    }
    if (opened.size > size) {
      closeSync(opened.fd);
      throw new BlobStoreError(
        'SOURCE_SIZE_MISMATCH',
        `declared ${size} bytes, source has ${opened.size}`,
        hash,
      );
    }

    const temp = join(this.root, TEMP_DIR, `${randomBytes(16).toString('hex')}.part`);
    let tempFd: number;
    try {
      // O_EXCL: the name is fresh, and a link planted under it is refused rather than followed.
      tempFd = openSync(temp, 'wx', 0o600);
    } catch (e) {
      closeSync(opened.fd);
      throw e;
    }
    let tempOpen = true;
    try {
      const copied = await copyAndHash(opened.fd, tempFd, size, hash);
      if (copied.size !== size) {
        throw new BlobStoreError(
          'SOURCE_SIZE_MISMATCH',
          `declared ${size} bytes, source has ${copied.size}`,
          hash,
        );
      }
      if (copied.sha256 !== hash) {
        throw new BlobStoreError(
          'SOURCE_HASH_MISMATCH',
          `declared ${hash}, source hashes to ${copied.sha256}`,
          hash,
        );
      }
      fsyncSync(tempFd);
      if (FINAL_MODE !== undefined) fchmodSync(tempFd, FINAL_MODE);
      // The descriptor stays open across the link, so the identity of what was verified is known
      // and the published entry can be checked to be that very file.
      const verified = fstatSync(tempFd);
      try {
        linkSync(temp, final);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Another writer published first; what it published is checked like any existing object.
        tempOpen = false;
        closeSync(tempFd);
        removeQuietly(temp);
        const winner = await this.existing(hash, size);
        if (!winner) throw new BlobStoreError('BLOB_MISSING', `object vanished after a race`, hash);
        return { ...winner, outcome: 'existing' };
      }
      this.confirmPublished(hash, verified, size);
      syncDirectory(this.objectDirectory(hash));
      tempOpen = false;
      closeSync(tempFd);
      removeQuietly(temp);
      return { sha256: hash, sizeBytes: size, storageKey: key, outcome: 'stored' };
    } catch (e) {
      // Only the descriptor this call still owns is closed: a number closed earlier may already
      // name another file opened meanwhile.
      if (tempOpen) closeSync(tempFd);
      removeQuietly(temp);
      throw e;
    }
  }

  async stat(sha256: string): Promise<BlobDescriptor | undefined> {
    const hash = checkSha256(sha256);
    this.checkObjectDirectories(hash);
    let stat: Stats;
    try {
      stat = lstatSync(this.objectPath(hash));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw e;
    }
    const kind = kindOf(stat);
    if (kind !== 'file') {
      throw new BlobStoreError('BLOB_NOT_REGULAR', `object is ${describe(kind)}`, hash);
    }
    return { sha256: hash, sizeBytes: stat.size, storageKey: this.storageKey(hash) };
  }

  async open(sha256: string, expectedSize?: number): Promise<OpenedBlob> {
    const hash = checkSha256(sha256);
    const size = expectedSize === undefined ? undefined : checkSize(expectedSize, hash);
    const opened = this.openObject(hash);
    if (size !== undefined && opened.size !== size) {
      closeSync(opened.fd);
      throw new BlobStoreError(
        'BLOB_SIZE_MISMATCH',
        `expected ${size} bytes, object has ${opened.size}`,
        hash,
      );
    }
    return {
      sha256: hash,
      sizeBytes: opened.size,
      storageKey: this.storageKey(hash),
      stream: createReadStream('', { fd: opened.fd }),
    };
  }

  async verify(sha256: string, expectedSize: number): Promise<BlobDescriptor> {
    const hash = checkSha256(sha256);
    const size = checkSize(expectedSize, hash);
    const found = await this.existing(hash, size);
    if (!found) throw new BlobStoreError('BLOB_MISSING', `no object for ${hash}`, hash);
    return found;
  }

  /**
   * Canonical objects on the medium itself, in hash order: `sha256/ab/cd/<hash>` and nothing
   * else. Only names the layout defines are returned, only when the shard directories agree with
   * the hash and the entry is a regular file; everything else is reported as a problem and never
   * followed or opened. The listing is bounded and resumable, so a large store is walked in
   * pages rather than read into one array.
   */
  async listObjects(options: ListObjectsOptions = {}): Promise<ObjectListing> {
    const limit = boundedLimit(options.limit);
    const after = options.after === undefined ? undefined : checkSha256(options.after);
    const problems: CasProblem[] = [];
    const objects: ObjectEntry[] = [];
    const objectsDir = join(this.root, OBJECTS_DIR);
    const kind = entryKind(objectsDir);
    if (kind === 'missing') return { objects, next: undefined, problems };
    if (kind !== 'directory') throw unsafeEntry(this.root, objectsDir, kind);
    let next: string | undefined;
    let full = false;
    for (const first of shards(objectsDir, this.root, problems)) {
      if (full) break;
      if (after !== undefined && first < after.slice(0, 2)) continue;
      const shardDir = join(objectsDir, first);
      for (const second of shards(shardDir, this.root, problems)) {
        if (full) break;
        if (after !== undefined && first === after.slice(0, 2) && second < after.slice(2, 4)) {
          continue;
        }
        const leaf = join(shardDir, second);
        for (const entry of entriesOf(leaf).sort(byName)) {
          // The cursor is applied first, so resuming a listing does not report the same
          // problems again for every page that passes over them.
          if (after !== undefined && isSha256(entry.name) && entry.name <= after) continue;
          const path = join(leaf, entry.name);
          if (!isSha256(entry.name)) {
            record(problems, problem('MALFORMED_NAME', this.root, path, 'not an object name'));
            continue;
          }
          // What the entry is matters before where it is filed: a link is reported as a link
          // whatever it is called, and is never opened or followed either way.
          if (!entry.isFile()) {
            record(problems, problem('NOT_REGULAR', this.root, path, 'not a regular file'));
            continue;
          }
          if (entry.name.slice(0, 2) !== first || entry.name.slice(2, 4) !== second) {
            record(problems, problem('WRONG_SHARD', this.root, path, 'filed under another hash'));
            continue;
          }
          if (objects.length === limit) {
            next = objects[objects.length - 1]?.sha256;
            full = true;
            break;
          }
          // An entry that vanished between the directory read and here is simply not listed.
          const stat = lstatSync(path, { throwIfNoEntry: false });
          if (stat === undefined || !stat.isFile()) continue;
          objects.push({
            sha256: entry.name,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime,
            storageKey: this.storageKey(entry.name),
          });
        }
      }
    }
    return { objects, next, problems };
  }

  /**
   * Removes one object the caller has established is no longer referenced. The path is derived
   * from the hash, inspected without following links, opened as a regular file, checked against
   * the size the caller knows, and hashed in full; the entry is then required to be the file
   * that was read before it is unlinked and the directory synced. A corrupt or unsafe entry
   * throws and stays for an operator; an object already gone answers `missing`, which is not a
   * failure. This is the only way bytes leave the store, and it leaves `put`'s refusal to
   * replace an object untouched.
   */
  async removeObject(sha256: string, expectedSize?: number): Promise<'removed' | 'missing'> {
    const hash = checkSha256(sha256);
    const size = expectedSize === undefined ? undefined : checkSize(expectedSize, hash);
    const path = this.objectPath(hash);
    this.checkObjectDirectories(hash);
    if (entryKind(path) === 'missing') return 'missing';
    const opened = this.openObject(hash);
    let read: Stats;
    try {
      read = fstatSync(opened.fd);
    } catch (e) {
      closeSync(opened.fd);
      throw e;
    }
    if (size !== undefined && read.size !== size) {
      closeSync(opened.fd);
      throw new BlobStoreError(
        'BLOB_SIZE_MISMATCH',
        `object should be ${size} bytes and is ${read.size}`,
        hash,
      );
    }
    const actual = await sha256Fd(opened.fd);
    if (actual !== hash) {
      throw new BlobStoreError('BLOB_HASH_MISMATCH', `object hashes to ${actual}`, hash);
    }
    // The entry must still be the file that was just verified: another writer publishing between
    // the read and the unlink would otherwise lose its object.
    let entry: Stats;
    try {
      entry = lstatSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw e;
    }
    if (entry.dev !== read.dev || entry.ino !== read.ino) {
      throw new BlobStoreError('BLOB_CHANGED', 'the object changed while it was being read', hash);
    }
    // Hashing a large object takes a while; the directories on the way to it are checked again
    // here, so a link planted in that window cannot steer the unlink out of the store.
    this.checkObjectDirectories(hash);
    unlinkSync(path);
    syncDirectory(this.objectDirectory(hash));
    return 'removed';
  }

  /**
   * The store's own temporary files, oldest first: only names `put` generates, only regular
   * files, and only those last modified before the cutoff when one is given. An entry with a
   * temporary name that is a link, a directory, or a special file is reported and never
   * followed; anything else under the temporary directory is not the store's and is ignored.
   * Unlike {@link listObjects} this reads the whole temporary directory before applying the
   * limit: the directory holds only files a writer abandoned, and ordering them by age needs
   * all of them.
   */
  async listTemporaryFiles(options: ListTemporaryOptions = {}): Promise<TemporaryListing> {
    const limit = boundedLimit(options.limit);
    const before = options.before;
    if (before !== undefined && !Number.isFinite(before.getTime())) {
      throw new TypeError('before must be a valid Date');
    }
    const problems: CasProblem[] = [];
    const files: TemporaryFile[] = [];
    const tempDir = join(this.root, TEMP_DIR);
    const kind = entryKind(tempDir);
    if (kind === 'missing') return { files, problems };
    if (kind !== 'directory') throw unsafeEntry(this.root, tempDir, kind);
    for (const entry of entriesOf(tempDir).sort(byName)) {
      if (!TEMPORARY_NAME.test(entry.name)) continue;
      const path = join(tempDir, entry.name);
      if (!entry.isFile()) {
        record(problems, problem('NOT_REGULAR', this.root, path, 'not a regular temporary file'));
        continue;
      }
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) continue;
      if (before !== undefined && stat.mtime.getTime() >= before.getTime()) continue;
      files.push({ name: entry.name, sizeBytes: stat.size, modifiedAt: stat.mtime });
    }
    files.sort(
      (a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime() || compare(a.name, b.name),
    );
    return { files: files.slice(0, limit), problems };
  }

  /** Unlinks one temporary file by name, without following anything; a name it did not generate is refused. */
  async removeTemporaryFile(name: string): Promise<'removed' | 'missing'> {
    checkTemporaryName(name);
    const tempDir = join(this.root, TEMP_DIR);
    // The directory itself is checked, not only the file: a link planted at `tmp` would
    // otherwise make this unlink a path outside the store entirely.
    const tempKind = entryKind(tempDir);
    if (tempKind === 'missing') return 'missing';
    if (tempKind !== 'directory') throw unsafeEntry(this.root, tempDir, tempKind);
    const path = join(tempDir, name);
    const kind = entryKind(path);
    if (kind === 'missing') return 'missing';
    if (kind !== 'file') {
      throw new BlobStoreError('BLOB_NOT_REGULAR', `${name} is ${describe(kind)}`);
    }
    // Re-checked immediately before the unlink, for the same reason.
    if (entryKind(tempDir) !== 'directory') throw unsafeEntry(this.root, tempDir, 'symlink');
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw e;
    }
    return 'removed';
  }

  /** The verified object for `hash`, or nothing when there is none; anything else is an error. */
  private async existing(hash: string, size: number): Promise<BlobDescriptor | undefined> {
    this.checkObjectDirectories(hash);
    if (entryKind(this.objectPath(hash)) === 'missing') return undefined;
    const opened = this.openObject(hash);
    if (opened.size !== size) {
      closeSync(opened.fd);
      throw new BlobStoreError(
        'BLOB_SIZE_MISMATCH',
        `object should be ${size} bytes and is ${opened.size}`,
        hash,
      );
    }
    const actual = await sha256Fd(opened.fd);
    if (actual !== hash) {
      throw new BlobStoreError('BLOB_HASH_MISMATCH', `object hashes to ${actual}`, hash);
    }
    return { sha256: hash, sizeBytes: size, storageKey: this.storageKey(hash) };
  }

  private openObject(hash: string): { fd: number; size: number } {
    this.checkObjectDirectories(hash);
    const path = this.objectPath(hash);
    const kind = entryKind(path);
    if (kind === 'missing') throw new BlobStoreError('BLOB_MISSING', `no object for ${hash}`, hash);
    if (kind !== 'file') {
      throw new BlobStoreError('BLOB_NOT_REGULAR', `object is ${describe(kind)}`, hash);
    }
    const opened = openRegular(path);
    if ('refused' in opened) {
      throw opened.refused === 'missing'
        ? new BlobStoreError('BLOB_MISSING', `no object for ${hash}`, hash)
        : new BlobStoreError('BLOB_NOT_REGULAR', `object is ${describe(opened.refused)}`, hash);
    }
    return opened;
  }

  /**
   * Re-opens the entry just linked at the final path and requires it to be the file that was
   * verified: same device and inode, same size. A different entry means the temporary name was
   * swapped under the store between verification and publication.
   */
  private confirmPublished(hash: string, verified: Stats, size: number): void {
    const opened = openRegular(this.objectPath(hash));
    if ('refused' in opened) {
      throw new BlobStoreError('PUBLISH_MISMATCH', `published entry is ${opened.refused}`, hash);
    }
    let stat: Stats;
    try {
      stat = fstatSync(opened.fd);
    } finally {
      closeSync(opened.fd);
    }
    if (stat.dev !== verified.dev || stat.ino !== verified.ino || stat.size !== size) {
      throw new BlobStoreError(
        'PUBLISH_MISMATCH',
        'published entry is not the verified file',
        hash,
      );
    }
  }

  /** Creates a directory the store owns and refuses to proceed through anything else there. */
  private ensureDirectory(path: string, mode: number): void {
    const before = entryKind(path);
    if (before !== 'missing' && before !== 'directory') throw unsafeEntry(this.root, path, before);
    mkdirSync(path, { recursive: true, mode });
    const kind = kindOf(lstatSync(path));
    if (kind !== 'directory') throw unsafeEntry(this.root, path, kind);
  }
}

function unsafeEntry(
  root: string,
  path: string,
  kind: 'symlink' | 'special' | 'file',
): BlobStoreError {
  return new BlobStoreError(
    'ROOT_ENTRY_UNSAFE',
    `${relative(root, path)} under the blob root is ${describe(kind)}, not a directory`,
  );
}

function checkTemporaryName(name: unknown): string {
  if (typeof name !== 'string' || !TEMPORARY_NAME.test(name)) {
    throw new BlobStoreError(
      'INVALID_TEMPORARY_NAME',
      'only a temporary file this store generated can be named',
    );
  }
  return name;
}

function notRegularSource(kind: 'symlink' | 'directory' | 'special', hash: string): BlobStoreError {
  return new BlobStoreError(
    'SOURCE_NOT_REGULAR',
    `the attachment source is ${describe(kind)}; only regular files are read`,
    hash,
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byName(a: { name: string }, b: { name: string }): number {
  return compare(a.name, b.name);
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a positive whole number');
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

/** Keeps one listing's problem list bounded, however much junk is planted under the root. */
function record(problems: CasProblem[], found: CasProblem): void {
  if (problems.length < MAX_PROBLEMS) {
    problems.push(found);
    return;
  }
  if (problems.length === MAX_PROBLEMS) {
    problems.push({
      code: 'UNEXPECTED_ENTRY',
      path: '',
      message: `more than ${MAX_PROBLEMS} entries the layout does not define; the rest are not listed`,
    });
  }
}

/** A directory's entries, or none when it is gone; a concurrent removal is not a failure. */
function entriesOf(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw e;
  }
}

function problem(
  code: CasProblem['code'],
  root: string,
  path: string,
  message: string,
): CasProblem {
  // Always reported the way a storage key reads, whatever the platform's separator is.
  return { code, path: relative(root, path).split(sep).join('/'), message };
}

/** The two-hex directories of one level, in order; anything else there becomes a problem. */
function shards(directory: string, root: string, problems: CasProblem[]): string[] {
  const found: string[] = [];
  for (const entry of entriesOf(directory).sort(byName)) {
    const path = join(directory, entry.name);
    if (!SHARD.test(entry.name)) {
      record(problems, problem('MALFORMED_NAME', root, path, 'not a shard name'));
      continue;
    }
    if (!entry.isDirectory()) {
      record(problems, problem('UNEXPECTED_ENTRY', root, path, 'not a shard directory'));
      continue;
    }
    found.push(entry.name);
  }
  return found;
}

function describe(kind: 'symlink' | 'directory' | 'special' | 'file'): string {
  switch (kind) {
    case 'symlink':
      return 'a symbolic link';
    case 'directory':
      return 'a directory';
    case 'special':
      return 'not a regular file';
    case 'file':
      return 'a regular file';
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Makes a new directory entry durable where the platform lets a directory be synced. */
function syncDirectory(path: string): void {
  if (!POSIX) return;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // A filesystem that cannot sync a directory keeps the entry on its own terms.
  } finally {
    closeSync(fd);
  }
}

/**
 * Streams the source descriptor into the destination descriptor, hashing and counting on the
 * way; stops as soon as the copy exceeds the declared size, so an oversized source is never read
 * to its end. The source stream owns and closes its descriptor, also when the loop leaves early;
 * the destination is written synchronously chunk by chunk and stays the caller's to sync and
 * close, so no stream ever closes it behind the caller's back.
 */
export async function copyAndHash(
  sourceFd: number,
  destinationFd: number,
  declaredSize: number,
  declaredHash: string,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream('', { fd: sourceFd })) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > declaredSize) {
      throw new BlobStoreError(
        'SOURCE_SIZE_MISMATCH',
        `declared ${declaredSize} bytes, source has more`,
        declaredHash,
      );
    }
    hash.update(bytes);
    let written = 0;
    while (written < bytes.length) written += writeSync(destinationFd, bytes, written);
  }
  return { sha256: hash.digest('hex'), size };
}

/** Hashes an already opened regular file; the stream owns and closes the descriptor. */
function sha256Fd(fd: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream('', { fd })
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}
