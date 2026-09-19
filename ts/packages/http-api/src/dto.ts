import type { FlakinessSummary, HistoryPage, PersistResult, RunSummary } from 'qe-report-postgres';
import type {
  Attempt,
  AttachmentReference,
  ExecutionOccurrence,
  ProjectedRun,
  ProjectedSession,
  ScopeFailure,
  Step,
  TestExecution,
} from 'qe-report-read-model';
import type { Diagnostic } from 'qe-report-validator';
import { encodeRunRef } from './run-ref.js';

/**
 * The public shapes of API v1. Each is built field by field from the domain object it reports,
 * so that no internal structure reaches a client because a serializer could reach it: no run
 * directory, source locator, content fingerprint, archived line, database identifier, or storage
 * key. Absent facts are omitted rather than sent as null. Values the protocol defines (a test
 * case, a component, a failure, a location) are protocol data and pass through as the protocol
 * shapes them.
 */

/** Copies only the members that are set, so an absent fact is absent on the wire. */
function defined<T extends Record<string, unknown>>(record: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value;
  return out as Partial<T>;
}

export function ingestionDto(
  result: Extract<PersistResult, { kind: 'inserted' | 'already_present' }>,
): Record<string, unknown> {
  const common = {
    outcome: result.kind,
    runId: result.runId,
    runRef: encodeRunRef(result.runId),
    ingestionSequence: result.ingestionSequence.toString(),
  };
  if (result.kind === 'inserted') return common;
  return {
    ...common,
    blobRelationsAdded: result.blobRelationsAdded,
    retentionAdded: result.retentionAdded,
    queryIndexRebuilt: result.queryIndexRebuilt,
  };
}

/**
 * A validator diagnostic as a client may see it. The store already names files relative to the
 * upload (`events/000001.ndjson`); nothing here can carry a server path.
 */
export function diagnosticDto(d: Diagnostic): Record<string, unknown> {
  return defined({
    severity: d.severity,
    code: d.code,
    detail: d.detail,
    message: d.message,
    file: d.file === '' ? undefined : d.file,
    line: d.line === 0 ? undefined : d.line,
    eventId: d.eventId,
    pointer: d.pointer === '' ? undefined : d.pointer,
  });
}

export function runSummaryDto(summary: RunSummary): Record<string, unknown> {
  return defined({
    runId: summary.runId,
    runRef: encodeRunRef(summary.runId),
    ingestionSequence: summary.ingestionSequence.toString(),
    ingestedAt: summary.ingestedAt.toISOString(),
    expiresAt: summary.expiresAt?.toISOString(),
    verdict: summary.verdict,
    complete: summary.complete,
    closed: summary.closed,
    ignoredEvents: summary.ignoredEvents,
    duplicateEvents: summary.duplicateEvents,
    sessionCount: summary.sessionCount,
    executionCount: summary.executionCount,
    scopeFailureCount: summary.scopeFailureCount,
    attachmentCount: summary.attachmentCount,
  });
}

function attachmentDto(runRef: string, a: AttachmentReference): Record<string, unknown> {
  return defined({
    sessionId: a.sessionId,
    attemptId: a.attemptId,
    stepId: a.stepId,
    name: a.name,
    mediaType: a.mediaType,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    href: `/v1/runs/${runRef}/attachments/${a.sha256}`,
  });
}

function sessionDto(s: ProjectedSession): Record<string, unknown> {
  return defined({
    sessionId: s.sessionId,
    startedAt: s.startedAt,
    producer: s.producer,
    runner: s.runner,
    environment: s.environment,
    executor: s.executor,
    source: s.source,
    labels: s.labels,
    finished: s.finished,
    finishedAt: s.finishedAt,
    status: s.status,
    rawStatus: s.rawStatus,
    failures: s.failures,
    executionIds: s.executionIds,
  });
}

function stepDto(s: Step): Record<string, unknown> {
  return defined({
    stepId: s.stepId,
    parentStepId: s.parentStepId,
    name: s.name,
    kind: s.kind,
    location: s.location,
    startedAt: s.startedAt,
    finished: s.finished,
    finishedAt: s.finishedAt,
    status: s.status,
    rawStatus: s.rawStatus,
    durationMs: s.durationMs,
    failures: s.failures,
  });
}

function attemptDto(runRef: string, a: Attempt): Record<string, unknown> {
  return defined({
    attemptId: a.attemptId,
    attemptNumber: a.attemptNumber,
    sessionId: a.sessionId,
    startedAt: a.startedAt,
    test: a.test,
    finished: a.finished,
    finishedAt: a.finishedAt,
    status: a.status,
    rawStatus: a.rawStatus,
    expectedStatus: a.expectedStatus,
    durationMs: a.durationMs,
    failures: a.failures,
    steps: a.steps.map(stepDto),
    attachments: a.attachments.map((x) => attachmentDto(runRef, x)),
  });
}

function executionDto(runRef: string, e: TestExecution): Record<string, unknown> {
  return defined({
    executionId: e.executionId,
    runnerName: e.runnerName,
    test: e.test,
    attempts: e.attempts.map((a) => attemptDto(runRef, a)),
    finalAttemptId: e.finalAttempt.attemptId,
    complete: e.complete,
    finalStatus: e.finalStatus,
    flaky: e.flaky,
  });
}

function scopeFailureDto(f: ScopeFailure): Record<string, unknown> {
  return defined({
    sessionId: f.sessionId,
    occurredAt: f.occurredAt,
    path: f.path,
    displayName: f.displayName,
    rawStatus: f.rawStatus,
    location: f.location,
    failures: f.failures,
  });
}

/** One whole run, replayed from its archived source, as the reporting facts it projects to. */
export function runDto(run: ProjectedRun): Record<string, unknown> {
  const runRef = encodeRunRef(run.runId);
  return {
    runId: run.runId,
    runRef,
    validator: {
      verdict: run.validator.verdict,
      complete: run.validator.complete,
      closed: run.validator.closed,
      ignoredEvents: run.validator.ignoredEvents,
      duplicateEvents: run.validator.duplicateEvents,
    },
    sessions: run.sessions.map(sessionDto),
    executions: run.executions.map((e) => executionDto(runRef, e)),
    scopeFailures: run.scopeFailures.map(scopeFailureDto),
    attachments: run.attachments.map((a) => attachmentDto(runRef, a)),
  };
}

export function occurrenceDto(o: ExecutionOccurrence): Record<string, unknown> {
  return defined({
    runId: o.runId,
    runRef: encodeRunRef(o.runId),
    executionId: o.executionId,
    sessionIds: o.sessionIds,
    historicalIdStability: o.historicalIdStability,
    occurredAt: o.occurredAt,
    attemptCount: o.attemptCount,
    complete: o.complete,
    finalStatus: o.finalStatus,
    expectedStatus: o.expectedStatus,
    flaky: o.flaky,
    runVerdict: o.runVerdict,
    runComplete: o.runComplete,
    sessionStatus: o.sessionStatus,
  });
}

export function historyPageDto(
  page: HistoryPage,
  nextCursor: string | undefined,
): Record<string, unknown> {
  return defined({
    runnerName: page.runnerName,
    historicalId: page.historicalId,
    occurrences: page.occurrences.map(occurrenceDto),
    nextCursor,
  });
}

export function flakinessDto(summary: FlakinessSummary): Record<string, unknown> {
  return {
    runnerName: summary.runnerName,
    historicalId: summary.historicalId,
    totalOccurrences: summary.totalOccurrences,
    flakyOccurrences: summary.flakyOccurrences,
    everFlaky: summary.everFlaky,
  };
}
