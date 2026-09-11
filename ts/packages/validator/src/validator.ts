import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
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
  | 'SEQUENCE_GAP'
  | 'DUPLICATE_EVENT_ID'
  | 'EVENT_AFTER_RUN_FINISHED'
  | 'DUPLICATE_RUN_FINISHED'
  | 'SESSION_NOT_FINISHED_AT_RUN_END'
  | 'DUPLICATE_ATTEMPT_ID'
  | 'ATTEMPT_NOT_STARTED'
  | 'DUPLICATE_ATTEMPT_FINISHED'
  | 'ATTEMPT_NOT_FINISHED_AT_SESSION_END'
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
  /** 1-based line in the event file; 0 when the diagnostic concerns the whole file. */
  readonly line: number;
  readonly eventId?: string;
  readonly pointer?: string;
  readonly detail?: LifecycleDetail;
  readonly message: string;
}

export interface Summary {
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
}
interface AttemptState {
  finished: boolean;
  steps: Map<string, boolean>;
}

/** Validates the lines of one event file. Lines are 1-based; blank lines are ignored. */
export async function validateLines(
  lines: Iterable<string>,
  options: ValidateOptions = {},
): Promise<Report> {
  const v = validators();
  const maxEventBytes = options.maxEventBytes ?? LIMITS.maxEventBytes;
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, string>();
  const sessions = new Map<string, SessionState>();
  const attempts = new Map<string, AttemptState>();
  const attachments: { line: number; eventId: string; sha256: string; sizeBytes: number }[] = [];
  let runId: string | undefined;
  let closed = false;
  let events = 0;
  let ignored = 0;
  let duplicates = 0;
  let steps = 0;
  let line = 0;

  const error = (code: DiagnosticCode, message: string, extra: Partial<Diagnostic> = {}): void => {
    diagnostics.push({ severity: 'error', code, line, message, ...extra });
  };
  const lifecycle = (detail: LifecycleDetail, message: string, eventId: string): void =>
    error('LIFECYCLE_INVALID', message, { detail, eventId });

  for (const raw of lines) {
    line += 1;
    if (raw.trim() === '') continue;
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
    const validate = isKnownEvent(event) ? v.byType.get(event.eventType) : v.envelope;
    if (validate && !validate(parsedJson)) {
      const { pointer, message } = firstError(validate.errors);
      error('SCHEMA_INVALID', message, { pointer, eventId: event.eventId });
      continue;
    }
    // Lifecycle.
    const key = canonical(parsedJson);
    const previous = seen.get(event.eventId);
    if (previous !== undefined) {
      if (previous === key) {
        duplicates += 1;
        diagnostics.push({
          severity: 'info',
          code: 'DUPLICATE_EVENT',
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
    seen.set(event.eventId, key);
    events += 1;
    if (runId === undefined) runId = event.runId;
    else if (runId !== event.runId)
      lifecycle('RUN_ID_MISMATCH', `runId ${event.runId} differs from ${runId}`, event.eventId);
    if (closed)
      lifecycle('EVENT_AFTER_RUN_FINISHED', `${event.eventType} after run.finished`, event.eventId);

    let session = sessions.get(event.sessionId);
    if (event.eventType === 'session.started') {
      if (session)
        lifecycle(
          'SESSION_ALREADY_STARTED',
          `session ${event.sessionId} started twice`,
          event.eventId,
        );
      else {
        session = { finished: false, lastSequence: 0 };
        sessions.set(event.sessionId, session);
      }
    } else if (!session) {
      lifecycle(
        'SESSION_NOT_STARTED',
        `${event.eventType} before session.started for ${event.sessionId}`,
        event.eventId,
      );
      session = { finished: false, lastSequence: event.sequence - 1 };
      sessions.set(event.sessionId, session);
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
    }

    if (!isKnownEvent(event)) {
      ignored += 1;
      diagnostics.push({
        severity: 'info',
        code: 'IGNORED_EVENT_TYPE',
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
        for (const [id, a] of attempts) {
          if (!a.finished)
            lifecycle(
              'ATTEMPT_NOT_FINISHED_AT_SESSION_END',
              `attempt ${id} still open`,
              event.eventId,
            );
        }
        break;
      }
      case 'run.finished': {
        if (closed) lifecycle('DUPLICATE_RUN_FINISHED', 'run.finished seen twice', event.eventId);
        for (const [id, s] of sessions) {
          if (!s.finished)
            lifecycle('SESSION_NOT_FINISHED_AT_RUN_END', `session ${id} still open`, event.eventId);
        }
        closed = true;
        break;
      }
      case 'attempt.started': {
        const id = event.payload.attemptId;
        if (attempts.has(id))
          lifecycle('DUPLICATE_ATTEMPT_ID', `attempt ${id} started twice`, event.eventId);
        else attempts.set(id, { finished: false, steps: new Map() });
        break;
      }
      case 'attempt.finished': {
        const a = attempts.get(event.payload.attemptId);
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
        const a = attempts.get(event.payload.attemptId);
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
          steps += 1;
        }
        break;
      }
      case 'step.finished': {
        const a = attempts.get(event.payload.attemptId);
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
        const a = attempts.get(event.payload.attemptId);
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
        attachments.push({
          line,
          eventId: event.eventId,
          sha256: event.payload.sha256,
          sizeBytes: event.payload.sizeBytes,
        });
        break;
      }
    }
  }

  if (options.attachmentsDir !== undefined) {
    for (const a of attachments) {
      line = a.line;
      const path = join(options.attachmentsDir, a.sha256);
      if (!existsSync(path)) {
        error('ATTACHMENT_MISSING', `no file for sha256 ${a.sha256}`, { eventId: a.eventId });
        continue;
      }
      const size = statSync(path).size;
      if (size !== a.sizeBytes) {
        error('ATTACHMENT_SIZE_MISMATCH', `declared ${a.sizeBytes} bytes, file has ${size}`, {
          eventId: a.eventId,
        });
      }
      const actual = await sha256File(path);
      if (actual !== a.sha256) {
        error('ATTACHMENT_HASH_MISMATCH', `declared ${a.sha256}, file hashes to ${actual}`, {
          eventId: a.eventId,
        });
      }
    }
  }

  let complete = true;
  for (const s of sessions.values()) if (!s.finished) complete = false;
  for (const a of attempts.values()) {
    if (!a.finished) complete = false;
    for (const done of a.steps.values()) if (!done) complete = false;
  }
  if (!complete) {
    diagnostics.push({
      severity: options.requireComplete ? 'error' : 'info',
      code: 'INCOMPLETE_RUN',
      line: 0,
      message: 'a session, attempt, or step started but never finished',
    });
  }
  const valid = !diagnostics.some((d) => d.severity === 'error');
  return {
    valid,
    diagnostics,
    summary: {
      events,
      sessions: sessions.size,
      attempts: attempts.size,
      steps,
      attachments: attachments.length,
      ignored,
      duplicates,
      complete,
      closed,
    },
  };
}

/**
 * Validates an `events.ndjson` file. Attachment bytes are looked up in the sibling `attachments`
 * directory unless another is given; a declared attachment whose file is not there is missing,
 * whether or not the directory exists.
 */
export async function validateFile(path: string, options: ValidateOptions = {}): Promise<Report> {
  const text = readFileSync(path, 'utf8');
  const attachmentsDir = options.attachmentsDir ?? join(path, '..', 'attachments');
  return validateLines(text.split('\n'), { ...options, attachmentsDir });
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
export function formatDiagnostic(file: string, d: Diagnostic): string {
  const id = d.eventId !== undefined ? ` [${d.eventId}]` : '';
  const detail = d.detail !== undefined ? `(${d.detail})` : '';
  const pointer = d.pointer !== undefined && d.pointer !== '' ? ` at ${d.pointer}` : '';
  return `${file}:${d.line}${id} ${d.severity.toUpperCase()} ${d.code}${detail}: ${d.message}${pointer}`;
}
