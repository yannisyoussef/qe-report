import { createHash } from 'node:crypto';
import {
  historyInstantMs,
  historyOccurrencesOf,
  type ExecutionOccurrence,
  type ProjectedRun,
} from 'qe-report-read-model';

/**
 * How a projected run is read into query-index rows. It is not the protocol version, not the
 * schema migration version, and not the package version: it changes when this interpretation
 * changes, and rows written under an older one are stale until they are rebuilt. Queries refuse
 * to serve a project holding any.
 */
export const QUERY_INDEX_VERSION = 1;

/** The listing facts of one run, copied from its projection. Nothing here is computed. */
export interface RunIndexRow {
  readonly projectId: string;
  readonly runId: string;
  readonly verdict: string;
  readonly complete: boolean;
  readonly closed: boolean;
  readonly ignoredEventCount: number;
  readonly duplicateEventCount: number;
  readonly sessionCount: number;
  readonly executionCount: number;
  readonly scopeFailureCount: number;
  readonly attachmentCount: number;
}

/**
 * One history occurrence as it is stored: the occurrence the read model derives, plus the
 * instant its comparator would order by, parsed once here so that the database orders exactly
 * as the in-memory model does.
 */
export interface OccurrenceIndexRow {
  readonly occurrence: ExecutionOccurrence;
  readonly occurredAtInstant: Date;
  /** {@link historyKeyOf} of the occurrence's runner and historical id. */
  readonly historyKey: Buffer;
}

export interface DerivedQueryIndex {
  readonly run: RunIndexRow;
  readonly occurrences: readonly OccurrenceIndexRow[];
}

/**
 * Reads a projected run into the rows a query answers from. Every fact is copied: the verdict
 * and completeness come from the validator through the projector, the occurrences from the read
 * model's own derivation, and the flakiness from the projected execution. Nothing is decided
 * here, so nothing here can disagree with the in-memory model.
 */
export function deriveQueryIndex(run: ProjectedRun): DerivedQueryIndex {
  return {
    run: {
      projectId: run.projectId,
      runId: run.runId,
      verdict: run.validator.verdict,
      complete: run.validator.complete,
      closed: run.validator.closed,
      ignoredEventCount: run.validator.ignoredEvents,
      duplicateEventCount: run.validator.duplicateEvents,
      sessionCount: run.sessions.length,
      executionCount: run.executions.length,
      scopeFailureCount: run.scopeFailures.length,
      attachmentCount: run.attachments.length,
    },
    occurrences: historyOccurrencesOf(run).map((occurrence) => ({
      occurrence,
      occurredAtInstant: instantOf(occurrence),
      historyKey: historyKeyOf(occurrence.runnerName, occurrence.historicalId),
    })),
  };
}

/**
 * What the history index is keyed by: a digest of the runner name and the historical id, which
 * the protocol bounds at 512 characters each. In multi-byte text two of those exceed what a
 * btree key can hold, and an index that a producer's own test names could make unwritable would
 * take a whole project's history down with it. The names are stored and compared beside the
 * digest, so the key is only how a row is found and never what makes it the right row.
 */
export function historyKeyOf(runnerName: string, historicalId: string): Buffer {
  return createHash('sha256')
    .update(runnerName, 'utf8')
    .update(Buffer.of(0))
    .update(historicalId, 'utf8')
    .digest();
}

/**
 * The instant the in-memory comparator sorts by, taken from the same function it uses, so that
 * the two orders cannot differ by construction. The protocol allows up to nanosecond precision
 * in the text and the comparator reads milliseconds, which is why the database stores what was
 * read rather than re-parsing the string and keeping more. It is total: a run the platform
 * cannot read a clock from is still archived and still indexed, because derived state never
 * decides whether a validated run may be stored.
 */
function instantOf(occurrence: ExecutionOccurrence): Date {
  return new Date(historyInstantMs(occurrence.occurredAt));
}
