import type { Pool, PoolClient } from 'pg';
import {
  BlobStoreError,
  isSha256,
  type BlobMaintenance,
  type BlobStore,
  type CasProblem,
} from 'qe-report-blob-fs';
import { withMaintenanceLock } from './locks.js';

/** How much one invocation may do when the caller does not say; every pass is bounded. */
export const DEFAULT_LIMITS = {
  runs: 100,
  blobs: 500,
  uncataloguedBlobs: 500,
  temporaryFiles: 500,
  legacy: 100,
  /** Bytes a pass may read while verifying objects; it holds the exclusive lock the whole time. */
  bytesExamined: 2 * 1024 * 1024 * 1024,
} as const;
/** Objects read from the blob store per enumeration page while looking for uncatalogued orphans. */
const CAS_PAGE = 200;

export interface MaintenanceOptions {
  /**
   * The instant retention is evaluated against; a run whose expiry is at or before it is
   * eligible. It is the caller's authority and is not compared with any clock: an instant in
   * the future expires runs that have not reached their expiry yet.
   */
  readonly asOf: Date;
  /** Give up rather than wait longer than this for the maintenance lock; only `run` uses it. */
  readonly lockTimeoutMs?: number;
  /**
   * Sweep temporary files last modified before this instant. Omitted means none are swept: the
   * caller decides how old an abandoned file must be before it is certainly abandoned.
   */
  readonly tempBefore?: Date;
  readonly maxRuns?: number;
  /** Bounds the catalogued blobs examined; the objects the catalog never knew have their own budget. */
  readonly maxBlobs?: number;
  /** Continue the catalogued pass after this hash, so an entry that cannot be removed stops blocking the rest. */
  readonly afterSha256?: string;
  /**
   * Collect objects the catalog never knew, last modified before this instant. Omitted means
   * none are collected: an object published moments ago by a writer that did not take the
   * maintenance lock looks exactly like one an ingestion abandoned, so the caller states how
   * old certainly abandoned is, as it does for temporary files.
   */
  readonly orphanObjectsBefore?: Date;
  /** Bounds the objects examined while enumerating the store for rollback orphans. */
  readonly maxUncataloguedBlobs?: number;
  /**
   * Bytes a pass may read while verifying objects. Every object is hashed in full before it is
   * removed, and the pass holds the maintenance lock throughout, so this bounds how long
   * ingestion can be kept waiting.
   */
  readonly maxBytesExamined?: number;
  readonly maxTemporaryFiles?: number;
  /** Bounds how many retention-unmanaged runs are named in the report; all of them are counted. */
  readonly maxLegacyReported?: number;
}

/** A run selected as expired: reported by preview, deleted by a run. */
export interface ExpiredRun {
  readonly projectId: string;
  readonly runId: string;
  readonly expiresAt: Date;
  readonly ingestionSequence: bigint;
  /** Source lines that went, or would go, with it. */
  readonly sourceLines: number;
  /** Run-to-blob relations released, or that would be released. */
  readonly blobRelations: number;
}

/** A run archived before retention existed: never swept, always reported. */
export interface LegacyRun {
  readonly projectId: string;
  readonly runId: string;
  readonly ingestedAt: Date;
  /** How many attachment blobs it relates to; a non-zero count is byte storage nothing will free. */
  readonly blobRelations: number;
}

export interface ReclaimedBlob {
  readonly sha256: string;
  /** The catalogued size, or the size found on the medium for an object with no catalog row. */
  readonly sizeBytes: number;
  /** `catalogued`: a catalog row no run references; `uncatalogued`: an object the catalog never knew. */
  readonly origin: 'catalogued' | 'uncatalogued';
  /**
   * `removed`: the object was unlinked. `planned`: a preview would remove it. `object_absent`:
   * there was nothing left on the medium to remove. `object_retained`: its catalog row went but
   * the object could not be removed, so the next pass collects it as an uncatalogued orphan.
   */
  readonly outcome: 'removed' | 'planned' | 'object_absent' | 'object_retained';
  readonly catalogRowRemoved: boolean;
}

export interface ReclaimedTemporaryFile {
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
  readonly outcome: 'removed' | 'planned' | 'absent';
}

export type MaintenanceProblemCode =
  /** The batch of expired runs could not be deleted; none of it was. */
  | 'RUN_DELETE_FAILED'
  /** A selected run was no longer eligible when the statement ran, so it was left alone. */
  | 'RUN_DELETE_DECLINED'
  /** An object is corrupt, or is not a regular file: left for an operator, never repaired. */
  | 'BLOB_UNSAFE'
  /** Removing an object failed for an operational reason. */
  | 'BLOB_DELETE_FAILED'
  /** The object went but its catalog row could not: the next pass finishes the job. */
  | 'CATALOG_DELETE_FAILED'
  /** A reference to the blob appeared after it was found unreferenced; nothing was removed. */
  | 'CATALOG_ROW_RETAINED'
  /** The object changed between being read and being removed; it was left alone. */
  | 'BLOB_CHANGED'
  /** An entry under the blob root that the layout does not define; never followed. */
  | 'CAS_ENTRY_UNSAFE'
  /** A temporary name that is a link, a directory, or a special file. */
  | 'TEMPORARY_ENTRY_UNSAFE'
  | 'TEMPORARY_DELETE_FAILED';

export interface MaintenanceProblem {
  readonly code: MaintenanceProblemCode;
  readonly sha256: string | undefined;
  /** Relative to the blob root when the problem is about an entry; never an absolute path. */
  readonly path: string | undefined;
  readonly message: string;
}

export interface MaintenanceReport {
  readonly asOf: Date;
  /** True when this was a preview: it mutated nothing by construction. */
  readonly dryRun: boolean;
  readonly expiredRuns: readonly ExpiredRun[];
  /** Source lines the deleted runs took with them, or would. */
  readonly sourceLinesReleased: number;
  /** Run-to-blob relations released, or that would be released. */
  readonly blobRelationsReleased: number;
  /** Retention-unmanaged runs, bounded by `maxLegacyReported`. */
  readonly legacyRuns: readonly LegacyRun[];
  /** How many there are in total, whatever the report lists. */
  readonly legacyRunCount: number;
  readonly blobs: readonly ReclaimedBlob[];
  /** Bytes of objects actually removed, or that a run would remove; a corrupt object counts for nothing. */
  readonly bytesReclaimed: number;
  readonly temporaryFiles: readonly ReclaimedTemporaryFile[];
  readonly temporaryBytesReclaimed: number;
  readonly problems: readonly MaintenanceProblem[];
  /** Where a limit stopped the pass, so the caller knows to invoke it again. */
  readonly truncated: {
    readonly runs: boolean;
    readonly blobs: boolean;
    readonly temporaryFiles: boolean;
  };
}

/**
 * Explicit, bounded lifecycle maintenance over the run archive and the blob store: delete runs
 * whose expiry has passed, reclaim blobs no run anywhere references, and sweep temporary files a
 * killed writer left behind. Nothing here runs by itself; every pass is invoked by a caller with
 * its own `asOf`, and `preview` mutates nothing at all.
 *
 * A destructive pass holds the maintenance lock exclusively, so no ingestion can publish a blob
 * or claim a run while it decides what is unreferenced. `preview` takes no lock, which is why
 * its answer is a description of the moment it ran and never a plan an execution will follow.
 */
export class RetentionMaintenance {
  private readonly pool: Pool;
  private readonly blobs: BlobStore & BlobMaintenance;

  constructor(pool: Pool, blobs: BlobStore & BlobMaintenance) {
    this.pool = pool;
    this.blobs = blobs;
  }

  /** What a pass would currently affect. Reads and verifies; deletes nothing, takes no lock. */
  async preview(options: MaintenanceOptions): Promise<MaintenanceReport> {
    return this.pass(this.pool, options, undefined);
  }

  /** Deletes what is eligible, under the exclusive maintenance lock. */
  async run(options: MaintenanceOptions): Promise<MaintenanceReport> {
    return withMaintenanceLock(
      this.pool,
      (client) => this.pass(client, options, client),
      options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs },
    );
  }

  /**
   * One pass. `client` is present exactly when the pass may delete, and is the connection that
   * holds the exclusive lock, so the deleting transaction is never spread over the pool.
   */
  private async pass(
    db: Pool | PoolClient,
    options: MaintenanceOptions,
    client: PoolClient | undefined,
  ): Promise<MaintenanceReport> {
    const destructive = client !== undefined;
    const asOf = checkDate(options.asOf, 'asOf');
    const tempBefore =
      options.tempBefore === undefined ? undefined : checkDate(options.tempBefore, 'tempBefore');
    const orphansBefore =
      options.orphanObjectsBefore === undefined
        ? undefined
        : checkDate(options.orphanObjectsBefore, 'orphanObjectsBefore');
    const maxRuns = limit(options.maxRuns, DEFAULT_LIMITS.runs, 'maxRuns');
    const maxBlobs = limit(options.maxBlobs, DEFAULT_LIMITS.blobs, 'maxBlobs');
    const maxUncatalogued = limit(
      options.maxUncataloguedBlobs,
      DEFAULT_LIMITS.uncataloguedBlobs,
      'maxUncataloguedBlobs',
    );
    const maxBytes = limit(
      options.maxBytesExamined,
      DEFAULT_LIMITS.bytesExamined,
      'maxBytesExamined',
    );
    const maxTemps = limit(
      options.maxTemporaryFiles,
      DEFAULT_LIMITS.temporaryFiles,
      'maxTemporaryFiles',
    );
    const maxLegacy = limit(options.maxLegacyReported, DEFAULT_LIMITS.legacy, 'maxLegacyReported');
    const after = options.afterSha256;
    if (after !== undefined && !isSha256(after)) {
      throw new TypeError('afterSha256 must be 64 lower-case hex characters');
    }
    const problems: MaintenanceProblem[] = [];

    const selected = await selectExpired(db, asOf, maxRuns);
    let expiredRuns = selected.runs;
    if (client !== undefined && expiredRuns.length > 0) {
      try {
        const deleted = await deleteRuns(client, expiredRuns, asOf);
        // Only what the statement actually removed is reported as gone.
        const went = new Set(deleted.map((r) => `${r.projectId}\u0000${r.runId}`));
        for (const run of expiredRuns) {
          if (went.has(`${run.projectId}\u0000${run.runId}`)) continue;
          problems.push({
            code: 'RUN_DELETE_DECLINED',
            sha256: undefined,
            path: undefined,
            message: `run ${run.runId} in project ${run.projectId} was no longer eligible when the batch ran`,
          });
        }
        expiredRuns = expiredRuns.filter((r) => went.has(`${r.projectId}\u0000${r.runId}`));
      } catch (e) {
        problems.push({
          code: 'RUN_DELETE_FAILED',
          sha256: undefined,
          path: undefined,
          message: `no run of this batch of ${expiredRuns.length} was deleted: ${message(e)}`,
        });
        // The batch is an independent failure domain: bytes orphaned by earlier passes and
        // temporary files left by killed writers are still collectible, and still collected.
        expiredRuns = [];
      }
    }

    const blobs: ReclaimedBlob[] = [];
    const budget = { bytes: maxBytes };
    let blobsTruncated = false;

    // Catalogued blobs no run references anywhere: the ordinary result of a run expiring.
    const unreferenced = await db.query<{ sha256: string; size_bytes: string }>(
      `SELECT b.sha256, b.size_bytes FROM qe_blobs b
        WHERE NOT EXISTS (SELECT 1 FROM qe_run_blobs rb WHERE rb.sha256 = b.sha256)
          AND ($2::text IS NULL OR b.sha256 > $2)
        ORDER BY b.sha256 LIMIT $1`,
      [maxBlobs + 1, after ?? null],
    );
    if (unreferenced.rows.length > maxBlobs) blobsTruncated = true;
    for (const row of unreferenced.rows.slice(0, maxBlobs)) {
      const size = Number(row.size_bytes);
      if (budget.bytes < size && blobs.length > 0) {
        blobsTruncated = true;
        break;
      }
      budget.bytes -= size;
      const reclaimed = await this.reclaim(
        db,
        row.sha256,
        size,
        'catalogued',
        destructive,
        problems,
      );
      if (reclaimed !== undefined) blobs.push(reclaimed);
    }

    // Objects the catalog never knew: a blob published by an ingestion whose transaction then
    // rolled back. Only the medium itself can show these, so the store is enumerated. It has a
    // budget of its own, so a catalogued entry that cannot be removed never starves this pass.
    let remaining = maxUncatalogued;
    let cursor: string | undefined;
    // Without a cutoff the store is not enumerated at all: see `orphanObjectsBefore`.
    let done = orphansBefore === undefined;
    while (!done) {
      const page = await this.blobs.listObjects(
        cursor === undefined ? { limit: CAS_PAGE } : { limit: CAS_PAGE, after: cursor },
      );
      for (const p of page.problems) problems.push(casProblem(p));
      const hashes = page.objects.map((o) => o.sha256);
      const catalogued = new Set(
        (
          await db.query<{ sha256: string }>(
            'SELECT sha256 FROM qe_blobs WHERE sha256 = ANY($1::text[])',
            [hashes],
          )
        ).rows.map((r) => r.sha256),
      );
      for (const object of page.objects) {
        if (catalogued.has(object.sha256)) continue;
        // Young enough to belong to a writer that is still working, so not anyone's garbage yet.
        if (orphansBefore === undefined || object.modifiedAt.getTime() >= orphansBefore.getTime()) {
          continue;
        }
        if (remaining === 0 || (budget.bytes < object.sizeBytes && blobs.length > 0)) {
          blobsTruncated = true;
          done = true;
          break;
        }
        remaining -= 1;
        budget.bytes -= object.sizeBytes;
        const reclaimed = await this.reclaim(
          db,
          object.sha256,
          object.sizeBytes,
          'uncatalogued',
          destructive,
          problems,
        );
        if (reclaimed !== undefined) blobs.push(reclaimed);
      }
      if (done) break;
      if (page.next === undefined) done = true;
      else cursor = page.next;
    }

    const temporaryFiles: ReclaimedTemporaryFile[] = [];
    let tempsTruncated = false;
    if (tempBefore !== undefined) {
      const listed = await this.blobs.listTemporaryFiles({
        before: tempBefore,
        limit: maxTemps + 1,
      });
      for (const p of listed.problems) {
        problems.push({ ...casProblem(p), code: 'TEMPORARY_ENTRY_UNSAFE' });
      }
      if (listed.files.length > maxTemps) tempsTruncated = true;
      for (const file of listed.files.slice(0, maxTemps)) {
        if (!destructive) {
          temporaryFiles.push({ ...file, outcome: 'planned' });
          continue;
        }
        try {
          const removed = await this.blobs.removeTemporaryFile(file.name);
          temporaryFiles.push({ ...file, outcome: removed === 'removed' ? 'removed' : 'absent' });
        } catch (e) {
          problems.push({
            code:
              e instanceof BlobStoreError ? 'TEMPORARY_ENTRY_UNSAFE' : 'TEMPORARY_DELETE_FAILED',
            sha256: undefined,
            path: this.blobs.temporaryKey(file.name),
            message: e instanceof BlobStoreError ? e.message : safeMessage(e),
          });
        }
      }
    }

    return report(
      asOf,
      destructive,
      expiredRuns,
      await legacyRuns(db, maxLegacy),
      blobs,
      temporaryFiles,
      problems,
      { runs: selected.truncated, blobs: blobsTruncated, temporaryFiles: tempsTruncated },
    );
  }

  /**
   * One blob's lifecycle. The catalog row goes first, under a final check that nothing started
   * referencing the hash, and the object only if that check passed. A failure between the two
   * leaves an object no row knows, which the enumeration above collects on the next pass; the
   * opposite order could leave a row, and so a run, pointing at bytes that are already gone.
   * The exclusive lock alone makes the race impossible, and the guard makes the consequence of
   * being wrong about that recoverable rather than permanent.
   */
  private async reclaim(
    db: Pool | PoolClient,
    sha256: string,
    sizeBytes: number,
    origin: ReclaimedBlob['origin'],
    destructive: boolean,
    problems: MaintenanceProblem[],
  ): Promise<ReclaimedBlob | undefined> {
    if (!destructive) {
      try {
        await this.blobs.verify(sha256, sizeBytes);
        return { sha256, sizeBytes, origin, outcome: 'planned', catalogRowRemoved: false };
      } catch (e) {
        if (e instanceof BlobStoreError && e.code === 'BLOB_MISSING') {
          return {
            sha256,
            sizeBytes,
            origin,
            outcome: 'object_absent',
            catalogRowRemoved: false,
          };
        }
        problems.push(blobProblem(e, sha256));
        return undefined;
      }
    }
    let rowRemoved = false;
    if (origin === 'catalogued') {
      try {
        const deleted = await db.query(
          `DELETE FROM qe_blobs b WHERE b.sha256 = $1
             AND NOT EXISTS (SELECT 1 FROM qe_run_blobs rb WHERE rb.sha256 = b.sha256)
           RETURNING sha256`,
          [sha256],
        );
        rowRemoved = (deleted.rowCount ?? 0) > 0;
      } catch (e) {
        problems.push({
          code: 'CATALOG_DELETE_FAILED',
          sha256,
          path: undefined,
          message: message(e),
        });
        return undefined;
      }
      if (!rowRemoved) {
        // Something referenced it after all. The bytes are still needed, so they stay.
        problems.push({
          code: 'CATALOG_ROW_RETAINED',
          sha256,
          path: undefined,
          message: 'a run referenced the blob while it was being reclaimed; nothing was removed',
        });
        return undefined;
      }
    }
    let removed: 'removed' | 'missing';
    try {
      removed = await this.blobs.removeObject(sha256, sizeBytes);
    } catch (e) {
      problems.push(blobProblem(e, sha256));
      return {
        sha256,
        sizeBytes,
        origin,
        outcome: 'object_retained',
        catalogRowRemoved: rowRemoved,
      };
    }
    return {
      sha256,
      sizeBytes,
      origin,
      outcome: removed === 'removed' ? 'removed' : 'object_absent',
      catalogRowRemoved: rowRemoved,
    };
  }
}

/** Assembles what a pass saw and did. */
function report(
  asOf: Date,
  destructive: boolean,
  expiredRuns: readonly ExpiredRun[],
  legacy: { runs: LegacyRun[]; total: number },
  blobs: readonly ReclaimedBlob[],
  temporaryFiles: readonly ReclaimedTemporaryFile[],
  problems: readonly MaintenanceProblem[],
  truncated: MaintenanceReport['truncated'],
): MaintenanceReport {
  return {
    asOf,
    dryRun: !destructive,
    expiredRuns,
    sourceLinesReleased: expiredRuns.reduce((n, r) => n + r.sourceLines, 0),
    blobRelationsReleased: expiredRuns.reduce((n, r) => n + r.blobRelations, 0),
    legacyRuns: legacy.runs,
    legacyRunCount: legacy.total,
    blobs,
    bytesReclaimed: blobs
      .filter((b) => b.outcome === 'removed' || b.outcome === 'planned')
      .reduce((n, b) => n + b.sizeBytes, 0),
    temporaryFiles,
    temporaryBytesReclaimed: temporaryFiles.reduce((n, f) => n + f.sizeBytes, 0),
    problems,
    truncated,
  };
}

/** Expired runs in a deterministic order, with the children they would take with them. */
async function selectExpired(
  db: Pool | PoolClient,
  asOf: Date,
  max: number,
): Promise<{ runs: ExpiredRun[]; truncated: boolean }> {
  const found = await db.query<{
    project_id: string;
    run_id: string;
    expires_at: Date;
    ingestion_sequence: string;
    source_lines: string;
    blob_relations: string;
  }>(
    `SELECT r.project_id, r.run_id, t.expires_at, r.ingestion_sequence,
            (SELECT count(*) FROM qe_run_source_lines l
              WHERE l.project_id = r.project_id AND l.run_id = r.run_id)::text AS source_lines,
            (SELECT count(*) FROM qe_run_blobs rb
              WHERE rb.project_id = r.project_id AND rb.run_id = r.run_id)::text AS blob_relations
       FROM qe_runs r
       JOIN qe_run_retention t ON t.project_id = r.project_id AND t.run_id = r.run_id
      WHERE t.expires_at <= $1
      ORDER BY t.expires_at, r.ingestion_sequence
      LIMIT $2`,
    [asOf, max + 1],
  );
  const truncated = found.rows.length > max;
  return {
    truncated,
    runs: found.rows.slice(0, max).map((r) => ({
      projectId: r.project_id,
      runId: r.run_id,
      expiresAt: r.expires_at,
      ingestionSequence: BigInt(r.ingestion_sequence),
      sourceLines: Number(r.source_lines),
      blobRelations: Number(r.blob_relations),
    })),
  };
}

/**
 * Deletes one batch in one transaction: its source lines, blob relations, and retention fact
 * cascade. The expiry is re-checked in the statement itself, so only a run that is still managed
 * and still expired can go, whatever the selection read a moment earlier.
 */
async function deleteRuns(
  client: PoolClient,
  runs: readonly ExpiredRun[],
  asOf: Date,
): Promise<{ projectId: string; runId: string }[]> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    const deleted = await client.query<{ project_id: string; run_id: string }>(
      `DELETE FROM qe_runs r
        USING unnest($1::text[], $2::text[]) AS t(project_id, run_id)
        WHERE r.project_id = t.project_id AND r.run_id = t.run_id
          AND EXISTS (SELECT 1 FROM qe_run_retention x
                       WHERE x.project_id = r.project_id AND x.run_id = r.run_id
                         AND x.expires_at <= $3)
        RETURNING r.project_id, r.run_id`,
      [runs.map((r) => r.projectId), runs.map((r) => r.runId), asOf],
    );
    await client.query('COMMIT');
    return deleted.rows.map((r) => ({ projectId: r.project_id, runId: r.run_id }));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/** Runs with no retention fact: archived before retention existed, and never swept. */
async function legacyRuns(
  db: Pool | PoolClient,
  max: number,
): Promise<{ runs: LegacyRun[]; total: number }> {
  const counted = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM qe_runs r
      WHERE NOT EXISTS (SELECT 1 FROM qe_run_retention t
                         WHERE t.project_id = r.project_id AND t.run_id = r.run_id)`,
  );
  const listed = await db.query<{
    project_id: string;
    run_id: string;
    ingested_at: Date;
    blob_relations: string;
  }>(
    `SELECT r.project_id, r.run_id, r.ingested_at,
            (SELECT count(*) FROM qe_run_blobs rb
              WHERE rb.project_id = r.project_id AND rb.run_id = r.run_id)::text AS blob_relations
       FROM qe_runs r
      WHERE NOT EXISTS (SELECT 1 FROM qe_run_retention t
                         WHERE t.project_id = r.project_id AND t.run_id = r.run_id)
      ORDER BY r.ingestion_sequence LIMIT $1`,
    [max],
  );
  return {
    total: Number(counted.rows[0]?.total ?? 0),
    runs: listed.rows.map((r) => ({
      projectId: r.project_id,
      runId: r.run_id,
      ingestedAt: r.ingested_at,
      blobRelations: Number(r.blob_relations),
    })),
  };
}

function casProblem(problem: CasProblem): MaintenanceProblem {
  return {
    code: 'CAS_ENTRY_UNSAFE',
    sha256: undefined,
    path: problem.path,
    message: `${problem.code}: ${problem.message}`,
  };
}

function blobProblem(e: unknown, sha256: string): MaintenanceProblem {
  return {
    code: blobProblemCode(e),
    sha256,
    path: undefined,
    message: safeMessage(e),
  };
}

/**
 * A runtime filesystem error carries the absolute path it failed on, which a report never
 * names; only its code survives. The store's own errors are written for a reader already.
 */
function safeMessage(e: unknown): string {
  if (e instanceof BlobStoreError) return e.message;
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === undefined
    ? 'the object could not be removed'
    : `the object could not be removed (${code})`;
}

/** A raced object is not a damaged one, and neither is an operational failure. */
function blobProblemCode(e: unknown): MaintenanceProblemCode {
  if (!(e instanceof BlobStoreError)) return 'BLOB_DELETE_FAILED';
  return e.code === 'BLOB_CHANGED' ? 'BLOB_CHANGED' : 'BLOB_UNSAFE';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function checkDate(value: unknown, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value;
}

/** A bound of at least one: a pass that may do nothing could never make progress. */
function limit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a whole number of at least one`);
  }
  return value;
}
