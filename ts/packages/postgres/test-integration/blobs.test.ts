import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlobStoreError,
  FileBlobStore,
  type BlobDescriptor,
  type BlobSource,
  type BlobStore,
  type OpenedBlob,
  type PutResult,
} from 'qe-report-blob-fs';
import { validateRunDirectorySnapshot } from 'qe-report-validator';
import { ReadModel, buildReadModel } from 'qe-report-read-model';
import type { ProjectedRun } from 'qe-report-read-model';
import { buildArchive, type RunArchive } from '../src/archive.js';
import { AttachmentIntegrityError, BlobSizeConflictError } from '../src/errors.js';
import { PostgresRunStore, migrate } from '../src/index.js';
import { FIXTURES_DIR, manifest } from '../../protocol/test/helpers.js';
import {
  attachment,
  attemptFinished,
  attemptStarted,
  finished,
  freshRoot,
  sha256,
  started,
  testCase,
  writeRun,
  type EventSpec,
} from '../../read-model/test/synthetic.js';
import {
  NEVER,
  TestPostgres,
  applyThrough,
  archiveInto,
  count,
  facts,
  failingPool,
  objectPath,
  publish,
} from './support.js';

const pgTest = new TestPostgres();
beforeAll(() => pgTest.start());
afterAll(() => pgTest.stop());

const fixture = (name: string): string => join(FIXTURES_DIR, name);
const posix = process.platform === 'win32' ? it.skip : it;

/** A blob store that reports every put and can act on the source just before it is read. */
class Interposing implements BlobStore {
  readonly outcomes: PutResult[] = [];
  beforePut: ((source: BlobSource) => void) | undefined;
  constructor(private readonly inner: FileBlobStore) {}
  storageKey(sha: string): string {
    return this.inner.storageKey(sha);
  }
  async put(source: BlobSource): Promise<PutResult> {
    this.beforePut?.(source);
    const r = await this.inner.put(source);
    this.outcomes.push(r);
    return r;
  }
  stat(sha: string): Promise<BlobDescriptor | undefined> {
    return this.inner.stat(sha);
  }
  open(sha: string, size?: number): Promise<OpenedBlob> {
    return size === undefined ? this.inner.open(sha) : this.inner.open(sha, size);
  }
  verify(sha: string, size: number): Promise<BlobDescriptor> {
    return this.inner.verify(sha, size);
  }
}

/** One session, one passed attempt, the given attachments on it. */
function runWith(
  root: string,
  dirName: string,
  runId: string,
  attachments: readonly { bytes: Buffer; extra?: Record<string, unknown> }[],
): string {
  const events: EventSpec[] = [
    started('pw'),
    attemptStarted('a', 1, testCase('e', 'h')),
    ...attachments.map((a) => attachment('a', a.bytes, a.extra ?? {})),
    attemptFinished('a', 'passed'),
    finished(),
  ];
  const bytes = [...new Map(attachments.map((a) => [sha256(a.bytes), a.bytes])).values()];
  return writeRun(root, dirName, runId, [{ sessionId: 's', events }], bytes);
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

async function failure<E extends Error>(
  promise: Promise<unknown>,
  type: new (...a: never[]) => E,
): Promise<E> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof type) return e;
    throw e;
  }
  throw new Error(`expected ${type.name}`);
}

function tempEntries(root: string): string[] {
  return existsSync(join(root, 'tmp')) ? readdirSync(join(root, 'tmp')) : [];
}

const rows = (pool: Parameters<typeof count>[0], table: string): Promise<number> =>
  count(pool, `SELECT count(*)::text AS n FROM ${table}`);

describe('durable attachment bytes', () => {
  it('archives a run without attachments with no blob records and verifies it trivially', async () => {
    const db = await pgTest.database('none');
    const r = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: fixture('runs/flaky-session-passed'),
      expiresAt: NEVER,
    });
    expect(r.kind).toBe('inserted');
    expect(await rows(db.pool, 'qe_blobs')).toBe(0);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(0);
    expect((await db.store.loadRun('A', 'run-so-0008'))?.blobs).toEqual([]);
    expect(await db.store.verifyStoredRunBlobs('A', 'run-so-0008')).toEqual([]);
    expect(existsSync(join(db.blobRoot, 'sha256'))).toBe(false);
  });

  it('makes one attachment durable: catalogued, related to the run, published under its hash', async () => {
    const db = await pgTest.database('one');
    const bytes = Buffer.from('one attachment');
    const dir = runWith(freshRoot('one'), 'one', 'run-one', [{ bytes }]);
    const sha = sha256(bytes);
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    const blob = await db.pool.query<{ sha256: string; size_bytes: string; storage_key: string }>(
      'SELECT sha256, size_bytes, storage_key FROM qe_blobs',
    );
    expect(blob.rows).toEqual([
      { sha256: sha, size_bytes: String(bytes.length), storage_key: db.blobs.storageKey(sha) },
    ]);
    const related = await db.pool.query<{ project_id: string; run_id: string; sha256: string }>(
      'SELECT project_id, run_id, sha256 FROM qe_run_blobs',
    );
    expect(related.rows).toEqual([{ project_id: 'A', run_id: 'run-one', sha256: sha }]);
    expect(statSync(objectPath(db.blobRoot, sha)).size).toBe(bytes.length);
    expect(await db.blobs.verify(sha, bytes.length)).toMatchObject({ sha256: sha });
    expect(await db.store.verifyStoredRunBlobs('A', 'run-one')).toEqual([
      { sha256: sha, sizeBytes: bytes.length, storageKey: db.blobs.storageKey(sha) },
    ]);
    const opened = await db.store.openBlob('A', 'run-one', sha);
    expect(opened && (await readAll(opened.stream))).toEqual(bytes);
    // The run is part of the address: another run, another project, or an unknown hash is nothing.
    expect(await db.store.openBlob('A', 'run-one', '0'.repeat(64))).toBeUndefined();
    expect(await db.store.openBlob('A', 'other-run', sha)).toBeUndefined();
    expect(await db.store.openBlob('B', 'run-one', sha)).toBeUndefined();
    await expect(db.store.openBlob('A', 'run-one', 'not a hash')).rejects.toThrow(TypeError);
    await expect(db.store.openBlob('', 'run-one', sha)).rejects.toThrow(TypeError);
  });

  it('keeps two references to one blob as two protocol facts over one durable object', async () => {
    const db = await pgTest.database('refs');
    const bytes = Buffer.from('referenced twice');
    const dir = runWith(freshRoot('refs'), 'refs', 'run-refs', [
      { bytes, extra: { name: 'first' } },
      { bytes, extra: { name: 'second', mediaType: 'application/octet-stream' } },
    ]);
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    expect(await rows(db.pool, 'qe_blobs')).toBe(1);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(1);
    const projected = await db.store.projectStoredRun('A', 'run-refs');
    expect(projected?.attachments.map((a) => [a.name, a.mediaType, a.sha256])).toEqual([
      ['first', 'text/plain', sha256(bytes)],
      ['second', 'application/octet-stream', sha256(bytes)],
    ]);
    const model = ReadModel.assemble([projected as ProjectedRun]);
    expect(model.model.getBlob(sha256(bytes))?.references).toHaveLength(2);
    expect(model.model.blobs()).toHaveLength(1);
    expect(await db.store.verifyStoredRunBlobs('A', 'run-refs')).toHaveLength(1);
  });

  it('makes every distinct blob of a run durable and re-verifies each', async () => {
    const db = await pgTest.database('many');
    const dir = fixture('runs/playwright');
    const local = await validateRunDirectorySnapshot(dir);
    const distinct = new Set(
      local.events.filter((e) => e.eventType === 'attachment.added').map((e) => e.payload.sha256),
    );
    expect(distinct.size).toBe(4);
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    expect(await rows(db.pool, 'qe_blobs')).toBe(4);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(4);
    const verified = await db.store.verifyStoredRunBlobs('A', local.events[0]?.runId ?? '');
    expect(verified?.map((b) => b.sha256).sort()).toEqual([...distinct].sort());
    for (const sha of distinct) expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    expect(tempEntries(db.blobRoot)).toEqual([]);
  });

  it('stores bytes shared between projects and between runs once, with a relation per run', async () => {
    const db = await pgTest.database('shared');
    const probe = new Interposing(db.blobs);
    const store = pgTest.storeWith(db, probe);
    const bytes = Buffer.from('shared everywhere');
    const root = freshRoot('shared');
    const first = runWith(root, 'first', 'run-first', [{ bytes }]);
    const second = runWith(root, 'second', 'run-second', [{ bytes, extra: { name: 'other' } }]);
    expect(
      (await store.persistRunDirectory({ projectId: 'A', runDirectory: first, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    expect(
      (await store.persistRunDirectory({ projectId: 'B', runDirectory: first, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    expect(
      (await store.persistRunDirectory({ projectId: 'A', runDirectory: second, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    expect(probe.outcomes.map((o) => o.outcome)).toEqual(['stored', 'existing', 'existing']);
    expect(await rows(db.pool, 'qe_blobs')).toBe(1);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(3);
    const stored = await db.pool.query<{ stored_at: Date }>('SELECT stored_at FROM qe_blobs');
    const sha = sha256(bytes);
    expect(readdirSync(join(db.blobRoot, 'sha256', sha.slice(0, 2), sha.slice(2, 4)))).toEqual([
      sha,
    ]);
    for (const [p, r] of [
      ['A', 'run-first'],
      ['B', 'run-first'],
      ['A', 'run-second'],
    ] as const) {
      expect((await store.loadRun(p, r))?.blobs).toEqual([
        {
          sha256: sha,
          sizeBytes: bytes.length,
          storageKey: db.blobs.storageKey(sha),
          storedAt: stored.rows[0]?.stored_at,
        },
      ]);
      expect(await store.verifyStoredRunBlobs(p, r)).toHaveLength(1);
    }
    const all = ReadModel.assemble(
      await Promise.all(
        (
          [
            ['A', 'run-first'],
            ['B', 'run-first'],
            ['A', 'run-second'],
          ] as const
        ).map(async ([p, r]) => (await store.projectStoredRun(p, r)) as ProjectedRun),
      ),
    );
    expect(all.model.blobs()).toHaveLength(1);
    expect(all.model.getBlob(sha)?.references).toHaveLength(3);
  });

  it('fails before any database write when the source changed after validation', async () => {
    const db = await pgTest.database('changed');
    const probe = new Interposing(db.blobs);
    const store = pgTest.storeWith(db, probe);
    const bytes = Buffer.from('validated bytes');
    const sha = sha256(bytes);
    const cases: [string, (path: string) => void, string][] = [
      ['hash', (p) => writeFileSync(p, Buffer.from('Validated bytes')), 'SOURCE_HASH_MISMATCH'],
      [
        'size',
        (p) => writeFileSync(p, Buffer.concat([bytes, Buffer.from('!')])),
        'SOURCE_SIZE_MISMATCH',
      ],
      ['gone', (p) => unlinkSync(p), 'SOURCE_MISSING'],
      [
        'dir',
        (p) => {
          unlinkSync(p);
          mkdirSync(p);
        },
        'SOURCE_NOT_REGULAR',
      ],
      ...(process.platform === 'win32'
        ? []
        : ([
            [
              'link',
              (p: string) => {
                writeFileSync(join(p, '..', '..', 'elsewhere'), bytes);
                unlinkSync(p);
                symlinkSync(join(p, '..', '..', 'elsewhere'), p);
              },
              'SOURCE_NOT_REGULAR',
            ],
          ] as [string, (path: string) => void, string][])),
    ];
    for (const [name, mutate, code] of cases) {
      const dir = runWith(freshRoot(name), name, `run-${name}`, [{ bytes }]);
      probe.beforePut = (source) => mutate(source.path);
      const e = await failure(
        store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }),
        BlobStoreError,
      );
      expect(e.code, name).toBe(code);
      expect(e.sha256, name).toBe(sha);
      expect(await rows(db.pool, 'qe_runs'), name).toBe(0);
      expect(await rows(db.pool, 'qe_run_source_lines'), name).toBe(0);
      expect(await rows(db.pool, 'qe_blobs'), name).toBe(0);
      expect(await rows(db.pool, 'qe_run_blobs'), name).toBe(0);
      expect(existsSync(objectPath(db.blobRoot, sha)), name).toBe(false);
      expect(tempEntries(db.blobRoot), name).toEqual([]);
    }
    probe.beforePut = undefined;
    const intact = runWith(freshRoot('intact'), 'intact', 'run-intact', [{ bytes }]);
    expect(
      (await store.persistRunDirectory({ projectId: 'A', runDirectory: intact, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
  });

  it('leaves only an unreferenced blob when the database fails after publication, and reuses it later', async () => {
    const db = await pgTest.database('orphan');
    const probe = new Interposing(db.blobs);
    const store = pgTest.storeWith(db, probe);
    const bytes = randomBytes(4096);
    const sha = sha256(bytes);
    const dir = runWith(freshRoot('orphan'), 'orphan', 'run-orphan', [{ bytes }]);
    const validated = await validateRunDirectorySnapshot(dir, { retainSourceLines: true });
    const archive = buildArchive(validated);
    const published = await publish(db, dir, archive);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    const broken: RunArchive = {
      ...archive,
      lines: archive.lines.map((l, i) =>
        i === 3 ? { ...l, disposition: 'bogus' as 'accepted' } : l,
      ),
    };
    await expect(archiveInto(db.pool, 'A', dir, broken, published)).rejects.toThrow(
      /disposition_check/u,
    );
    expect(await rows(db.pool, 'qe_runs')).toBe(0);
    expect(await rows(db.pool, 'qe_run_source_lines')).toBe(0);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(0);
    expect(await rows(db.pool, 'qe_blobs')).toBe(0);
    // The published object is an orphan: safe, immutable, not deleted here.
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    const before = statSync(objectPath(db.blobRoot, sha));
    const later = await store.persistRunDirectory({
      projectId: 'A',
      runDirectory: dir,
      expiresAt: NEVER,
    });
    expect(later.kind).toBe('inserted');
    expect(probe.outcomes.map((o) => o.outcome)).toEqual(['existing']);
    expect(statSync(objectPath(db.blobRoot, sha)).ino).toBe(before.ino);
    expect(await rows(db.pool, 'qe_blobs')).toBe(1);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(1);
    expect(await store.verifyStoredRunBlobs('A', 'run-orphan')).toHaveLength(1);
  });

  it('re-ingests the same run as already present without new blob work in the catalog, and refuses different content', async () => {
    const db = await pgTest.database('idem');
    const probe = new Interposing(db.blobs);
    const store = pgTest.storeWith(db, probe);
    const root = freshRoot('idem');
    const bytes = Buffer.from('idempotent bytes');
    const dir = runWith(root, 'idem', 'run-idem', [{ bytes }]);
    const first = await store.persistRunDirectory({
      projectId: 'A',
      runDirectory: dir,
      expiresAt: NEVER,
    });
    expect(first.kind).toBe('inserted');
    const copy = join(root, 'runs', 'copy');
    cpSync(dir, copy, { recursive: true });
    const again = await store.persistRunDirectory({
      projectId: 'A',
      runDirectory: copy,
      expiresAt: NEVER,
    });
    expect(again).toEqual({
      ...first,
      kind: 'already_present',
      blobRelationsAdded: 0,
      retentionAdded: false,
      queryIndexRebuilt: false,
    });
    // A run already archived with its relations costs no blob work at all.
    expect(probe.outcomes.map((o) => o.outcome)).toEqual(['stored']);
    expect(await rows(db.pool, 'qe_blobs')).toBe(1);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(1);
    expect((await store.loadRun('A', 'run-idem'))?.sourceLocator).toBe(dir);
    // Different content under the identity: a different attachment. The conflict is seen before
    // any blob work, so nothing of the loser is published.
    const other = Buffer.from('different bytes');
    const conflicting = runWith(root, 'conflict', 'run-idem', [{ bytes: other }]);
    const r = await store.persistRunDirectory({
      projectId: 'A',
      runDirectory: conflicting,
      expiresAt: NEVER,
    });
    expect(r).toMatchObject({ kind: 'conflict', reason: 'RUN_CONFLICT', runId: 'run-idem' });
    expect(probe.outcomes.map((o) => o.outcome)).toEqual(['stored']);
    expect(existsSync(objectPath(db.blobRoot, sha256(other)))).toBe(false);
    expect(await rows(db.pool, 'qe_blobs')).toBe(1);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(1);
    expect((await store.loadRun('A', 'run-idem'))?.blobs.map((b) => b.sha256)).toEqual([
      sha256(bytes),
    ]);
  });

  it('lets concurrent runs sharing one new blob all archive over one object', async () => {
    const db = await pgTest.database('concurrent');
    const bytes = randomBytes(1024 * 1024);
    const sha = sha256(bytes);
    const root = freshRoot('concurrent');
    const runs = Array.from({ length: 6 }, (_, i) =>
      runWith(root, `run-${i}`, `run-c-${i}`, [{ bytes }]),
    );
    const stores = runs.map(() =>
      pgTest.storeWith(db, new FileBlobStore(db.blobRoot), pgTest.anotherPool(db)),
    );
    const results = await Promise.all(
      runs.map((dir, i) =>
        (stores[i] as PostgresRunStore).persistRunDirectory({
          projectId: 'A',
          runDirectory: dir,
          expiresAt: NEVER,
        }),
      ),
    );
    expect(results.map((r) => r.kind)).toEqual(Array.from({ length: 6 }, () => 'inserted'));
    expect(await rows(db.pool, 'qe_blobs')).toBe(1);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(6);
    expect(readdirSync(join(db.blobRoot, 'sha256', sha.slice(0, 2), sha.slice(2, 4)))).toEqual([
      sha,
    ]);
    expect(tempEntries(db.blobRoot)).toEqual([]);
    for (let i = 0; i < 6; i += 1) {
      expect(await db.store.verifyStoredRunBlobs('A', `run-c-${i}`)).toHaveLength(1);
    }
  });

  it('refuses a run whose blob the catalog records with another size, writing nothing', async () => {
    const db = await pgTest.database('sizes');
    const bytes = Buffer.from('recorded at the wrong size');
    const sha = sha256(bytes);
    await db.pool.query(
      'INSERT INTO qe_blobs (sha256, size_bytes, storage_key) VALUES ($1, $2, $3)',
      [sha, bytes.length + 5, db.blobs.storageKey(sha)],
    );
    const dir = runWith(freshRoot('sizes'), 'sizes', 'run-sizes', [{ bytes }]);
    const e = await failure(
      db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }),
      BlobSizeConflictError,
    );
    expect(e).toMatchObject({
      sha256: sha,
      recordedSize: bytes.length + 5,
      offeredSize: bytes.length,
    });
    expect(await rows(db.pool, 'qe_runs')).toBe(0);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(0);
    expect(
      (await db.pool.query<{ size_bytes: string }>('SELECT size_bytes FROM qe_blobs')).rows,
    ).toEqual([{ size_bytes: String(bytes.length + 5) }]);
    // The bytes were published before the transaction, as always; they are an orphan here.
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
  });

  it('completes the byte archive of a run stored before its blobs were durable, without touching its source', async () => {
    const db = await pgTest.database('legacy');
    const bytes = Buffer.from('legacy bytes');
    const sha = sha256(bytes);
    const dir = runWith(freshRoot('legacy'), 'legacy', 'run-legacy', [{ bytes }]);
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    const before = await db.store.loadRun('A', 'run-legacy');
    // Stage the state migration 2 leaves a pre-existing archive in: source only, no bytes.
    await db.pool.query('DELETE FROM qe_run_blobs');
    await db.pool.query('DELETE FROM qe_blobs');
    rmSync(objectPath(db.blobRoot, sha));
    expect((await db.store.loadRun('A', 'run-legacy'))?.blobs).toEqual([]);
    const missing = await failure(
      db.store.verifyStoredRunBlobs('A', 'run-legacy'),
      AttachmentIntegrityError,
    );
    expect(missing.code).toBe('BLOB_RECORD_MISSING');
    // The structural replay and the projection still work; only the bytes are not established.
    expect((await db.store.projectStoredRun('A', 'run-legacy'))?.attachments).toHaveLength(1);
    const upgraded = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: dir,
      expiresAt: NEVER,
    });
    expect(upgraded).toEqual({
      kind: 'already_present',
      runId: 'run-legacy',
      ingestionSequence: before?.ingestionSequence,
      blobRelationsAdded: 1,
      retentionAdded: false,
      queryIndexRebuilt: false,
    });
    const after = await db.store.loadRun('A', 'run-legacy');
    expect(after?.blobs.map((b) => b.sha256)).toEqual([sha]);
    expect({ ...after, blobs: [] }).toEqual({ ...before, blobs: [] });
    expect(await db.store.verifyStoredRunBlobs('A', 'run-legacy')).toHaveLength(1);
    const again = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: dir,
      expiresAt: NEVER,
    });
    expect(again).toEqual({
      ...upgraded,
      blobRelationsAdded: 0,
      retentionAdded: false,
      queryIndexRebuilt: false,
    });
    // Several upgraders at once: the relation is created once and counted once.
    await db.pool.query('DELETE FROM qe_run_blobs');
    await db.pool.query('DELETE FROM qe_blobs');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        pgTest
          .storeWith(db, db.blobs, pgTest.anotherPool(db))
          .persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }),
      ),
    );
    expect(results.every((r) => r.kind === 'already_present')).toBe(true);
    expect(
      results.reduce((n, r) => n + (r.kind === 'already_present' ? r.blobRelationsAdded : 0), 0),
    ).toBe(1);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(1);
  });

  it('completes a run archived under migration 1 once the database is at migration 2', async () => {
    const db = await pgTest.emptyDatabase('v1run');
    await applyThrough(db.pool, 1);
    const bytes = Buffer.from('archived before durable bytes');
    const sha = sha256(bytes);
    const dir = runWith(freshRoot('v1run'), 'v1', 'run-v1', [{ bytes }]);
    const archive = buildArchive(
      await validateRunDirectorySnapshot(dir, { retainSourceLines: true }),
    );
    // What the migration 1 store wrote: the run row and its lines, nothing about bytes.
    await db.pool.query(
      `INSERT INTO qe_runs (project_id, run_id, source_locator, content_fingerprint, fingerprint_version,
         protocol_versions, source_line_count, attachments_verified, validation_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
      [
        'A',
        archive.runId,
        dir,
        archive.contentFingerprint,
        archive.fingerprintVersion,
        archive.protocolVersions,
        archive.lines.length,
        JSON.stringify(archive.summary),
      ],
    );
    for (const l of archive.lines) {
      await db.pool.query(
        `INSERT INTO qe_run_source_lines (project_id, run_id, storage_ordinal, event_id, session_id, sequence,
           event_type, protocol_version, canonical_sha256, disposition, raw_line, source_file, source_line)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          'A',
          archive.runId,
          l.storageOrdinal,
          l.eventId,
          l.sessionId,
          l.sequence,
          l.eventType,
          l.protocolVersion,
          l.canonicalSha256,
          l.disposition,
          l.rawLine,
          l.sourceFile,
          l.sourceLine,
        ],
      );
    }
    await migrate(db.pool);
    const legacy = await db.store.loadRun('A', 'run-v1');
    expect(legacy?.sourceAttachmentsVerified).toBe(true);
    expect(legacy?.blobs).toEqual([]);
    expect((await db.store.projectStoredRun('A', 'run-v1'))?.attachments).toHaveLength(1);
    const missing = await failure(
      db.store.verifyStoredRunBlobs('A', 'run-v1'),
      AttachmentIntegrityError,
    );
    expect(missing.code).toBe('BLOB_RECORD_MISSING');
    const upgraded = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: dir,
      expiresAt: NEVER,
    });
    // The same call completes both storage facts the older schema had no room for.
    expect(upgraded).toMatchObject({
      kind: 'already_present',
      blobRelationsAdded: 1,
      retentionAdded: true,
    });
    expect(await db.store.verifyStoredRunBlobs('A', 'run-v1')).toEqual([
      { sha256: sha, sizeBytes: bytes.length, storageKey: db.blobs.storageKey(sha) },
    ]);
    const after = await db.store.loadRun('A', 'run-v1');
    expect(legacy?.expiresAt).toBeUndefined();
    expect(after?.expiresAt).toEqual(NEVER);
    expect({ ...after, blobs: [], expiresAt: undefined }).toEqual({
      ...legacy,
      blobs: [],
      expiresAt: undefined,
    });
  });

  it('rolls back the run when the commit itself fails after the blobs were published', async () => {
    const db = await pgTest.database('commitfail');
    const bytes = Buffer.from('published, then the commit fails');
    const sha = sha256(bytes);
    const dir = runWith(freshRoot('commitfail'), 'cf', 'run-cf', [{ bytes }]);
    const failing = pgTest.storeWith(
      db,
      db.blobs,
      failingPool(db.pool, /^COMMIT$/u, 'connection lost before commit'),
    );
    await expect(
      failing.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }),
    ).rejects.toThrow(/connection lost/u);
    expect(await rows(db.pool, 'qe_runs')).toBe(0);
    expect(await rows(db.pool, 'qe_run_source_lines')).toBe(0);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(0);
    expect(await rows(db.pool, 'qe_blobs')).toBe(0);
    expect(existsSync(objectPath(db.blobRoot, sha))).toBe(true);
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    expect(await db.store.verifyStoredRunBlobs('A', 'run-cf')).toHaveLength(1);
  });

  it('archives an empty attachment', async () => {
    const db = await pgTest.database('emptyblob');
    const empty = Buffer.alloc(0);
    const dir = runWith(freshRoot('emptyblob'), 'e', 'run-e', [{ bytes: empty }]);
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    expect(await db.store.verifyStoredRunBlobs('A', 'run-e')).toEqual([
      { sha256: sha256(empty), sizeBytes: 0, storageKey: db.blobs.storageKey(sha256(empty)) },
    ]);
    const opened = await db.store.openBlob('A', 'run-e', sha256(empty));
    expect(opened && (await readAll(opened.stream)).length).toBe(0);
  });

  it('detects a missing, corrupted, or truncated object after commit and repairs nothing', async () => {
    const db = await pgTest.database('damage');
    const bytes = Buffer.from('bytes that will be damaged');
    const sha = sha256(bytes);
    const dir = runWith(freshRoot('damage'), 'damage', 'run-damage', [{ bytes }]);
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    rmSync(dir, { recursive: true });
    const path = objectPath(db.blobRoot, sha);
    const damage = (content: Buffer): void => {
      chmodSync(path, 0o644);
      writeFileSync(path, content);
    };
    damage(Buffer.from('bytes that will be Damaged'));
    const corrupt = await failure(
      db.store.verifyStoredRunBlobs('A', 'run-damage'),
      AttachmentIntegrityError,
    );
    expect(corrupt.code).toBe('BLOB_CORRUPT');
    expect((corrupt.cause as BlobStoreError).code).toBe('BLOB_HASH_MISMATCH');
    expect(statSync(path).size).toBe(bytes.length);
    damage(Buffer.from('short'));
    const truncated = await failure(
      db.store.replayRun('A', 'run-damage', { verifyAttachments: true }),
      AttachmentIntegrityError,
    );
    expect(truncated.code).toBe('BLOB_CORRUPT');
    expect((truncated.cause as BlobStoreError).code).toBe('BLOB_SIZE_MISMATCH');
    await expect(db.store.openBlob('A', 'run-damage', sha)).rejects.toMatchObject({
      code: 'BLOB_SIZE_MISMATCH',
    });
    rmSync(path);
    const gone = await failure(
      db.store.verifyStoredRunBlobs('A', 'run-damage'),
      AttachmentIntegrityError,
    );
    expect(gone.code).toBe('BLOB_MISSING');
    await expect(db.store.openBlob('A', 'run-damage', sha)).rejects.toMatchObject({
      code: 'BLOB_MISSING',
    });
    // Nothing fell back to the run directory (gone) and nothing was rebuilt.
    expect(existsSync(path)).toBe(false);
    const replayed = await db.store.replayRun('A', 'run-damage');
    expect(replayed?.verifiedBlobs).toBeUndefined();
    expect(replayed?.validated.report.summary.attachments).toBe(1);
    expect((await db.store.projectStoredRun('A', 'run-damage'))?.attachments).toHaveLength(1);
    expect(await rows(db.pool, 'qe_run_blobs')).toBe(1);
  });

  it('fails verification when the catalog size disagrees with the source declaration', async () => {
    const db = await pgTest.database('catalogsize');
    const bytes = Buffer.from('catalog says otherwise');
    const dir = runWith(freshRoot('catalogsize'), 'cs', 'run-cs', [{ bytes }]);
    await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER });
    await db.pool.query('UPDATE qe_blobs SET size_bytes = size_bytes + 1');
    const e = await failure(db.store.verifyStoredRunBlobs('A', 'run-cs'), AttachmentIntegrityError);
    expect(e.code).toBe('BLOB_RECORD_SIZE_MISMATCH');
  });

  it('makes every fixture attachment durable and rebuilds the same blob catalog from the archive', async () => {
    const db = await pgTest.database('fixtures');
    const withBytes = manifest().runs.filter(
      (r) =>
        r.outcome === 'VALID' &&
        r.complete !== false &&
        existsSync(join(fixture(r.dir), 'attachments')),
    );
    expect(withBytes.length).toBeGreaterThanOrEqual(4);
    const dirs = withBytes.map((r) => fixture(r.dir));
    for (const d of dirs) {
      expect(
        (await db.store.persistRunDirectory({ projectId: 'P', runDirectory: d, expiresAt: NEVER }))
          .kind,
        d,
      ).toBe('inserted');
    }
    const local = await buildReadModel(dirs.map((d) => ({ projectId: 'P', runDirectory: d })));
    expect(local.problems).toEqual([]);
    const fromDb: ProjectedRun[] = [];
    for (const run of local.model.runs()) {
      const projected = await db.store.projectStoredRun('P', run.runId);
      if (!projected) throw new Error(`missing ${run.runId}`);
      fromDb.push(projected);
      const verified = await db.store.verifyStoredRunBlobs('P', run.runId);
      expect(verified?.map((b) => b.sha256).sort()).toEqual(
        [...new Set(run.attachments.map((a) => a.sha256))].sort(),
      );
    }
    const rebuilt = ReadModel.assemble(fromDb);
    expect(rebuilt.model.blobs().map((b) => [b.sha256, b.sizeBytes])).toEqual(
      local.model.blobs().map((b) => [b.sha256, b.sizeBytes]),
    );
    expect(await rows(db.pool, 'qe_blobs')).toBe(local.model.blobs().length);
    for (const blob of local.model.blobs()) {
      const source = blob.references[0];
      if (!source) throw new Error('a blob has a reference');
      const opened = await db.store.openBlob(source.projectId, source.runId, blob.sha256);
      expect(
        opened &&
          createHash('sha256')
            .update(await readAll(opened.stream))
            .digest('hex'),
      ).toBe(blob.sha256);
    }
    expect(rebuilt.model.runs().map(facts)).toEqual(local.model.runs().map(facts));
  });

  posix('serves nothing through a link planted at an object path', async () => {
    const db = await pgTest.database('planted');
    const bytes = Buffer.from('planted link');
    const sha = sha256(bytes);
    const dir = runWith(freshRoot('planted'), 'planted', 'run-planted', [{ bytes }]);
    await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir, expiresAt: NEVER });
    const path = objectPath(db.blobRoot, sha);
    rmSync(path);
    symlinkSync(join(dir, 'attachments', sha), path);
    await expect(db.store.openBlob('A', 'run-planted', sha)).rejects.toMatchObject({
      code: 'BLOB_NOT_REGULAR',
    });
    const e = await failure(
      db.store.verifyStoredRunBlobs('A', 'run-planted'),
      AttachmentIntegrityError,
    );
    expect(e.code).toBe('BLOB_CORRUPT');
    expect((e.cause as BlobStoreError).code).toBe('BLOB_NOT_REGULAR');
  });
});
