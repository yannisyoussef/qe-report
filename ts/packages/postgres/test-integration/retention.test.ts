import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateRunDirectorySnapshot } from 'qe-report-validator';
import { buildArchive, type RunArchive } from '../src/archive.js';
import { MAINTENANCE_LOCK_KEY, RetentionMaintenance } from '../src/index.js';
import type { MaintenanceOptions, MaintenanceReport } from '../src/index.js';
import { freshRoot, sha256 } from '../../read-model/test/synthetic.js';
import {
  TestPostgres,
  ageEntry,
  archiveInto,
  failingPool,
  objectPath,
  publish,
  rowsIn,
  runWithAttachments,
  waitFor,
} from './support.js';

const pgTest = new TestPostgres();
beforeAll(() => pgTest.start());
afterAll(() => pgTest.stop());

const posix = process.platform === 'win32' ? it.skip : it;
/** Objects and temporary files older than this are certainly nobody's work in progress. */
const STALE = (): Date => new Date(Date.now() - 30 * 60 * 1000);
const AN_HOUR = 60 * 60 * 1000;

const T0 = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-10-01T00:00:00.000Z');
/** Read as "now" by every pass that means to expire something written at T0. */
const AFTER = new Date('2026-09-02T00:00:00.000Z');

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** A run with one attachment of its own bytes, archived with the given expiry. */
async function archiveRun(
  db: Awaited<ReturnType<TestPostgres['database']>>,
  name: string,
  runId: string,
  bytes: Buffer,
  expiresAt: Date,
  projectId = 'A',
): Promise<string> {
  const dir = runWithAttachments(freshRoot(name), name, runId, [{ bytes }]);
  const result = await db.store.persistRunDirectory({ projectId, runDirectory: dir, expiresAt });
  expect(result.kind, `${projectId}/${runId}`).toBe('inserted');
  return dir;
}

describe('recording an expiry', () => {
  it('requires a finite instant, accepts one already past, and keeps projects independent', async () => {
    const db = await pgTest.database('expiry');
    const dir = runWithAttachments(freshRoot('expiry'), 'r', 'run-exp', [
      { bytes: Buffer.from('one') },
    ]);
    for (const bad of [undefined, null, 'tomorrow', 0, new Date(Number.NaN)]) {
      await expect(
        db.store.persistRunDirectory({
          projectId: 'A',
          runDirectory: dir,
          expiresAt: bad as unknown as Date,
        }),
      ).rejects.toThrow(TypeError);
    }
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(0);
    // An instant already past is a legitimate expiry: the run is simply eligible at once.
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: T0 }))
        .kind,
    ).toBe('inserted');
    expect((await db.store.loadRun('A', 'run-exp'))?.expiresAt).toEqual(T0);
    // The same run in another project carries its own expiry.
    expect(
      (await db.store.persistRunDirectory({ projectId: 'B', runDirectory: dir, expiresAt: LATER }))
        .kind,
    ).toBe('inserted');
    expect((await db.store.loadRun('B', 'run-exp'))?.expiresAt).toEqual(LATER);
    expect((await db.store.loadRun('A', 'run-exp'))?.expiresAt).toEqual(T0);
    expect(await rowsIn(db.pool, 'qe_run_retention')).toBe(2);
  });

  it('never moves an established expiry, whatever a later ingestion offers', async () => {
    const db = await pgTest.database('immutable');
    const dir = await archiveRun(db, 'immutable', 'run-im', Buffer.from('bytes'), T0);
    const again = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: dir,
      expiresAt: LATER,
    });
    expect(again).toMatchObject({ kind: 'already_present', retentionAdded: false });
    expect((await db.store.loadRun('A', 'run-im'))?.expiresAt).toEqual(T0);
    // A different content under the same identity is refused and touches nothing.
    const conflicting = runWithAttachments(freshRoot('conflict'), 'c', 'run-im', [
      { bytes: Buffer.from('other bytes') },
    ]);
    const conflict = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: conflicting,
      expiresAt: LATER,
    });
    expect(conflict).toMatchObject({ kind: 'conflict', reason: 'RUN_CONFLICT' });
    expect((await db.store.loadRun('A', 'run-im'))?.expiresAt).toEqual(T0);
    expect(await rowsIn(db.pool, 'qe_run_retention')).toBe(1);
  });

  it('leaves a retention-unmanaged run alone, reports it, and completes it only on re-ingestion', async () => {
    const db = await pgTest.database('legacy');
    const dir = await archiveRun(db, 'legacy', 'run-legacy', Buffer.from('legacy bytes'), T0);
    // The shape migration 3 leaves an older archive in: a run with no retention fact at all.
    await db.pool.query('DELETE FROM qe_run_retention');
    const before = await db.store.loadRun('A', 'run-legacy');
    expect(before?.expiresAt).toBeUndefined();

    const preview = await db.maintenance.preview({ asOf: AFTER });
    expect(preview.expiredRuns).toEqual([]);
    expect(preview.legacyRunCount).toBe(1);
    expect(preview.legacyRuns).toEqual([
      { projectId: 'A', runId: 'run-legacy', ingestedAt: before?.ingestedAt, blobRelations: 1 },
    ]);
    // Even a pass that would delete everything eligible leaves it, because it is not eligible.
    const swept = await db.maintenance.run({ asOf: AFTER });
    expect(swept.expiredRuns).toEqual([]);
    expect(swept.legacyRunCount).toBe(1);
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(1);

    const upgraded = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: dir,
      expiresAt: T0,
    });
    expect(upgraded).toMatchObject({ kind: 'already_present', retentionAdded: true });
    const after = await db.store.loadRun('A', 'run-legacy');
    expect(after?.expiresAt).toEqual(T0);
    // Only the lifecycle fact changed; the archive itself is untouched.
    expect({ ...after, expiresAt: undefined }).toEqual({ ...before, expiresAt: undefined });
    expect((await db.maintenance.preview({ asOf: AFTER })).legacyRunCount).toBe(0);
  });

  it('adds one retention row when several upgraders race', async () => {
    const db = await pgTest.database('race');
    const dir = await archiveRun(db, 'race', 'run-race', Buffer.from('raced'), T0);
    await db.pool.query('DELETE FROM qe_run_retention');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        pgTest
          .storeWith(db, db.blobs, pgTest.anotherPool(db))
          .persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: T0 }),
      ),
    );
    expect(results.every((r) => r.kind === 'already_present')).toBe(true);
    expect(results.filter((r) => r.kind === 'already_present' && r.retentionAdded).length).toBe(1);
    expect(await rowsIn(db.pool, 'qe_run_retention')).toBe(1);
  });
});

describe('deleting expired runs', () => {
  it('selects by expiry at or before the instant asked about, and nothing after it', async () => {
    const db = await pgTest.database('select');
    await archiveRun(db, 'past', 'run-past', Buffer.from('past'), T0);
    await archiveRun(db, 'boundary', 'run-boundary', Buffer.from('boundary'), AFTER);
    await archiveRun(db, 'future', 'run-future', Buffer.from('future'), LATER);
    const preview = await db.maintenance.preview({ asOf: AFTER });
    // The boundary is inclusive: an expiry exactly at the instant asked about is eligible.
    expect(preview.expiredRuns.map((r) => r.runId)).toEqual(['run-past', 'run-boundary']);
    expect(preview.dryRun).toBe(true);
    expect(preview.expiredRuns[0]).toMatchObject({
      projectId: 'A',
      expiresAt: T0,
      sourceLines: 5,
      blobRelations: 1,
    });
    expect(preview.sourceLinesReleased).toBe(10);
    expect(preview.blobRelationsReleased).toBe(2);
    // A dry run changes nothing at all.
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(3);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(3);
    expect(preview.blobs).toEqual([]);
    for (const run of ['run-past', 'run-boundary', 'run-future']) {
      expect(await db.store.loadRun('A', run), run).toBeDefined();
    }
  });

  it('deletes the run and everything that belongs to it, and keeps the rest', async () => {
    const db = await pgTest.database('delete');
    await archiveRun(db, 'gone', 'run-gone', Buffer.from('gone'), T0);
    await archiveRun(db, 'kept', 'run-kept', Buffer.from('kept'), LATER);
    const goneSha = sha256(Buffer.from('gone'));
    const report = await db.maintenance.run({ asOf: AFTER });
    expect(report.dryRun).toBe(false);
    expect(report.expiredRuns.map((r) => r.runId)).toEqual(['run-gone']);
    expect(report.sourceLinesReleased).toBe(5);
    expect(report.blobRelationsReleased).toBe(1);
    // The run, its source, its relations, and its retention fact all went together.
    expect(await db.store.loadRun('A', 'run-gone')).toBeUndefined();
    expect(await db.store.replayRun('A', 'run-gone')).toBeUndefined();
    expect(await db.store.projectStoredRun('A', 'run-gone')).toBeUndefined();
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(1);
    expect(await rowsIn(db.pool, 'qe_run_source_lines')).toBe(5);
    expect(await rowsIn(db.pool, 'qe_run_blobs')).toBe(1);
    expect(await rowsIn(db.pool, 'qe_run_retention')).toBe(1);
    // Its blob was nobody else's, so the same pass reclaimed it.
    expect(report.blobs).toEqual([
      {
        sha256: goneSha,
        sizeBytes: 4,
        origin: 'catalogued',
        outcome: 'removed',
        catalogRowRemoved: true,
      },
    ]);
    expect(report.bytesReclaimed).toBe(4);
    expect(existsSync(objectPath(db.blobRoot, goneSha))).toBe(false);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(1);
    // The unexpired run is untouched, bytes included.
    const kept = await db.store.loadRun('A', 'run-kept');
    expect(kept?.expiresAt).toEqual(LATER);
    expect(await db.store.verifyStoredRunBlobs('A', 'run-kept')).toHaveLength(1);
    expect(report.problems).toEqual([]);
  });

  it('works in bounded deterministic batches until nothing is left', async () => {
    const db = await pgTest.database('batches');
    for (let i = 0; i < 5; i += 1) {
      await archiveRun(
        db,
        `batch-${i}`,
        `run-b-${i}`,
        Buffer.from(`batch ${i}`),
        new Date(T0.getTime() + i * 1000),
      );
    }
    const first = await db.maintenance.run({ asOf: AFTER, maxRuns: 2, maxBlobs: 2 });
    expect(first.expiredRuns.map((r) => r.runId)).toEqual(['run-b-0', 'run-b-1']);
    expect(first.truncated.runs).toBe(true);
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(3);
    const second = await db.maintenance.run({ asOf: AFTER, maxRuns: 2, maxBlobs: 2 });
    expect(second.expiredRuns.map((r) => r.runId)).toEqual(['run-b-2', 'run-b-3']);
    const third = await db.maintenance.run({ asOf: AFTER, maxRuns: 2, maxBlobs: 2 });
    expect(third.expiredRuns.map((r) => r.runId)).toEqual(['run-b-4']);
    expect(third.truncated.runs).toBe(false);
    const fourth = await db.maintenance.run({ asOf: AFTER, maxRuns: 2, maxBlobs: 2 });
    expect(fourth.expiredRuns).toEqual([]);
    expect(fourth.blobs).toEqual([]);
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(0);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(0);
    expect(await rowsIn(db.pool, 'qe_run_source_lines')).toBe(0);
  });

  it('deletes none of a batch whose transaction fails, and says so', async () => {
    const db = await pgTest.database('atomic');
    await archiveRun(db, 'a1', 'run-a1', Buffer.from('a1'), T0);
    await archiveRun(db, 'a2', 'run-a2', Buffer.from('a2'), T0);
    const broken = new RetentionMaintenance(
      failingPool(db.pool, /DELETE FROM qe_runs/u, 'the delete could not run'),
      db.blobs,
    );
    const report = await broken.run({ asOf: AFTER });
    expect(report.expiredRuns).toEqual([]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ code: 'RUN_DELETE_FAILED' });
    expect(report.problems[0]?.message).toContain('batch of 2');
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(2);
    expect(await rowsIn(db.pool, 'qe_run_source_lines')).toBe(10);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(2);
    // A healthy pass afterwards still does the work.
    const ok = await db.maintenance.run({ asOf: AFTER });
    expect(ok.expiredRuns).toHaveLength(2);
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(0);
  });
});

describe('global blob references', () => {
  it('keeps bytes another project still references, and reclaims them when the last run goes', async () => {
    const db = await pgTest.database('shared');
    const bytes = Buffer.from('shared between two projects');
    const sha = sha256(bytes);
    await archiveRun(db, 'shared-a', 'run-a', bytes, T0, 'A');
    await archiveRun(db, 'shared-b', 'run-b', bytes, LATER, 'B');
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(1);
    expect(await rowsIn(db.pool, 'qe_run_blobs')).toBe(2);

    const first = await db.maintenance.run({ asOf: AFTER });
    expect(first.expiredRuns.map((r) => [r.projectId, r.runId])).toEqual([['A', 'run-a']]);
    // Project B still references the bytes, so nothing about them moved.
    expect(first.blobs).toEqual([]);
    expect(first.bytesReclaimed).toBe(0);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(1);
    expect(await rowsIn(db.pool, 'qe_run_blobs')).toBe(1);
    expect(await db.store.verifyStoredRunBlobs('B', 'run-b')).toHaveLength(1);
    const opened = await db.store.openBlob('B', 'run-b', sha);
    expect(opened && (await readAll(opened.stream))).toEqual(bytes);
    // The expired run's access went with it; the hash alone opens nothing.
    expect(await db.store.openBlob('A', 'run-a', sha)).toBeUndefined();

    const second = await db.maintenance.run({ asOf: new Date(LATER.getTime() + 1000) });
    expect(second.expiredRuns.map((r) => [r.projectId, r.runId])).toEqual([['B', 'run-b']]);
    expect(second.blobs).toEqual([
      {
        sha256: sha,
        sizeBytes: bytes.length,
        origin: 'catalogued',
        outcome: 'removed',
        catalogRowRemoved: true,
      },
    ]);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(false);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(0);
  });

  it('counts references across runs of one project the same way', async () => {
    const db = await pgTest.database('sibling');
    const bytes = Buffer.from('shared between two runs of one project');
    const sha = sha256(bytes);
    await archiveRun(db, 'sib-1', 'run-1', bytes, T0);
    await archiveRun(db, 'sib-2', 'run-2', bytes, LATER);
    const first = await db.maintenance.run({ asOf: AFTER });
    expect(first.expiredRuns.map((r) => r.runId)).toEqual(['run-1']);
    expect(first.blobs).toEqual([]);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    const second = await db.maintenance.run({ asOf: new Date(LATER.getTime() + 1000) });
    expect(second.blobs.map((b) => b.sha256)).toEqual([sha]);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(false);
  });
});

describe('orphaned bytes', () => {
  it('finds an object no database row ever knew, verifies it, and removes it', async () => {
    const db = await pgTest.database('orphan');
    const bytes = randomBytes(4096);
    const sha = sha256(bytes);
    const dir = runWithAttachments(freshRoot('orphan'), 'o', 'run-orphan', [{ bytes }]);
    // The QE-006 failure shape: the bytes are published, then the run's transaction fails.
    const failing = pgTest.storeWith(
      db,
      db.blobs,
      failingPool(db.pool, /^COMMIT$/u, 'connection lost before commit'),
    );
    await expect(
      failing.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: LATER }),
    ).rejects.toThrow(/connection lost/u);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(0);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(0);
    expect(await rowsIn(db.pool, 'qe_run_blobs')).toBe(0);

    // Without a cutoff the store is not enumerated at all, so a young object is nobody's garbage.
    const untouched = await db.maintenance.run({ asOf: AFTER });
    expect(untouched.blobs).toEqual([]);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    const fresh = await db.maintenance.run({ asOf: AFTER, orphanObjectsBefore: STALE() });
    expect(fresh.blobs).toEqual([]);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    ageEntry(objectPath(db.blobRoot, sha), AN_HOUR);

    // No database query could have found it: the enumeration of the store itself does.
    const preview = await db.maintenance.preview({
      asOf: AFTER,
      orphanObjectsBefore: STALE(),
    });
    expect(preview.blobs).toEqual([
      {
        sha256: sha,
        sizeBytes: bytes.length,
        origin: 'uncatalogued',
        outcome: 'planned',
        catalogRowRemoved: false,
      },
    ]);
    expect(preview.bytesReclaimed).toBe(bytes.length);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);

    const report = await db.maintenance.run({ asOf: AFTER, orphanObjectsBefore: STALE() });
    expect(report.blobs).toEqual([
      {
        sha256: sha,
        sizeBytes: bytes.length,
        origin: 'uncatalogued',
        outcome: 'removed',
        catalogRowRemoved: false,
      },
    ]);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(false);
    expect(report.problems).toEqual([]);
    // Nothing was fabricated in the database to delete it.
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(0);
  });

  it('reports a corrupt or unsafe object and leaves it for an operator', async () => {
    const db = await pgTest.database('corrupt');
    const bytes = Buffer.from('the bytes the name promises');
    const sha = sha256(bytes);
    // An unreferenced canonical object whose content does not hash to its own name.
    const path = objectPath(db.blobRoot, sha);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.from('something else entirely!!'));
    ageEntry(path, AN_HOUR);
    const report = await db.maintenance.run({ asOf: AFTER, orphanObjectsBefore: STALE() });
    // It is described, not reclaimed: the bytes stay and nothing counts them as freed.
    expect(report.blobs).toEqual([
      {
        sha256: sha,
        sizeBytes: 25,
        origin: 'uncatalogued',
        outcome: 'object_retained',
        catalogRowRemoved: false,
      },
    ]);
    expect(report.bytesReclaimed).toBe(0);
    expect(report.problems.map((p) => [p.code, p.sha256])).toEqual([['BLOB_UNSAFE', sha]]);
    expect(readFileSync(path, 'utf8')).toBe('something else entirely!!');

    // A catalogued blob whose object no longer has the size the catalog records. Nothing
    // references it, so its row goes and the object stays for an operator: the catalog stops
    // claiming durable content it cannot produce.
    chmodSync(path, 0o644);
    writeFileSync(path, bytes);
    ageEntry(path, AN_HOUR);
    await db.pool.query(
      'INSERT INTO qe_blobs (sha256, size_bytes, storage_key) VALUES ($1, $2, $3)',
      [sha, bytes.length + 3, db.blobs.storageKey(sha)],
    );
    const sized = await db.maintenance.run({ asOf: AFTER });
    expect(sized.problems.map((p) => p.code)).toEqual(['BLOB_UNSAFE']);
    expect(sized.problems[0]?.message).toMatch(/should be \d+ bytes/u);
    expect(sized.blobs).toEqual([
      {
        sha256: sha,
        sizeBytes: bytes.length + 3,
        origin: 'catalogued',
        outcome: 'object_retained',
        catalogRowRemoved: true,
      },
    ]);
    expect(sized.bytesReclaimed).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(0);
  });

  posix('never follows a link planted where an object belongs', async () => {
    const db = await pgTest.database('link');
    const outside = join(freshRoot('outside'), 'kept');
    writeFileSync(outside, 'not a blob');
    const sha = sha256(Buffer.from('not a blob'));
    const path = objectPath(db.blobRoot, sha);
    mkdirSync(join(path, '..'), { recursive: true });
    symlinkSync(outside, path);
    const report = await db.maintenance.run({ asOf: AFTER, orphanObjectsBefore: STALE() });
    // The enumeration refuses it, so it is never a candidate at all.
    expect(report.blobs).toEqual([]);
    expect(report.problems.map((p) => p.code)).toEqual(['CAS_ENTRY_UNSAFE']);
    expect(report.problems[0]?.path).toBe(db.blobs.storageKey(sha));
    expect(readFileSync(outside, 'utf8')).toBe('not a blob');
    expect(existsSync(path)).toBe(true);
  });
});

describe('temporary files', () => {
  it('sweeps only its own abandoned files, only when they are old enough', async () => {
    const db = await pgTest.database('temps');
    const tmp = join(db.blobRoot, 'tmp');
    mkdirSync(tmp, { recursive: true });
    const old = 'a'.repeat(32) + '.part';
    const recent = 'b'.repeat(32) + '.part';
    const linked = 'c'.repeat(32) + '.part';
    const directory = 'd'.repeat(32) + '.part';
    writeFileSync(join(tmp, old), 'abandoned');
    ageEntry(join(tmp, old), AN_HOUR);
    writeFileSync(join(tmp, recent), 'in flight');
    writeFileSync(join(tmp, 'unrelated.txt'), 'not mine');
    ageEntry(join(tmp, 'unrelated.txt'), AN_HOUR);
    const target = freshRoot('temp-target');
    if (process.platform !== 'win32') symlinkSync(target, join(tmp, linked));
    mkdirSync(join(tmp, directory));
    const cutoff = STALE();

    const preview = await db.maintenance.preview({ asOf: AFTER, tempBefore: cutoff });
    expect(preview.temporaryFiles).toEqual([
      {
        name: old,
        sizeBytes: 9,
        modifiedAt: expect.any(Date) as unknown as Date,
        outcome: 'planned',
      },
    ]);
    expect(preview.temporaryBytesReclaimed).toBe(9);
    expect(preview.problems.map((p) => p.code)).toEqual(
      Array.from({ length: process.platform === 'win32' ? 1 : 2 }, () => 'TEMPORARY_ENTRY_UNSAFE'),
    );
    expect(existsSync(join(tmp, old))).toBe(true);

    const report = await db.maintenance.run({ asOf: AFTER, tempBefore: cutoff });
    expect(report.temporaryFiles.map((f) => [f.name, f.outcome])).toEqual([[old, 'removed']]);
    expect(existsSync(join(tmp, old))).toBe(false);
    expect(existsSync(join(tmp, recent))).toBe(true);
    expect(existsSync(join(tmp, 'unrelated.txt'))).toBe(true);
    expect(existsSync(join(tmp, directory))).toBe(true);
    expect(existsSync(target)).toBe(true);
    // Nothing is swept unless the caller says how old abandoned means.
    const withoutCutoff = await db.maintenance.run({ asOf: AFTER });
    expect(withoutCutoff.temporaryFiles).toEqual([]);
    expect(existsSync(join(tmp, recent))).toBe(true);
  });
});

describe('coordination with ingestion', () => {
  /** How many backends are waiting on the maintenance advisory lock right now. */
  const waitingOnLock = (db: { pool: pg.Pool; name: string }, n: number): Promise<void> =>
    waitFor(async () => {
      const r = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        [db.name],
      );
      return Number(r.rows[0]?.n) === n;
    });

  it('makes destructive retention wait for an ingestion that is already writing', async () => {
    const db = await pgTest.database('lock-ingest');
    await archiveRun(db, 'lock-1', 'run-lock-1', Buffer.from('expired'), T0);
    // An ingestion in flight: it holds the lock shared from before it publishes until it commits.
    const ingesting = new pg.Client({ connectionString: pgTest.connectionUriFor(db) });
    await ingesting.connect();
    await ingesting.query('SELECT pg_advisory_lock_shared($1)', [MAINTENANCE_LOCK_KEY]);
    const pending = db.maintenance.run({ asOf: AFTER });
    await waitingOnLock(db, 1);
    // Nothing has been deleted while the writer is still inside its window.
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(1);
    await ingesting.query('SELECT pg_advisory_unlock_shared($1)', [MAINTENANCE_LOCK_KEY]);
    const report = await pending;
    expect(report.expiredRuns.map((r) => r.runId)).toEqual(['run-lock-1']);
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(0);
    await ingesting.end();
  });

  it('makes an ingestion wait while destructive retention is running', async () => {
    const db = await pgTest.database('lock-maint');
    const bytes = Buffer.from('arrives during maintenance');
    const dir = runWithAttachments(freshRoot('lock-maint'), 'm', 'run-lock-2', [{ bytes }]);
    const sweeping = new pg.Client({ connectionString: pgTest.connectionUriFor(db) });
    await sweeping.connect();
    await sweeping.query('SELECT pg_advisory_lock($1)', [MAINTENANCE_LOCK_KEY]);
    const pending = pgTest
      .storeWith(db, db.blobs, pgTest.anotherPool(db))
      .persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: LATER });
    await waitingOnLock(db, 1);
    // The run has not been claimed and its bytes have not been published.
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(0);
    expect(existsSync(objectPath(db.blobRoot, sha256(bytes)))).toBe(false);
    await sweeping.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK_KEY]);
    expect((await pending).kind).toBe('inserted');
    expect(existsSync(objectPath(db.blobRoot, sha256(bytes)))).toBe(true);
    await sweeping.end();
  });

  it('lets ingestions run beside each other, because they share the lock', async () => {
    const db = await pgTest.database('lock-shared');
    const holder = new pg.Client({ connectionString: pgTest.connectionUriFor(db) });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock_shared($1)', [MAINTENANCE_LOCK_KEY]);
    // Another ingestion takes the same lock shared and finishes without waiting for the first.
    const result = await pgTest
      .storeWith(db, db.blobs, pgTest.anotherPool(db))
      .persistRunDirectory({
        projectId: 'A',
        runDirectory: runWithAttachments(freshRoot('lock-shared'), 's', 'run-lock-3', [
          { bytes: Buffer.from('beside another writer') },
        ]),
        expiresAt: LATER,
      });
    expect(result.kind).toBe('inserted');
    const waiting = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      [db.name],
    );
    expect(Number(waiting.rows[0]?.n)).toBe(0);
    await holder.query('SELECT pg_advisory_unlock_shared($1)', [MAINTENANCE_LOCK_KEY]);
    await holder.end();
  });
});

describe('reporting', () => {
  it('refuses an invalid instant or limit and describes an empty installation plainly', async () => {
    const db = await pgTest.database('report');
    for (const bad of [undefined, 'now', new Date(Number.NaN)]) {
      await expect(db.maintenance.preview({ asOf: bad as unknown as Date })).rejects.toThrow(
        TypeError,
      );
    }
    await expect(db.maintenance.preview({ asOf: AFTER, maxRuns: -1 })).rejects.toThrow(TypeError);
    await expect(
      db.maintenance.preview({ asOf: AFTER, tempBefore: new Date(Number.NaN) }),
    ).rejects.toThrow(TypeError);
    const empty: MaintenanceReport = await db.maintenance.preview({ asOf: AFTER });
    expect(empty).toEqual({
      asOf: AFTER,
      dryRun: true,
      expiredRuns: [],
      sourceLinesReleased: 0,
      blobRelationsReleased: 0,
      legacyRuns: [],
      legacyRunCount: 0,
      blobs: [],
      bytesReclaimed: 0,
      temporaryFiles: [],
      temporaryBytesReclaimed: 0,
      problems: [],
      truncated: { runs: false, blobs: false, temporaryFiles: false },
    });
  });

  it('reclaims a blob whose object is already gone without calling it bytes it freed', async () => {
    const db = await pgTest.database('absent');
    const bytes = Buffer.from('removed from under the catalog');
    const sha = sha256(bytes);
    await archiveRun(db, 'absent', 'run-absent', bytes, T0);
    rmSync(objectPath(db.blobRoot, sha));
    const report = await db.maintenance.run({ asOf: AFTER });
    expect(report.blobs).toEqual([
      {
        sha256: sha,
        sizeBytes: bytes.length,
        origin: 'catalogued',
        outcome: 'object_absent',
        catalogRowRemoved: true,
      },
    ]);
    expect(report.bytesReclaimed).toBe(0);
    expect(report.problems).toEqual([]);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(0);
  });

  it('expires a run archived through the transaction directly, expiry and bytes included', async () => {
    const db = await pgTest.database('fixture');
    const bytes = randomBytes(2048);
    const dir = runWithAttachments(freshRoot('fixture'), 'f', 'run-fixture', [{ bytes }]);
    const archive: RunArchive = buildArchive(
      await validateRunDirectorySnapshot(dir, { retainSourceLines: true, retainEvents: true }),
    );
    const published = await publish(db, dir, archive);
    expect(await archiveInto(db.pool, 'A', dir, archive, published, T0)).toMatchObject({
      kind: 'inserted',
    });
    expect((await db.store.loadRun('A', 'run-fixture'))?.expiresAt).toEqual(T0);
    const report = await db.maintenance.run({ asOf: AFTER });
    expect(report.expiredRuns.map((r) => r.runId)).toEqual(['run-fixture']);
    expect(report.blobs.map((b) => b.sha256)).toEqual([sha256(bytes)]);
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(0);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(0);
  });
});

describe('bounds, ordering, and partial failure', () => {
  it('orders a batch by ingestion sequence when expiries are equal', async () => {
    const db = await pgTest.database('tiebreak');
    for (let i = 0; i < 4; i += 1) {
      await archiveRun(db, `tie-${i}`, `run-tie-${i}`, Buffer.from(`tie ${i}`), T0);
    }
    const first = await db.maintenance.run({ asOf: AFTER, maxRuns: 2 });
    expect(first.expiredRuns.map((r) => r.runId)).toEqual(['run-tie-0', 'run-tie-1']);
    expect(first.expiredRuns.map((r) => r.ingestionSequence)).toEqual([1n, 2n]);
    const second = await db.maintenance.run({ asOf: AFTER, maxRuns: 2 });
    expect(second.expiredRuns.map((r) => r.runId)).toEqual(['run-tie-2', 'run-tie-3']);
  });

  it('says when a limit stopped it, for runs, blobs, and temporary files alike', async () => {
    const db = await pgTest.database('truncation');
    // One run with two attachments, so a single expiry can leave two blobs collectible at once.
    const first = runWithAttachments(freshRoot('trunc-1'), 'trunc-1', 'run-t1', [
      { bytes: Buffer.from('one'), extra: { name: 'first' } },
      { bytes: Buffer.from('two'), extra: { name: 'second' } },
    ]);
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: first, expiresAt: T0 }))
        .kind,
    ).toBe('inserted');
    await archiveRun(db, 'trunc-2', 'run-t2', Buffer.from('three'), T0);
    const tmp = join(db.blobRoot, 'tmp');
    mkdirSync(tmp, { recursive: true });
    for (const name of ['a'.repeat(32), 'b'.repeat(32)]) {
      writeFileSync(join(tmp, `${name}.part`), 'abandoned');
      ageEntry(join(tmp, `${name}.part`), AN_HOUR);
    }
    const limited = await db.maintenance.run({
      asOf: AFTER,
      maxRuns: 1,
      maxBlobs: 1,
      maxTemporaryFiles: 1,
      tempBefore: STALE(),
    });
    expect(limited.expiredRuns.map((r) => r.runId)).toEqual(['run-t1']);
    expect(limited.truncated.runs).toBe(true);
    expect(limited.blobs).toHaveLength(1);
    expect(limited.truncated.blobs).toBe(true);
    expect(limited.temporaryFiles).toHaveLength(1);
    expect(limited.truncated.temporaryFiles).toBe(true);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(2);

    // A pass with room finishes everything the limited one left, and says nothing was cut short.
    const second = await db.maintenance.run({ asOf: AFTER, tempBefore: STALE() });
    expect(second.expiredRuns.map((r) => r.runId)).toEqual(['run-t2']);
    expect(second.truncated).toEqual({ runs: false, blobs: false, temporaryFiles: false });
    expect(second.blobs).toHaveLength(2);
    expect(second.temporaryFiles).toHaveLength(1);
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(0);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(0);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('continues past a hash the caller has already dealt with', async () => {
    const db = await pgTest.database('cursor');
    const bytes = [Buffer.from('first by hash'), Buffer.from('second by hash')];
    await archiveRun(db, 'cur-1', 'run-c1', bytes[0] as Buffer, T0);
    await archiveRun(db, 'cur-2', 'run-c2', bytes[1] as Buffer, T0);
    const [head, next] = [sha256(bytes[0] as Buffer), sha256(bytes[1] as Buffer)].sort() as [
      string,
      string,
    ];
    // Both runs go, so both blobs are collectible; the cursor decides where the pass begins.
    const past = await db.maintenance.run({ asOf: AFTER, maxBlobs: 1, afterSha256: head });
    expect(past.blobs.map((b) => b.sha256)).toEqual([next]);
    expect(existsSync(objectPath(db.blobRoot, head))).toBe(true);
    expect(existsSync(objectPath(db.blobRoot, next))).toBe(false);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(1);
    const rest = await db.maintenance.run({ asOf: AFTER });
    expect(rest.blobs.map((b) => b.sha256)).toEqual([head]);
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(0);
    await expect(db.maintenance.run({ asOf: AFTER, afterSha256: 'not a hash' })).rejects.toThrow(
      TypeError,
    );
  });

  it('keeps the bytes when the catalog row cannot be deleted', async () => {
    const db = await pgTest.database('rowfail');
    const bytes = Buffer.from('the row delete will fail');
    const sha = sha256(bytes);
    await archiveRun(db, 'rowfail', 'run-rowfail', bytes, T0);
    const broken = new RetentionMaintenance(
      failingPool(db.pool, /DELETE FROM qe_blobs/u, 'the catalog delete could not run'),
      db.blobs,
    );
    const report = await broken.run({ asOf: AFTER });
    expect(report.expiredRuns.map((r) => r.runId)).toEqual(['run-rowfail']);
    expect(report.blobs).toEqual([]);
    expect(report.problems.map((p) => [p.code, p.sha256])).toEqual([
      ['CATALOG_DELETE_FAILED', sha],
    ]);
    // The row survives and so do the bytes: nothing is removed on a half-finished reclamation.
    expect(await rowsIn(db.pool, 'qe_blobs')).toBe(1);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    expect(await db.blobs.verify(sha, bytes.length)).toMatchObject({ sha256: sha });
    // A later healthy pass finishes it.
    const ok = await db.maintenance.run({ asOf: AFTER });
    expect(ok.blobs.map((b) => b.sha256)).toEqual([sha]);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(false);
  });

  it('deletes none of a batch that the database refuses part-way through', async () => {
    const db = await pgTest.database('serverfail');
    await archiveRun(db, 'sf1', 'run-sf1', Buffer.from('sf1'), T0);
    await archiveRun(db, 'sf2', 'run-sf2', Buffer.from('sf2'), T0);
    // The server itself refuses one row of the batch, after the statement has begun.
    await db.pool.query(`
      CREATE FUNCTION refuse_one() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'this run may not be deleted'; END $$`);
    await db.pool.query(`
      CREATE TRIGGER refuse_one_run BEFORE DELETE ON qe_runs FOR EACH ROW
      WHEN (OLD.run_id = 'run-sf2') EXECUTE FUNCTION refuse_one()`);
    const report = await db.maintenance.run({ asOf: AFTER });
    expect(report.expiredRuns).toEqual([]);
    expect(report.problems.map((p) => p.code)).toEqual(['RUN_DELETE_FAILED']);
    expect(await rowsIn(db.pool, 'qe_runs')).toBe(2);
    expect(await rowsIn(db.pool, 'qe_run_source_lines')).toBe(10);
    expect(await rowsIn(db.pool, 'qe_run_blobs')).toBe(2);
    expect(await rowsIn(db.pool, 'qe_run_retention')).toBe(2);
    // The other failure domains still ran: a stale temporary file was swept regardless.
    const tmp = join(db.blobRoot, 'tmp');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, `${'e'.repeat(32)}.part`), 'abandoned');
    ageEntry(join(tmp, `${'e'.repeat(32)}.part`), AN_HOUR);
    const again = await db.maintenance.run({ asOf: AFTER, tempBefore: STALE() });
    expect(again.problems.map((p) => p.code)).toEqual(['RUN_DELETE_FAILED']);
    expect(again.temporaryFiles.map((f) => f.outcome)).toEqual(['removed']);
    await db.pool.query('DROP TRIGGER refuse_one_run ON qe_runs');
    const ok = await db.maintenance.run({ asOf: AFTER });
    expect(ok.expiredRuns).toHaveLength(2);
  });

  it('reports every retention-unmanaged run it counts, up to the bound it was given', async () => {
    const db = await pgTest.database('legacybound');
    for (let i = 0; i < 3; i += 1) {
      await archiveRun(db, `lb-${i}`, `run-lb-${i}`, Buffer.from(`legacy ${i}`), T0);
    }
    await db.pool.query('DELETE FROM qe_run_retention');
    const bounded = await db.maintenance.preview({ asOf: AFTER, maxLegacyReported: 1 });
    expect(bounded.legacyRuns.map((r) => r.runId)).toEqual(['run-lb-0']);
    expect(bounded.legacyRunCount).toBe(3);
    expect(bounded.expiredRuns).toEqual([]);
    const all = await db.maintenance.preview({ asOf: AFTER });
    expect(all.legacyRuns).toHaveLength(3);
    for (const bad of ['maxRuns', 'maxBlobs', 'maxTemporaryFiles', 'maxLegacyReported']) {
      await expect(
        db.maintenance.preview({ asOf: AFTER, [bad]: 0 } as MaintenanceOptions),
      ).rejects.toThrow(TypeError);
    }
  });

  it('changes nothing at all in a preview of a state with work to do in every phase', async () => {
    const db = await pgTest.database('previewrich');
    const expiring = Buffer.from('an expired run of its own');
    await archiveRun(db, 'pr-1', 'run-pr-1', expiring, T0);
    await archiveRun(db, 'pr-2', 'run-pr-2', Buffer.from('a run that stays'), LATER);
    // A catalogued blob nothing references, an aged object nothing knows, and a stale temp file.
    const loose = Buffer.from('catalogued and unreferenced');
    const looseSha = sha256(loose);
    await archiveRun(db, 'pr-3', 'run-pr-3', loose, T0);
    await db.pool.query('DELETE FROM qe_run_blobs WHERE sha256 = $1', [looseSha]);
    const orphan = Buffer.from('known to nobody');
    const orphanSha = sha256(orphan);
    const orphanPath = objectPath(db.blobRoot, orphanSha);
    mkdirSync(join(orphanPath, '..'), { recursive: true });
    writeFileSync(orphanPath, orphan);
    ageEntry(orphanPath, AN_HOUR);
    const tmp = join(db.blobRoot, 'tmp');
    mkdirSync(tmp, { recursive: true });
    const temp = join(tmp, `${'f'.repeat(32)}.part`);
    writeFileSync(temp, 'abandoned');
    ageEntry(temp, AN_HOUR);

    const before = {
      runs: await rowsIn(db.pool, 'qe_runs'),
      lines: await rowsIn(db.pool, 'qe_run_source_lines'),
      relations: await rowsIn(db.pool, 'qe_run_blobs'),
      retention: await rowsIn(db.pool, 'qe_run_retention'),
      blobs: await rowsIn(db.pool, 'qe_blobs'),
    };
    const preview = await db.maintenance.preview({
      asOf: AFTER,
      tempBefore: STALE(),
      orphanObjectsBefore: STALE(),
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.expiredRuns.map((r) => r.runId).sort()).toEqual(['run-pr-1', 'run-pr-3']);
    expect(preview.blobs.map((b) => [b.origin, b.outcome, b.sha256]).sort()).toEqual(
      [
        ['catalogued', 'planned', looseSha],
        ['uncatalogued', 'planned', orphanSha],
      ].sort(),
    );
    expect(preview.temporaryFiles.map((f) => f.outcome)).toEqual(['planned']);
    expect(preview.bytesReclaimed).toBe(loose.length + orphan.length);

    // Every row and every file is exactly as it was.
    expect({
      runs: await rowsIn(db.pool, 'qe_runs'),
      lines: await rowsIn(db.pool, 'qe_run_source_lines'),
      relations: await rowsIn(db.pool, 'qe_run_blobs'),
      retention: await rowsIn(db.pool, 'qe_run_retention'),
      blobs: await rowsIn(db.pool, 'qe_blobs'),
    }).toEqual(before);
    expect(existsSync(objectPath(db.blobRoot, looseSha))).toBe(true);
    expect(existsSync(orphanPath)).toBe(true);
    expect(existsSync(temp)).toBe(true);
    expect(await db.store.loadRun('A', 'run-pr-1')).toBeDefined();
    // And a real pass afterwards does exactly what the preview described.
    const done = await db.maintenance.run({
      asOf: AFTER,
      tempBefore: STALE(),
      orphanObjectsBefore: STALE(),
    });
    expect(done.expiredRuns.map((r) => r.runId).sort()).toEqual(['run-pr-1', 'run-pr-3']);
    expect(done.bytesReclaimed).toBe(preview.bytesReclaimed + expiring.length);
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(temp)).toBe(false);
  });
});
