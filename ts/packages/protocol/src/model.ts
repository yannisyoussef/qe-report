/** Canonical attempt or step status. */
export type Status = 'passed' | 'failed' | 'skipped' | 'inconclusive';

/**
 * Canonical aggregate outcome of one session as reported by the runner invocation itself:
 * distinct from the attempt status (no skipped session, no expected status).
 */
export type SessionStatus = 'passed' | 'failed' | 'inconclusive';
/** What the test author declared the attempt should end with. Absent means passed. */
export type ExpectedStatus = 'passed' | 'failed' | 'skipped';
/** How much an adapter trusts a historical identity to survive unrelated edits. */
export type HistoricalIdStability = 'stable' | 'uncertain' | 'unavailable';
/** Where a failure originated when the runner can tell. */
export type FailurePhase = 'setup' | 'test' | 'teardown';

export const STATUSES: readonly Status[] = ['passed', 'failed', 'skipped', 'inconclusive'];
export const EXPECTED_STATUSES: readonly ExpectedStatus[] = ['passed', 'failed', 'skipped'];
export const HISTORICAL_ID_STABILITIES: readonly HistoricalIdStability[] = [
  'stable',
  'uncertain',
  'unavailable',
];
export const FAILURE_PHASES: readonly FailurePhase[] = ['setup', 'test', 'teardown'];

/** A named, versioned piece of software: the producing adapter or the observed runner. */
export interface Component {
  readonly name: string;
  readonly version?: string;
}

/** The CI or local context that ran the session. */
export interface Executor {
  readonly name?: string;
  readonly buildId?: string;
  readonly buildUrl?: string;
}

/** Version control state of the tested code. */
export interface Source {
  readonly repository?: string;
  readonly revision?: string;
  readonly branch?: string;
}

/** Where a test or step is defined. Display only; never resolved on a server. */
export interface Location {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * One container in the runner's hierarchy. Well-known kinds are `file` and `group`; other kinds
 * are permitted and treated like a group by consumers that do not know them.
 */
export interface PathSegment {
  readonly kind: string;
  readonly name: string;
}

export interface Failure {
  readonly message: string;
  /** Runner-native classification, for example an exception class name. */
  readonly type?: string;
  readonly stackTrace?: string;
  readonly phase?: FailurePhase;
  readonly location?: Location;
}

/** The test an attempt executes. */
export interface TestCase {
  /** Identifies the logical test within the run; shared by all its attempts. */
  readonly executionId: string;
  /** Identifies the same logical test across runs. Absent only when stability is `unavailable`. */
  readonly historicalId?: string;
  readonly historicalIdStability: HistoricalIdStability;
  readonly displayName: string;
  /** Containers in the runner's own hierarchy, outermost first. */
  readonly path: readonly PathSegment[];
  readonly location?: Location;
  readonly tags?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
}

export interface SessionStartedPayload {
  readonly producer: Component;
  readonly runner?: Component;
  /** Facts about the system under test and the machine, from an explicit allowlist only. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly executor?: Executor;
  readonly source?: Source;
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * The runner's aggregate outcome for the completed session. Empty for a producer whose runner
 * exposes none; consumers then derive the outcome from attempt and scope facts alone.
 */
export interface SessionFinishedPayload {
  readonly status?: SessionStatus;
  /** The runner's own aggregate word; requires `status`. */
  readonly rawStatus?: string;
  /**
   * Errors of the invocation itself that belong to no attempt and no hierarchy scope (a global
   * setup or teardown exception); require `status` and never accompany `passed`.
   */
  readonly failures?: readonly Failure[];
}

export interface AttemptStartedPayload {
  readonly attemptId: string;
  /** 1 for the first execution of the test in this run, 2 for the first retry, and so on. */
  readonly attemptNumber: number;
  readonly test: TestCase;
}

export interface AttemptFinishedPayload {
  readonly attemptId: string;
  readonly status: Status;
  /** The runner's own status word, preserved for display and lossy mappings. */
  readonly rawStatus?: string;
  readonly expectedStatus?: ExpectedStatus;
  readonly durationMs?: number;
  readonly failures?: readonly Failure[];
}

export interface StepStartedPayload {
  readonly stepId: string;
  readonly attemptId: string;
  readonly parentStepId?: string;
  readonly name: string;
  /** Runner-native step category, for example `hook`, `expect`, `http`, `background`. */
  readonly kind?: string;
  readonly location?: Location;
}

export interface StepFinishedPayload {
  readonly stepId: string;
  readonly attemptId: string;
  readonly status: Status;
  readonly rawStatus?: string;
  readonly durationMs?: number;
  readonly failures?: readonly Failure[];
}

/** Metadata for bytes stored outside the event stream. Must precede the attempt's `attempt.finished`. */
export interface AttachmentAddedPayload {
  readonly attemptId: string;
  readonly stepId?: string;
  /** Display name chosen by the producer; never used to locate the bytes. */
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  /** Lower-case hex SHA-256 of the stored bytes. */
  readonly sha256: string;
}

/**
 * A failure at a non-test scope of the runner hierarchy (a class, suite, file, module, or
 * analogous node). It contributes to the execution's failed outcome without changing any child
 * attempt's verdict. Session-scoped: valid between `session.started` and `session.finished`,
 * before or after the child attempts.
 */
export interface ScopeFailedPayload {
  /** The failing scope itself, outermost first, in the same segments a test path uses. */
  readonly path: readonly PathSegment[];
  readonly displayName?: string;
  /** The runner's own status word for the scope. */
  readonly rawStatus?: string;
  readonly location?: Location;
  /** Never empty. */
  readonly failures: readonly Failure[];
}

/** Fields common to every event. */
export interface Envelope {
  /** Full Semantic Version written by the producer. */
  readonly protocolVersion: string;
  /** Unique within the run. */
  readonly eventId: string;
  readonly runId: string;
  /** The producer process that emitted the event. */
  readonly sessionId: string;
  /** 1-based, contiguous position within the session. */
  readonly sequence: number;
  /** ISO-8601 with offset, from the producer clock. */
  readonly occurredAt: string;
  /** Whether an older consumer may skip this event if it does not know the type. Absent means false. */
  readonly ignorable?: boolean;
}

export interface SessionStartedEvent extends Envelope {
  readonly eventType: 'session.started';
  readonly payload: SessionStartedPayload;
}
export interface SessionFinishedEvent extends Envelope {
  readonly eventType: 'session.finished';
  readonly payload: SessionFinishedPayload;
}
export interface RunFinishedEvent extends Envelope {
  readonly eventType: 'run.finished';
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface AttemptStartedEvent extends Envelope {
  readonly eventType: 'attempt.started';
  readonly payload: AttemptStartedPayload;
}
export interface AttemptFinishedEvent extends Envelope {
  readonly eventType: 'attempt.finished';
  readonly payload: AttemptFinishedPayload;
}
export interface StepStartedEvent extends Envelope {
  readonly eventType: 'step.started';
  readonly payload: StepStartedPayload;
}
export interface StepFinishedEvent extends Envelope {
  readonly eventType: 'step.finished';
  readonly payload: StepFinishedPayload;
}
export interface AttachmentAddedEvent extends Envelope {
  readonly eventType: 'attachment.added';
  readonly payload: AttachmentAddedPayload;
}
export interface ScopeFailedEvent extends Envelope {
  readonly eventType: 'scope.failed';
  readonly payload: ScopeFailedPayload;
}

/** An event whose type this binding knows. */
export type Event =
  | SessionStartedEvent
  | SessionFinishedEvent
  | RunFinishedEvent
  | AttemptStartedEvent
  | AttemptFinishedEvent
  | StepStartedEvent
  | StepFinishedEvent
  | AttachmentAddedEvent
  | ScopeFailedEvent;

export type EventType = Event['eventType'];

/** The payload half of a known event, discriminated by `eventType`. */
export type EventInput = {
  [E in Event as E['eventType']]: {
    readonly eventType: E['eventType'];
    readonly payload: E['payload'];
  };
}[EventType];

/**
 * An event of a type this binding does not know and which the producer marked ignorable. The
 * payload is kept verbatim so a consumer can store or forward it.
 */
export interface UnknownEvent extends Envelope {
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const EVENT_TYPES: readonly EventType[] = [
  'session.started',
  'session.finished',
  'run.finished',
  'attempt.started',
  'attempt.finished',
  'step.started',
  'step.finished',
  'attachment.added',
  'scope.failed',
];

export function isKnownEventType(eventType: string): eventType is EventType {
  return (EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * Narrows to a known event. Use this rather than testing for the unknown shape: events with an
 * empty payload are structurally compatible with {@link UnknownEvent}, so only the positive test
 * narrows both branches correctly.
 */
export function isKnownEvent(event: Event | UnknownEvent): event is Event {
  return isKnownEventType(event.eventType);
}

/** Limits enforced by producers and consumers outside the schema. */
export const LIMITS = {
  /** A serialised event, in UTF-8 bytes, including its newline. */
  maxEventBytes: 1_048_576,
} as const;
