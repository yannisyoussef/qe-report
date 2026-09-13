import type { Pool, PoolClient } from 'pg';
import { projectRun, type ExecutionOccurrence, type ProjectedRun } from 'qe-report-read-model';
import type {
  ExpectedStatus,
  HistoricalIdStability,
  SessionStatus,
  Status,
} from 'qe-report-protocol';
import type { Summary } from 'qe-report-validator';
import { withIngestionLock } from './locks.js';
import { replaceQueryIndex } from './index-writer.js';
import {
  QUERY_INDEX_VERSION,
  deriveQueryIndex,
  historyKeyOf,
  type DerivedQueryIndex,
} from './query-index.js';
import {
  loadStoredRun,
  projectStoredRunFrom,
  readStoredRun,
  replayStored,
  type StoredRun,
} from './store.js';

/** How many runs a rebuild pass takes when the caller does not say. */
export const DEFAULT_REBUILD_RUNS = 100;
/** How many rows a page returns when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 100;
/** The most any one page returns, whatever is asked for: a page is bounded or it is not a page. */
export const MAX_PAGE_SIZE = 1000;
/** The most runs one rebuild pass takes; it holds the shared maintenance lease throughout. */
export const MAX_REBUILD_RUNS = 1000;

/** A project id is an opaque partition key; the archive bounds its length because it is indexed. */
const MAX_PROJECT_ID_LENGTH = 128;

function checkProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || projectId === '') {
    throw new TypeError('projectId must be a non-empty string');
  }
  if (projectId.length > MAX_PROJECT_ID_LENGTH) {
    throw new TypeError(`projectId must be at most ${MAX_PROJECT_ID_LENGTH} characters`);
  }
}

function checkLimit(limit: number | undefined, fallback: number, ceiling: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a whole number of at least one');
  }
  return Math.min(limit, ceiling);
}

/** A cursor only moves the position inside a key; it still has to be one this can bind. */
function checkCursor(after: HistoryCursor | undefined): HistoryCursor | undefined {
  if (after === undefined) return undefined;
  if (!(after.occurredAt instanceof Date) || !Number.isFinite(after.occurredAt.getTime())) {
    throw new TypeError('the cursor instant must be a valid Date');
  }
  if (typeof after.runId !== 'string' || after.runId === '') {
    throw new TypeError('the cursor must name a run');
  }
  if (typeof after.executionId !== 'string' || after.executionId === '') {
    throw new TypeError('the cursor must name an execution');
  }
  return after;
}

/** PostgreSQL's `bigint`; a sequence outside it is not one this archive ever handed out. */
const MAX_BIGINT = 9_223_372_036_854_775_807n;

function checkSequence(sequence: bigint | undefined): bigint | undefined {
  if (sequence === undefined) return undefined;
  if (typeof sequence !== 'bigint' || sequence < 0n || sequence > MAX_BIGINT) {
    throw new TypeError('beforeIngestionSequence must be a non-negative bigint');
  }
  return sequence;
}

/** An error a caller may see, without the statement text or the content behind it. */
function shown(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const oneLine = raw.replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}...` : oneLine;
}

/** What a project's derived index covers, and whether a cross-run query may be answered from it. */
export interface IndexStatus {
  readonly projectId: string;
  /** The interpretation queries require; a row written under another one is stale. */
  readonly indexVersion: number;
  readonly totalRuns: number;
  /** Runs indexed under the current version from their current source. */
  readonly currentRuns: number;
  readonly missingRuns: number;
  readonly staleRuns: number;
  /** True when every archived run of the project is currently indexed. */
  readonly complete: boolean;
}

/** A cross-run query was asked of a project whose index does not cover all of it. */
export class QueryIndexIncompleteError extends Error {
  readonly status: IndexStatus;

  constructor(status: IndexStatus) {
    super(
      `project ${status.projectId} has ${status.missingRuns} unindexed and ${status.staleRuns} stale runs of ${status.totalRuns}; rebuild its query index before asking across runs`,
    );
    this.name = 'QueryIndexIncompleteError';
    this.status = status;
  }
}

/** One run as a listing shows it: the facts of its projection, without its contents. */
export interface RunSummary {
  readonly projectId: string;
  readonly runId: string;
  /** Archive order, not protocol chronology and not producer time. */
  readonly ingestionSequence: bigint;
  readonly ingestedAt: Date;
  /** Absent for a run archived before retention existed. */
  readonly expiresAt: Date | undefined;
  readonly verdict: Summary['verdict'];
  readonly complete: boolean;
  readonly closed: boolean;
  readonly ignoredEvents: number;
  readonly duplicateEvents: number;
  readonly sessionCount: number;
  readonly executionCount: number;
  readonly scopeFailureCount: number;
  readonly attachmentCount: number;
}

export interface ListRunsRequest {
  readonly projectId: string;
  readonly limit?: number;
  /** Continue below this ingestion sequence, from a previous page's `next`. */
  readonly beforeIngestionSequence?: bigint;
}

export interface RunPage {
  readonly runs: readonly RunSummary[];
  /** Pass back as `beforeIngestionSequence`; absent when the listing reached the end. */
  readonly next: bigint | undefined;
}

/** Where a history page continues: the instant the order uses, then the identifier tie-breakers. */
export interface HistoryCursor {
  readonly occurredAt: Date;
  readonly runId: string;
  readonly executionId: string;
}

export interface HistoryRequest {
  readonly projectId: string;
  readonly runnerName: string;
  readonly historicalId: string;
  readonly limit?: number;
  readonly after?: HistoryCursor;
}

export interface HistoryPage {
  readonly projectId: string;
  readonly runnerName: string;
  readonly historicalId: string;
  readonly occurrences: readonly ExecutionOccurrence[];
  readonly next: HistoryCursor | undefined;
}

export interface HistoryKey {
  readonly projectId: string;
  readonly runnerName: string;
  readonly historicalId: string;
}

/** Counted over indexed occurrences; no score, no window, and nothing stored as an aggregate. */
export interface FlakinessSummary extends HistoryKey {
  readonly totalOccurrences: number;
  readonly flakyOccurrences: number;
  readonly everFlaky: boolean;
}

export interface RebuildRequest {
  readonly projectId: string;
  readonly maxRuns?: number;
  /** Continue above this ingestion sequence, from a previous pass's `lastIngestionSequence`. */
  readonly afterIngestionSequence?: bigint;
}

export interface RebuildProblem {
  readonly runId: string;
  readonly message: string;
}

export interface RebuildResult {
  readonly projectId: string;
  readonly rebuilt: number;
  /** Runs that vanished between selection and replacement, which retention may do at any time. */
  readonly skipped: number;
  /**
   * Pass back as `afterIngestionSequence` to continue. It moves past every run the pass looked
   * at, including any named in `problems`, so that a walk of the project makes progress rather
   * than stopping on one run; a pass started without it revisits them.
   */
  readonly lastIngestionSequence: bigint | undefined;
  /** True when the limit stopped the pass before the project ended. */
  readonly more: boolean;
  readonly problems: readonly RebuildProblem[];
}

/** What a deliberate comparison of one indexed run against its source found. */
export interface IndexDrift {
  readonly projectId: string;
  readonly runId: string;
  /** True when the run is archived and its indexed rows are what its source projects to. */
  readonly agrees: boolean;
  readonly differences: readonly string[];
}

/**
 * The durable read side: one archived run replayed from its own source, and the cross-run
 * questions answered from rebuildable indexes.
 *
 * ```
 * one run          ->  raw source  ->  validator  ->  projectRun
 * runs, history    ->  query indexes
 * ```
 *
 * The indexes are derived state. They are written when a run is archived, rebuilt on demand from
 * the source, and dropped with the run by cascade; nothing here decides a verdict, an identity,
 * or what flakiness means, because all of that already happened in the validator and the
 * projector before a row was written.
 */
export class PostgresQueries {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * One complete run, rebuilt from its archived source through the validator and the projector.
   * It never consults the query index, so it answers whether or not the project is indexed.
   */
  async getRun(projectId: string, runId: string): Promise<ProjectedRun | undefined> {
    checkProjectId(projectId);
    return projectStoredRunFrom(this.pool, projectId, runId);
  }

  /** What the project's derived index covers right now. */
  async getIndexStatus(projectId: string): Promise<IndexStatus> {
    checkProjectId(projectId);
    return indexStatus(this.pool, projectId);
  }

  /**
   * The project's runs, newest archived first, in bounded keyset pages. The order is the
   * archive's own ingestion sequence: an operational order, and not protocol chronology,
   * producer time, or the order a history is presented in.
   */
  async listRuns(request: ListRunsRequest): Promise<RunPage> {
    checkProjectId(request.projectId);
    const limit = checkLimit(request.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const before = checkSequence(request.beforeIngestionSequence);
    return this.answering(request.projectId, async (client) => {
      const rows = await client.query<RunSummaryRow>(
        `SELECT r.run_id, r.ingestion_sequence, r.ingested_at, t.expires_at,
                q.verdict, q.complete, q.closed, q.ignored_event_count, q.duplicate_event_count,
                q.session_count, q.execution_count, q.scope_failure_count, q.attachment_count
           FROM qe_runs r
           JOIN qe_run_query_index q
             ON q.project_id = r.project_id AND q.run_id = r.run_id
            AND q.index_version = $2 AND q.source_fingerprint = r.content_fingerprint
           LEFT JOIN qe_run_retention t ON t.project_id = r.project_id AND t.run_id = r.run_id
          WHERE r.project_id = $1${before === undefined ? '' : ' AND r.ingestion_sequence < $4'}
          ORDER BY r.ingestion_sequence DESC
          LIMIT $3`,
        before === undefined
          ? [request.projectId, QUERY_INDEX_VERSION, limit + 1]
          : [request.projectId, QUERY_INDEX_VERSION, limit + 1, before],
      );
      const page = rows.rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        runs: page.map((row) => runSummary(request.projectId, row)),
        next:
          rows.rows.length > limit && last !== undefined
            ? BigInt(last.ingestion_sequence)
            : undefined,
      };
    });
  }

  /**
   * How one historical test behaved across the project's runs, one page at a time, in the order
   * the in-memory model presents: producer instant, then run id, then execution id. The instant
   * is stored exactly as that comparator parses it and the identifiers are compared by byte,
   * which for the protocol's printable-ASCII identifiers is the same as by code unit.
   */
  async getTestHistoryPage(request: HistoryRequest): Promise<HistoryPage> {
    checkProjectId(request.projectId);
    const limit = checkLimit(request.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const after = checkCursor(request.after);
    const key = historyKeyOf(request.runnerName, request.historicalId);
    return this.answering(request.projectId, async (client) => {
      // The cursor is a clause rather than a guarded parameter, so that the plan is the same
      // keyset scan whether or not a page follows another one.
      const rows = await client.query<OccurrenceRow>(
        `SELECT run_id, execution_id, historical_id_stability, occurred_at_raw,
                occurred_at_instant, session_ids, attempt_count, complete, final_status,
                expected_status, flaky, run_verdict, run_complete, session_status
           FROM qe_history_occurrences
          WHERE project_id = $1 AND history_key = $2 AND index_version = $3
            AND runner_name = $4 AND historical_id = $5${
              after === undefined
                ? ''
                : '\n            AND (occurred_at_instant, run_id, execution_id) > ($7, $8, $9)'
            }
          ORDER BY occurred_at_instant, run_id, execution_id
          LIMIT $6`,
        after === undefined
          ? [
              request.projectId,
              key,
              QUERY_INDEX_VERSION,
              request.runnerName,
              request.historicalId,
              limit + 1,
            ]
          : [
              request.projectId,
              key,
              QUERY_INDEX_VERSION,
              request.runnerName,
              request.historicalId,
              limit + 1,
              after.occurredAt,
              after.runId,
              after.executionId,
            ],
      );
      const page = rows.rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        projectId: request.projectId,
        runnerName: request.runnerName,
        historicalId: request.historicalId,
        occurrences: page.map((row) =>
          occurrenceOf(request.projectId, request.runnerName, request.historicalId, row),
        ),
        next:
          rows.rows.length > limit && last !== undefined
            ? {
                occurredAt: last.occurred_at_instant,
                runId: last.run_id,
                executionId: last.execution_id,
              }
            : undefined,
      };
    });
  }

  /** How often the executions of one historical test were flaky, counted over indexed rows. */
  async getFlakinessSummary(key: HistoryKey): Promise<FlakinessSummary> {
    checkProjectId(key.projectId);
    const digest = historyKeyOf(key.runnerName, key.historicalId);
    return this.answering(key.projectId, async (client) => {
      const counted = await client.query<{ total: string; flaky: string }>(
        `SELECT count(*)::text AS total, count(*) FILTER (WHERE flaky)::text AS flaky
           FROM qe_history_occurrences
          WHERE project_id = $1 AND history_key = $2 AND index_version = $3
            AND runner_name = $4 AND historical_id = $5`,
        [key.projectId, digest, QUERY_INDEX_VERSION, key.runnerName, key.historicalId],
      );
      const row = counted.rows[0];
      const flakyOccurrences = Number(row?.flaky ?? 0);
      return {
        projectId: key.projectId,
        runnerName: key.runnerName,
        historicalId: key.historicalId,
        totalOccurrences: Number(row?.total ?? 0),
        flakyOccurrences,
        everFlaky: flakyOccurrences > 0,
      };
    });
  }

  /**
   * Rebuilds the derived index of a bounded number of the project's runs from their archived
   * source, oldest first, replacing each run's rows in one transaction. It holds the shared
   * maintenance lease, so destructive retention cannot delete a run half way through, while
   * other ingestions carry on beside it.
   */
  async rebuildProjectIndex(request: RebuildRequest): Promise<RebuildResult> {
    checkProjectId(request.projectId);
    const maxRuns = checkLimit(request.maxRuns, DEFAULT_REBUILD_RUNS, MAX_REBUILD_RUNS);
    return withIngestionLock(this.pool, async (client) => {
      const selected = await client.query<{
        run_id: string;
        ingestion_sequence: string;
        content_fingerprint: string;
      }>(
        `SELECT run_id, ingestion_sequence, content_fingerprint FROM qe_runs
          WHERE project_id = $1 AND ($2::bigint IS NULL OR ingestion_sequence > $2)
          ORDER BY ingestion_sequence
          LIMIT $3`,
        [request.projectId, request.afterIngestionSequence ?? null, maxRuns + 1],
      );
      const runs = selected.rows.slice(0, maxRuns);
      const problems: RebuildProblem[] = [];
      let rebuilt = 0;
      let skipped = 0;
      for (const run of runs) {
        try {
          const stored = await readStoredRun(client, request.projectId, run.run_id);
          if (stored === undefined) {
            skipped += 1;
            continue;
          }
          const derived = deriveQueryIndex(
            projectRun(request.projectId, stored.sourceLocator, await replayStored(stored)),
          );
          const replaced = await replaceOneRun(
            client,
            request.projectId,
            run.run_id,
            derived,
            run.content_fingerprint,
          );
          if (replaced) rebuilt += 1;
          else skipped += 1;
        } catch (e) {
          // One run that cannot be indexed does not end the pass; it is named instead.
          problems.push({ runId: run.run_id, message: shown(e) });
        }
      }
      const last = runs[runs.length - 1];
      return {
        projectId: request.projectId,
        rebuilt,
        skipped,
        lastIngestionSequence: last === undefined ? undefined : BigInt(last.ingestion_sequence),
        more: selected.rows.length > maxRuns,
        problems,
      };
    });
  }

  /**
   * Replays one indexed run from its source and compares what it projects to with what is
   * stored. It is an operator's tool, not part of answering a query: the ordinary freshness
   * contract is the index version and the source fingerprint.
   */
  async verifyIndexedRun(projectId: string, runId: string): Promise<IndexDrift> {
    checkProjectId(projectId);
    const stored = await loadStoredRun(this.pool, projectId, runId);
    if (stored === undefined) {
      return { projectId, runId, agrees: false, differences: ['the run is not archived'] };
    }
    const derived = deriveQueryIndex(
      projectRun(projectId, stored.sourceLocator, await replayStored(stored)),
    );
    return compareIndex(this.pool, projectId, runId, derived, stored);
  }

  /**
   * Answers a cross-run question in one read-only snapshot: the completeness check and the
   * answer see the same rows, so a project that passes the gate cannot have changed underneath
   * the query that follows it. A run archived a moment later is simply not in this answer.
   */
  private async answering<T>(
    projectId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let returned = false;
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const incomplete = await client.query<{ incomplete: boolean }>(INCOMPLETE_SQL, [
        projectId,
        QUERY_INDEX_VERSION,
      ]);
      // Only a refusal pays for the counts that describe it.
      const status =
        incomplete.rows[0]?.incomplete === true ? await indexStatus(client, projectId) : undefined;
      const answer = status === undefined ? await fn(client) : undefined;
      await client.query('COMMIT');
      client.release();
      returned = true;
      if (status !== undefined) throw new QueryIndexIncompleteError(status);
      return answer as T;
    } catch (e) {
      // The refusal above gave the connection back already; only a real failure discards it.
      if (!returned) {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release(e instanceof Error ? e : new Error(String(e)));
      }
      throw e;
    }
  }
}

interface RunSummaryRow {
  run_id: string;
  ingestion_sequence: string;
  ingested_at: Date;
  expires_at: Date | null;
  verdict: string;
  complete: boolean;
  closed: boolean;
  ignored_event_count: number;
  duplicate_event_count: number;
  session_count: number;
  execution_count: number;
  scope_failure_count: number;
  attachment_count: number;
}

interface IndexHeadRow {
  index_version: number;
  source_fingerprint: string;
  verdict: string;
  complete: boolean;
  closed: boolean;
  ignored_event_count: number;
  duplicate_event_count: number;
  session_count: number;
  execution_count: number;
  scope_failure_count: number;
  attachment_count: number;
}

interface OccurrenceRow {
  run_id: string;
  execution_id: string;
  historical_id_stability: string;
  occurred_at_raw: string;
  occurred_at_instant: Date;
  session_ids: string[];
  attempt_count: number;
  complete: boolean;
  final_status: string | null;
  expected_status: string | null;
  flaky: boolean;
  run_verdict: string;
  run_complete: boolean;
  session_status: string | null;
}

function runSummary(projectId: string, row: RunSummaryRow): RunSummary {
  return {
    projectId,
    runId: row.run_id,
    ingestionSequence: BigInt(row.ingestion_sequence),
    ingestedAt: row.ingested_at,
    expiresAt: row.expires_at ?? undefined,
    verdict: row.verdict as Summary['verdict'],
    complete: row.complete,
    closed: row.closed,
    ignoredEvents: row.ignored_event_count,
    duplicateEvents: row.duplicate_event_count,
    sessionCount: row.session_count,
    executionCount: row.execution_count,
    scopeFailureCount: row.scope_failure_count,
    attachmentCount: row.attachment_count,
  };
}

/** The stored row read back as the occurrence it was derived from. */
function occurrenceOf(
  projectId: string,
  runnerName: string,
  historicalId: string,
  row: OccurrenceRow,
): ExecutionOccurrence {
  return {
    projectId,
    runnerName,
    historicalId,
    runId: row.run_id,
    executionId: row.execution_id,
    sessionIds: row.session_ids,
    historicalIdStability: row.historical_id_stability as HistoricalIdStability,
    occurredAt: row.occurred_at_raw,
    attemptCount: row.attempt_count,
    complete: row.complete,
    finalStatus: (row.final_status ?? undefined) as Status | undefined,
    expectedStatus: (row.expected_status ?? undefined) as ExpectedStatus | undefined,
    flaky: row.flaky,
    runVerdict: row.run_verdict as Summary['verdict'],
    runComplete: row.run_complete,
    sessionStatus: (row.session_status ?? undefined) as SessionStatus | undefined,
  };
}

/** Whether anything of the project is unindexed or indexed otherwise; stops at the first one. */
const INCOMPLETE_SQL = `SELECT EXISTS (
  SELECT 1 FROM qe_runs r
   LEFT JOIN qe_run_query_index q ON q.project_id = r.project_id AND q.run_id = r.run_id
   WHERE r.project_id = $1
     AND (q.run_id IS NULL OR q.index_version <> $2 OR q.source_fingerprint <> r.content_fingerprint)
) AS incomplete`;

async function indexStatus(db: Pool | PoolClient, projectId: string): Promise<IndexStatus> {
  const counted = await db.query<{
    total: string;
    current: string;
    missing: string;
    stale: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (
              WHERE q.run_id IS NOT NULL AND q.index_version = $2
                AND q.source_fingerprint = r.content_fingerprint)::text AS current,
            count(*) FILTER (WHERE q.run_id IS NULL)::text AS missing,
            count(*) FILTER (
              WHERE q.run_id IS NOT NULL AND (q.index_version <> $2
                OR q.source_fingerprint <> r.content_fingerprint))::text AS stale
       FROM qe_runs r
       LEFT JOIN qe_run_query_index q ON q.project_id = r.project_id AND q.run_id = r.run_id
      WHERE r.project_id = $1`,
    [projectId, QUERY_INDEX_VERSION],
  );
  const row = counted.rows[0];
  const missingRuns = Number(row?.missing ?? 0);
  const staleRuns = Number(row?.stale ?? 0);
  return {
    projectId,
    indexVersion: QUERY_INDEX_VERSION,
    totalRuns: Number(row?.total ?? 0),
    currentRuns: Number(row?.current ?? 0),
    missingRuns,
    staleRuns,
    complete: missingRuns === 0 && staleRuns === 0,
  };
}

/**
 * Replaces one run's derived rows in one transaction, having locked the run itself: two rebuilds
 * of the same run serialize on that row rather than on anything in this process. A run that is
 * no longer there is left alone.
 */
async function replaceOneRun(
  client: PoolClient,
  projectId: string,
  runId: string,
  derived: DerivedQueryIndex,
  sourceFingerprint: string,
): Promise<boolean> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    const locked = await client.query(
      'SELECT 1 FROM qe_runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE',
      [projectId, runId],
    );
    if (locked.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await replaceQueryIndex(client, projectId, runId, derived, sourceFingerprint);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/** Compares one run's stored index rows with what its source projects to now. */
async function compareIndex(
  db: Pool,
  projectId: string,
  runId: string,
  derived: DerivedQueryIndex,
  stored: StoredRun,
): Promise<IndexDrift> {
  const differences: string[] = [];
  const head = await db.query<IndexHeadRow>(
    `SELECT index_version, source_fingerprint, verdict, complete, closed,
            ignored_event_count, duplicate_event_count, session_count, execution_count,
            scope_failure_count, attachment_count
       FROM qe_run_query_index WHERE project_id = $1 AND run_id = $2`,
    [projectId, runId],
  );
  const row = head.rows[0];
  if (row === undefined) {
    differences.push('the run has no query index');
  } else {
    if (row.index_version !== QUERY_INDEX_VERSION) {
      differences.push(
        `index version: stored ${row.index_version}, current ${QUERY_INDEX_VERSION}`,
      );
    }
    if (row.source_fingerprint !== stored.contentFingerprint) {
      differences.push('source fingerprint: the index was built from other content');
    }
    const facts: [string, unknown, unknown][] = [
      ['verdict', row.verdict, derived.run.verdict],
      ['complete', row.complete, derived.run.complete],
      ['closed', row.closed, derived.run.closed],
      ['ignoredEvents', row.ignored_event_count, derived.run.ignoredEventCount],
      ['duplicateEvents', row.duplicate_event_count, derived.run.duplicateEventCount],
      ['sessions', row.session_count, derived.run.sessionCount],
      ['executions', row.execution_count, derived.run.executionCount],
      ['scopeFailures', row.scope_failure_count, derived.run.scopeFailureCount],
      ['attachments', row.attachment_count, derived.run.attachmentCount],
    ];
    for (const [name, stored_, now] of facts) {
      if (stored_ !== now)
        differences.push(`${name}: stored ${String(stored_)}, now ${String(now)}`);
    }
  }
  const occurrences = await db.query<
    OccurrenceRow & { runner_name: string; historical_id: string; index_version: number }
  >(
    `SELECT run_id, execution_id, runner_name, historical_id, historical_id_stability,
            occurred_at_raw, occurred_at_instant, session_ids, attempt_count, complete,
            final_status, expected_status, flaky, run_verdict, run_complete, session_status,
            index_version
       FROM qe_history_occurrences WHERE project_id = $1 AND run_id = $2
      ORDER BY execution_id`,
    [projectId, runId],
  );
  const expected = [...derived.occurrences].sort((a, b) =>
    byteOrder(a.occurrence.executionId, b.occurrence.executionId),
  );
  if (occurrences.rows.length !== expected.length) {
    differences.push(
      `history occurrences: stored ${occurrences.rows.length}, now ${expected.length}`,
    );
  } else {
    for (const [i, stored_] of occurrences.rows.entries()) {
      const now = expected[i];
      if (now === undefined) continue;
      const was = occurrenceOf(projectId, stored_.runner_name, stored_.historical_id, stored_);
      for (const field of OCCURRENCE_FIELDS) {
        const a = was[field];
        const b = now.occurrence[field];
        const same = Array.isArray(a) && Array.isArray(b) ? sameStrings(a, b) : a === b;
        if (!same) {
          differences.push(
            `occurrence ${now.occurrence.executionId}: ${field} is ${String(a)}, now ${String(b)}`,
          );
        }
      }
      // The column the whole history order rests on, which no other field would show.
      if (stored_.occurred_at_instant.getTime() !== now.occurredAtInstant.getTime()) {
        differences.push(
          `occurrence ${now.occurrence.executionId}: the ordering instant is not what its clock reads to`,
        );
      }
      if (stored_.index_version !== QUERY_INDEX_VERSION) {
        differences.push(
          `occurrence ${now.occurrence.executionId}: written under index version ${stored_.index_version}`,
        );
      }
    }
  }
  return { projectId, runId, agrees: differences.length === 0, differences };
}

/** Every fact an occurrence row carries, so that a comparison cannot quietly skip one. */
const OCCURRENCE_FIELDS: readonly (keyof ExecutionOccurrence)[] = [
  'projectId',
  'runnerName',
  'historicalId',
  'runId',
  'executionId',
  'sessionIds',
  'historicalIdStability',
  'occurredAt',
  'attemptCount',
  'complete',
  'finalStatus',
  'expectedStatus',
  'flaky',
  'runVerdict',
  'runComplete',
  'sessionStatus',
];

/** The order the database sorts identifiers in, so both sides of a comparison line up. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sameStrings(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
