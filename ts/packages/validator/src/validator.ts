import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENT_TYPES,
  LIMITS,
  ProtocolError,
  eventFromObject,
  isKnownEvent,
  type Event,
  type UnknownEvent,
} from 'qe-report-protocol';

export type DiagnosticCode =
  | 'MALFORMED_JSON'
  | 'SCHEMA_INVALID'
  | 'UNSUPPORTED_PROTOCOL_VERSION'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'EVENT_TOO_LARGE'
  | 'LIFECYCLE_INVALID'
  | 'ATTACHMENT_MISSING'
  | 'ATTACHMENT_SIZE_MISMATCH'
  | 'ATTACHMENT_HASH_MISMATCH'
  | 'IGNORED_EVENT_TYPE'
  | 'DUPLICATE_EVENT'
  | 'INCOMPLETE_RUN';

export type LifecycleDetail =
  | 'RUN_ID_MISMATCH'
  | 'SESSION_NOT_STARTED'
  | 'SESSION_ALREADY_STARTED'
  | 'SESSION_ALREADY_FINISHED'
  | 'SESSION_FILE_MIXED'
  | 'SEQUENCE_GAP'
  | 'DUPLICATE_EVENT_ID'
  | 'EVENT_AFTER_RUN_FINISHED'
  | 'DUPLICATE_RUN_FINISHED'
  | 'SESSION_NOT_FINISHED_AT_RUN_END'
  | 'DUPLICATE_ATTEMPT_ID'
  | 'ATTEMPT_NOT_STARTED'
  | 'DUPLICATE_ATTEMPT_FINISHED'
  | 'ATTEMPT_NOT_FINISHED_AT_SESSION_END'
  | 'HISTORICAL_ID_WITHOUT_RUNNER'
  | 'STEP_OUTSIDE_ATTEMPT'
  | 'STEP_PARENT_UNKNOWN'
  | 'DUPLICATE_STEP_ID'
  | 'STEP_NOT_STARTED'
  | 'DUPLICATE_STEP_FINISHED'
  | 'STEP_NOT_FINISHED_AT_ATTEMPT_END'
  | 'ATTACHMENT_ATTEMPT_UNKNOWN'
  | 'ATTACHMENT_AFTER_ATTEMPT_FINISHED'
  | 'ATTACHMENT_STEP_UNKNOWN';

export interface Diagnostic {
  readonly severity: 'error' | 'info';
  readonly code: DiagnosticCode;
  /** The event file the diagnostic concerns, as given to the validator. */
  readonly file: string;
  /** 1-based line in that file; 0 when the diagnostic concerns the whole run. */
  readonly line: number;
  readonly eventId?: string;
  readonly pointer?: string;
  readonly detail?: LifecycleDetail;
  readonly message: string;
}

export interface Summary {
  readonly files: number;
  readonly events: number;
  readonly sessions: number;
  readonly attempts: number;
  readonly steps: number;
  readonly attachments: number;
  readonly ignored: number;
  readonly duplicates: number;
  /** Every session, attempt, and step that started also finished. */
  readonly complete: boolean;
  /** A run.finished event was seen. */
  readonly closed: boolean;
}

export interface Report {
  readonly valid: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly summary: Summary;
}

export interface ValidateOptions {
  /** Directory holding attachment bytes named by SHA-256. When absent, declared attachments are not checked. */
  readonly attachmentsDir?: string;
  /** Report an incomplete run as an error instead of an info. */
  readonly requireComplete?: boolean;
  readonly maxEventBytes?: number;
}

const SCHEMA_PATH = new URL('../schema/event.schema.json', import.meta.url);

interface Validators {
  readonly envelope: ValidateFunction;
  readonly byType: ReadonlyMap<string, ValidateFunction>;
}

let cached: Validators | undefined;

/** Loads the schema shipped with this package and compiles one validator per event type. */
function validators(): Validators {
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true });
  addFormats.default(ajv);
  const { $id: _id, oneOf: _oneOf, ...base } = schema;
  void _id;
  void _oneOf;
  const envelope = ajv.compile(base);
  const byType = new Map<string, ValidateFunction>();
  for (const t of EVENT_TYPES) {
    byType.set(t, ajv.compile({ ...base, allOf: [{ $ref: `#/$defs/event.${t}` }] }));
  }
  cached = { envelope, byType };
  return cached;
}

function firstError(errors: ErrorObject[] | null | undefined): {
  pointer: string;
  message: string;
} {
  const e = errors?.[0];
  if (!e) return { pointer: '', message: 'schema violation' };
  const extra =
    e.params && 'missingProperty' in e.params ? ` '${String(e.params['missingProperty'])}'` : '';
  return {
    pointer: e.instancePath,
    message: `${e.instancePath || '/'} ${e.message ?? 'invalid'}${extra}`,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

interface SessionState {
  finished: boolean;
  lastSequence: number;
  runnerName: string | undefined;
}
interface AttemptState {
  session: string;
  finished: boolean;
  steps: Map<string, boolean>;
}
interface Location {
  file: string;
  line: number;
  eventId: string;
}

/**
 * Validates one run, fed one event file at a time. Ordering is defined only inside a session,
 * so files are independent except for run-level facts: one runId, unique event and session ids,
 * at most one run.finished, and every session finished when the run is closed.
 */
export class RunValidator {
  private readonly v = validators();
  private readonly options: ValidateOptions;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly seen = new Map<string, string>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly attempts = new Map<string, AttemptState>();
  private readonly attachments: (Location & { sha256: string; sizeBytes: number })[] = [];
  private runId: string | undefined;
  private runFinished: Location | undefined;
  private files = 0;
  private events = 0;
  private ignored = 0;
  private duplicates = 0;
  private steps = 0;

  constructor(options: ValidateOptions = {}) {
    this.options = options;
  }

  /**
   * Validates the lines of one event file. With `singleSession`, every event in the file must
   * belong to the session of its first event, as a session file written by a file sink does.
   */
  feed(lines: Iterable<string>, file: string, singleSession: boolean): void {
    this.files += 1;
    const maxEventBytes = this.options.maxEventBytes ?? LIMITS.maxEventBytes;
    let line = 0;
    let fileSession: string | undefined;
    let closedHere = false;
    let abandoned = false;
    const error = (
      code: DiagnosticCode,
      message: string,
      extra: Partial<Diagnostic> = {},
    ): void => {
      this.diagnostics.push({ severity: 'error', code, file, line, message, ...extra });
    };
    const lifecycle = (detail: LifecycleDetail, message: string, eventId: string): void =>
      error('LIFECYCLE_INVALID', message, { detail, eventId });

    for (const raw of lines) {
      line += 1;
      if (abandoned || raw.trim() === '') continue;
      if (Buffer.byteLength(raw, 'utf8') + 1 > maxEventBytes) {
        error(
          'EVENT_TOO_LARGE',
          `event is ${Buffer.byteLength(raw, 'utf8') + 1} bytes, limit ${maxEventBytes}`,
        );
        continue;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (e) {
        error('MALFORMED_JSON', `not JSON: ${(e as Error).message}`);
        continue;
      }
      let event: Event | UnknownEvent;
      try {
        event = eventFromObject(parsedJson);
      } catch (e) {
        if (e instanceof ProtocolError) {
          const extra: Partial<Diagnostic> = e.pointer !== undefined ? { pointer: e.pointer } : {};
          error(e.code, e.message, extra);
          continue;
        }
        throw e;
      }
      const validate = isKnownEvent(event) ? this.v.byType.get(event.eventType) : this.v.envelope;
      if (validate && !validate(parsedJson)) {
        const { pointer, message } = firstError(validate.errors);
        error('SCHEMA_INVALID', message, { pointer, eventId: event.eventId });
        continue;
      }
      const key = canonical(parsedJson);
      const previous = this.seen.get(event.eventId);
      if (previous !== undefined) {
        if (previous === key) {
          this.duplicates += 1;
          this.diagnostics.push({
            severity: 'info',
            code: 'DUPLICATE_EVENT',
            file,
            line,
            eventId: event.eventId,
            message: 'identical duplicate ignored',
          });
        } else {
          lifecycle(
            'DUPLICATE_EVENT_ID',
            `eventId ${event.eventId} reused with different content`,
            event.eventId,
          );
        }
        continue;
      }
      this.seen.set(event.eventId, key);
      this.events += 1;
      if (this.runId === undefined) this.runId = event.runId;
      else if (this.runId !== event.runId)
        lifecycle(
          'RUN_ID_MISMATCH',
          `runId ${event.runId} differs from ${this.runId}`,
          event.eventId,
        );
      if (singleSession) {
        if (fileSession === undefined) fileSession = event.sessionId;
        else if (fileSession !== event.sessionId) {
          lifecycle(
            'SESSION_FILE_MIXED',
            `session ${event.sessionId} in the file of session ${fileSession}`,
            event.eventId,
          );
          continue;
        }
      }
      if (closedHere)
        lifecycle(
          'EVENT_AFTER_RUN_FINISHED',
          `${event.eventType} after run.finished`,
          event.eventId,
        );

      let session = this.sessions.get(event.sessionId);
      if (event.eventType === 'session.started') {
        if (session) {
          lifecycle(
            'SESSION_ALREADY_STARTED',
            `session ${event.sessionId} started twice`,
            event.eventId,
          );
          if (singleSession) abandoned = true;
          continue;
        }
        session = {
          finished: false,
          lastSequence: 0,
          runnerName:
            isKnownEvent(event) && event.eventType === 'session.started'
              ? event.payload.runner?.name
              : undefined,
        };
        this.sessions.set(event.sessionId, session);
      } else if (!session) {
        lifecycle(
          'SESSION_NOT_STARTED',
          `${event.eventType} before session.started for ${event.sessionId}`,
          event.eventId,
        );
        session = { finished: false, lastSequence: event.sequence - 1, runnerName: undefined };
        this.sessions.set(event.sessionId, session);
      }
      if (event.sequence !== session.lastSequence + 1) {
        lifecycle(
          'SEQUENCE_GAP',
          `sequence ${event.sequence} follows ${session.lastSequence} in session ${event.sessionId}`,
          event.eventId,
        );
      }
      session.lastSequence = event.sequence;
      if (session.finished && event.eventType !== 'run.finished') {
        lifecycle(
          'SESSION_ALREADY_FINISHED',
          `${event.eventType} after session.finished`,
          event.eventId,
        );
        continue;
      }

      if (!isKnownEvent(event)) {
        this.ignored += 1;
        this.diagnostics.push({
          severity: 'info',
          code: 'IGNORED_EVENT_TYPE',
          file,
          line,
          eventId: event.eventId,
          message: `unknown ignorable event type ${event.eventType} skipped`,
        });
        continue;
      }
      switch (event.eventType) {
        case 'session.started':
          break;
        case 'session.finished': {
          session.finished = true;
          for (const [id, a] of this.attempts) {
            if (a.session === event.sessionId && !a.finished)
              lifecycle(
                'ATTEMPT_NOT_FINISHED_AT_SESSION_END',
                `attempt ${id} still open`,
                event.eventId,
              );
          }
          break;
        }
        case 'run.finished': {
          if (this.runFinished)
            lifecycle(
              'DUPLICATE_RUN_FINISHED',
              `run.finished seen twice (first in ${this.runFinished.file}:${this.runFinished.line})`,
              event.eventId,
            );
          else this.runFinished = { file, line, eventId: event.eventId };
          closedHere = true;
          break;
        }
        case 'attempt.started': {
          const id = event.payload.attemptId;
          if (event.payload.test.historicalId !== undefined && session.runnerName === undefined) {
            lifecycle(
              'HISTORICAL_ID_WITHOUT_RUNNER',
              `test ${id} carries a historicalId but session ${event.sessionId} declares no runner`,
              event.eventId,
            );
          }
          if (this.attempts.has(id))
            lifecycle('DUPLICATE_ATTEMPT_ID', `attempt ${id} started twice`, event.eventId);
          else
            this.attempts.set(id, { session: event.sessionId, finished: false, steps: new Map() });
          break;
        }
        case 'attempt.finished': {
          const a = this.attempts.get(event.payload.attemptId);
          if (!a)
            lifecycle(
              'ATTEMPT_NOT_STARTED',
              `attempt ${event.payload.attemptId} finished but never started`,
              event.eventId,
            );
          else if (a.finished)
            lifecycle(
              'DUPLICATE_ATTEMPT_FINISHED',
              `attempt ${event.payload.attemptId} finished twice`,
              event.eventId,
            );
          else {
            a.finished = true;
            for (const [sid, done] of a.steps) {
              if (!done)
                lifecycle(
                  'STEP_NOT_FINISHED_AT_ATTEMPT_END',
                  `step ${sid} still open`,
                  event.eventId,
                );
            }
          }
          break;
        }
        case 'step.started': {
          const a = this.attempts.get(event.payload.attemptId);
          if (!a || a.finished)
            lifecycle(
              'STEP_OUTSIDE_ATTEMPT',
              `step ${event.payload.stepId} outside an open attempt`,
              event.eventId,
            );
          else {
            if (a.steps.has(event.payload.stepId))
              lifecycle(
                'DUPLICATE_STEP_ID',
                `step ${event.payload.stepId} started twice`,
                event.eventId,
              );
            const parent = event.payload.parentStepId;
            if (parent !== undefined && !a.steps.has(parent))
              lifecycle('STEP_PARENT_UNKNOWN', `parent step ${parent} unknown`, event.eventId);
            a.steps.set(event.payload.stepId, false);
            this.steps += 1;
          }
          break;
        }
        case 'step.finished': {
          const a = this.attempts.get(event.payload.attemptId);
          const state = a?.steps.get(event.payload.stepId);
          if (!a || state === undefined)
            lifecycle(
              'STEP_NOT_STARTED',
              `step ${event.payload.stepId} finished but never started`,
              event.eventId,
            );
          else if (state)
            lifecycle(
              'DUPLICATE_STEP_FINISHED',
              `step ${event.payload.stepId} finished twice`,
              event.eventId,
            );
          else a.steps.set(event.payload.stepId, true);
          break;
        }
        case 'attachment.added': {
          const a = this.attempts.get(event.payload.attemptId);
          if (!a)
            lifecycle(
              'ATTACHMENT_ATTEMPT_UNKNOWN',
              `attachment for unknown attempt ${event.payload.attemptId}`,
              event.eventId,
            );
          else if (a.finished)
            lifecycle(
              'ATTACHMENT_AFTER_ATTEMPT_FINISHED',
              `attachment after attempt ${event.payload.attemptId} finished`,
              event.eventId,
            );
          else if (event.payload.stepId !== undefined && !a.steps.has(event.payload.stepId)) {
            lifecycle(
              'ATTACHMENT_STEP_UNKNOWN',
              `attachment for unknown step ${event.payload.stepId}`,
              event.eventId,
            );
          }
          this.attachments.push({
            file,
            line,
            eventId: event.eventId,
            sha256: event.payload.sha256,
            sizeBytes: event.payload.sizeBytes,
          });
          break;
        }
      }
    }
  }

  /** Applies the run-level rules, checks attachment bytes, and produces the report. */
  async finish(): Promise<Report> {
    if (this.runFinished) {
      for (const [id, s] of this.sessions) {
        if (!s.finished) {
          this.diagnostics.push({
            severity: 'error',
            code: 'LIFECYCLE_INVALID',
            detail: 'SESSION_NOT_FINISHED_AT_RUN_END',
            file: this.runFinished.file,
            line: this.runFinished.line,
            eventId: this.runFinished.eventId,
            message: `run.finished while session ${id} is still open`,
          });
        }
      }
    }
    const dir = this.options.attachmentsDir;
    if (dir !== undefined) {
      for (const a of this.attachments) {
        const at = { file: a.file, line: a.line, eventId: a.eventId };
        const path = join(dir, a.sha256);
        if (!existsSync(path)) {
          this.diagnostics.push({
            severity: 'error',
            code: 'ATTACHMENT_MISSING',
            message: `no file for sha256 ${a.sha256}`,
            ...at,
          });
          continue;
        }
        const size = statSync(path).size;
        if (size !== a.sizeBytes) {
          this.diagnostics.push({
            severity: 'error',
            code: 'ATTACHMENT_SIZE_MISMATCH',
            message: `declared ${a.sizeBytes} bytes, file has ${size}`,
            ...at,
          });
        }
        const actual = await sha256File(path);
        if (actual !== a.sha256) {
          this.diagnostics.push({
            severity: 'error',
            code: 'ATTACHMENT_HASH_MISMATCH',
            message: `declared ${a.sha256}, file hashes to ${actual}`,
            ...at,
          });
        }
      }
    }
    let complete = true;
    for (const s of this.sessions.values()) if (!s.finished) complete = false;
    for (const a of this.attempts.values()) {
      if (!a.finished) complete = false;
      for (const done of a.steps.values()) if (!done) complete = false;
    }
    if (!complete) {
      this.diagnostics.push({
        severity: this.options.requireComplete ? 'error' : 'info',
        code: 'INCOMPLETE_RUN',
        file: '',
        line: 0,
        message: 'a session, attempt, or step started but never finished',
      });
    }
    const valid = !this.diagnostics.some((d) => d.severity === 'error');
    return {
      valid,
      diagnostics: this.diagnostics,
      summary: {
        files: this.files,
        events: this.events,
        sessions: this.sessions.size,
        attempts: this.attempts.size,
        steps: this.steps,
        attachments: this.attachments.length,
        ignored: this.ignored,
        duplicates: this.duplicates,
        complete,
        closed: this.runFinished !== undefined,
      },
    };
  }
}

/** Validates one event stream. Several sessions may share the stream. */
export async function validateLines(
  lines: Iterable<string>,
  options: ValidateOptions = {},
  file = '<stream>',
): Promise<Report> {
  const run = new RunValidator(options);
  run.feed(lines, file, false);
  return run.finish();
}

/**
 * Validates one event file as a stream. Attachment bytes are looked up in the `attachments`
 * directory next to the file's run directory unless another is given.
 */
export async function validateFile(path: string, options: ValidateOptions = {}): Promise<Report> {
  const text = readFileSync(path, 'utf8');
  const attachmentsDir = options.attachmentsDir ?? join(path, '..', '..', 'attachments');
  return validateLines(text.split('\n'), { ...options, attachmentsDir }, path);
}

/**
 * Validates a run directory: every `events/*.ndjson` file as one session file, plus the run-level
 * rules and the bytes under `attachments/`. A declared attachment whose file is not there is
 * missing, whether or not the directory exists.
 */
export async function validateRunDirectory(
  dir: string,
  options: ValidateOptions = {},
): Promise<Report> {
  const eventsDir = join(dir, 'events');
  if (!existsSync(eventsDir)) throw new Error(`${dir} has no events directory`);
  const run = new RunValidator({
    ...options,
    attachmentsDir: options.attachmentsDir ?? join(dir, 'attachments'),
  });
  for (const name of readdirSync(eventsDir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()) {
    const file = join(eventsDir, name);
    run.feed(readFileSync(file, 'utf8').split('\n'), file, true);
  }
  return run.finish();
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** One line per diagnostic: `file:line [eventId] CODE(DETAIL): message`. */
export function formatDiagnostic(d: Diagnostic): string {
  const id = d.eventId !== undefined ? ` [${d.eventId}]` : '';
  const detail = d.detail !== undefined ? `(${d.detail})` : '';
  const pointer = d.pointer !== undefined && d.pointer !== '' ? ` at ${d.pointer}` : '';
  const where = d.file !== '' ? `${d.file}:${d.line}` : 'run';
  return `${where}${id} ${d.severity.toUpperCase()} ${d.code}${detail}: ${d.message}${pointer}`;
}
