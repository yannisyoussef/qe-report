import type { BlobStoreError } from 'qe-report-blob-fs';

/** One SHA-256 has one size; two records or declarations disagreeing about it cannot both be right. */
export class BlobSizeConflictError extends Error {
  readonly sha256: string;
  readonly recordedSize: number;
  readonly offeredSize: number;

  constructor(sha256: string, recordedSize: number, offeredSize: number, recordedBy: string) {
    super(
      `blob ${sha256} is ${recordedSize} bytes as ${recordedBy} and ${offeredSize} bytes as offered; a hash has one size`,
    );
    this.name = 'BlobSizeConflictError';
    this.sha256 = sha256;
    this.recordedSize = recordedSize;
    this.offeredSize = offeredSize;
  }
}

export type AttachmentIntegrityCode =
  /** The run's source requires a blob the catalog does not relate to it: a legacy archive, or lost metadata. */
  | 'BLOB_RECORD_MISSING'
  /** The catalog's size for the hash is not the size the run's source declares. */
  | 'BLOB_RECORD_SIZE_MISMATCH'
  /** The blob store has no object for the hash. */
  | 'BLOB_MISSING'
  /** The object is there but is not a regular file, or its size or hash is wrong. */
  | 'BLOB_CORRUPT';

/** A stored run's attachment bytes cannot be established from the catalog and the blob store. */
export class AttachmentIntegrityError extends Error {
  readonly code: AttachmentIntegrityCode;
  readonly projectId: string;
  readonly runId: string;
  readonly sha256: string;

  constructor(
    code: AttachmentIntegrityCode,
    projectId: string,
    runId: string,
    sha256: string,
    detail: string,
    cause?: BlobStoreError,
  ) {
    super(
      `attachment ${sha256} of run ${runId} in project ${projectId}: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'AttachmentIntegrityError';
    this.code = code;
    this.projectId = projectId;
    this.runId = runId;
    this.sha256 = sha256;
  }
}
