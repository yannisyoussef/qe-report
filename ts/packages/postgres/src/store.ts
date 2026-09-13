import type { Pool, PoolClient } from 'pg';
import type { BlobDescriptor, BlobStore, BlobStoreError, OpenedBlob } from 'qe-report-blob-fs';
import { isSha256 } from 'qe-report-blob-fs';
import {
  RunValidator,
  validateRunDirectorySnapshot,
  type Diagnostic,
  type Summary,
  type ValidatedRun,
} from 'qe-report-validator';
import { projectRun, type ProjectedRun } from 'qe-report-read-model';
import { replaceQueryIndex } from './index-writer.js';
import { QUERY_INDEX_VERSION, deriveQueryIndex, type DerivedQueryIndex } from './query-index.js';
import {
  FINGERPRINT_VERSION,
  buildArchive,
  contentFingerprint,
  requiredBlobs,
  type ArchivedLine,
  type RequiredBlob,
  type RunArchive,
} from './archive.js';
import { AttachmentIntegrityError, BlobSizeConflictError } from './errors.js';
import { withIngestionLock } from './locks.js';
import { MATERIALISE_CONCURRENCY, eachLimited, materialiseBlobs } from './materialise.js';

export interface PersistRequest {
  /** Opaque, non-empty partition key chosen by the caller; never a protocol field (ADR-0007). */
  readonly projectId: string;
  /** The run directory to validate and archive; stored as provenance only. */
  readonly runDirectory: string;
  /**
   * The instant after which retention may delete this run: ingestion context like the project
   * id, supplied by whoever ingests and never derived from the run's events, its files, or the
   * time it was archived. An instant already past is valid and makes the run eligible at once.
   * A run archived here always gets one; the first one recorded is the one that stands.
   */
  readonly expiresAt: Date;
}

export type PersistResult =
  | { readonly kind: 'inserted'; readonly runId: string; readonly ingestionSequence: bigint }
  | {
      readonly kind: 'already_present';
      readonly runId: string;
      readonly ingestionSequence: bigint;
      /**
       * Run-to-blob relations this call recorded for a run archived before its bytes were
       * durable; zero for a run archived with them. The run's source and provenance are untouched.
       */
      readonly blobRelationsAdded: number;
      /**
       * True when this call gave a retention-unmanaged run its missing retention fact, which a
       * run archived before retention existed has none of. An established expiry is never moved.
       */
      readonly retentionAdded: boolean;
      /**
       * True when this call rebuilt the run's derived query index because it was missing or was
       * written under an older interpretation of a projected run. Derived state is repaired
       * here, never promoted to truth: the archived source is untouched.
       */
      readonly queryIndexRebuilt: boolean;
    }
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

/** A blob the catalog relates to a run: metadata only, the bytes are in the blob store. */
export interface StoredBlob extends BlobDescriptor {
  readonly storedAt: Date;
}

/** A run as archived: its provenance, ingestion metadata, audit summary, every source line, and its blob relations. */
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
  /**
   * The validation pass at ingestion checked the source attachment bytes. An audit claim about
   * the source then; whether durable bytes exist now is `blobs` plus verification.
   */
  readonly sourceAttachmentsVerified: boolean;
  /**
   * When retention may delete this run. Absent for a run archived before retention existed:
   * such a run is retention-unmanaged, is never swept, and gains its fact only if it is
   * re-ingested from its source.
   */
  readonly expiresAt: Date | undefined;
  /** The validator summary at ingestion; an audit record, never the source of outcomes. */
  readonly validationSummary: Summary;
  readonly sourceLines: readonly StoredSourceLine[];
  /** The durable blobs the catalog relates to this run, by hash; empty for a legacy archive. */
  readonly blobs: readonly StoredBlob[];
}

/** A stored run replayed through the current validator: the input today's projector takes. */
export interface ReplayedRun {
  readonly stored: StoredRun;
  readonly validated: ValidatedRun;
  /** Present when the caller asked for the bytes to be re-read: every required blob, verified. */
  readonly verifiedBlobs: readonly BlobDescriptor[] | undefined;
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

/** An opaque partition key, bounded because the derived indexes are keyed by it. */
const MAX_PROJECT_ID_LENGTH = 128;

function checkProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || projectId === '') {
    throw new TypeError('projectId must be a non-empty string');
  }
  if (projectId.length > MAX_PROJECT_ID_LENGTH) {
    throw new TypeError(`projectId must be at most ${MAX_PROJECT_ID_LENGTH} characters`);
  }
}

/** Retention refuses to guess: an ingestion states one finite instant, or archives nothing. */
function checkExpiresAt(expiresAt: unknown): Date {
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) {
    throw new TypeError(
      'expiresAt must be a valid Date: the instant after which retention may delete the run',
    );
  }
  return expiresAt;
}

const LINE_COLUMNS = 13;
/** PostgreSQL allows 65535 parameters per statement; 500 rows of 13 stay well below. */
const LINES_PER_STATEMENT = 500;

/**
 * The durable run store: complete, validator-valid runs archived as their original protocol
 * source under `(projectId, runId)`, their attachment bytes made durable in the blob store first,
 * one transaction per run, idempotent for the same semantic content and refusing different
 * content under one identity. Nothing here mutates or deletes.
 */
export class PostgresRunStore {
  private readonly pool: Pool;
  private readonly blobs: BlobStore;

  constructor(pool: Pool, blobs: BlobStore) {
    this.pool = pool;
    this.blobs = blobs;
  }

  /**
   * Validates a run directory and archives it when it is valid and complete: the source lines
   * are retained, every distinct attachment is copied from `attachments/<sha256>`, re-hashed, and
   * published to the blob store, and only then is the run written in one transaction. Invalid or
   * incomplete runs write nothing. A source attachment that changed since validation fails the
   * ingestion with the blob store's error before any database write.
   */
  async persistRunDirectory(request: PersistRequest): Promise<PersistResult> {
    checkProjectId(request.projectId);
    const expiresAt = checkExpiresAt(request.expiresAt);
    const validated = await validateRunDirectorySnapshot(request.runDirectory, {
      retainEvents: true,
      retainSourceLines: true,
    });
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
    // validateRunDirectorySnapshot checked the bytes under <run>/attachments against the events.
    const archive = buildArchive(validated);
    // The projection this archive produces, read into query-index rows now, so that the
    // transaction below stores a run that is immediately queryable. It is derived state: the
    // source lines beside it are what can produce it again.
    const derived = deriveQueryIndex(
      projectRun(request.projectId, request.runDirectory, validated),
    );
    // From here the call may publish bytes or write rows, so it holds the maintenance lock
    // shared: destructive retention cannot interleave with the identity check, the
    // materialisation, or the transaction, and other ingestions still run beside it.
    return withIngestionLock(this.pool, async (client) => {
      const known = await knownRun(client, request.projectId, archive, expiresAt, derived);
      if (known !== undefined) return known;
      const published = await materialiseBlobs(
        this.blobs,
        request.runDirectory,
        archive.requiredBlobs,
      );
      return archiveWithin(
        client,
        request.projectId,
        request.runDirectory,
        archive,
        published,
        expiresAt,
        derived,
      );
    });
  }

  /** The archived run, or nothing when the project holds no such run. */
  async loadRun(projectId: string, runId: string): Promise<StoredRun | undefined> {
    return loadStoredRun(this.pool, projectId, runId);
  }

  /**
   * Replays a stored run through the current validator, session by session in storage order,
   * and checks the result against the ingestion record. The structural replay reads no bytes;
   * with `verifyAttachments`, every blob the replayed source requires is also looked up in the
   * catalog, opened from the blob store, and re-read in full.
   */
  async replayRun(
    projectId: string,
    runId: string,
    options: { readonly verifyAttachments?: boolean } = {},
  ): Promise<ReplayedRun | undefined> {
    const stored = await this.loadRun(projectId, runId);
    if (stored === undefined) return undefined;
    const validated = await replayStored(stored);
    const verifiedBlobs =
      options.verifyAttachments === true ? await this.verifyBlobs(stored, validated) : undefined;
    return { stored, validated, verifiedBlobs };
  }

  /**
   * The stored run as today's projector sees it: replayed, then projected. No bytes are read.
   * The same operation the query surface offers as `getRun`, through the same implementation.
   */
  async projectStoredRun(projectId: string, runId: string): Promise<ProjectedRun | undefined> {
    return projectStoredRunFrom(this.pool, projectId, runId);
  }

  /**
   * Establishes that every attachment a stored run's source requires is durable now: the run is
   * replayed, each distinct hash must be related to the run in the catalog with the declared
   * size, and the object is opened from the blob store and re-hashed in full. Nothing is
   * repaired and nothing falls back to the run's source locator. Returns the verified blobs;
   * nothing when the run is not stored.
   */
  async verifyStoredRunBlobs(
    projectId: string,
    runId: string,
  ): Promise<readonly BlobDescriptor[] | undefined> {
    const replayed = await this.replayRun(projectId, runId, { verifyAttachments: true });
    return replayed?.verifiedBlobs;
  }

  /**
   * Opens a blob one archived run relates to, by hash. The bytes are opaque and streamed from
   * the blob store's own location. The run is part of the address: whether a hash exists is a
   * global fact, and a caller learns it only through a run it may see.
   */
  async openBlob(
    projectId: string,
    runId: string,
    sha256: string,
  ): Promise<OpenedBlob | undefined> {
    checkProjectId(projectId);
    if (!isSha256(sha256)) throw new TypeError('sha256 must be 64 lower-case hex characters');
    const record = await this.pool.query<{ size_bytes: string }>(
      `SELECT b.size_bytes FROM qe_run_blobs rb JOIN qe_blobs b USING (sha256)
        WHERE rb.project_id = $1 AND rb.run_id = $2 AND rb.sha256 = $3`,
      [projectId, runId, sha256],
    );
    const row = record.rows[0];
    if (row === undefined) return undefined;
    return this.blobs.open(sha256, Number(row.size_bytes));
  }

  private async verifyBlobs(
    stored: StoredRun,
    validated: ValidatedRun,
  ): Promise<readonly BlobDescriptor[]> {
    const required = requiredBlobs(validated);
    const recorded = new Map(stored.blobs.map((b) => [b.sha256, b]));
    const verified: BlobDescriptor[] = new Array<BlobDescriptor>(required.length);
    const { projectId, runId } = stored;
    await eachLimited(required, MATERIALISE_CONCURRENCY, async (blob, i) => {
      const record = recorded.get(blob.sha256);
      if (record === undefined) {
        throw new AttachmentIntegrityError(
          'BLOB_RECORD_MISSING',
          projectId,
          runId,
          blob.sha256,
          'the catalog relates no durable blob to this run for it',
        );
      }
      if (record.sizeBytes !== blob.sizeBytes) {
        throw new AttachmentIntegrityError(
          'BLOB_RECORD_SIZE_MISMATCH',
          projectId,
          runId,
          blob.sha256,
          `the catalog records ${record.sizeBytes} bytes, the source declares ${blob.sizeBytes}`,
        );
      }
      try {
        verified[i] = await this.blobs.verify(blob.sha256, blob.sizeBytes);
      } catch (e) {
        const failure = e as BlobStoreError;
        if (failure.name !== 'BlobStoreError') throw e;
        throw new AttachmentIntegrityError(
          failure.code === 'BLOB_MISSING' ? 'BLOB_MISSING' : 'BLOB_CORRUPT',
          projectId,
          runId,
          blob.sha256,
          failure.message,
          failure,
        );
      }
    });
    return verified;
  }
}

/**
 * One archived run as the projector sees it, rebuilt from its own stored source: the whole of
 * the durable read path for a single run, and its only implementation.
 */
export async function projectStoredRunFrom(
  pool: Pool,
  projectId: string,
  runId: string,
): Promise<ProjectedRun | undefined> {
  const stored = await loadStoredRun(pool, projectId, runId);
  if (stored === undefined) return undefined;
  return projectRun(projectId, stored.sourceLocator, await replayStored(stored));
}

/**
 * Reads one archived run as of a single instant. Its head, its source lines, its retention fact,
 * and its blob relations live in four tables that retention may be deleting from right now, so
 * they are read on one connection inside a read-only repeatable-read transaction: a run present
 * at the snapshot is read whole, and one deleted a moment later is simply absent. No maintenance
 * lease is taken; this is ordinary MVCC, not writer serialisation.
 */
export async function loadStoredRun(
  pool: Pool,
  projectId: string,
  runId: string,
): Promise<StoredRun | undefined> {
  checkProjectId(projectId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const stored = await readStoredRun(client, projectId, runId);
    await client.query('COMMIT');
    client.release();
    return stored;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release(e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
}

/**
 * The four reads themselves, on a caller's connection. A caller that needs them to agree gives
 * a connection inside a snapshot; one that already holds the maintenance lease, where nothing
 * can delete a run underneath it, does not need one.
 */
export async function readStoredRun(
  client: PoolClient,
  projectId: string,
  runId: string,
): Promise<StoredRun | undefined> {
  const run = await client.query<{
    ingestion_sequence: string;
    ingested_at: Date;
    source_locator: string;
    content_fingerprint: string;
    fingerprint_version: number;
    protocol_versions: string[];
    source_line_count: number;
    source_attachments_verified: boolean;
    expires_at: Date | null;
    validation_summary: Summary;
  }>(
    `SELECT r.ingestion_sequence, r.ingested_at, r.source_locator, r.content_fingerprint,
                r.fingerprint_version, r.protocol_versions, r.source_line_count,
                r.source_attachments_verified, r.validation_summary, t.expires_at
           FROM qe_runs r
           LEFT JOIN qe_run_retention t
             ON t.project_id = r.project_id AND t.run_id = r.run_id
          WHERE r.project_id = $1 AND r.run_id = $2`,
    [projectId, runId],
  );
  const head = run.rows[0];
  if (head === undefined) return undefined;
  const lines = await client.query<{
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
  const blobs = await client.query<{
    sha256: string;
    size_bytes: string;
    storage_key: string;
    stored_at: Date;
  }>(
    `SELECT b.sha256, b.size_bytes, b.storage_key, b.stored_at
           FROM qe_run_blobs rb JOIN qe_blobs b USING (sha256)
          WHERE rb.project_id = $1 AND rb.run_id = $2
          ORDER BY b.sha256`,
    [projectId, runId],
  );
  const stored: StoredRun = {
    projectId,
    runId,
    ingestionSequence: BigInt(head.ingestion_sequence),
    ingestedAt: head.ingested_at,
    sourceLocator: head.source_locator,
    contentFingerprint: head.content_fingerprint,
    fingerprintVersion: head.fingerprint_version,
    protocolVersions: head.protocol_versions,
    sourceLineCount: head.source_line_count,
    sourceAttachmentsVerified: head.source_attachments_verified,
    expiresAt: head.expires_at ?? undefined,
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
    blobs: blobs.rows.map((r) => ({
      sha256: r.sha256,
      sizeBytes: Number(r.size_bytes),
      storageKey: r.storage_key,
      storedAt: r.stored_at,
    })),
  };
  return stored;
}

/**
 * An advisory look before any blob work: a run already archived with the same content, every
 * required relation, and its retention fact is `already_present`, and different content is
 * `conflict`, without copying a byte. Anything else (absent, or an archive missing relations or
 * retention) goes through materialisation and the transaction, which settle races on their own.
 */
async function knownRun(
  client: PoolClient,
  projectId: string,
  archive: RunArchive,
  expiresAt: Date,
  derived: DerivedQueryIndex,
): Promise<PersistResult | undefined> {
  const stored = await storedFingerprint(client, projectId, archive);
  if (stored === undefined) return undefined;
  if (stored.fingerprint !== archive.contentFingerprint) {
    return {
      kind: 'conflict',
      reason: 'RUN_CONFLICT',
      runId: archive.runId,
      storedFingerprint: stored.fingerprint,
      offeredFingerprint: archive.contentFingerprint,
    };
  }
  const related = await client.query<{ sha256: string }>(
    'SELECT sha256 FROM qe_run_blobs WHERE project_id = $1 AND run_id = $2',
    [projectId, archive.runId],
  );
  const known = new Set(related.rows.map((r) => r.sha256));
  if (archive.requiredBlobs.some((b) => !known.has(b.sha256))) return undefined;
  // Its bytes are all accounted for, so only derived state can still be missing, and none of it
  // needs blob work: a run archived before retention or before query indexes existed is
  // completed from what has just been validated, in one transaction, without the archive itself
  // changing in any way.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  let retentionAdded = false;
  let queryIndexRebuilt = false;
  try {
    // Whoever repairs derived state holds the run's own row while deciding what is missing, so
    // that a rebuild and a re-ingestion of one run cannot both write its occurrences.
    const locked = await client.query(
      'SELECT 1 FROM qe_runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE',
      [projectId, archive.runId],
    );
    if (locked.rowCount === 0) {
      // Retention took it between the fingerprint read and here; archive it afresh instead.
      await client.query('ROLLBACK');
      return undefined;
    }
    retentionAdded = await recordRetention(client, projectId, archive.runId, expiresAt);
    const indexed = await client.query(
      `SELECT 1 FROM qe_run_query_index
        WHERE project_id = $1 AND run_id = $2 AND index_version = $3 AND source_fingerprint = $4`,
      [projectId, archive.runId, QUERY_INDEX_VERSION, stored.storedFingerprint],
    );
    queryIndexRebuilt = indexed.rowCount === 0;
    if (queryIndexRebuilt) {
      await replaceQueryIndex(client, projectId, archive.runId, derived, stored.storedFingerprint);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return {
    kind: 'already_present',
    runId: archive.runId,
    ingestionSequence: stored.ingestionSequence,
    blobRelationsAdded: 0,
    retentionAdded,
    queryIndexRebuilt,
  };
}

/**
 * The transaction behind every persist: claim the identity, record the blobs, insert every line,
 * every run-to-blob relation, and the retention fact, commit; or read the claimant and back out.
 * `published` must cover every blob the archive requires: the database references only blobs the
 * store already holds.
 *
 * The caller owns the mutation boundary and this does not take one of its own: it must already
 * be running on a connection that holds the shared maintenance lock, which
 * {@link withIngestionLock} is the single way to obtain. One mutation, one lease.
 */
export async function archiveWithin(
  client: PoolClient,
  projectId: string,
  sourceLocator: string,
  archive: RunArchive,
  published: readonly BlobDescriptor[],
  expiresAt: Date,
  derived: DerivedQueryIndex,
): Promise<PersistResult> {
  checkProjectId(projectId);
  checkExpiresAt(expiresAt);
  const blobs = coveredBlobs(archive.requiredBlobs, published);
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const claimed = await client.query<{ ingestion_sequence: string }>(
      `INSERT INTO qe_runs (
         project_id, run_id, source_locator, content_fingerprint, fingerprint_version,
         protocol_versions, source_line_count, source_attachments_verified, validation_summary)
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
        archive.sourceAttachmentsVerified,
        JSON.stringify(archive.summary),
      ],
    );
    const row = claimed.rows[0];
    if (row === undefined) {
      // Under READ COMMITTED the insert waited for a concurrent claimant to finish, so the row
      // read here is the committed winner (or absent if it rolled back, which the next attempt handles).
      const stored = await storedFingerprint(client, projectId, archive);
      if (stored === undefined) {
        throw new Error('run identity claimed by a transaction that vanished; retry');
      }
      if (stored.fingerprint !== archive.contentFingerprint) {
        // A different content under this identity changes nothing at all, retention included.
        await client.query('ROLLBACK');
        return {
          kind: 'conflict',
          reason: 'RUN_CONFLICT',
          runId: archive.runId,
          storedFingerprint: stored.fingerprint,
          offeredFingerprint: archive.contentFingerprint,
        };
      }
      // Same content. A run archived before its bytes were durable gains its blob relations now,
      // from blobs this caller has just published; its source and provenance stay as they are.
      // The claimant's row is held first, so no rebuild replaces its index at the same moment.
      await client.query('SELECT 1 FROM qe_runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE', [
        projectId,
        archive.runId,
      ]);
      const related = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM qe_run_blobs WHERE project_id = $1 AND run_id = $2',
        [projectId, archive.runId],
      );
      const known = new Set(related.rows.map((r) => r.sha256));
      const missing = blobs.filter((b) => !known.has(b.sha256));
      let added = 0;
      if (missing.length > 0) {
        await recordBlobs(client, missing);
        added = await relateBlobs(client, projectId, archive.runId, missing);
      }
      // A run archived before retention existed gains its fact here. One already recorded is
      // left exactly as it is: an established expiry is never moved by re-ingestion.
      const retentionAdded = await recordRetention(client, projectId, archive.runId, expiresAt);
      const indexed = await client.query(
        `SELECT 1 FROM qe_run_query_index
          WHERE project_id = $1 AND run_id = $2 AND index_version = $3 AND source_fingerprint = $4`,
        [projectId, archive.runId, QUERY_INDEX_VERSION, stored.storedFingerprint],
      );
      const queryIndexRebuilt = indexed.rowCount === 0;
      if (queryIndexRebuilt)
        await replaceQueryIndex(
          client,
          projectId,
          archive.runId,
          derived,
          stored.storedFingerprint,
        );
      await client.query('COMMIT');
      return {
        kind: 'already_present',
        runId: archive.runId,
        ingestionSequence: stored.ingestionSequence,
        blobRelationsAdded: added,
        retentionAdded,
        queryIndexRebuilt,
      };
    }
    await recordBlobs(client, blobs);
    await insertLines(client, projectId, archive.runId, archive.lines);
    await relateBlobs(client, projectId, archive.runId, blobs);
    // In the same transaction as the run: this writer never leaves a run without its expiry,
    // and never leaves one that nothing can query until an operator rebuilds it.
    await recordRetention(client, projectId, archive.runId, expiresAt);
    await replaceQueryIndex(client, projectId, archive.runId, derived, archive.contentFingerprint);
    await client.query('COMMIT');
    return {
      kind: 'inserted',
      runId: archive.runId,
      ingestionSequence: BigInt(row.ingestion_sequence),
    };
  } catch (e) {
    // The transaction is abandoned; the caller decides what to do with the connection.
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/** Records the run's expiry when it has none; true when this call wrote it. */
async function recordRetention(
  client: PoolClient,
  projectId: string,
  runId: string,
  expiresAt: Date,
): Promise<boolean> {
  const written = await client.query(
    `INSERT INTO qe_run_retention (project_id, run_id, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, run_id) DO NOTHING
     RETURNING run_id`,
    [projectId, runId, expiresAt],
  );
  return (written.rowCount ?? 0) > 0;
}

/**
 * The fingerprint the identity is stored with, comparable to the archive's: a run archived under
 * an older fingerprint rule is recomputed from its lines. Nothing when the identity is absent.
 */
async function storedFingerprint(
  db: Pool | PoolClient,
  projectId: string,
  archive: RunArchive,
): Promise<
  { fingerprint: string; storedFingerprint: string; ingestionSequence: bigint } | undefined
> {
  const existing = await db.query<{
    content_fingerprint: string;
    fingerprint_version: number;
    ingestion_sequence: string;
  }>(
    'SELECT content_fingerprint, fingerprint_version, ingestion_sequence FROM qe_runs WHERE project_id = $1 AND run_id = $2',
    [projectId, archive.runId],
  );
  const stored = existing.rows[0];
  if (stored === undefined) return undefined;
  const fingerprint =
    stored.fingerprint_version === archive.fingerprintVersion
      ? stored.content_fingerprint
      : contentFingerprint(
          (
            await db.query<{
              canonical_sha256: string;
              disposition: 'accepted' | 'ignored' | 'duplicate';
            }>(
              'SELECT canonical_sha256, disposition FROM qe_run_source_lines WHERE project_id = $1 AND run_id = $2',
              [projectId, archive.runId],
            )
          ).rows.map((r) => ({ canonicalSha256: r.canonical_sha256, disposition: r.disposition })),
        );
  return {
    fingerprint,
    storedFingerprint: stored.content_fingerprint,
    ingestionSequence: BigInt(stored.ingestion_sequence),
  };
}

/** The published descriptors for exactly the blobs the archive requires, sizes agreeing. */
function coveredBlobs(
  required: readonly RequiredBlob[],
  published: readonly BlobDescriptor[],
): BlobDescriptor[] {
  const bySha = new Map(published.map((b) => [b.sha256, b]));
  return required.map((blob) => {
    const found = bySha.get(blob.sha256);
    if (found === undefined) {
      throw new Error(
        `blob ${blob.sha256} required by run is not published; the database references only durable blobs`,
      );
    }
    if (found.sizeBytes !== blob.sizeBytes) {
      throw new BlobSizeConflictError(blob.sha256, found.sizeBytes, blob.sizeBytes, 'published');
    }
    return found;
  });
}

/**
 * Records blob metadata, one row per hash, keeping whatever row exists: the size a hash was
 * first recorded with is the only size it has, and a different one is a consistency error that
 * rolls the transaction back.
 */
async function recordBlobs(client: PoolClient, blobs: readonly BlobDescriptor[]): Promise<void> {
  if (blobs.length === 0) return;
  // One statement in hash order: the order every ingestion takes its blob locks in.
  await client.query(
    `INSERT INTO qe_blobs (sha256, size_bytes, storage_key)
     SELECT * FROM unnest($1::text[], $2::bigint[], $3::text[]) AS t(sha256, size_bytes, storage_key)
     ORDER BY sha256
     ON CONFLICT (sha256) DO NOTHING`,
    [blobs.map((b) => b.sha256), blobs.map((b) => b.sizeBytes), blobs.map((b) => b.storageKey)],
  );
  const recorded = await client.query<{ sha256: string; size_bytes: string }>(
    'SELECT sha256, size_bytes FROM qe_blobs WHERE sha256 = ANY($1::text[])',
    [blobs.map((b) => b.sha256)],
  );
  const sizes = new Map(recorded.rows.map((r) => [r.sha256, Number(r.size_bytes)]));
  for (const b of blobs) {
    const size = sizes.get(b.sha256);
    if (size === undefined) throw new Error(`blob ${b.sha256} was not recorded`);
    if (size !== b.sizeBytes) {
      throw new BlobSizeConflictError(b.sha256, size, b.sizeBytes, 'recorded in the catalog');
    }
  }
}

/** Relates the run to its blobs; returns how many relations this call created. */
async function relateBlobs(
  client: PoolClient,
  projectId: string,
  runId: string,
  blobs: readonly BlobDescriptor[],
): Promise<number> {
  if (blobs.length === 0) return 0;
  const inserted = await client.query(
    `INSERT INTO qe_run_blobs (project_id, run_id, sha256)
     SELECT $1, $2, sha256 FROM unnest($3::text[]) AS t(sha256) ORDER BY sha256
     ON CONFLICT (project_id, run_id, sha256) DO NOTHING
     RETURNING sha256`,
    [projectId, runId, blobs.map((b) => b.sha256)],
  );
  return inserted.rowCount ?? 0;
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
