import { createHash } from 'node:crypto';
import {
  historyInstant,
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
 * position its comparator would order it by, read once here by the same primitive so that the
 * database orders exactly as the in-memory model does.
 */
export interface OccurrenceIndexRow {
  readonly occurrence: ExecutionOccurrence;
  /** The position's instant: for a leap second, the last millisecond of the second before it. */
  readonly occurredAtInstant: Date;
  /** 0 for an ordinary timestamp; for a leap second, 1 plus its millisecond within it. */
  readonly occurredAtLeap: number;
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
    occurrences: historyOccurrencesOf(run).map((occurrence) => {
      // The read model's own ordering primitive: a timestamp no validator accepts is refused
      // there rather than given a place, and nothing here reads a clock differently.
      const position = historyInstant(occurrence.occurredAt);
      return {
        occurrence,
        occurredAtInstant: new Date(position.epochMs),
        occurredAtLeap: position.leap,
        historyKey: historyKeyOf(occurrence.runnerName, occurrence.historicalId),
      };
    }),
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
