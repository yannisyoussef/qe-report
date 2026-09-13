import type { Pool, PoolClient } from 'pg';
import {
  RunValidator,
  validateRunDirectorySnapshot,
  type Diagnostic,
  type Summary,
  type ValidatedRun,
} from 'qe-report-validator';
import { projectRun, type ProjectedRun } from 'qe-report-read-model';
import {
  FINGERPRINT_VERSION,
  buildArchive,
  contentFingerprint,
  type ArchivedLine,
  type RunArchive,
} from './archive.js';

export interface PersistRequest {
  /** Opaque, non-empty partition key chosen by the caller; never a protocol field (ADR-0007). */
  readonly projectId: string;
  /** The run directory to validate and archive; stored as provenance only. */
  readonly runDirectory: string;
}

export type PersistResult =
  | { readonly kind: 'inserted'; readonly runId: string; readonly ingestionSequence: bigint }
  | { readonly kind: 'already_present'; readonly runId: string; readonly ingestionSequence: bigint }
  | {
      readonly kind: 'rejected';
      readonly reason: 'RUN_INVALID' | 'RUN_INCOMPLETE' | 'RUN_EMPTY';
      readonly runId: string | undefined;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly kind: 'conflict';
      readonly reason: 'RUN_CONFLICT';
      readonly runId: string;
      readonly storedFingerprint: string;
      readonly offeredFingerprint: string;
    };

/** A stored source line, as archived. */
export interface StoredSourceLine {
  readonly storageOrdinal: number;
  readonly eventId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly protocolVersion: string;
  readonly canonicalSha256: string;
  readonly disposition: 'accepted' | 'ignored' | 'duplicate';
  readonly rawLine: string;
  readonly sourceFile: string;
  readonly sourceLine: number;
}

/** A run as archived: its provenance, ingestion metadata, audit summary, and every source line. */
export interface StoredRun {
  readonly projectId: string;
  readonly runId: string;
  /** Out-of-band ingestion order from the database; not protocol chronology. */
  readonly ingestionSequence: bigint;
  readonly ingestedAt: Date;
  readonly sourceLocator: string;
  readonly contentFingerprint: string;
  readonly fingerprintVersion: number;
  readonly protocolVersions: readonly string[];
  /** How many source lines were archived; compared with the rows read back. */
  readonly sourceLineCount: number;
  /** Attachment bytes were hash-verified when this run was archived; this store holds no bytes. */
  readonly attachmentsVerified: boolean;
  /** The validator summary at ingestion; an audit record, never the source of outcomes. */
  readonly validationSummary: Summary;
  readonly sourceLines: readonly StoredSourceLine[];
}

/** A stored run replayed through the current validator: the input today's projector takes. */
export interface ReplayedRun {
  readonly stored: StoredRun;
  readonly validated: ValidatedRun;
}

/** The replayed source disagrees with what was recorded at ingestion under the same contract. */
export class ReplayMismatchError extends Error {
  readonly projectId: string;
  readonly runId: string;
  readonly differences: readonly string[];

  constructor(projectId: string, runId: string, differences: readonly string[]) {
    super(
      `replay of run ${runId} in project ${projectId} disagrees with its ingestion record: ${differences.join('; ')}`,
    );
    this.name = 'ReplayMismatchError';
    this.projectId = projectId;
    this.runId = runId;
    this.differences = differences;
  }
}

function checkProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || projectId === '') {
    throw new TypeError('projectId must be a non-empty string');
  }
}

const LINE_COLUMNS = 13;
/** PostgreSQL allows 65535 parameters per statement; 500 rows of 13 stay well below. */
const LINES_PER_STATEMENT = 500;

/**
 * The durable run store: complete, validator-valid runs archived as their original protocol
 * source under `(projectId, runId)`, one transaction per run, idempotent for the same semantic
 * content and refusing different content under one identity. Nothing here mutates or deletes.
 */
export class PostgresRunStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Validates a run directory and archives it when it is valid and complete. Invalid or
   * incomplete runs write nothing. The archive is built in memory from the validation pass; the
   * filesystem is not read again inside the transaction.
   */
  async persistRunDirectory(request: PersistRequest): Promise<PersistResult> {
    checkProjectId(request.projectId);
    const validated = await validateRunDirectorySnapshot(request.runDirectory, {
      retainEvents: false,
      retainSourceLines: true,
    });
    // validateRunDirectorySnapshot checks the bytes under <run>/attachments.
    return this.persistValidated(request.projectId, request.runDirectory, validated, {
      attachmentsVerified: true,
    });
  }

  /**
   * Archives an already validated run. The same rules apply: only a valid, complete run whose
   * source lines were retained is stored. The caller states whether its validation checked the
   * attachment bytes; a run replayed from this store was validated without them.
   */
  async persistValidated(
    projectId: string,
    sourceLocator: string,
    validated: ValidatedRun,
    options: { readonly attachmentsVerified: boolean },
  ): Promise<PersistResult> {
    checkProjectId(projectId);
    const runId = validated.sourceLines[0]?.runId;
    if (!validated.report.valid) {
      return {
        kind: 'rejected',
        reason: 'RUN_INVALID',
        runId,
        diagnostics: validated.report.diagnostics.filter((d) => d.severity === 'error'),
      };
    }
    if (!validated.report.summary.complete) {
      return {
        kind: 'rejected',
        reason: 'RUN_INCOMPLETE',
        runId,
        diagnostics: validated.report.diagnostics.filter((d) => d.code === 'INCOMPLETE_RUN'),
      };
    }
    if (validated.report.summary.events === 0) {
      // Structurally valid, but it names no run: there is nothing to archive.
      return { kind: 'rejected', reason: 'RUN_EMPTY', runId: undefined, diagnostics: [] };
    }
    if (validated.sourceLines.length === 0) {
      throw new Error('the validated run carries no source lines; validate with retainSourceLines');
    }
    return persistArchive(
      this.pool,
      projectId,
      sourceLocator,
      buildArchive(validated, options.attachmentsVerified),
    );
  }

  /** The archived run, or nothing when the project holds no such run. */
  async loadRun(projectId: string, runId: string): Promise<StoredRun | undefined> {
    checkProjectId(projectId);
    const run = await this.pool.query<{
      ingestion_sequence: string;
      ingested_at: Date;
      source_locator: string;
      content_fingerprint: string;
      fingerprint_version: number;
      protocol_versions: string[];
      source_line_count: number;
      attachments_verified: boolean;
      validation_summary: Summary;
    }>(
      `SELECT ingestion_sequence, ingested_at, source_locator, content_fingerprint,
              fingerprint_version, protocol_versions, source_line_count, attachments_verified,
              validation_summary
         FROM qe_runs WHERE project_id = $1 AND run_id = $2`,
      [projectId, runId],
    );
    const head = run.rows[0];
    if (head === undefined) return undefined;
    const lines = await this.pool.query<{
      storage_ordinal: number;
      event_id: string;
      session_id: string;
      sequence: string;
      event_type: string;
      protocol_version: string;
      canonical_sha256: string;
      disposition: 'accepted' | 'ignored' | 'duplicate';
      raw_line: string;
      source_file: string;
      source_line: number;
    }>(
      `SELECT storage_ordinal, event_id, session_id, sequence, event_type, protocol_version,
              canonical_sha256, disposition, raw_line, source_file, source_line
         FROM qe_run_source_lines WHERE project_id = $1 AND run_id = $2
        ORDER BY storage_ordinal`,
      [projectId, runId],
    );
    return {
      projectId,
      runId,
      ingestionSequence: BigInt(head.ingestion_sequence),
      ingestedAt: head.ingested_at,
      sourceLocator: head.source_locator,
      contentFingerprint: head.content_fingerprint,
      fingerprintVersion: head.fingerprint_version,
      protocolVersions: head.protocol_versions,
      sourceLineCount: head.source_line_count,
      attachmentsVerified: head.attachments_verified,
      validationSummary: head.validation_summary,
      sourceLines: lines.rows.map((r) => ({
        storageOrdinal: r.storage_ordinal,
        eventId: r.event_id,
        sessionId: r.session_id,
        sequence: Number(r.sequence),
        eventType: r.event_type,
        protocolVersion: r.protocol_version,
        canonicalSha256: r.canonical_sha256,
        disposition: r.disposition,
        rawLine: r.raw_line,
        sourceFile: r.source_file,
        sourceLine: r.source_line,
      })),
    };
  }

  /**
   * Replays a stored run through the current validator, session by session in storage order,
   * and checks the result against the ingestion record. Attachment bytes are not re-verified:
   * the store holds none, and `attachmentsVerified` records that they were checked at ingestion.
   */
  async replayRun(projectId: string, runId: string): Promise<ReplayedRun | undefined> {
    const stored = await this.loadRun(projectId, runId);
    if (stored === undefined) return undefined;
    return { stored, validated: await replayStored(stored) };
  }

  /** The stored run as today's projector sees it: replayed, then projected. */
  async projectStoredRun(projectId: string, runId: string): Promise<ProjectedRun | undefined> {
    const replayed = await this.replayRun(projectId, runId);
    if (replayed === undefined) return undefined;
    return projectRun(projectId, replayed.stored.sourceLocator, replayed.validated);
  }
}

/**
 * The transaction behind every persist: claim the identity, insert every line, commit; or read
 * the claimant and back out. Exported for the package's own tests; callers archive through the
 * store, which admits only complete valid runs.
 */
export async function persistArchive(
  pool: Pool,
  projectId: string,
  sourceLocator: string,
  archive: RunArchive,
): Promise<PersistResult> {
  checkProjectId(projectId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const claimed = await client.query<{ ingestion_sequence: string }>(
      `INSERT INTO qe_runs (
         project_id, run_id, source_locator, content_fingerprint, fingerprint_version,
         protocol_versions, source_line_count, attachments_verified, validation_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (project_id, run_id) DO NOTHING
       RETURNING ingestion_sequence`,
      [
        projectId,
        archive.runId,
        sourceLocator,
        archive.contentFingerprint,
        archive.fingerprintVersion,
        archive.protocolVersions,
        archive.lines.length,
        archive.attachmentsVerified,
        JSON.stringify(archive.summary),
      ],
    );
    const row = claimed.rows[0];
    if (row === undefined) {
      // Under READ COMMITTED the insert waited for a concurrent claimant to finish, so the row
      // read here is the committed winner (or absent if it rolled back, which the next attempt handles).
      const existing = await client.query<{
        content_fingerprint: string;
        fingerprint_version: number;
        ingestion_sequence: string;
      }>(
        'SELECT content_fingerprint, fingerprint_version, ingestion_sequence FROM qe_runs WHERE project_id = $1 AND run_id = $2',
        [projectId, archive.runId],
      );
      const stored = existing.rows[0];
      if (stored === undefined) {
        throw new Error('run identity claimed by a transaction that vanished; retry');
      }
      // A run archived under an older fingerprint rule is compared by recomputing from its lines.
      const storedFingerprint =
        stored.fingerprint_version === archive.fingerprintVersion
          ? stored.content_fingerprint
          : contentFingerprint(
              (
                await client.query<{
                  canonical_sha256: string;
                  disposition: 'accepted' | 'ignored' | 'duplicate';
                }>(
                  'SELECT canonical_sha256, disposition FROM qe_run_source_lines WHERE project_id = $1 AND run_id = $2',
                  [projectId, archive.runId],
                )
              ).rows.map((r) => ({
                canonicalSha256: r.canonical_sha256,
                disposition: r.disposition,
              })),
            );
      await client.query('ROLLBACK');
      client.release();
      if (storedFingerprint === archive.contentFingerprint) {
        return {
          kind: 'already_present',
          runId: archive.runId,
          ingestionSequence: BigInt(stored.ingestion_sequence),
        };
      }
      return {
        kind: 'conflict',
        reason: 'RUN_CONFLICT',
        runId: archive.runId,
        storedFingerprint,
        offeredFingerprint: archive.contentFingerprint,
      };
    }
    await insertLines(client, projectId, archive.runId, archive.lines);
    await client.query('COMMIT');
    client.release();
    return {
      kind: 'inserted',
      runId: archive.runId,
      ingestionSequence: BigInt(row.ingestion_sequence),
    };
  } catch (e) {
    // The connection may be mid-transaction or broken: roll back if possible and discard it.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release(e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
}

async function insertLines(
  client: PoolClient,
  projectId: string,
  runId: string,
  lines: readonly ArchivedLine[],
): Promise<void> {
  for (let start = 0; start < lines.length; start += LINES_PER_STATEMENT) {
    const chunk = lines.slice(start, start + LINES_PER_STATEMENT);
    const values: unknown[] = [];
    const tuples = chunk.map((line, i) => {
      values.push(
        projectId,
        runId,
        line.storageOrdinal,
        line.eventId,
        line.sessionId,
        line.sequence,
        line.eventType,
        line.protocolVersion,
        line.canonicalSha256,
        line.disposition,
        line.rawLine,
        line.sourceFile,
        line.sourceLine,
      );
      const base = i * LINE_COLUMNS;
      return `(${Array.from({ length: LINE_COLUMNS }, (_, k) => `$${base + k + 1}`).join(', ')})`;
    });
    await client.query(
      `INSERT INTO qe_run_source_lines (
         project_id, run_id, storage_ordinal, event_id, session_id, sequence, event_type,
         protocol_version, canonical_sha256, disposition, raw_line, source_file, source_line)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}

/**
 * Summary facts that must agree between ingestion and replay under one software contract. The
 * file count is not among them: it describes the directory layout (an empty extra file, a copy
 * of a session file holding only duplicates), and replay reads one group per session.
 */
const COMPARED: readonly (keyof Summary)[] = [
  'events',
  'sessions',
  'attempts',
  'steps',
  'attachments',
  'failedAttempts',
  'scopeFailures',
  'failedSessions',
  'inconclusiveSessions',
  'sessionFailures',
  'ignored',
  'duplicates',
  'complete',
  'closed',
  'verdict',
];

/**
 * Feeds the stored lines to a fresh validator, one feed per session in storage order (as one
 * session file each), without an attachments directory, and compares the summary with the
 * ingestion record.
 */
export async function replayStored(stored: StoredRun): Promise<ValidatedRun> {
  const run = new RunValidator({ retainEvents: true, retainSourceLines: true });
  const bySession = new Map<string, string[]>();
  for (const line of stored.sourceLines) {
    const list = bySession.get(line.sessionId);
    if (list === undefined) bySession.set(line.sessionId, [line.rawLine]);
    else list.push(line.rawLine);
  }
  for (const [sessionId, lines] of bySession) {
    run.feed(lines, `postgres:${stored.projectId}/${stored.runId}/${sessionId}`, true);
  }
  // finish() touches the filesystem only for attachments, which are not configured here.
  const report = await run.finish();
  const differences: string[] = [];
  if (!report.valid) {
    differences.push(
      `replayed source is not valid: ${report.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code}${d.detail ? `(${d.detail})` : ''}`)
        .join(', ')}`,
    );
  }
  for (const key of COMPARED) {
    const was = stored.validationSummary[key];
    const now = report.summary[key];
    if (was !== now) differences.push(`${key}: ingested ${String(was)}, replayed ${String(now)}`);
  }
  if (stored.sourceLines.length !== stored.sourceLineCount) {
    differences.push(
      `source lines: archived ${stored.sourceLineCount}, read ${stored.sourceLines.length}`,
    );
  }
  // The lines read back must still carry the archived content, whatever the index columns say.
  if (
    stored.fingerprintVersion === FINGERPRINT_VERSION &&
    contentFingerprint(run.sourceLines()) !== stored.contentFingerprint
  ) {
    differences.push('content fingerprint: the source lines no longer match the archived content');
  }
  if (differences.length > 0) {
    throw new ReplayMismatchError(stored.projectId, stored.runId, differences);
  }
  return { report, events: run.acceptedEvents(), sourceLines: run.sourceLines() };
}
