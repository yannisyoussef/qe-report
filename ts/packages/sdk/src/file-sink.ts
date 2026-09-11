import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { stringifyEvent, type Event, type UnknownEvent } from 'qe-report-protocol';
import { sessionFileName } from './session-file.js';
import { AttachmentTooLargeError, type ReportSink, type StoredAttachment } from './sink.js';

/** Default per-attachment limit: 64 MiB. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const EVENTS_DIR = 'events';
export const ATTACHMENTS_DIR = 'attachments';

export interface FileSinkOptions {
  readonly maxAttachmentBytes?: number;
}

/**
 * Writes one session of a run to a run directory:
 *
 * ```
 * <run>/events/<session file>.ndjson   this session's events, created exclusively
 * <run>/attachments/<sha256>           bytes shared by every session of the run
 * ```
 *
 * Several processes may write to the same run directory at once: each owns its event file, and
 * attachment bytes are written to a uniquely named temporary file, hashed, and published under
 * the hash by rename. Two writers publishing the same bytes both succeed. Every event is written
 * and flushed as it comes, so a partial file is inspectable after a crash.
 */
export class FileSink implements ReportSink {
  readonly maxAttachmentBytes: number;
  /** Absolute or relative path of this session's event file. */
  readonly eventFile: string;
  private readonly attachmentsDir: string;
  private readonly fd: number;
  private closed = false;

  private constructor(
    eventFile: string,
    attachmentsDir: string,
    fd: number,
    maxAttachmentBytes: number,
  ) {
    this.eventFile = eventFile;
    this.attachmentsDir = attachmentsDir;
    this.fd = fd;
    this.maxAttachmentBytes = maxAttachmentBytes;
  }

  /**
   * Opens the sink for one session. The event file is created exclusively and must not exist:
   * a second process using the same sessionId is a producer error, reported here rather than
   * silently interleaved. A restarted producer uses a new sessionId.
   */
  static open(runDirectory: string, sessionId: string, options: FileSinkOptions = {}): FileSink {
    const max = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    if (max < 0) throw new Error('maxAttachmentBytes must be >= 0');
    const events = join(runDirectory, EVENTS_DIR);
    const attachments = join(runDirectory, ATTACHMENTS_DIR);
    mkdirSync(events, { recursive: true });
    mkdirSync(attachments, { recursive: true });
    const eventFile = join(events, sessionFileName(sessionId));
    const fd = openSync(eventFile, 'wx');
    return new FileSink(eventFile, attachments, fd, max);
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
    const temp = this.createTemp();
    try {
      const fd = openSync(temp, 'wx');
      try {
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      this.discard(temp);
      throw e;
    }
    this.publish(temp, sha256, bytes.byteLength);
    return { sha256, sizeBytes: bytes.byteLength };
  }

  async storeAttachmentStream(stream: Readable): Promise<StoredAttachment> {
    this.ensureOpen();
    const hash = createHash('sha256');
    let size = 0;
    const limit = this.maxAttachmentBytes;
    const temp = this.createTemp();
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
      await pipeline(stream, counter, createWriteStream(temp, { flags: 'wx' }));
    } catch (e) {
      this.discard(temp);
      throw e;
    }
    const sha256 = hash.digest('hex');
    this.publish(temp, sha256, size);
    return { sha256, sizeBytes: size };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  /** A temporary name that no other process or sink instance can produce. */
  private createTemp(): string {
    return join(this.attachmentsDir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  }

  /**
   * Publishes a fully written temporary file under its hash. On POSIX, rename replaces an
   * existing target atomically, so concurrent identical publications both succeed. Where rename
   * refuses an existing target, the existing file is accepted when its size matches: it can only
   * have been published by this same procedure from bytes with the same hash.
   */
  private publish(temp: string, sha256: string, size: number): void {
    const target = join(this.attachmentsDir, sha256);
    try {
      renameSync(temp, target);
    } catch (e) {
      if (this.matches(target, size)) {
        this.discard(temp);
        return;
      }
      this.discard(temp);
      throw e;
    }
  }

  private matches(target: string, size: number): boolean {
    try {
      return statSync(target).size === size;
    } catch {
      return false;
    }
  }

  private discard(temp: string): void {
    try {
      unlinkSync(temp);
    } catch {
      // already gone
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('sink is closed');
  }
}
