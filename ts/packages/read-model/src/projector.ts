import type {
  AttachmentAddedEvent,
  AttemptFinishedEvent,
  AttemptStartedEvent,
  Event,
  ExpectedStatus,
  ScopeFailedEvent,
  SessionFinishedEvent,
  SessionStartedEvent,
  StepFinishedEvent,
  StepStartedEvent,
} from 'qe-report-protocol';
import type { ValidatedRun } from 'qe-report-validator';
import type {
  AmbiguityDetail,
  Attempt,
  AttachmentReference,
  ProjectedRun,
  ProjectedSession,
  ScopeFailure,
  Step,
  TestExecution,
} from './model.js';

/**
 * A snapshot whose executions contradict themselves: two attempts with one attempt number, a
 * history identity that changes between attempts, or attempts in sessions of different runners.
 * The validator rejects all three under protocol line 0.3 (LIFECYCLE_INVALID with the same detail
 * names), so validation-first ingestion never reaches this; it protects direct callers of
 * `projectRun` that pass a fabricated or cast snapshot, and the read model never holds an
 * invented fact. Ingestion would report it as PROJECTION_AMBIGUOUS.
 */
export class AmbiguousRunError extends Error {
  readonly detail: AmbiguityDetail;
  readonly executionId: string;

  constructor(detail: AmbiguityDetail, executionId: string, message: string) {
    super(message);
    this.name = 'AmbiguousRunError';
    this.detail = detail;
    this.executionId = executionId;
  }
}

interface SessionState {
  started: SessionStartedEvent;
  finished: SessionFinishedEvent | undefined;
  executionIds: Set<string>;
}

interface StepState {
  started: StepStartedEvent;
  finished: StepFinishedEvent | undefined;
}

interface AttemptState {
  started: AttemptStartedEvent;
  finished: AttemptFinishedEvent | undefined;
  steps: StepState[];
  stepsById: Map<string, StepState>;
  attachments: AttachmentReference[];
}

interface Emitted {
  sessionId: string;
  sequence: number;
  reference: AttachmentReference;
}

/**
 * Projects the accepted events of one valid run into an immutable run. Pure and deterministic:
 * sessions are ordered by session id, executions by execution id, attempts by attempt number,
 * and facts inside a session by that session's own sequence, so the order in which files were
 * fed never shows. The verdict, completeness, and closure are the validator's.
 */
export function projectRun(
  projectId: string,
  runDirectory: string,
  snapshot: ValidatedRun,
): ProjectedRun {
  if (!snapshot.report.valid) throw new Error('only a valid run can be projected');
  const sessions = new Map<string, SessionState>();
  const attempts = new Map<string, AttemptState>();
  const scopeFailures: ScopeFailure[] = [];
  const emitted: Emitted[] = [];
  let runId: string | undefined;

  for (const event of ordered(snapshot.events)) {
    runId ??= event.runId;
    switch (event.eventType) {
      case 'session.started':
        sessions.set(event.sessionId, {
          started: event,
          finished: undefined,
          executionIds: new Set(),
        });
        break;
      case 'session.finished': {
        const s = sessions.get(event.sessionId);
        if (s) s.finished = event;
        break;
      }
      case 'run.finished':
        break;
      case 'attempt.started':
        attempts.set(event.payload.attemptId, {
          started: event,
          finished: undefined,
          steps: [],
          stepsById: new Map(),
          attachments: [],
        });
        sessions.get(event.sessionId)?.executionIds.add(event.payload.test.executionId);
        break;
      case 'attempt.finished': {
        const a = attempts.get(event.payload.attemptId);
        if (a) a.finished = event;
        break;
      }
      case 'step.started': {
        const a = attempts.get(event.payload.attemptId);
        if (a) {
          const state: StepState = { started: event, finished: undefined };
          a.steps.push(state);
          a.stepsById.set(event.payload.stepId, state);
        }
        break;
      }
      case 'step.finished': {
        const state = attempts.get(event.payload.attemptId)?.stepsById.get(event.payload.stepId);
        if (state) state.finished = event;
        break;
      }
      case 'attachment.added': {
        const r = reference(event);
        attempts.get(event.payload.attemptId)?.attachments.push(r);
        emitted.push({ sessionId: event.sessionId, sequence: event.sequence, reference: r });
        break;
      }
      case 'scope.failed':
        scopeFailures.push(scopeFailure(event));
        break;
    }
  }
  if (runId === undefined) throw new Error('a valid run carries at least one event');

  const executions = groupExecutions(attempts, sessions);
  const projectedSessions = [...sessions.values()]
    .map(session)
    .sort((a, b) => compare(a.sessionId, b.sessionId));
  return {
    projectId,
    runId,
    runDirectory,
    validator: {
      valid: true,
      complete: snapshot.report.summary.complete,
      closed: snapshot.report.summary.closed,
      verdict: snapshot.report.summary.verdict,
      ignoredEvents: snapshot.report.summary.ignored,
      duplicateEvents: snapshot.report.summary.duplicates,
    },
    sessions: projectedSessions,
    executions,
    scopeFailures,
    attachments: emitted
      .sort((a, b) => compare(a.sessionId, b.sessionId) || a.sequence - b.sequence)
      .map((e) => e.reference),
  };
}

/** Events by session id, then by sequence: the only ordering the protocol defines. */
function ordered(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => compare(a.sessionId, b.sessionId) || a.sequence - b.sequence);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function reference(e: AttachmentAddedEvent): AttachmentReference {
  return {
    sessionId: e.sessionId,
    attemptId: e.payload.attemptId,
    stepId: e.payload.stepId,
    name: e.payload.name,
    mediaType: e.payload.mediaType,
    sizeBytes: e.payload.sizeBytes,
    sha256: e.payload.sha256,
  };
}

function scopeFailure(e: ScopeFailedEvent): ScopeFailure {
  return {
    sessionId: e.sessionId,
    occurredAt: e.occurredAt,
    path: e.payload.path,
    displayName: e.payload.displayName,
    rawStatus: e.payload.rawStatus,
    location: e.payload.location,
    failures: e.payload.failures,
  };
}

function session(s: SessionState): ProjectedSession {
  const p = s.started.payload;
  const f = s.finished?.payload;
  return {
    sessionId: s.started.sessionId,
    startedAt: s.started.occurredAt,
    producer: p.producer,
    runner: p.runner,
    environment: p.environment,
    executor: p.executor,
    source: p.source,
    labels: p.labels,
    finished: s.finished !== undefined,
    finishedAt: s.finished?.occurredAt,
    status: f?.status,
    rawStatus: f?.rawStatus,
    failures: f?.failures ?? [],
    executionIds: [...s.executionIds].sort(compare),
  };
}

function step(s: StepState): Step {
  const p = s.started.payload;
  const f = s.finished?.payload;
  return {
    stepId: p.stepId,
    parentStepId: p.parentStepId,
    name: p.name,
    kind: p.kind,
    location: p.location,
    startedAt: s.started.occurredAt,
    finished: s.finished !== undefined,
    finishedAt: s.finished?.occurredAt,
    status: f?.status,
    rawStatus: f?.rawStatus,
    durationMs: f?.durationMs,
    failures: f?.failures ?? [],
  };
}

function attempt(a: AttemptState): Attempt {
  const p = a.started.payload;
  const f = a.finished?.payload;
  return {
    attemptId: p.attemptId,
    attemptNumber: p.attemptNumber,
    sessionId: a.started.sessionId,
    startedAt: a.started.occurredAt,
    test: p.test,
    finished: a.finished !== undefined,
    finishedAt: a.finished?.occurredAt,
    status: f?.status,
    rawStatus: f?.rawStatus,
    expectedStatus: f?.expectedStatus,
    durationMs: f?.durationMs,
    failures: f?.failures ?? [],
    steps: a.steps.map(step),
    attachments: a.attachments,
  };
}

function expected(a: Attempt): ExpectedStatus {
  return a.expectedStatus ?? 'passed';
}

/**
 * Groups attempts by execution id and checks, defensively, that the group has one meaning: one
 * attempt per attempt number, one historical identity, one runner. The validator guarantees all
 * three for a valid run; a snapshot that breaks them was not produced by it, and the projector
 * refuses rather than guesses.
 */
function groupExecutions(
  attempts: Map<string, AttemptState>,
  sessions: Map<string, SessionState>,
): TestExecution[] {
  const groups = new Map<string, AttemptState[]>();
  for (const a of attempts.values()) {
    const id = a.started.payload.test.executionId;
    const list = groups.get(id) ?? [];
    list.push(a);
    groups.set(id, list);
  }
  const executions: TestExecution[] = [];
  for (const [executionId, states] of [...groups.entries()].sort(([a], [b]) => compare(a, b))) {
    const list = states.map(attempt).sort((a, b) => a.attemptNumber - b.attemptNumber);
    for (let i = 1; i < list.length; i += 1) {
      const previous = list[i - 1] as Attempt;
      const current = list[i] as Attempt;
      if (previous.attemptNumber === current.attemptNumber) {
        throw new AmbiguousRunError(
          'DUPLICATE_ATTEMPT_NUMBER',
          executionId,
          `execution ${executionId} has two attempts numbered ${current.attemptNumber} (${previous.attemptId}, ${current.attemptId}); the final attempt is undefined`,
        );
      }
    }
    const first = list[0] as Attempt;
    for (const a of list) {
      if (
        a.test.historicalId !== first.test.historicalId ||
        a.test.historicalIdStability !== first.test.historicalIdStability
      ) {
        throw new AmbiguousRunError(
          'HISTORICAL_IDENTITY_CHANGED',
          executionId,
          `execution ${executionId} changes historical identity between attempts ${first.attemptId} and ${a.attemptId}`,
        );
      }
    }
    const runnerNames = new Set(
      list.map((a) => sessions.get(a.sessionId)?.started.payload.runner?.name),
    );
    if (runnerNames.size > 1) {
      throw new AmbiguousRunError(
        'EXECUTION_RUNNER_CHANGED',
        executionId,
        `execution ${executionId} spans sessions that declare different runners`,
      );
    }
    const finalAttempt = list[list.length - 1] as Attempt;
    const complete = list.every((a) => a.finished);
    executions.push({
      executionId,
      runnerName: [...runnerNames][0],
      test: first.test,
      attempts: list,
      finalAttempt,
      complete,
      finalStatus: finalAttempt.status,
      flaky: isFlaky(list),
    });
  }
  return executions;
}

/**
 * The flakiness rule over the attempts of one execution, whose final attempt is the one with
 * the highest attempt number; see {@link TestExecution.flaky}.
 */
export function isFlaky(attempts: readonly Attempt[]): boolean {
  if (attempts.length < 2) return false;
  const finalAttempt = attempts.reduce((f, a) => (a.attemptNumber > f.attemptNumber ? a : f));
  if (!finalAttempt.finished) return false;
  if (finalAttempt.status !== 'passed' || expected(finalAttempt) !== 'passed') return false;
  return attempts.some(
    (a) => a !== finalAttempt && a.finished && a.status === 'failed' && expected(a) === 'passed',
  );
}
