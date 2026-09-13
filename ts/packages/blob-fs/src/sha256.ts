import { BlobStoreError } from './errors.js';

const SHA256 = /^[0-9a-f]{64}$/u;

/** The protocol's attachment hash: 64 lower-case hex characters, nothing else. */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

export function checkSha256(value: unknown): string {
  if (!isSha256(value)) {
    throw new BlobStoreError(
      'INVALID_SHA256',
      'a blob is addressed by its full lower-case hex SHA-256 (64 characters)',
    );
  }
  return value;
}

export function checkSize(value: unknown, sha256: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BlobStoreError('INVALID_SIZE', 'a blob size is a non-negative byte count', sha256);
  }
  return value;
}
