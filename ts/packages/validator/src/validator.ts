import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
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
  | 'UNSAFE_FILESYSTEM_ENTRY'
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
  | 'DUPLICATE_ATTEMPT_NUMBER'
  | 'HISTORICAL_IDENTITY_CHANGED'
  | 'EXECUTION_RUNNER_CHANGED'
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
  /** Attempts that finished with status `failed`, whatever was expected. Scope failures are never counted here. */
  readonly failedAttempts: number;
  /** scope.failed events: failures of non-test scopes that fail the run without touching attempt verdicts. */
  readonly scopeFailures: number;
  /** Sessions whose runner reported a failed aggregate outcome; never counted as attempts or scope failures. */
  readonly failedSessions: number;
  /** Sessions whose runner reported an inconclusive aggregate outcome. */
  readonly inconclusiveSessions: number;
  /** Failures carried by session.finished events: errors of the invocation itself. */
  readonly sessionFailures: number;
  readonly ignored: number;
  readonly duplicates: number;
  /** Every session, attempt, and step that started also finished. */
  readonly complete: boolean;
  /** A run.finished event was seen. */
  readonly closed: boolean;
  /**
   * The derived run verdict, in order of precedence: `incomplete` while any session, attempt, or
   * step is structurally open; `failed` on any unexpected final test outcome (read against
   * `expectedStatus`), any `scope.failed`, or any session whose status is `failed`;
   * `inconclusive` on any inconclusive final attempt or any session whose status is
   * `inconclusive`; otherwise `passed`.
   */
  readonly verdict: 'passed' | 'failed' | 'inconclusive' | 'incomplete';
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
  /**
   * Keep every accepted known event for {@link RunValidator.acceptedEvents}. Off by default, so plain
   * validation retains nothing but its bookkeeping.
   */
  readonly retainEvents?: boolean;
}

/** A validated run: the report, and the events validation accepted when they were retained. */
export interface ValidatedRun {
  readonly report: Report;
  /**
   * The known events that passed decoding, the schema, and the duplicate check, in the order
   * they were fed (file by file, each file in line order). Identical duplicates appear once;
   * unknown ignorable events are counted in the summary and not listed. Empty when events were
   * not retained. When the report is invalid the list is what was accepted before or beside the
   * errors and carries no guarantee of lifecycle consistency.
   */
  readonly events: readonly Event[];
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

/**
 * The canonical text of a parsed JSON value: object keys sorted by code unit, array order kept,
 * primitives as JSON.stringify writes them. Two events are the same event when their canonical
 * texts match, whatever property order the producer used. Iterative with an explicit stack, so
 * an unknown property nested to any depth the parser accepted cannot exhaust the call stack;
 * the input is only read, never changed.
 */
function canonical(root: unknown): string {
  type Frame =
    | { readonly kind: 'array'; readonly items: readonly unknown[]; index: number }
    | {
        readonly kind: 'object';
        readonly object: Readonly<Record<string, unknown>>;
        readonly keys: readonly string[];
        index: number;
      };
  const out: string[] = [];
  const stack: Frame[] = [];
  const open = (value: unknown): void => {
    if (Array.isArray(value)) {
      out.push('[');
      stack.push({ kind: 'array', items: value, index: 0 });
    } else if (typeof value === 'object' && value !== null) {
      const object = value as Readonly<Record<string, unknown>>;
      out.push('{');
      stack.push({ kind: 'object', object, keys: Object.keys(object).sort(), index: 0 });
    } else {
      out.push(JSON.stringify(value));
    }
  };
  open(root);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.kind === 'array') {
      if (frame.index < frame.items.length) {
        if (frame.index > 0) out.push(',');
        open(frame.items[frame.index++]);
      } else {
        out.push(']');
        stack.pop();
      }
    } else if (frame.index < frame.keys.length) {
      const key = frame.keys[frame.index++] as string;
      if (frame.index > 1) out.push(',');
      out.push(`${JSON.stringify(key)}:`);
      open(frame.object[key]);
    } else {
      out.push('}');
      stack.pop();
    }
  }
  return out.join('');
}

/** What a path is without following it: the only question the validator asks before opening. */
type EntryKind = 'missing' | 'file' | 'directory' | 'symlink' | 'special';

/** Only a path that does not exist is "missing"; any other failure to inspect it is an I/O error. */
function entryKind(path: string): EntryKind {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw e;
  }
  return kindOf(stat);
}

function kindOf(stat: Stats): Exclude<EntryKind, 'missing'> {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'special';
}

/**
 * A directory the caller named explicitly is a trusted entry point like the run directory: it is
 * resolved once, so a link the caller chose is not refused below. A directory that does not
 * exist keeps its path, so declared attachments are reported as missing.
 */
function trustedDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return path;
    throw e;
  }
}

/** Why an entry was refused, worded for the diagnostic; the entry's target is never named. */
const REFUSAL: Record<Exclude<EntryKind, 'missing'>, string> = {
  symlink: 'a symbolic link',
  directory: 'a directory',
  special: 'not a regular file',
  file: 'a regular file',
};

/**
 * Opens a path that `entryKind` reported as a regular file, refusing to follow a link that may
 * have appeared since (O_NOFOLLOW where the platform has it), never blocking on a pipe that may
 * have appeared since (O_NONBLOCK), and re-checking the open descriptor. Returns the descriptor,
 * or the kind that was found instead.
 */
function openRegular(path: string): { fd: number } | { refused: Exclude<EntryKind, 'file'> } {
  const flags = constants as { O_NOFOLLOW?: number; O_NONBLOCK?: number };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return { refused: 'symlink' };
    if (code === 'ENOENT') return { refused: 'missing' };
    throw e;
  }
  // Re-check the opened descriptor: a link replaced by a directory or a device between the
  // lstat and the open is caught here; a link itself was refused by O_NOFOLLOW above.
  let kind: Exclude<EntryKind, 'missing'>;
  try {
    kind = kindOf(fstatSync(fd));
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  if (kind !== 'file') {
    closeSync(fd);
    return { refused: kind };
  }
  return { fd };
}

interface SessionState {
  finished: boolean;
  lastSequence: number;
  runnerName: string | undefined;
  /** Created for an event that arrived before session.started; its runner is unknown, not absent. */
  synthesized: boolean;
}
interface AttemptState {
  session: string;
  executionId: string;
  attemptNumber: number;
  inconclusive: boolean;
  finished: boolean;
  unexpected: boolean;
  steps: Map<string, boolean>;
}
interface Location {
  file: string;
  line: number;
  eventId: string;
}
/**
 * What every attempt of one execution must agree on: one attempt per attempt number, one history
 * identity, one runner family. Run-wide, because an execution may span sessions.
 */
interface ExecutionState {
  attemptNumbers: Map<number, Location & { attemptId: string }>;
  historicalId: string | undefined;
  historicalIdStability: string;
  /** The runner of the reference attempt's session; undefined when unknown or absent. */
  runnerName: string | undefined;
  /** Whether the reference attempt's session was started properly, so its runner is known. */
  runnerKnown: boolean;
  /** The attempt that fixed the execution's identity: the first one fed, not attempt number 1. */
  reference: Location & { attemptId: string };
}

/**
 * Validates one run, fed one event file at a time. Ordering is defined only inside a session,
 * so files are independent except for run-level facts: one runId, unique event and session ids,
 * at most one run.finished, every session finished when the run is closed, and one meaning per
 * execution (attempt numbers, history identity, runner family) across all its attempts.
 */
export class RunValidator {
  private readonly v = validators();
  private readonly options: ValidateOptions;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly seen = new Map<string, string>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly attempts = new Map<string, AttemptState>();
  private readonly executions = new Map<string, ExecutionState>();
  private readonly attachments: (Location & { sha256: string; sizeBytes: number })[] = [];
  private readonly accepted: Event[] = [];
  private attachmentsDirRefused = false;
  private runId: string | undefined;
  private runFinished: Location | undefined;
  private files = 0;
  private events = 0;
  private ignored = 0;
  private duplicates = 0;
  private steps = 0;
  private scopeFailures = 0;
  private failedAttempts = 0;
  private failedSessions = 0;
  private inconclusiveSessions = 0;
  private sessionFailures = 0;

  constructor(options: ValidateOptions = {}) {
    this.options = options;
  }

  /**
   * Records a filesystem entry the validator will not read: a symbolic link, a directory, or a
   * special file where a regular file is required, or anything but a real directory where a
   * directory is required. Called by the directory validators of this module for entries below
   * the run directory; not part of the supported API. Nothing about the entry's target is read.
   */
  refuseEntry(
    path: string,
    reason: Exclude<EntryKind, 'missing'>,
    expected: 'file' | 'directory' = 'file',
  ): void {
    this.diagnostics.push({
      severity: 'error',
      code: 'UNSAFE_FILESYSTEM_ENTRY',
      file: path,
      line: 0,
      message:
        expected === 'directory'
          ? `${REFUSAL[reason]} where a directory is required; nothing below it is read`
          : `${REFUSAL[reason]}; only regular files are read`,
    });
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
          synthesized: false,
        };
        this.sessions.set(event.sessionId, session);
      } else if (!session) {
        lifecycle(
          'SESSION_NOT_STARTED',
          `${event.eventType} before session.started for ${event.sessionId}`,
          event.eventId,
        );
        session = {
          finished: false,
          lastSequence: event.sequence - 1,
          runnerName: undefined,
          synthesized: true,
        };
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
      if (this.options.retainEvents) this.accepted.push(event);
      switch (event.eventType) {
        case 'session.started':
          break;
        case 'session.finished': {
          session.finished = true;
          if (event.payload.status === 'failed') this.failedSessions += 1;
          if (event.payload.status === 'inconclusive') this.inconclusiveSessions += 1;
          this.sessionFailures += event.payload.failures?.length ?? 0;
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
          else {
            this.attempts.set(id, {
              session: event.sessionId,
              executionId: event.payload.test.executionId,
              attemptNumber: event.payload.attemptNumber,
              finished: false,
              unexpected: false,
              inconclusive: false,
              steps: new Map(),
            });
            this.checkExecution(event, session, { file, line }, lifecycle);
          }
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
            const status = event.payload.status;
            const expected = event.payload.expectedStatus ?? 'passed';
            if (status === 'failed') this.failedAttempts += 1;
            a.unexpected =
              (status === 'failed' && expected !== 'failed') ||
              (status === 'passed' && expected === 'failed');
            a.inconclusive = status === 'inconclusive';
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
        case 'scope.failed': {
          this.scopeFailures += 1;
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

  /**
   * The relational rules of one execution: the attempts sharing an executionId are one logical
   * test, so they cannot share an attempt number (the final attempt would be undefined), change
   * their history identity (historicalId and its stability, absence included), or come from
   * sessions of different runner families (the history key would be undefined). Gaps in the
   * numbering, several sessions of one runner, and differing presentation fields are allowed.
   * Which attempt is the reference depends on feed order; which rule fires does not.
   */
  private checkExecution(
    event: Extract<Event, { eventType: 'attempt.started' }>,
    session: SessionState,
    at: { file: string; line: number },
    lifecycle: (detail: LifecycleDetail, message: string, eventId: string) => void,
  ): void {
    const { attemptId, attemptNumber, test } = event.payload;
    const here = { ...at, eventId: event.eventId, attemptId };
    const known = this.executions.get(test.executionId);
    if (!known) {
      this.executions.set(test.executionId, {
        attemptNumbers: new Map([[attemptNumber, here]]),
        historicalId: test.historicalId,
        historicalIdStability: test.historicalIdStability,
        runnerName: session.runnerName,
        runnerKnown: !session.synthesized,
        reference: here,
      });
      return;
    }
    const sameNumber = known.attemptNumbers.get(attemptNumber);
    if (sameNumber) {
      lifecycle(
        'DUPLICATE_ATTEMPT_NUMBER',
        `execution ${test.executionId} has attempts ${sameNumber.attemptId} (${where(sameNumber)}) and ${attemptId} both numbered ${attemptNumber}`,
        event.eventId,
      );
    } else known.attemptNumbers.set(attemptNumber, here);
    if (
      known.historicalId !== test.historicalId ||
      known.historicalIdStability !== test.historicalIdStability
    ) {
      lifecycle(
        'HISTORICAL_IDENTITY_CHANGED',
        `execution ${test.executionId} changes history identity between attempts ${known.reference.attemptId} (${describeIdentity(known.historicalId, known.historicalIdStability)}, ${where(known.reference)}) and ${attemptId} (${describeIdentity(test.historicalId, test.historicalIdStability)})`,
        event.eventId,
      );
    }
    if (known.runnerKnown && !session.synthesized && known.runnerName !== session.runnerName) {
      lifecycle(
        'EXECUTION_RUNNER_CHANGED',
        `execution ${test.executionId} spans sessions of different runners: ${known.runnerName ?? 'none'} at attempt ${known.reference.attemptId} (${where(known.reference)}), ${session.runnerName ?? 'none'} at attempt ${attemptId}`,
        event.eventId,
      );
    }
  }

  /**
   * The accepted known events so far, when `retainEvents` is set; see {@link ValidatedRun}. The
   * live list: it grows with every further `feed`.
   */
  acceptedEvents(): readonly Event[] {
    return this.accepted;
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
      const dirKind = entryKind(dir);
      if (dirKind === 'symlink' || dirKind === 'special' || dirKind === 'file') {
        // Declared attachments cannot be checked through an entry that is not a real directory;
        // one refusal stands for all of them, and nothing below it is opened.
        if (this.attachments.length > 0 && !this.attachmentsDirRefused) {
          this.refuseEntry(dir, dirKind, 'directory');
          this.attachmentsDirRefused = true;
        }
      } else {
        for (const a of this.attachments) {
          const at = { file: a.file, line: a.line, eventId: a.eventId };
          const path = join(dir, a.sha256);
          const kind = entryKind(path);
          if (kind === 'missing') {
            this.diagnostics.push({
              severity: 'error',
              code: 'ATTACHMENT_MISSING',
              message: `no file for sha256 ${a.sha256}`,
              ...at,
            });
            continue;
          }
          if (kind !== 'file') {
            this.diagnostics.push({
              severity: 'error',
              code: 'UNSAFE_FILESYSTEM_ENTRY',
              message: `attachment ${a.sha256} is ${REFUSAL[kind]}; only regular files are read`,
              ...at,
            });
            continue;
          }
          const opened = openRegular(path);
          if ('refused' in opened) {
            if (opened.refused === 'missing') {
              this.diagnostics.push({
                severity: 'error',
                code: 'ATTACHMENT_MISSING',
                message: `no file for sha256 ${a.sha256}`,
                ...at,
              });
            } else {
              this.diagnostics.push({
                severity: 'error',
                code: 'UNSAFE_FILESYSTEM_ENTRY',
                message: `attachment ${a.sha256} is ${REFUSAL[opened.refused]}; only regular files are read`,
                ...at,
              });
            }
            continue;
          }
          let size: number;
          try {
            size = fstatSync(opened.fd).size;
          } catch (e) {
            closeSync(opened.fd);
            throw e;
          }
          if (size !== a.sizeBytes) {
            this.diagnostics.push({
              severity: 'error',
              code: 'ATTACHMENT_SIZE_MISMATCH',
              message: `declared ${a.sizeBytes} bytes, file has ${size}`,
              ...at,
            });
          }
          const actual = await sha256Fd(opened.fd);
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
    // A test case's outcome is that of its final attempt (highest attemptNumber); two attempts
    // sharing the highest number are a DUPLICATE_ATTEMPT_NUMBER error, so the verdict of a valid
    // run never depends on which one was fed first.
    const finalAttempts = new Map<string, AttemptState>();
    for (const a of this.attempts.values()) {
      const current = finalAttempts.get(a.executionId);
      if (!current || a.attemptNumber > current.attemptNumber) finalAttempts.set(a.executionId, a);
    }
    const finals = [...finalAttempts.values()];
    const anyUnexpected = finals.some((a) => a.unexpected);
    const anyInconclusive = finals.some((a) => a.inconclusive);
    // Precedence: structurally open, then any failure fact, then any inconclusive fact.
    const verdict = !complete
      ? 'incomplete'
      : anyUnexpected || this.scopeFailures > 0 || this.failedSessions > 0
        ? 'failed'
        : anyInconclusive || this.inconclusiveSessions > 0
          ? 'inconclusive'
          : 'passed';
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
        failedAttempts: this.failedAttempts,
        scopeFailures: this.scopeFailures,
        failedSessions: this.failedSessions,
        inconclusiveSessions: this.inconclusiveSessions,
        sessionFailures: this.sessionFailures,
        ignored: this.ignored,
        duplicates: this.duplicates,
        complete,
        closed: this.runFinished !== undefined,
        verdict,
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
  const attachmentsDir =
    options.attachmentsDir === undefined
      ? join(path, '..', '..', 'attachments')
      : trustedDirectory(options.attachmentsDir);
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
  return (await validateRunDirectorySnapshot(dir, { ...options, retainEvents: false })).report;
}

/**
 * Validates a run directory exactly as {@link validateRunDirectory} does and also returns the
 * accepted decoded events, so a consumer can project the run without parsing it a second time.
 * Events are retained unless `retainEvents` is explicitly false.
 */
export async function validateRunDirectorySnapshot(
  dir: string,
  options: ValidateOptions = {},
): Promise<ValidatedRun> {
  const eventsDir = join(dir, 'events');
  const eventsKind = entryKind(eventsDir);
  if (eventsKind === 'missing') throw new Error(`${dir} has no events directory`);
  const run = new RunValidator({
    ...options,
    attachmentsDir:
      options.attachmentsDir === undefined
        ? join(dir, 'attachments')
        : trustedDirectory(options.attachmentsDir),
    retainEvents: options.retainEvents ?? true,
  });
  if (eventsKind !== 'directory') {
    // A linked or otherwise irregular events directory is not read at all.
    run.refuseEntry(eventsDir, eventsKind, 'directory');
    return { report: await run.finish(), events: run.acceptedEvents() };
  }
  for (const name of readdirSync(eventsDir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()) {
    const file = join(eventsDir, name);
    const kind = entryKind(file);
    if (kind === 'missing') continue;
    if (kind !== 'file') {
      run.refuseEntry(file, kind);
      continue;
    }
    const opened = openRegular(file);
    if ('refused' in opened) {
      if (opened.refused !== 'missing') run.refuseEntry(file, opened.refused);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(opened.fd, 'utf8');
    } finally {
      closeSync(opened.fd);
    }
    run.feed(text.split('\n'), file, true);
  }
  return { report: await run.finish(), events: run.acceptedEvents() };
}

function describeIdentity(historicalId: string | undefined, stability: string): string {
  return historicalId === undefined ? stability : `${historicalId}, ${stability}`;
}

function where(at: Location): string {
  return `${at.file}:${at.line}`;
}

/** Hashes an already opened regular file; the stream owns and closes the descriptor. */
function sha256Fd(fd: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream('', { fd })
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
  const message = d.message.replace(/[\r\n]/g, ' ');
  return `${where}${id} ${d.severity.toUpperCase()} ${d.code}${detail}: ${message}${pointer}`;
}
