import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateRunDirectorySnapshot } from 'qe-report-validator';
import { ReadModel, buildReadModel, projectRun } from 'qe-report-read-model';
import type { ProjectedRun } from 'qe-report-read-model';
import { buildArchive, type RunArchive } from '../src/archive.js';
import { ReplayMismatchError, persistArchive, type PersistResult } from '../src/store.js';
import type { ValidatedRun } from 'qe-report-validator';
import { FIXTURES_DIR, manifest } from '../../protocol/test/helpers.js';
import {
  attachment,
  attemptFinished,
  attemptStarted,
  execution,
  finished,
  freshRoot,
  started,
  testCase,
  writeRun,
} from '../../read-model/test/synthetic.js';
import { TestPostgres, count, facts, waitFor } from './support.js';

const pgTest = new TestPostgres();
beforeAll(() => pgTest.start());
afterAll(() => pgTest.stop());

const fixture = (name: string): string => join(FIXTURES_DIR, name);
/** Every archive in these tests comes from a directory validation, which checked the bytes. */
const archiveOf = (validated: ValidatedRun): RunArchive => buildArchive(validated, true);

/** A run written as one hand-formatted event file, to control property order and whitespace. */
function writeRawRun(
  root: string,
  dir: string,
  lines: readonly string[],
  attachments: Buffer[] = [],
): string {
  const run = join(root, 'runs', dir);
  mkdirSync(join(run, 'events'), { recursive: true });
  writeFileSync(join(run, 'events', 's.ndjson'), lines.join('\n') + '\n');
  if (attachments.length > 0) {
    mkdirSync(join(run, 'attachments'));
    for (const bytes of attachments) {
      writeFileSync(
        join(run, 'attachments', createHash('sha256').update(bytes).digest('hex')),
        bytes,
      );
    }
  }
  return run;
}

const env = (seq: number, type: string, payload: string, extra = ''): string =>
  `{"protocolVersion":"0.3.0","eventId":"s-${seq}","eventType":"${type}","runId":"run-fwd","sessionId":"s","sequence":${seq},"occurredAt":"2026-09-12T10:00:0${seq}.000+00:00"${extra},"payload":${payload}}`;

describe('persisting runs', () => {
  it('archives every complete valid fixture once, refuses the incomplete ones, and writes nothing for invalid ones', async () => {
    const db = await pgTest.database('fixtures');
    const results = new Map<string, PersistResult>();
    for (const run of manifest().runs) {
      results.set(
        run.dir,
        await db.store.persistRunDirectory({ projectId: 'P', runDirectory: fixture(run.dir) }),
      );
    }
    for (const run of manifest().runs) {
      const r = results.get(run.dir);
      if (run.outcome === 'INVALID') {
        expect(r?.kind, run.dir).toBe('rejected');
        expect(r?.kind === 'rejected' && r.reason, run.dir).toBe('RUN_INVALID');
        expect(
          r?.kind === 'rejected' && r.diagnostics.some((d) => d.code === run.reason),
          run.dir,
        ).toBe(true);
      } else if (run.complete === false) {
        expect(r?.kind === 'rejected' && r.reason, run.dir).toBe('RUN_INCOMPLETE');
      } else {
        expect(r?.kind, run.dir).toBe('inserted');
      }
    }
    const complete = manifest().runs.filter((r) => r.outcome === 'VALID' && r.complete !== false);
    expect(await count(db.pool, 'SELECT count(*)::text AS n FROM qe_runs')).toBe(complete.length);
    const forked = await db.store.loadRun('P', 'run-fork-0001');
    expect(forked?.validationSummary).toMatchObject({
      complete: true,
      closed: false,
      verdict: 'passed',
    });
    expect(forked?.attachmentsVerified).toBe(true);
    expect(forked?.sourceLines.map((l) => l.sessionId)).toEqual(
      [...(forked?.sourceLines ?? [])].map((l) => l.sessionId).sort(),
    );
    expect(await db.store.loadRun('P', 'run-inv-0030')).toBeUndefined();
    expect(await db.store.loadRun('other', 'run-fork-0001')).toBeUndefined();
  });

  it('is idempotent for the same run and refuses different content under one identity', async () => {
    const db = await pgTest.database('idem');
    const first = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: fixture('runs/karate'),
    });
    expect(first.kind).toBe('inserted');
    const again = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: fixture('runs/karate'),
    });
    expect(again).toEqual({ ...first, kind: 'already_present' });
    const root = freshRoot('other-copy');
    const copy = join(root, 'runs', 'elsewhere');
    mkdirSync(join(root, 'runs'), { recursive: true });
    cpSync(fixture('runs/karate'), copy, { recursive: true });
    const fromElsewhere = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: copy,
    });
    expect(fromElsewhere.kind).toBe('already_present');
    const stored = await db.store.loadRun('A', 'run-karate-0001');
    expect(stored?.sourceLocator).toBe(fixture('runs/karate'));
    // Same run id, different content: the flaky fixture pair only differs by the session outcome.
    const a = await validateRunDirectorySnapshot(fixture('runs/flaky-session-passed'), {
      retainSourceLines: true,
    });
    const b = await validateRunDirectorySnapshot(fixture('runs/flaky-session-failed'), {
      retainSourceLines: true,
    });
    const archiveA = archiveOf(a);
    const archiveB: RunArchive = { ...archiveOf(b), runId: archiveA.runId };
    expect(await persistArchive(db.pool, 'A', 'first', archiveA)).toMatchObject({
      kind: 'inserted',
    });
    const conflict = await persistArchive(db.pool, 'A', 'second', archiveB);
    expect(conflict).toMatchObject({
      kind: 'conflict',
      reason: 'RUN_CONFLICT',
      runId: archiveA.runId,
    });
    expect(conflict.kind === 'conflict' && conflict.storedFingerprint).toBe(
      archiveA.contentFingerprint,
    );
    const kept = await db.store.loadRun('A', archiveA.runId);
    expect(kept?.contentFingerprint).toBe(archiveA.contentFingerprint);
    expect(kept?.sourceLocator).toBe('first');
    expect(kept?.sourceLines.map((l) => l.canonicalSha256)).toEqual(
      archiveA.lines.map((l) => l.canonicalSha256),
    );
  });

  it('keeps the same run id apart in two projects with independent sequences and loads', async () => {
    const db = await pgTest.database('projects');
    const a = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: fixture('runs/forked'),
    });
    const b = await db.store.persistRunDirectory({
      projectId: 'B',
      runDirectory: fixture('runs/forked'),
    });
    expect(a.kind).toBe('inserted');
    expect(b.kind).toBe('inserted');
    expect(
      a.kind === 'inserted' && b.kind === 'inserted' && a.ingestionSequence !== b.ingestionSequence,
    ).toBe(true);
    const loadedA = await db.store.loadRun('A', 'run-fork-0001');
    const loadedB = await db.store.loadRun('B', 'run-fork-0001');
    expect(loadedA?.projectId).toBe('A');
    expect(loadedB?.projectId).toBe('B');
    expect(loadedA?.ingestionSequence).not.toBe(loadedB?.ingestionSequence);
    expect(
      await count(db.pool, 'SELECT count(*)::text AS n FROM qe_runs WHERE run_id = $1', [
        'run-fork-0001',
      ]),
    ).toBe(2);
    await expect(db.store.loadRun('', 'run-fork-0001')).rejects.toThrow(TypeError);
  });

  it('treats property order, whitespace, and extra identical duplicate lines as the same run', async () => {
    const db = await pgTest.database('order');
    const root = freshRoot('order');
    const compact = [
      env(
        1,
        'session.started',
        '{"producer":{"name":"p"},"runner":{"name":"pw"},"labels":{"b":"2","a":"1"}}',
      ),
      env(
        2,
        'attempt.started',
        '{"attemptId":"a","attemptNumber":1,"test":{"executionId":"e","historicalId":"h","historicalIdStability":"stable","displayName":"t","path":[]}}',
      ),
      env(3, 'attempt.finished', '{"attemptId":"a","status":"passed"}'),
      env(4, 'session.finished', '{}'),
    ];
    const spaced = [
      '{ "payload": {"labels": {"a": "1", "b": "2"}, "runner": {"name": "pw"}, "producer": {"name": "p"}}, "occurredAt": "2026-09-12T10:00:01.000+00:00", "sequence": 1, "sessionId": "s", "runId": "run-fwd", "eventType": "session.started", "eventId": "s-1", "protocolVersion": "0.3.0" }',
      '{"eventId":"s-2", "payload":{"test":{"path":[],"displayName":"t","historicalIdStability":"stable","historicalId":"h","executionId":"e"},"attemptNumber":1,"attemptId":"a"}, "protocolVersion":"0.3.0","eventType":"attempt.started","runId":"run-fwd","sessionId":"s","sequence":2,"occurredAt":"2026-09-12T10:00:02.000+00:00"}',
      env(3, 'attempt.finished', '{"status":"passed","attemptId":"a"}'),
      env(3, 'attempt.finished', '{"status":"passed","attemptId":"a"}'),
      env(4, 'session.finished', '{}'),
    ];
    const first = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: writeRawRun(root, 'compact', compact),
    });
    expect(first.kind).toBe('inserted');
    const second = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: writeRawRun(root, 'spaced', spaced),
    });
    expect(second).toEqual({ ...first, kind: 'already_present' });
    const stored = await db.store.loadRun('A', 'run-fwd');
    expect(stored?.sourceLines.map((l) => l.rawLine)).toEqual(compact);
    expect(stored?.sourceLines.filter((l) => l.disposition === 'duplicate')).toEqual([]);
    // The same run with an unknown optional field is different content.
    const forward = [
      env(
        1,
        'session.started',
        '{"producer":{"name":"p"},"runner":{"name":"pw"},"labels":{"b":"2","a":"1"},"vendor":{"build":"x"}}',
      ),
      ...compact.slice(1),
    ];
    const conflict = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: writeRawRun(root, 'forward', forward),
    });
    expect(conflict).toMatchObject({ kind: 'conflict', reason: 'RUN_CONFLICT' });
    expect((await db.store.loadRun('A', 'run-fwd'))?.sourceLines.map((l) => l.rawLine)).toEqual(
      compact,
    );
    // Under another project the forward version is simply a different run.
    expect(
      (
        await db.store.persistRunDirectory({
          projectId: 'B',
          runDirectory: writeRawRun(root, 'forward-b', forward),
        })
      ).kind,
    ).toBe('inserted');
  });

  it('keeps forward-compatible source after the directory is gone and projects it correctly', async () => {
    const db = await pgTest.database('forward');
    const root = freshRoot('forward');
    const bytes = Buffer.from('attached bytes');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const protoMap = '{"__proto__":"one","constructor":"two","toString":"three"}';
    const lines = [
      env(
        1,
        'session.started',
        `{"producer":{"name":"p"},"runner":{"name":"pw"},"environment":${protoMap},"labels":${protoMap},"vendorSession":{"deep":[1,{"k":"v"}]}}`,
        ',"envelopeExtra":42',
      ),
      env(
        2,
        'attempt.started',
        `{"attemptId":"a","attemptNumber":1,"test":{"executionId":"e","historicalId":"h","historicalIdStability":"stable","displayName":"t","path":[],"labels":${protoMap}},"vendorAttempt":"kept"}`,
      ),
      env(3, 'custom.heartbeat', '{"beat":1}', ',"ignorable":true'),
      env(
        4,
        'attachment.added',
        `{"attemptId":"a","name":"log","mediaType":"text/plain","sizeBytes":${bytes.length},"sha256":"${sha}"}`,
      ),
      env(5, 'attempt.finished', '{"attemptId":"a","status":"passed","vendorResult":{"score":1}}'),
      env(5, 'attempt.finished', '{"attemptId":"a","status":"passed","vendorResult":{"score":1}}'),
      env(6, 'session.finished', '{"status":"passed","rawStatus":"passed"}'),
    ];
    const dir = writeRawRun(root, 'fwd', lines, [bytes]);
    const local = await validateRunDirectorySnapshot(dir, { retainSourceLines: true });
    expect(local.report).toMatchObject({
      valid: true,
      summary: { ignored: 1, duplicates: 1, attachments: 1 },
    });
    const localProjection = projectRun('A', dir, local);
    const persisted = await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir });
    expect(persisted.kind).toBe('inserted');
    rmSync(root, { recursive: true, force: true });

    const stored = await db.store.loadRun('A', 'run-fwd');
    expect(stored?.sourceLines.map((l) => l.rawLine)).toEqual(lines);
    expect(stored?.sourceLines.map((l) => l.disposition)).toEqual([
      'accepted',
      'accepted',
      'ignored',
      'accepted',
      'accepted',
      'duplicate',
      'accepted',
    ]);
    const raw = stored?.sourceLines.map((l) => l.rawLine).join('\n') ?? '';
    for (const kept of [
      '"envelopeExtra":42',
      '"vendorSession"',
      '"vendorAttempt":"kept"',
      '"vendorResult"',
      'custom.heartbeat',
      '"__proto__":"one"',
    ]) {
      expect(raw).toContain(kept);
    }
    const replayed = await db.store.replayRun('A', 'run-fwd');
    expect(replayed?.validated.report.summary).toEqual(local.report.summary);
    expect(replayed?.validated.report.summary).toMatchObject({
      ignored: 1,
      duplicates: 1,
      verdict: 'passed',
    });
    const projected = await db.store.projectStoredRun('A', 'run-fwd');
    expect(projected && facts(projected)).toEqual(facts(localProjection));
    const session = projected?.sessions[0];
    expect(Object.keys(session?.environment ?? {})).toEqual([
      '__proto__',
      'constructor',
      'toString',
    ]);
    expect(Object.getPrototypeOf(session?.labels)).toBe(Object.prototype);
    expect(projected?.executions[0]?.test.labels).toEqual(JSON.parse(protoMap));
    expect(projected?.attachments.map((a) => [a.sha256, a.sizeBytes])).toEqual([
      [sha, bytes.length],
    ]);
    expect(projected?.validator).toMatchObject({
      ignoredEvents: 1,
      duplicateEvents: 1,
      verdict: 'passed',
    });
  });

  it('rolls the whole run back when a line cannot be stored, leaving no orphan row', async () => {
    const db = await pgTest.database('atomic');
    const validated = await validateRunDirectorySnapshot(fixture('runs/karate'), {
      retainSourceLines: true,
    });
    const archive = archiveOf(validated);
    const broken: RunArchive = {
      ...archive,
      lines: archive.lines.map((l, i) =>
        i === 2 ? { ...l, disposition: 'bogus' as 'accepted' } : l,
      ),
    };
    await expect(persistArchive(db.pool, 'A', 'broken', broken)).rejects.toThrow(
      /disposition_check/u,
    );
    expect(await count(db.pool, 'SELECT count(*)::text AS n FROM qe_runs')).toBe(0);
    expect(await count(db.pool, 'SELECT count(*)::text AS n FROM qe_run_source_lines')).toBe(0);
    // The identity was released: the intact archive can still be stored.
    expect((await persistArchive(db.pool, 'A', 'intact', archive)).kind).toBe('inserted');
    expect(await count(db.pool, 'SELECT count(*)::text AS n FROM qe_run_source_lines')).toBe(
      archive.lines.length,
    );
  });

  it('lets concurrent ingestions of one run end with one archive and no mixed lines', async () => {
    const db = await pgTest.database('concurrent');
    const same = archiveOf(
      await validateRunDirectorySnapshot(fixture('runs/junit'), { retainSourceLines: true }),
    );
    const pools = [db.pool, ...Array.from({ length: 5 }, () => pgTest.anotherPool(db))];
    const results = await Promise.all(
      pools.map((p, i) => persistArchive(p, 'A', `copy-${i}`, same)),
    );
    expect(results.filter((r) => r.kind === 'inserted')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'already_present')).toHaveLength(pools.length - 1);
    expect(
      await count(
        db.pool,
        'SELECT count(*)::text AS n FROM qe_run_source_lines WHERE run_id = $1',
        [same.runId],
      ),
    ).toBe(same.lines.length);

    const passed = archiveOf(
      await validateRunDirectorySnapshot(fixture('runs/flaky-session-passed'), {
        retainSourceLines: true,
      }),
    );
    const failed: RunArchive = {
      ...archiveOf(
        await validateRunDirectorySnapshot(fixture('runs/flaky-session-failed'), {
          retainSourceLines: true,
        }),
      ),
      runId: passed.runId,
    };
    const contenders = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? passed : failed));
    const outcomes = await Promise.all(
      contenders.map((archive, i) =>
        persistArchive(pools[i % pools.length] as pg.Pool, 'A', `contender-${i}`, archive),
      ),
    );
    const inserted = outcomes.filter((r) => r.kind === 'inserted');
    expect(inserted).toHaveLength(1);
    const winner = await db.store.loadRun('A', passed.runId);
    const winning = winner?.contentFingerprint === passed.contentFingerprint ? passed : failed;
    expect([passed.contentFingerprint, failed.contentFingerprint]).toContain(
      winner?.contentFingerprint,
    );
    expect(winner?.sourceLines.map((l) => l.canonicalSha256)).toEqual(
      winning.lines.map((l) => l.canonicalSha256),
    );
    for (const r of outcomes) {
      if (r.kind === 'inserted') continue;
      expect(['already_present', 'conflict']).toContain(r.kind);
    }
    expect(outcomes.filter((r) => r.kind === 'conflict').length).toBe(4);
    expect(outcomes.filter((r) => r.kind === 'already_present').length).toBe(3);
  });

  it('fails visibly when the stored audit summary disagrees with the replay', async () => {
    const db = await pgTest.database('audit');
    await db.store.persistRunDirectory({ projectId: 'A', runDirectory: fixture('runs/forked') });
    await db.pool.query(
      `UPDATE qe_runs SET validation_summary = validation_summary || '{"verdict":"failed"}'::jsonb WHERE project_id = $1 AND run_id = $2`,
      ['A', 'run-fork-0001'],
    );
    await expect(db.store.replayRun('A', 'run-fork-0001')).rejects.toThrow(ReplayMismatchError);
    await expect(db.store.replayRun('A', 'run-fork-0001')).rejects.toThrow(
      /verdict: ingested failed, replayed passed/u,
    );
  });

  it('rebuilds the same read model from PostgreSQL as from the local directories', async () => {
    const db = await pgTest.database('readmodel');
    const dirs = [
      'runs/forked',
      'runs/playwright',
      'runs/karate',
      'runs/flaky-session-passed',
      'runs/flaky-session-failed',
      'runs/retry-across-sessions',
      'runs/coordinator',
      'runs/junit',
    ];
    for (const d of dirs)
      expect(
        (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: fixture(d) })).kind,
      ).toBe('inserted');
    const local = await buildReadModel(
      dirs.map((d) => ({ projectId: 'A', runDirectory: fixture(d) })),
    );
    expect(local.problems).toEqual([]);
    const fromDb: ProjectedRun[] = [];
    for (const run of local.model.runs()) {
      const projected = await db.store.projectStoredRun('A', run.runId);
      if (!projected) throw new Error(`missing ${run.runId}`);
      fromDb.push(projected);
    }
    const rebuilt = ReadModel.assemble(fromDb);
    expect(rebuilt.problems).toEqual([]);
    expect(rebuilt.model.runs().map(facts)).toEqual(local.model.runs().map(facts));
    expect(
      rebuilt.model.blobs().map((b) => ({ ...b, sources: b.sources.map((s) => s.runId) })),
    ).toEqual(local.model.blobs().map((b) => ({ ...b, sources: b.sources.map((s) => s.runId) })));
    for (const run of local.model.runs()) {
      for (const e of run.executions) {
        if (e.test.historicalId === undefined || e.runnerName === undefined) continue;
        expect(rebuilt.model.getTestHistory('A', e.runnerName, e.test.historicalId)).toEqual(
          local.model.getTestHistory('A', e.runnerName, e.test.historicalId),
        );
        expect(rebuilt.model.getFlakiness('A', e.runnerName, e.test.historicalId)).toEqual(
          local.model.getFlakiness('A', e.runnerName, e.test.historicalId),
        );
      }
    }
    const flaky = rebuilt.model.getRun('A', 'run-so-0009');
    expect(flaky?.executions[0]?.flaky).toBe(true);
    expect(flaky?.sessions[0]?.status).toBe('failed');
    expect(flaky?.validator.verdict).toBe('failed');
    const stored = await db.store.loadRun('A', 'run-karate-0001');
    expect(stored?.ingestionSequence).toBeGreaterThan(0n);
  });

  it('accepts a synthetic complete open run with attachments and rejects the same run left open', async () => {
    const db = await pgTest.database('open');
    const root = freshRoot('open');
    const bytes = Buffer.from('log');
    const open = writeRun(
      root,
      'open',
      'run-open',
      [
        {
          sessionId: 's',
          events: [
            started('pw'),
            attemptStarted('a', 1, testCase('e', 'h')),
            attachment('a', bytes),
            attemptFinished('a', 'passed'),
            finished(),
          ],
        },
      ],
      [bytes],
    );
    expect((await db.store.persistRunDirectory({ projectId: 'A', runDirectory: open })).kind).toBe(
      'inserted',
    );
    const unfinished = writeRun(root, 'unfinished', 'run-unfinished', [
      {
        sessionId: 's',
        events: [started('pw'), ...execution(testCase('e', 'h'), [['passed']]).slice(0, 1)],
      },
    ]);
    const r = await db.store.persistRunDirectory({ projectId: 'A', runDirectory: unfinished });
    expect(r).toMatchObject({
      kind: 'rejected',
      reason: 'RUN_INCOMPLETE',
      runId: 'run-unfinished',
    });
    expect(
      await count(db.pool, 'SELECT count(*)::text AS n FROM qe_runs WHERE run_id = $1', [
        'run-unfinished',
      ]),
    ).toBe(0);
  });
  it('archives and replays runs whose directory layout differs from their session count', async () => {
    const db = await pgTest.database('layout');
    const cases: [string, (dir: string) => void][] = [
      ['empty-extra-file', (dir) => writeFileSync(join(dir, 'events', 'zz-empty.ndjson'), '')],
      [
        'blank-extra-file',
        (dir) => writeFileSync(join(dir, 'events', 'zz-blank.ndjson'), '\n\n  \n'),
      ],
      [
        'physical-copy',
        (dir) => {
          const [file] = readdirSync(join(dir, 'events')).sort();
          cpSync(join(dir, 'events', file ?? ''), join(dir, 'events', `zz-copy-${file}`));
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const root = freshRoot(name);
      const dir = join(root, 'runs', name);
      mkdirSync(join(root, 'runs'), { recursive: true });
      cpSync(fixture('runs/karate'), dir, { recursive: true });
      mutate(dir);
      const local = await validateRunDirectorySnapshot(dir, { retainSourceLines: true });
      expect(local.report.valid, name).toBe(true);
      expect(local.report.summary.files, name).toBe(2);
      const result = await db.store.persistRunDirectory({ projectId: name, runDirectory: dir });
      expect(result.kind, name).toBe('inserted');
      const replayed = await db.store.replayRun(name, 'run-karate-0001');
      expect(replayed?.validated.report.summary.duplicates, name).toBe(
        local.report.summary.duplicates,
      );
      expect(replayed?.validated.report.summary.events, name).toBe(local.report.summary.events);
      const projected = await db.store.projectStoredRun(name, 'run-karate-0001');
      expect(projected && facts(projected), name).toEqual(facts(projectRun(name, dir, local)));
    }
    const copy = await db.store.loadRun('physical-copy', 'run-karate-0001');
    expect(copy?.sourceLines.filter((l) => l.disposition === 'duplicate').length).toBeGreaterThan(
      0,
    );
  });

  it('rejects a directory whose events name no run as RUN_EMPTY without throwing', async () => {
    const db = await pgTest.database('empty');
    const root = freshRoot('empty');
    const dir = join(root, 'runs', 'empty');
    mkdirSync(join(dir, 'events'), { recursive: true });
    const r = await db.store.persistRunDirectory({ projectId: 'A', runDirectory: dir });
    expect(r).toEqual({ kind: 'rejected', reason: 'RUN_EMPTY', runId: undefined, diagnostics: [] });
    expect(await count(db.pool, 'SELECT count(*)::text AS n FROM qe_runs')).toBe(0);
  });

  it('records whether attachment bytes were verified, as the caller states it', async () => {
    const db = await pgTest.database('verified');
    await db.store.persistRunDirectory({ projectId: 'A', runDirectory: fixture('runs/karate') });
    expect((await db.store.loadRun('A', 'run-karate-0001'))?.attachmentsVerified).toBe(true);
    const replayed = await db.store.replayRun('A', 'run-karate-0001');
    if (!replayed) throw new Error('missing');
    // Re-archiving a replayed run elsewhere: its validation saw no bytes, and the record says so.
    const again = await db.store.persistValidated('B', 'replayed-from-A', replayed.validated, {
      attachmentsVerified: false,
    });
    expect(again.kind).toBe('inserted');
    const b = await db.store.loadRun('B', 'run-karate-0001');
    expect(b?.attachmentsVerified).toBe(false);
    expect(b?.contentFingerprint).toBe(
      (await db.store.loadRun('A', 'run-karate-0001'))?.contentFingerprint,
    );
  });

  it('stores a run larger than one insert statement and rolls back a failure in a later chunk', async () => {
    const db = await pgTest.database('chunks');
    const root = freshRoot('big');
    const events = [started('pw')];
    for (let i = 0; i < 700; i += 1) {
      events.push(
        attemptStarted(`a-${i}`, 1, testCase(`e-${i}`, `h-${i}`)),
        attemptFinished(`a-${i}`, i % 7 === 0 ? 'failed' : 'passed'),
      );
    }
    events.push(finished());
    const dir = writeRun(root, 'big', 'run-big', [{ sessionId: 's', events }]);
    const validated = await validateRunDirectorySnapshot(dir, { retainSourceLines: true });
    expect(validated.sourceLines.length).toBe(1402);
    const archive = archiveOf(validated);
    const broken: RunArchive = {
      ...archive,
      lines: archive.lines.map((l, i) =>
        i === 1300 ? { ...l, disposition: 'bogus' as 'accepted' } : l,
      ),
    };
    await expect(persistArchive(db.pool, 'A', 'broken', broken)).rejects.toThrow(
      /disposition_check/u,
    );
    expect(await count(db.pool, 'SELECT count(*)::text AS n FROM qe_run_source_lines')).toBe(0);
    expect(await count(db.pool, 'SELECT count(*)::text AS n FROM qe_runs')).toBe(0);
    expect((await persistArchive(db.pool, 'A', dir, archive)).kind).toBe('inserted');
    const stored = await db.store.loadRun('A', 'run-big');
    expect(stored?.sourceLines).toHaveLength(1402);
    expect(stored?.sourceLines.map((l) => l.storageOrdinal)).toEqual(
      archive.lines.map((l) => l.storageOrdinal),
    );
    const projected = await db.store.projectStoredRun('A', 'run-big');
    expect(projected?.executions).toHaveLength(700);
    expect(projected && facts(projected)).toEqual(facts(projectRun('A', dir, validated)));
  });

  it('replays every complete valid fixture into the same projection as its directory', async () => {
    const db = await pgTest.database('all');
    for (const run of manifest().runs.filter(
      (r) => r.outcome === 'VALID' && r.complete !== false,
    )) {
      const dir = fixture(run.dir);
      expect(
        (await db.store.persistRunDirectory({ projectId: 'P', runDirectory: dir })).kind,
        run.dir,
      ).toBe('inserted');
      const local = await validateRunDirectorySnapshot(dir);
      const runId = local.events[0]?.runId ?? '';
      const projected = await db.store.projectStoredRun('P', runId);
      expect(projected && facts(projected), run.dir).toEqual(facts(projectRun('P', dir, local)));
    }
  });

  it('blocks a second claimant on the identity until the first ends, then answers from the committed row', async () => {
    const db = await pgTest.database('interleave');
    const archive = archiveOf(
      await validateRunDirectorySnapshot(fixture('runs/karate'), { retainSourceLines: true }),
    );
    const holder = new pg.Client({ connectionString: pgTest.connectionUriFor(db) });
    await holder.connect();
    const claim = async (a: RunArchive): Promise<void> => {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO qe_runs (project_id, run_id, source_locator, content_fingerprint, fingerprint_version,
           protocol_versions, source_line_count, attachments_verified, validation_summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          'A',
          a.runId,
          'holder',
          a.contentFingerprint,
          a.fingerprintVersion,
          a.protocolVersions,
          a.lines.length,
          true,
          JSON.stringify(a.summary),
        ],
      );
    };
    // Polled outside the holder's transaction: pg_stat_activity is snapshotted per transaction,
    // so the holder itself would keep seeing the state before the contenders arrived.
    const waiting = (n: number): Promise<void> =>
      waitFor(async () => {
        const r = await db.pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND state = 'active'`,
          [db.name],
        );
        return Number(r.rows[0]?.n) === n;
      });
    await claim(archive);
    const pending = persistArchive(pgTest.anotherPool(db), 'A', 'contender', archive);
    await waiting(1);
    expect(await count(db.pool, 'SELECT count(*)::text AS n FROM qe_run_source_lines')).toBe(0);
    await holder.query('ROLLBACK');
    expect((await pending).kind).toBe('inserted');
    expect((await db.store.loadRun('A', archive.runId))?.sourceLocator).toBe('contender');
    // With a holder that commits, the waiters answer from the committed row.
    const other = archiveOf(
      await validateRunDirectorySnapshot(fixture('runs/forked'), { retainSourceLines: true }),
    );
    await claim(other);
    const same = persistArchive(pgTest.anotherPool(db), 'A', 'same', other);
    const different = persistArchive(pgTest.anotherPool(db), 'A', 'different', {
      ...archive,
      runId: other.runId,
    });
    await waiting(2);
    await holder.query('COMMIT');
    expect((await same).kind).toBe('already_present');
    expect((await different).kind).toBe('conflict');
    await holder.end();
  });

  it('recognises the same content archived under an older fingerprint rule', async () => {
    const db = await pgTest.database('fpversion');
    expect(
      (await db.store.persistRunDirectory({ projectId: 'A', runDirectory: fixture('runs/karate') }))
        .kind,
    ).toBe('inserted');
    await db.pool.query(
      'UPDATE qe_runs SET fingerprint_version = 0, content_fingerprint = $3 WHERE project_id = $1 AND run_id = $2',
      ['A', 'run-karate-0001', '0'.repeat(64)],
    );
    const again = await db.store.persistRunDirectory({
      projectId: 'A',
      runDirectory: fixture('runs/karate'),
    });
    expect(again).toMatchObject({ kind: 'already_present', runId: 'run-karate-0001' });
    const conflict = await persistArchive(db.pool, 'A', 'x', {
      ...archiveOf(
        await validateRunDirectorySnapshot(fixture('runs/forked'), { retainSourceLines: true }),
      ),
      runId: 'run-karate-0001',
    });
    expect(conflict.kind).toBe('conflict');
  });

  it('fails visibly when a stored line no longer matches the archived content', async () => {
    const db = await pgTest.database('tamper');
    await db.store.persistRunDirectory({ projectId: 'A', runDirectory: fixture('runs/karate') });
    await db.pool.query(
      `UPDATE qe_run_source_lines SET raw_line = replace(raw_line, '"status":"failed"', '"status":"passed"')
        WHERE project_id = $1 AND run_id = $2 AND event_type = 'attempt.finished'`,
      ['A', 'run-karate-0001'],
    );
    await expect(db.store.replayRun('A', 'run-karate-0001')).rejects.toThrow(ReplayMismatchError);
    await db.pool.query(
      'UPDATE qe_runs SET validation_summary = validation_summary || $3::jsonb WHERE project_id = $1 AND run_id = $2',
      ['A', 'run-karate-0001', '{"failedAttempts":0,"verdict":"passed"}'],
    );
    await expect(db.store.replayRun('A', 'run-karate-0001')).rejects.toThrow(
      /content fingerprint/u,
    );
  });
});
