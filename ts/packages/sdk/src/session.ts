import { createReadStream, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  LIMITS,
  PROTOCOL_VERSION,
  stringifyEvent,
  type Event,
  type EventInput,
  type SessionStartedPayload,
} from 'qe-report-protocol';
import { isTextualMediaType } from './media-types.js';
import { Redactor } from './redactor.js';
import { AttachmentTooLargeError, type ReportSink, type StoredAttachment } from './sink.js';

export type ReportProblemKind =
  /** The serialised event exceeds the size limit and was dropped. */
  | 'EVENT_TOO_LARGE'
  /** The attachment exceeds the size limit and was not stored. */
  | 'ATTACHMENT_TOO_LARGE'
  /** The sink failed; the event or attachment is lost. */
  | 'SINK_FAILURE'
  /** An event was emitted after the session finished and was dropped. */
  | 'SESSION_FINISHED';

/**
 * Something the SDK could not do. Problems never change a test result and never propagate into
 * the test; they are delivered to the handler.
 */
export interface ReportProblem {
  readonly kind: ReportProblemKind;
  readonly message: string;
  readonly cause?: unknown;
}

export type ReportProblemHandler = (problem: ReportProblem) => void;

/** Prints each problem once to standard error. */
export const standardErrorProblemHandler: ReportProblemHandler = (p) => {
  process.stderr.write(`qe-report: ${p.kind}: ${p.message}\n`);
  if (p.cause !== undefined) process.stderr.write(`qe-report:   cause: ${String(p.cause)}\n`);
};

export interface ReportSessionOptions {
  readonly runId: string;
  readonly sessionId: string;
  readonly sink: ReportSink;
  /** The clock for `occurredAt`. Inject a fixed clock for deterministic output. */
  readonly clock?: () => Date;
  /** Generates event ids. Inject a counter for deterministic output. */
  readonly ids?: () => string;
  readonly redactor?: Redactor;
  readonly onProblem?: ReportProblemHandler;
  /** Lowers the event size limit. It cannot be raised above the protocol limit. */
  readonly maxEventBytes?: number;
}

export interface AttachmentInput {
  readonly attemptId: string;
  readonly stepId?: string;
  readonly name: string;
  readonly mediaType: string;
}

export interface SessionSummary {
  readonly eventsWritten: number;
  readonly eventsDropped: number;
}

/**
 * Writes the events of one session: fills the envelope (protocol version, event id, sequence,
 * timestamp), redacts, enforces the event size limit, and hands the result to a sink. Nothing
 * thrown by the sink escapes; problems go to the handler.
 */
export class ReportSession {
  readonly runId: string;
  readonly sessionId: string;
  private readonly sink: ReportSink;
  private readonly clock: () => Date;
  private readonly ids: () => string;
  private readonly redactor: Redactor;
  private readonly onProblem: ReportProblemHandler;
  private readonly maxEventBytes: number;
  private sequence = 0;
  private written = 0;
  private dropped = 0;
  private finished = false;
  private closed = false;

  private constructor(options: ReportSessionOptions) {
    this.runId = options.runId;
    this.sessionId = options.sessionId;
    this.sink = options.sink;
    this.clock = options.clock ?? (() => new Date());
    this.ids = options.ids ?? (() => randomUUID());
    this.redactor = options.redactor ?? Redactor.defaults();
    this.onProblem = options.onProblem ?? standardErrorProblemHandler;
    const max = options.maxEventBytes ?? LIMITS.maxEventBytes;
    if (max < 1 || max > LIMITS.maxEventBytes) {
      throw new Error(`maxEventBytes must be within 1..${LIMITS.maxEventBytes}`);
    }
    this.maxEventBytes = max;
  }

  /** Creates the session and emits `session.started`. */
  static start(options: ReportSessionOptions, payload: SessionStartedPayload): ReportSession {
    const session = new ReportSession(options);
    session.emit({ eventType: 'session.started', payload });
    return session;
  }

  /** Emits one event. Returns false if it was dropped; the handler has been told why. */
  emit(input: EventInput): boolean {
    if (this.finished) {
      this.dropped += 1;
      this.problem(
        'SESSION_FINISHED',
        `event ${input.eventType} emitted after session.finished; dropped`,
      );
      return false;
    }
    const candidate = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: this.ids(),
      eventType: input.eventType,
      runId: this.runId,
      sessionId: this.sessionId,
      sequence: this.sequence + 1,
      occurredAt: this.clock().toISOString(),
      payload: input.payload,
    } as Event;
    const event = this.redactor.redactEvent(candidate);
    const bytes = Buffer.byteLength(stringifyEvent(event), 'utf8') + 1;
    if (bytes > this.maxEventBytes) {
      this.dropped += 1;
      this.problem(
        'EVENT_TOO_LARGE',
        `event ${input.eventType} is ${bytes} bytes, limit ${this.maxEventBytes}; dropped`,
      );
      return false;
    }
    try {
      this.sink.write(event);
    } catch (e) {
      this.dropped += 1;
      this.problem('SINK_FAILURE', `cannot write ${input.eventType}`, e);
      return false;
    }
    this.sequence += 1;
    this.written += 1;
    if (input.eventType === 'session.finished') this.finished = true;
    return true;
  }

  /** Stores bytes as an attachment and emits `attachment.added`. Text is redacted first. */
  attach(input: AttachmentInput, bytes: Uint8Array): boolean {
    let content = bytes;
    if (isTextualMediaType(input.mediaType)) {
      content = Buffer.from(this.redactor.redactText(Buffer.from(bytes).toString('utf8')), 'utf8');
    }
    let stored: StoredAttachment;
    try {
      stored = this.sink.storeAttachment(content);
    } catch (e) {
      return this.storeFailed(input, e);
    }
    return this.emitAttachment(input, stored);
  }

  /**
   * Stores a file as an attachment and emits `attachment.added`. Binary content is streamed; text
   * is read fully so it can be redacted.
   */
  async attachFile(input: AttachmentInput, path: string): Promise<boolean> {
    try {
      if (isTextualMediaType(input.mediaType)) return this.attach(input, readFileSync(path));
      const stored = await this.sink.storeAttachmentStream(createReadStream(path));
      return this.emitAttachment(input, stored);
    } catch (e) {
      return this.storeFailed(input, e);
    }
  }

  /** Emits `session.finished`. Further events are dropped and reported. */
  finish(): boolean {
    return this.emit({ eventType: 'session.finished', payload: {} });
  }

  /**
   * Emits `run.finished`. Only for a producer that knows every session of the run has finished;
   * the session itself is finished first if it is not already.
   */
  finishRun(): boolean {
    if (!this.finished) this.finish();
    this.finished = false;
    const ok = this.emit({ eventType: 'run.finished', payload: {} });
    this.finished = true;
    return ok;
  }

  /** Finishes the session if needed and closes the sink. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.finished) this.finish();
    try {
      this.sink.close();
    } catch (e) {
      this.problem('SINK_FAILURE', 'cannot close sink', e);
    }
  }

  summary(): SessionSummary {
    return { eventsWritten: this.written, eventsDropped: this.dropped };
  }

  private emitAttachment(input: AttachmentInput, stored: StoredAttachment): boolean {
    return this.emit({
      eventType: 'attachment.added',
      payload: {
        attemptId: input.attemptId,
        ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
        name: input.name,
        mediaType: input.mediaType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
      },
    });
  }

  private storeFailed(input: AttachmentInput, e: unknown): boolean {
    if (e instanceof AttachmentTooLargeError)
      this.problem('ATTACHMENT_TOO_LARGE', `attachment ${input.name}`, e);
    else this.problem('SINK_FAILURE', `cannot store attachment ${input.name}`, e);
    return false;
  }

  private problem(kind: ReportProblemKind, message: string, cause?: unknown): void {
    this.onProblem(cause === undefined ? { kind, message } : { kind, message, cause });
  }
}
