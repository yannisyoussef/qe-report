import type { Readable } from 'node:stream';

/** Where a blob's bytes are said to come from: a regular file and the declaration to check it against. */
export interface BlobSource {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** A blob the store holds, by identity, size, and the server-generated key it lives under. */
export interface BlobDescriptor {
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Relative, provider-generated, derived from the hash alone; never a caller path. */
  readonly storageKey: string;
}

export interface PutResult extends BlobDescriptor {
  /** `stored`: this call published the bytes; `existing`: a verified object was already there. */
  readonly outcome: 'stored' | 'existing';
}

export interface OpenedBlob extends BlobDescriptor {
  /** The bytes, streamed from an open descriptor the stream owns. */
  readonly stream: Readable;
}

/**
 * Durable content storage keyed by the protocol's SHA-256: the boundary the run archive uses.
 * One provider exists, {@link FileBlobStore}; the interface is what it needs, not a framework.
 */
export interface BlobStore {
  /** The key a hash maps to, without touching the filesystem. */
  storageKey(sha256: string): string;
  /** Materialises, hashes, verifies, and publishes; or verifies and reuses what is there. */
  put(source: BlobSource): Promise<PutResult>;
  /** Presence and size by inspection, without hashing; nothing when absent. */
  stat(sha256: string): Promise<BlobDescriptor | undefined>;
  /** Opens the bytes for reading; the size is checked when the caller states it. */
  open(sha256: string, expectedSize?: number): Promise<OpenedBlob>;
  /** Re-reads the whole object: regular file, exact size, full SHA-256. */
  verify(sha256: string, expectedSize: number): Promise<BlobDescriptor>;
}

/** A CAS entry maintenance refused to treat as a blob; its path is relative to the blob root. */
export interface CasProblem {
  readonly code:
    /** A name where a two-hex shard or a 64-hex object belongs. */
    | 'MALFORMED_NAME'
    /** A well-formed hash filed under a shard its own hash does not name. */
    | 'WRONG_SHARD'
    /** A link, a directory, or a special file where a regular object belongs; never followed. */
    | 'NOT_REGULAR'
    /** Anything else the layout does not define, at a level the store owns. */
    | 'UNEXPECTED_ENTRY';
  /** Relative to the blob root, with `/` separators whatever the platform uses. An absolute path is never reported. */
  readonly path: string;
  readonly message: string;
}

export interface ListObjectsOptions {
  /** Continue after this hash, from a previous listing's `next`. */
  readonly after?: string;
  /** Most objects to return; the listing is always bounded. */
  readonly limit?: number;
}

/** A canonical object as maintenance sees it on the medium. */
export interface ObjectEntry extends BlobDescriptor {
  readonly modifiedAt: Date;
}

export interface ObjectListing {
  /** Canonical objects in hash order. */
  readonly objects: readonly ObjectEntry[];
  /** Pass as `after` to continue; absent when the enumeration reached the end. */
  readonly next: string | undefined;
  readonly problems: readonly CasProblem[];
}

/** An unpublished temporary file of the store, as maintenance sees it. */
export interface TemporaryFile {
  /** The file's own name under the temporary directory; never a path. */
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
}

export interface ListTemporaryOptions {
  /** Only files last modified strictly before this instant. */
  readonly before?: Date;
  readonly limit?: number;
}

export interface TemporaryListing {
  readonly files: readonly TemporaryFile[];
  readonly problems: readonly CasProblem[];
}

/**
 * What an operator-level retention pass needs from a blob provider, beyond reading. Deleting a
 * blob is a lifecycle action a maintenance caller takes deliberately; it is not part of
 * {@link BlobStore}, and it does not weaken `put`, which still never replaces an object.
 */
export interface BlobMaintenance {
  /** Where a temporary file of this name sits, relative to the root; for reporting only. */
  temporaryKey(name: string): string;
  /** Canonical objects on the medium itself, in hash order, bounded and resumable. */
  listObjects(options?: ListObjectsOptions): Promise<ObjectListing>;
  /**
   * Re-verifies an object and unlinks it: regular file, expected size when the caller knows it,
   * full SHA-256, and the entry still the file that was read. A corrupt or unsafe entry throws
   * and stays; an object that is already gone answers `missing`.
   */
  removeObject(sha256: string, expectedSize?: number): Promise<'removed' | 'missing'>;
  /** Temporary files the store may have left behind, oldest first. */
  listTemporaryFiles(options?: ListTemporaryOptions): Promise<TemporaryListing>;
  /** Unlinks one temporary file by the name a listing gave. */
  removeTemporaryFile(name: string): Promise<'removed' | 'missing'>;
}
