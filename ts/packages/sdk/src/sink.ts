import type { Event, UnknownEvent } from 'qe-report-protocol';
import type { Readable } from 'node:stream';

/** Digest and size of stored bytes. */
export interface StoredAttachment {
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Thrown by a sink when an attachment exceeds its limit; nothing was stored. */
export class AttachmentTooLargeError extends Error {
  constructor(limit: number) {
    super(`attachment exceeds ${limit} bytes`);
    this.name = 'AttachmentTooLargeError';
  }
}

/** Where a session writes events and attachment bytes. */
export interface ReportSink {
  /** The largest attachment the sink stores, in bytes. Text is bounded to this before it is read. */
  readonly maxAttachmentBytes: number;
  /** Writes one event. The event is already redacted and within the size limit. */
  write(event: Event | UnknownEvent): void;
  /** Stores bytes and returns their digest and size. */
  storeAttachment(bytes: Uint8Array): StoredAttachment;
  /** Stores a stream and returns its digest and size. */
  storeAttachmentStream(stream: Readable): Promise<StoredAttachment>;
  close(): void;
}
