export type BlobStoreErrorCode =
  /** The caller's SHA-256 is not 64 lower-case hex characters, or the size is not a byte count. */
  | 'INVALID_SHA256'
  | 'INVALID_SIZE'
  /** The declared size exceeds what the store accepts; nothing is read. */
  | 'BLOB_TOO_LARGE'
  /** The source file to materialise is gone, or is not a regular file. */
  | 'SOURCE_MISSING'
  | 'SOURCE_NOT_REGULAR'
  /** The source bytes disagree with their declaration. */
  | 'SOURCE_SIZE_MISMATCH'
  | 'SOURCE_HASH_MISMATCH'
  /** The final object is absent, not a regular file, or does not carry the bytes its name says. */
  | 'BLOB_MISSING'
  | 'BLOB_NOT_REGULAR'
  | 'BLOB_SIZE_MISMATCH'
  | 'BLOB_HASH_MISMATCH'
  /** The entry found at the final path right after publication is not the verified file. */
  | 'PUBLISH_MISMATCH'
  /** A directory the store created or expects under its root is a link or not a directory. */
  | 'ROOT_ENTRY_UNSAFE';

/**
 * Every failure the store reports about its inputs or its objects. Operational errors (a full
 * disk, a permission problem) are thrown as they come from the runtime.
 */
export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode;
  readonly sha256: string | undefined;

  constructor(code: BlobStoreErrorCode, message: string, sha256?: string) {
    super(message);
    this.name = 'BlobStoreError';
    this.code = code;
    this.sha256 = sha256;
  }
}
