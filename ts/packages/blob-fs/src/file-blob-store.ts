import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
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
  type Stats,
} from 'node:fs';
import { join, relative } from 'node:path';
import { BlobStoreError } from './errors.js';
import { entryKind, kindOf, openRegular } from './fs-safety.js';
import { checkSha256, checkSize } from './sha256.js';
import type { BlobDescriptor, BlobSource, BlobStore, OpenedBlob, PutResult } from './store.js';

const OBJECTS_DIR = 'sha256';
const TEMP_DIR = 'tmp';
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
export class FileBlobStore implements BlobStore {
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

  private checkSize(size: unknown, hash: string): number {
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
    const size = this.checkSize(source.sizeBytes, hash);
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
    const size = expectedSize === undefined ? undefined : this.checkSize(expectedSize, hash);
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
    const size = this.checkSize(expectedSize, hash);
    const found = await this.existing(hash, size);
    if (!found) throw new BlobStoreError('BLOB_MISSING', `no object for ${hash}`, hash);
    return found;
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

function notRegularSource(kind: 'symlink' | 'directory' | 'special', hash: string): BlobStoreError {
  return new BlobStoreError(
    'SOURCE_NOT_REGULAR',
    `the attachment source is ${describe(kind)}; only regular files are read`,
    hash,
  );
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
