import type { PoolClient } from 'pg';
import { QUERY_INDEX_VERSION, type DerivedQueryIndex } from './query-index.js';

/** Occurrence rows written per statement; a run with thousands of executions still fits. */
const OCCURRENCES_PER_STATEMENT = 500;
/** Columns each occurrence row carries; 500 of them stay far below PostgreSQL's parameter limit. */
const OCCURRENCE_COLUMNS = 20;

/**
 * Replaces one run's derived rows. The caller supplies a transaction: there is never a committed
 * state in which the run's listing row and its occurrence rows come from different derivations,
 * because both are written here and both are visible only when that transaction commits.
 */
export async function replaceQueryIndex(
  client: PoolClient,
  projectId: string,
  runId: string,
  derived: DerivedQueryIndex,
  sourceFingerprint: string,
): Promise<void> {
  // The rows are written under the identity the caller locked and claimed, not one read back out
  // of the derivation: a derivation aimed elsewhere would otherwise rewrite another run's index.
  if (derived.run.projectId !== projectId || derived.run.runId !== runId) {
    throw new Error(
      `the derived index is for ${derived.run.runId} in ${derived.run.projectId}, not ${runId} in ${projectId}`,
    );
  }
  await client.query('DELETE FROM qe_history_occurrences WHERE project_id = $1 AND run_id = $2', [
    projectId,
    runId,
  ]);
  await client.query(
    `INSERT INTO qe_run_query_index (
       project_id, run_id, index_version, source_fingerprint, verdict, complete, closed,
       ignored_event_count, duplicate_event_count, session_count, execution_count,
       scope_failure_count, attachment_count, indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     ON CONFLICT (project_id, run_id) DO UPDATE SET
       index_version = EXCLUDED.index_version,
       source_fingerprint = EXCLUDED.source_fingerprint,
       verdict = EXCLUDED.verdict,
       complete = EXCLUDED.complete,
       closed = EXCLUDED.closed,
       ignored_event_count = EXCLUDED.ignored_event_count,
       duplicate_event_count = EXCLUDED.duplicate_event_count,
       session_count = EXCLUDED.session_count,
       execution_count = EXCLUDED.execution_count,
       scope_failure_count = EXCLUDED.scope_failure_count,
       attachment_count = EXCLUDED.attachment_count,
       indexed_at = now()`,
    [
      projectId,
      runId,
      QUERY_INDEX_VERSION,
      sourceFingerprint,
      derived.run.verdict,
      derived.run.complete,
      derived.run.closed,
      derived.run.ignoredEventCount,
      derived.run.duplicateEventCount,
      derived.run.sessionCount,
      derived.run.executionCount,
      derived.run.scopeFailureCount,
      derived.run.attachmentCount,
    ],
  );
  for (let start = 0; start < derived.occurrences.length; start += OCCURRENCES_PER_STATEMENT) {
    const chunk = derived.occurrences.slice(start, start + OCCURRENCES_PER_STATEMENT);
    const values: unknown[] = [];
    const tuples = chunk.map((row, i) => {
      const o = row.occurrence;
      values.push(
        projectId,
        runId,
        o.executionId,
        row.historyKey,
        QUERY_INDEX_VERSION,
        o.runnerName,
        o.historicalId,
        o.historicalIdStability,
        o.occurredAt,
        row.occurredAtInstant,
        row.occurredAtLeap,
        o.sessionIds,
        o.attemptCount,
        o.complete,
        o.finalStatus ?? null,
        o.expectedStatus ?? null,
        o.flaky,
        o.runVerdict,
        o.runComplete,
        o.sessionStatus ?? null,
      );
      const base = i * OCCURRENCE_COLUMNS;
      return `(${Array.from({ length: OCCURRENCE_COLUMNS }, (_, k) => `$${base + k + 1}`).join(', ')})`;
    });
    await client.query(
      `INSERT INTO qe_history_occurrences (
         project_id, run_id, execution_id, history_key, index_version, runner_name, historical_id,
         historical_id_stability,
         occurred_at_raw, occurred_at_instant, occurred_at_leap, session_ids, attempt_count, complete,
         final_status, expected_status, flaky, run_verdict, run_complete, session_status)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}
