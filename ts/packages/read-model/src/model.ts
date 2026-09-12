import type {
  Component,
  ExpectedStatus,
  Executor,
  Failure,
  HistoricalIdStability,
  Location,
  PathSegment,
  SessionStatus,
  Source,
  Status,
  TestCase,
} from 'qe-report-protocol';
import type { Diagnostic, Summary } from 'qe-report-validator';

/** The validator's derived run verdict; the read model never computes its own. */
export type RunVerdict = Summary['verdict'];

/**
 * The canonical identity of a run in the read model. `projectId` is ingestion context supplied by
 * the caller, an opaque non-empty partition key that is not a protocol field; `runId` is the
 * authoritative run identity carried by the events. The same `runId` may exist in two projects.
 */
export interface RunKey {
  readonly projectId: string;
  readonly runId: string;
}

/** What the validator concluded about the run; copied, never recomputed. */
export interface ValidatorFacts {
  readonly valid: true;
  /** Every session, attempt, and step that started also finished. */
  readonly complete: boolean;
  /** A `run.finished` event was seen. A complete run may stay open, as forked JUnit runs do. */
  readonly closed: boolean;
  readonly verdict: RunVerdict;
  /** Unknown ignorable events the validator skipped; they are no read-model fact. */
  readonly ignoredEvents: number;
  /** Identical duplicate events the validator suppressed; they produced nothing twice. */
  readonly duplicateEvents: number;
}

/** One logical run, projected from one validated run directory. Immutable. */
export interface ProjectedRun extends RunKey {
  /** Where the run was read from. A locator only: never an identity, never compared. */
  readonly runDirectory: string;
  readonly validator: ValidatorFacts;
  /** Every session of the run, by session id. */
  readonly sessions: readonly ProjectedSession[];
  /** Every test execution of the run, by execution id. */
  readonly executions: readonly TestExecution[];
  /** Every `scope.failed`, kept apart from attempts and sessions, by session then emission order. */
  readonly scopeFailures: readonly ScopeFailure[];
  /** Every attachment reference of the run, by session then emission order. */
  readonly attachments: readonly AttachmentReference[];
}

/** One producer process. Runs may hold several whose metadata differs; none is synthesised into a run-level view. */
export interface ProjectedSession {
  readonly sessionId: string;
  /** Producer clock of `session.started`. */
  readonly startedAt: string;
  readonly producer: Component;
  readonly runner: Component | undefined;
  readonly environment: Readonly<Record<string, string>> | undefined;
  readonly executor: Executor | undefined;
  readonly source: Source | undefined;
  readonly labels: Readonly<Record<string, string>> | undefined;
  /** A `session.finished` was seen. */
  readonly finished: boolean;
  readonly finishedAt: string | undefined;
  /**
   * The runner's aggregate outcome for the session, when its runner exposes one. Absent for a
   * producer whose runner has none (the JUnit Platform adapter) and while the session is open.
   * It never rewrites the attempts below it.
   */
  readonly status: SessionStatus | undefined;
  readonly rawStatus: string | undefined;
  /** Errors of the invocation itself, from `session.finished`. */
  readonly failures: readonly Failure[];
  /** Executions with at least one attempt in this session, by execution id. */
  readonly executionIds: readonly string[];
}

/**
 * The attempts of one logical test within a run, grouped by the protocol's `executionId`. Retries
 * are further attempts of the same execution; a `repeatEach` repetition is a separate execution.
 */
export interface TestExecution {
  readonly executionId: string;
  /** The runner declared by the session(s) of its attempts; identical across them or the run is not projectable. */
  readonly runnerName: string | undefined;
  /** The authored test as the lowest-numbered attempt describes it; every attempt keeps its own. */
  readonly test: TestCase;
  /** By attempt number, ascending. */
  readonly attempts: readonly Attempt[];
  /** The attempt with the highest attempt number; its outcome is the execution's. */
  readonly finalAttempt: Attempt;
  /** Every attempt finished. */
  readonly complete: boolean;
  /** The final attempt's status, absent while it has not finished. Never invented. */
  readonly finalStatus: Status | undefined;
  /**
   * More than one attempt, the final one passed while expected to pass, and an earlier one failed
   * while expected to pass. A runner policy that fails the session for a flaky test does not
   * change this, and an unfinished execution is never flaky.
   */
  readonly flaky: boolean;
}

export interface Attempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly sessionId: string;
  readonly startedAt: string;
  /** The test descriptor carried by this attempt's `attempt.started`. */
  readonly test: TestCase;
  readonly finished: boolean;
  readonly finishedAt: string | undefined;
  readonly status: Status | undefined;
  readonly rawStatus: string | undefined;
  /** As authored; absent means the attempt was expected to pass. */
  readonly expectedStatus: ExpectedStatus | undefined;
  readonly durationMs: number | undefined;
  /** The attempt's own failures. Step failures stay on their steps. */
  readonly failures: readonly Failure[];
  /** Every step of the attempt in start order, with parents referenced by id. */
  readonly steps: readonly Step[];
  /** Every attachment of the attempt, including step-scoped ones, in emission order. */
  readonly attachments: readonly AttachmentReference[];
}

export interface Step {
  readonly stepId: string;
  readonly parentStepId: string | undefined;
  readonly name: string;
  readonly kind: string | undefined;
  readonly location: Location | undefined;
  readonly startedAt: string;
  readonly finished: boolean;
  readonly finishedAt: string | undefined;
  readonly status: Status | undefined;
  readonly rawStatus: string | undefined;
  readonly durationMs: number | undefined;
  readonly failures: readonly Failure[];
}

/** A reference to stored bytes. Identity of the bytes is the full SHA-256; the reference is where they were used. */
export interface AttachmentReference {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly stepId: string | undefined;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** A failure of a non-test scope. It fails the run and touches no child execution. */
export interface ScopeFailure {
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly path: readonly PathSegment[];
  readonly displayName: string | undefined;
  readonly rawStatus: string | undefined;
  readonly location: Location | undefined;
  readonly failures: readonly Failure[];
}

/**
 * The exact history collision domain: a project, the runner family named by `runner.name` on
 * `session.started`, and the adapter-derived `historicalId`. The producer's name is not part of
 * it, so replacing an adapter keeps the history.
 */
export interface HistoryKey {
  readonly projectId: string;
  readonly runnerName: string;
  readonly historicalId: string;
}

/** One execution of a historical test in one run. A run may hold several. */
export interface ExecutionOccurrence extends HistoryKey {
  readonly runId: string;
  readonly executionId: string;
  readonly sessionIds: readonly string[];
  /** How far the adapter trusts the identity; an uncertain occurrence is indexed but marked. */
  readonly historicalIdStability: HistoricalIdStability;
  /** Producer clock of the first attempt's start; ordering across producers is not authoritative. */
  readonly occurredAt: string;
  readonly attemptCount: number;
  readonly complete: boolean;
  readonly finalStatus: Status | undefined;
  readonly expectedStatus: ExpectedStatus | undefined;
  readonly flaky: boolean;
  /** The validator's verdict of the containing run; `incomplete` runs keep saying so here. */
  readonly runVerdict: RunVerdict;
  readonly runComplete: boolean;
  /** The aggregate status of the final attempt's session, when its runner reported one. */
  readonly sessionStatus: SessionStatus | undefined;
}

export interface TestHistory extends HistoryKey {
  /** By producer time, then run id, then execution id. */
  readonly occurrences: readonly ExecutionOccurrence[];
}

export interface Flakiness extends HistoryKey {
  readonly totalOccurrences: number;
  readonly flakyOccurrences: number;
  readonly everFlaky: boolean;
  /** The flaky occurrences, in history order. */
  readonly flaky: readonly ExecutionOccurrence[];
}

/** Stored bytes known to the snapshot, identified by their full SHA-256 across every run. */
export interface Blob {
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Run directories holding the bytes under `attachments/<sha256>`, by project then run id. */
  readonly sources: readonly BlobSource[];
  /** Every reference to the bytes, by project, run id, then the run's attachment order. */
  readonly references: readonly BlobReference[];
}

export interface BlobSource extends RunKey {
  readonly runDirectory: string;
}

export interface BlobReference extends RunKey {
  readonly reference: AttachmentReference;
}

export type DiscoveryProblemCode =
  'RUNS_DIRECTORY_MISSING' | 'SYMLINK_SKIPPED' | 'NOT_A_DIRECTORY' | 'NO_EVENTS_DIRECTORY';

export interface DiscoveryProblem {
  readonly code: DiscoveryProblemCode;
  readonly path: string;
  readonly message: string;
}

/**
 * An execution invariant the projector found broken in a snapshot handed to it directly. The
 * validator enforces the same three rules under protocol line 0.3 with the same names, so a
 * genuine validator-produced valid snapshot never trips them; they guard `projectRun` against
 * fabricated or cast snapshots.
 */
export type AmbiguityDetail =
  'DUPLICATE_ATTEMPT_NUMBER' | 'HISTORICAL_IDENTITY_CHANGED' | 'EXECUTION_RUNNER_CHANGED';

export type IngestionProblemCode =
  | DiscoveryProblemCode
  | 'NOT_A_RUN_DIRECTORY'
  | 'NOT_A_REGULAR_FILE'
  | 'VALIDATION_ERROR'
  | 'EMPTY_RUN'
  | 'RUN_INVALID'
  | 'PROJECTION_AMBIGUOUS'
  | 'DUPLICATE_RUN'
  | 'BLOB_SIZE_CONFLICT';

/** A run directory that did not become a run, and why. Validator diagnostics are passed through, not restated. */
export interface IngestionProblem {
  readonly code: IngestionProblemCode;
  readonly projectId: string;
  readonly runDirectory: string;
  readonly runId: string | undefined;
  readonly detail: AmbiguityDetail | undefined;
  readonly message: string;
  readonly diagnostics: readonly Diagnostic[];
}
