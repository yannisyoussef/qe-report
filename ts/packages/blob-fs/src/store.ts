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
