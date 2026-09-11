import { createHash } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { stringifyEvent, type Event, type UnknownEvent } from 'qe-report-protocol';
import { AttachmentTooLargeError, type ReportSink, type StoredAttachment } from './sink.js';

/** Default per-attachment limit: 64 MiB. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const EVENTS_FILE = 'events.ndjson';
export const ATTACHMENTS_DIR = 'attachments';

export interface FileSinkOptions {
  readonly maxAttachmentBytes?: number;
}

/**
 * Writes a run to a directory: `events.ndjson` plus `attachments/<sha256>`.
 *
 * Every event is written synchronously and flushed, so a partial file is inspectable after a
 * crash. Attachment bytes go to a temporary file while hashed, then are renamed to their final
 * name; the producer's display name never influences the path. Nothing is buffered beyond one
 * event.
 */
export class FileSink implements ReportSink {
  private readonly attachmentsDir: string;
  private readonly fd: number;
  private readonly maxAttachmentBytes: number;
  private tempCounter = 0;
  private closed = false;

  private constructor(attachmentsDir: string, fd: number, maxAttachmentBytes: number) {
    this.attachmentsDir = attachmentsDir;
    this.fd = fd;
    this.maxAttachmentBytes = maxAttachmentBytes;
  }

  /** Opens (creating if needed) a run directory. Events are appended if the file exists. */
  static open(directory: string, options: FileSinkOptions = {}): FileSink {
    const max = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    if (max < 0) throw new Error('maxAttachmentBytes must be >= 0');
    const attachments = join(directory, ATTACHMENTS_DIR);
    mkdirSync(attachments, { recursive: true });
    const fd = openSync(join(directory, EVENTS_FILE), 'a');
    return new FileSink(attachments, fd, max);
  }

  write(event: Event | UnknownEvent): void {
    this.ensureOpen();
    writeSync(this.fd, stringifyEvent(event) + '\n');
    fsyncSync(this.fd);
  }

  storeAttachment(bytes: Uint8Array): StoredAttachment {
    this.ensureOpen();
    if (bytes.byteLength > this.maxAttachmentBytes)
      throw new AttachmentTooLargeError(this.maxAttachmentBytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const target = join(this.attachmentsDir, sha256);
    if (!existsSync(target)) {
      const temp = this.tempPath();
      const fd = openSync(temp, 'w');
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, target);
    }
    return { sha256, sizeBytes: bytes.byteLength };
  }

  async storeAttachmentStream(stream: Readable): Promise<StoredAttachment> {
    this.ensureOpen();
    const hash = createHash('sha256');
    let size = 0;
    const limit = this.maxAttachmentBytes;
    const temp = this.tempPath();
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.byteLength;
        if (size > limit) {
          cb(new AttachmentTooLargeError(limit));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, counter, createWriteStream(temp));
    } catch (e) {
      if (existsSync(temp)) unlinkSync(temp);
      throw e;
    }
    const sha256 = hash.digest('hex');
    const target = join(this.attachmentsDir, sha256);
    if (existsSync(target)) unlinkSync(temp);
    else renameSync(temp, target);
    return { sha256, sizeBytes: size };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  private tempPath(): string {
    this.tempCounter += 1;
    return join(this.attachmentsDir, `.tmp-${process.pid}-${this.tempCounter}`);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('sink is closed');
  }
}
