import { closeSync, createReadStream, openSync, readSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  LIMITS,
  PROTOCOL_VERSION,
  stringifyEvent,
  type Event,
  type EventInput,
  type SessionFinishedPayload,
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
  /** A session-scoped event was emitted after session.finished and was dropped. */
  | 'SESSION_FINISHED'
  /** An event was emitted after run.finished and was dropped. */
  | 'RUN_FINISHED'
  /** A payload violates a rule of the protocol and was dropped. */
  | 'INVALID_PAYLOAD';

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

/**
 * Lifecycle of a session: `active` accepts every event; `session-finished` accepts only
 * `run.finished`; `run-finished` and `closed` accept nothing.
 */
export type SessionState = 'active' | 'session-finished' | 'run-finished' | 'closed';

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
  private lifecycle: SessionState = 'active';

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

  get state(): SessionState {
    return this.lifecycle;
  }

  /**
   * Emits one event. Returns false if it was dropped; the handler has been told why. After
   * `session.finished` only `run.finished` is accepted; after `run.finished` nothing is.
   */
  emit(input: EventInput): boolean {
    if (input.eventType === 'run.finished') return this.finishRun();
    if (!this.acceptsSessionEvents(`event ${input.eventType}`)) return false;
    const ok = this.write(input);
    if (ok && input.eventType === 'session.finished') this.lifecycle = 'session-finished';
    return ok;
  }

  /** Stores bytes as an attachment and emits `attachment.added`. Text is redacted first. */
  attach(input: AttachmentInput, bytes: Uint8Array): boolean {
    if (!this.acceptsSessionEvents(`attachment ${input.name}`)) return false;
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
   * Stores a file as an attachment and emits `attachment.added`. Binary content is streamed.
   * Text is read into memory so it can be redacted, but never more than the sink's attachment
   * limit plus one byte: a larger file is reported as too large without being read further.
   */
  async attachFile(input: AttachmentInput, path: string): Promise<boolean> {
    if (!this.acceptsSessionEvents(`attachment ${input.name}`)) return false;
    try {
      if (isTextualMediaType(input.mediaType)) {
        const bytes = readBounded(path, this.sink.maxAttachmentBytes);
        if (bytes === undefined)
          return this.storeFailed(input, new AttachmentTooLargeError(this.sink.maxAttachmentBytes));
        return this.attach(input, bytes);
      }
      const stored = await this.sink.storeAttachmentStream(createReadStream(path));
      return this.emitAttachment(input, stored);
    } catch (e) {
      return this.storeFailed(input, e);
    }
  }

  /**
   * Emits `session.finished`, with the runner's aggregate outcome for this session when the
   * runner exposes one; a producer without one passes nothing. Only `run.finished` is accepted
   * afterwards.
   */
  finish(outcome: SessionFinishedPayload = {}): boolean {
    const violation = outcomeViolation(outcome);
    if (violation !== undefined) {
      this.dropped += 1;
      this.problem('INVALID_PAYLOAD', `session.finished ${violation}; dropped`);
      return false;
    }
    if (this.emit({ eventType: 'session.finished', payload: outcome })) return true;
    if (this.lifecycle !== 'active') return false;
    // Dropped while the session is still active (the outcome exceeded the event limit, or the sink
    // failed): the session must still close, so the outcome is retried without its failures, then
    // as the empty payload. Each reduction is reported.
    if (outcome.failures !== undefined && outcome.failures.length > 0) {
      this.problem(
        'EVENT_TOO_LARGE',
        'session.finished retried without its failures so that the session closes',
      );
      const reduced: SessionFinishedPayload = {
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        ...(outcome.rawStatus !== undefined ? { rawStatus: outcome.rawStatus } : {}),
      };
      if (this.emit({ eventType: 'session.finished', payload: reduced })) return true;
      if (this.lifecycle !== 'active') return false;
    }
    if (outcome.status !== undefined) {
      this.problem(
        'EVENT_TOO_LARGE',
        'session.finished retried with an empty payload so that the session closes',
      );
      return this.emit({ eventType: 'session.finished', payload: {} });
    }
    return false;
  }

  /**
   * Emits `run.finished`, after `session.finished` if the session is still active. Only for a
   * producer that knows every session of the run has finished; a forked worker must not call it.
   */
  finishRun(): boolean {
    if (this.lifecycle === 'active' && !this.finish()) return false;
    if (this.lifecycle !== 'session-finished') {
      this.dropped += 1;
      this.problem(
        'RUN_FINISHED',
        `run.finished emitted after ${this.lifecycle.replace('-', '.')}; dropped`,
      );
      return false;
    }
    const ok = this.write({ eventType: 'run.finished', payload: {} });
    if (ok) this.lifecycle = 'run-finished';
    return ok;
  }

  /** Finishes the session if it is still active and closes the sink. */
  close(): void {
    if (this.lifecycle === 'closed') return;
    if (this.lifecycle === 'active') this.finish();
    this.lifecycle = 'closed';
    try {
      this.sink.close();
    } catch (e) {
      this.problem('SINK_FAILURE', 'cannot close sink', e);
    }
  }

  summary(): SessionSummary {
    return { eventsWritten: this.written, eventsDropped: this.dropped };
  }

  /** False, with a problem reported and counted, when the lifecycle no longer accepts session events. */
  private acceptsSessionEvents(what: string): boolean {
    if (this.lifecycle === 'active') return true;
    this.dropped += 1;
    const kind: ReportProblemKind =
      this.lifecycle === 'run-finished' ? 'RUN_FINISHED' : 'SESSION_FINISHED';
    this.problem(kind, `${what} emitted after ${this.lifecycle.replace('-', '.')}; dropped`);
    return false;
  }

  private write(input: EventInput): boolean {
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
    return true;
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

/** The rule an outcome breaks, if any: the same three the codec and the schema enforce. */
function outcomeViolation(o: SessionFinishedPayload): string | undefined {
  const some = o.failures !== undefined && o.failures.length > 0;
  if (o.status === undefined && o.rawStatus !== undefined) return 'rawStatus requires status';
  if (o.status === undefined && some) return 'failures require status';
  if (o.status === 'passed' && some) return 'a passed session carries no failures';
  return undefined;
}

/** Reads at most `limit` bytes; returns undefined as soon as the file proves larger. */
function readBounded(path: string, limit: number): Buffer | undefined {
  const fd = openSync(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > limit) return undefined;
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}
