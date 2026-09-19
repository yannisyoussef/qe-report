import { DEFAULT_MAX_BLOB_BYTES } from 'qe-report-blob-fs';

const MiB = 1024 * 1024;

/**
 * What one request may make the server hold or read. Every value is finite; a request past any
 * of them is refused with 413 and leaves nothing behind.
 */
export interface TransportLimits {
  /** Every byte of a request body, multipart framing included. */
  readonly maxRequestBytes: number;
  /** `events` parts in one upload. */
  readonly maxEventParts: number;
  /** Bytes across every `events` part of one upload. */
  readonly maxEventBytes: number;
  /** `attachment` parts in one upload. */
  readonly maxAttachmentParts: number;
  /** Bytes of one `attachment` part; never more than the blob store accepts. */
  readonly maxAttachmentBytes: number;
  /** Bytes across every `attachment` part of one upload. */
  readonly maxTotalAttachmentBytes: number;
  /** A JSON request body, such as a history query. */
  readonly maxJsonBodyBytes: number;
}

export const DEFAULT_TRANSPORT_LIMITS: TransportLimits = {
  maxRequestBytes: 1024 * MiB,
  maxEventParts: 64,
  maxEventBytes: 256 * MiB,
  maxAttachmentParts: 256,
  maxAttachmentBytes: DEFAULT_MAX_BLOB_BYTES,
  maxTotalAttachmentBytes: 512 * MiB,
  maxJsonBodyBytes: 64 * 1024,
};

/** The defaults with the caller's overrides, each checked to be a usable finite bound. */
export function resolveLimits(
  overrides: Partial<TransportLimits> = {},
  maxBlobBytes: number = DEFAULT_MAX_BLOB_BYTES,
): TransportLimits {
  const limits = { ...DEFAULT_TRANSPORT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a whole number of at least one`);
    }
  }
  if (limits.maxAttachmentBytes > maxBlobBytes) {
    throw new TypeError(
      `maxAttachmentBytes (${limits.maxAttachmentBytes}) must not exceed what the blob store accepts (${maxBlobBytes})`,
    );
  }
  return limits;
}
