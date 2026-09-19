import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { validateRunDirectorySnapshot } from 'qe-report-validator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ReadModel,
  buildReadModel,
  compareHistoryOccurrences,
  type ExecutionOccurrence,
  type ProjectedRun,
} from 'qe-report-read-model';
import {
  MAINTENANCE_LOCK_KEY,
  MAX_PAGE_SIZE,
  PostgresQueries,
  QUERY_INDEX_VERSION,
  QueryIndexIncompleteError,
  ReplayMismatchError,
  type HistoryPage,
  type RunSummary,
} from '../src/index.js';
import { buildArchive, type RunArchive } from '../src/archive.js';
import { FIXTURES_DIR, manifest } from '../../protocol/test/helpers.js';
import {
  attemptFinished,
  attemptStarted,
  finished,
  freshRoot,
  started,
  testCase,
  writeRun,
  type EventSpec,
} from '../../read-model/test/synthetic.js';
import { NEVER, TestPostgres, archiveInto, publish, rowsIn, waitFor } from './support.js';

const pgTest = new TestPostgres();
beforeAll(() => pgTest.start());
afterAll(() => pgTest.stop());

const fixture = (name: string): string => join(FIXTURES_DIR, name);
const PAST = new Date('2026-01-01T00:00:00.000Z');
const AFTER_PAST = new Date('2026-06-01T00:00:00.000Z');

type Database = Awaited<ReturnType<TestPostgres['database']>>;

/** Every complete, valid fixture run: the corpus the in-memory model is the oracle for. */
function corpus(): string[] {
  return manifest()
    .runs.filter((r) => r.outcome === 'VALID' && r.complete !== false)
    .map((r) => fixture(r.dir));
}

/** Every history key the in-memory model holds, so both sides can be asked the same questions. */
function historyKeys(model: ReadModel): { runnerName: string; historicalId: string }[] {
  const keys = new Map<string, { runnerName: string; historicalId: string }>();
  for (const run of model.runs()) {
    for (const e of run.executions) {
      if (e.runnerName === undefined || e.test.historicalId === undefined) continue;
      keys.set(`${e.runnerName} ${e.test.historicalId}`, {
        runnerName: e.runnerName,
        historicalId: e.test.historicalId,
      });
    }
  }
  return [...keys.values()];
}

/** Reads a whole history through the paged API, which is the only way it is offered. */
async function wholeHistory(
  queries: PostgresQueries,
  projectId: string,
  runnerName: string,
  historicalId: string,
  limit = 100,
): Promise<ExecutionOccurrence[]> {
  const all: ExecutionOccurrence[] = [];
  let after: HistoryPage['next'];
  for (let guard = 0; guard < 1000; guard += 1) {
    const page: HistoryPage = await queries.getTestHistoryPage(
      after === undefined
        ? { projectId, runnerName, historicalId, limit }
        : { projectId, runnerName, historicalId, limit, after },
    );
    all.push(...page.occurrences);
    if (page.next === undefined) return all;
    after = page.next;
  }
  throw new Error('the history did not end');
}

/** Reads a whole run listing through its pages. */
async function wholeListing(
  queries: PostgresQueries,
  projectId: string,
  limit = 100,
): Promise<RunSummary[]> {
  const all: RunSummary[] = [];
  let before: bigint | undefined;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await queries.listRuns(
      before === undefined
        ? { projectId, limit }
        : { projectId, limit, beforeIngestionSequence: before },
    );
    all.push(...page.runs);
    if (page.next === undefined) return all;
    before = page.next;
  }
  throw new Error('the listing did not end');
}

/** Persists the corpus into one project and returns both sides of the comparison. */
async function corpusProject(
  name: string,
  expiresAt: Date = NEVER,
): Promise<{ db: Database; queries: PostgresQueries; local: ReadModel }> {
  const db = await pgTest.database(name);
  const dirs = corpus();
  for (const dir of dirs) {
    const result = await db.store.persistRunDirectory({
      projectId: 'P',
      runDirectory: dir,
      expiresAt,
    });
    expect(result.kind, dir).toBe('inserted');
  }
  const built = await buildReadModel(dirs.map((d) => ({ projectId: 'P', runDirectory: d })));
  expect(built.problems).toEqual([]);
  return { db, queries: new PostgresQueries(db.pool), local: built.model };
}

describe('what a newly archived run answers', () => {
  it('is queryable at once, without any rebuild', async () => {
    const db = await pgTest.database('fresh');
    const queries = new PostgresQueries(db.pool);
    expect(await queries.getIndexStatus('P')).toEqual({
      projectId: 'P',
      indexVersion: QUERY_INDEX_VERSION,
      totalRuns: 0,
      currentRuns: 0,
      missingRuns: 0,
      staleRuns: 0,
      complete: true,
    });
    const dir = fixture('runs/flaky-session-passed');
    expect(
      (await db.store.persistRunDirectory({ projectId: 'P', runDirectory: dir, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    expect(await queries.getIndexStatus('P')).toMatchObject({
      totalRuns: 1,
      currentRuns: 1,
      complete: true,
    });

    const local = (await buildReadModel([{ projectId: 'P', runDirectory: dir }])).model;
    const run = local.runs()[0] as ProjectedRun;
    const listed = await queries.listRuns({ projectId: 'P' });
    expect(listed.next).toBeUndefined();
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]).toMatchObject({
      projectId: 'P',
      runId: run.runId,
      expiresAt: NEVER,
      verdict: run.validator.verdict,
      complete: run.validator.complete,
      closed: run.validator.closed,
      sessionCount: run.sessions.length,
      executionCount: run.executions.length,
      scopeFailureCount: run.scopeFailures.length,
      attachmentCount: run.attachments.length,
    });
    expect(listed.runs[0]?.ingestionSequence).toBeGreaterThan(0n);
    // The whole run comes from its own source, never from the index.
    const replayed = await queries.getRun('P', run.runId);
    expect(replayed?.executions).toEqual(run.executions);
    expect(replayed?.sessions).toEqual(run.sessions);
    expect(await queries.getRun('P', 'no-such-run')).toBeUndefined();
    await expect(queries.getRun('', run.runId)).rejects.toThrow(TypeError);
    await expect(queries.listRuns({ projectId: 'P', limit: 0 })).rejects.toThrow(TypeError);
  });
});

describe('agreement with the in-memory read model', () => {
  it('answers every history and flakiness question of the corpus identically', async () => {
    const { queries, local } = await corpusProject('corpus');
    const keys = historyKeys(local);
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      const label = `${key.runnerName}/${key.historicalId}`;
      const durable = await wholeHistory(queries, 'P', key.runnerName, key.historicalId, 3);
      const memory = local.getTestHistory('P', key.runnerName, key.historicalId).occurrences;
      expect(durable, label).toEqual(memory);
      const expected = local.getFlakiness('P', key.runnerName, key.historicalId);
      expect(
        await queries.getFlakinessSummary({
          projectId: 'P',
          runnerName: key.runnerName,
          historicalId: key.historicalId,
        }),
        label,
      ).toEqual({
        projectId: 'P',
        runnerName: key.runnerName,
        historicalId: key.historicalId,
        totalOccurrences: expected.totalOccurrences,
        flakyOccurrences: expected.flakyOccurrences,
        everFlaky: expected.everFlaky,
      });
    }
    // A key nobody ran is empty rather than an error.
    expect(
      await queries.getFlakinessSummary({
        projectId: 'P',
        runnerName: 'nobody',
        historicalId: 'nothing',
      }),
    ).toMatchObject({ totalOccurrences: 0, flakyOccurrences: 0, everFlaky: false });
    expect(
      (await queries.getTestHistoryPage({ projectId: 'P', runnerName: 'n', historicalId: 'n' }))
        .occurrences,
    ).toEqual([]);
  });

  it('summarises every corpus run as its projection does, newest archived first', async () => {
    const { queries, local } = await corpusProject('summaries');
    const listed = await wholeListing(queries, 'P', 4);
    expect(listed).toHaveLength(local.runs().length);
    const sequences = listed.map((r) => r.ingestionSequence);
    expect([...sequences].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(sequences);
    expect(new Set(listed.map((r) => r.runId)).size).toBe(listed.length);
    for (const summary of listed) {
      const run = local.getRun('P', summary.runId) as ProjectedRun;
      expect(summary, summary.runId).toMatchObject({
        verdict: run.validator.verdict,
        complete: run.validator.complete,
        closed: run.validator.closed,
        ignoredEvents: run.validator.ignoredEvents,
        duplicateEvents: run.validator.duplicateEvents,
        sessionCount: run.sessions.length,
        executionCount: run.executions.length,
        scopeFailureCount: run.scopeFailures.length,
        attachmentCount: run.attachments.length,
      });
    }
  });

  it('keeps every distinction the projector makes', async () => {
    const { db, queries, local } = await corpusProject('distinctions');
    const flakyRun = local.getRun('P', 'run-so-0008') as ProjectedRun;
    const failedRun = local.getRun('P', 'run-so-0009') as ProjectedRun;
    const runner = flakyRun.executions[0]?.runnerName as string;
    const historicalId = flakyRun.executions[0]?.test.historicalId as string;
    const occurrences = await wholeHistory(queries, 'P', runner, historicalId);
    // The same flaky execution: passed run under an ordinary policy, failed under fail-on-flaky.
    expect(occurrences.find((o) => o.runId === flakyRun.runId)).toMatchObject({
      flaky: true,
      runVerdict: 'passed',
      sessionStatus: 'passed',
    });
    expect(occurrences.find((o) => o.runId === failedRun.runId)).toMatchObject({
      flaky: true,
      runVerdict: 'failed',
      sessionStatus: 'failed',
    });
    // An execution with no historical id is not history, and nothing gives it one.
    const anonymous = local
      .runs()
      .flatMap((r) => r.executions)
      .filter((e) => e.test.historicalId === undefined || e.runnerName === undefined);
    expect(anonymous.length).toBeGreaterThan(0);
    const indexedExecutions = await rowsIn(db.pool, 'qe_history_occurrences');
    const eligible = local
      .runs()
      .flatMap((r) => r.executions)
      .filter((e) => e.test.historicalId !== undefined && e.runnerName !== undefined);
    expect(indexedExecutions).toBe(eligible.length);
    // An uncertain identity is indexed and stays uncertain.
    const uncertain = local
      .runs()
      .flatMap((r) => r.executions)
      .find(
        (e) => e.test.historicalIdStability === 'uncertain' && e.test.historicalId !== undefined,
      );
    expect(uncertain?.runnerName).toBeDefined();
    if (uncertain?.runnerName !== undefined) {
      const page = await wholeHistory(
        queries,
        'P',
        uncertain.runnerName,
        uncertain.test.historicalId as string,
      );
      expect(page.some((o) => o.historicalIdStability === 'uncertain')).toBe(true);
    }
    // A complete but open run stays both.
    const forked = listedRun(await wholeListing(queries, 'P'), 'run-fork-0001');
    expect(forked).toMatchObject({ complete: true, closed: false });
    // A scope failure fails the run without touching the child that passed.
    const scoped = local
      .runs()
      .find(
        (r) => r.scopeFailures.length > 0 && r.executions.some((e) => e.finalStatus === 'passed'),
      );
    expect(scoped).toBeDefined();
    if (scoped !== undefined) {
      expect(listedRun(await wholeListing(queries, 'P'), scoped.runId)).toMatchObject({
        verdict: 'failed',
        scopeFailureCount: scoped.scopeFailures.length,
      });
      const child = scoped.executions.find((e) => e.finalStatus === 'passed');
      expect(child?.test.historicalId).toBeDefined();
      if (child?.runnerName !== undefined && child.test.historicalId !== undefined) {
        const history = await wholeHistory(queries, 'P', child.runnerName, child.test.historicalId);
        expect(
          history.find((o) => o.runId === scoped.runId && o.executionId === child.executionId),
        ).toMatchObject({ finalStatus: 'passed', runVerdict: 'failed' });
      }
    }
  });
});

function listedRun(runs: readonly RunSummary[], runId: string): RunSummary {
  const found = runs.find((r) => r.runId === runId);
  if (found === undefined) throw new Error(`${runId} is not listed`);
  return found;
}

describe('ordering', () => {
  it('orders identifiers exactly as the in-memory comparator does', async () => {
    const db = await pgTest.database('ordering');
    const queries = new PostgresQueries(db.pool);
    const root = freshRoot('ordering');
    // Identifiers a locale collation would order differently from code units: punctuation that
    // many collations ignore at the primary level, and case, which they fold together.
    const executionIds = ['a-b', 'ab', 'a_b', 'A-b', 'AB', 'a~b', 'Z-z', 'zz'];
    const at = '2026-09-12T10:00:00.000+00:00';
    const runIds = ['run-B', 'run-a', 'run-A', 'run_a'];
    // Directory names differ in more than case: the filesystem under the test may not.
    const directories = new Map(runIds.map((runId, i) => [runId, `dir-${i}`]));
    for (const runId of runIds) {
      const events: EventSpec[] = [started('pw')];
      for (const id of executionIds) {
        events.push(
          { ...attemptStarted(`${id}-1`, 1, testCase(id, 'shared-history')), at },
          { ...attemptFinished(`${id}-1`, 'passed'), at },
        );
      }
      events.push(finished());
      const dir = writeRun(root, directories.get(runId) as string, runId, [
        { sessionId: 's', events },
      ]);
      expect(
        (
          await db.store.persistRunDirectory({
            projectId: 'P',
            runDirectory: dir,
            expiresAt: NEVER,
          })
        ).kind,
        runId,
      ).toBe('inserted');
    }
    const durable = await wholeHistory(queries, 'P', 'pw', 'shared-history', 5);
    expect(durable).toHaveLength(executionIds.length * runIds.length);
    // Every occurrence shares one instant, so the whole order is the identifier tie-breakers.
    expect(new Set(durable.map((o) => o.occurredAt)).size).toBe(1);
    expect(durable.map((o) => [o.runId, o.executionId])).toEqual(
      [...durable].sort(compareHistoryOccurrences).map((o) => [o.runId, o.executionId]),
    );
    const local = (
      await buildReadModel(
        runIds.map((r) => ({
          projectId: 'P',
          runDirectory: join(root, 'runs', directories.get(r) as string),
        })),
      )
    ).model;
    expect(durable).toEqual(local.getTestHistory('P', 'pw', 'shared-history').occurrences);
    // Pages that straddle the tie-breakers lose and repeat nothing.
    expect(new Set(durable.map((o) => `${o.runId} ${o.executionId}`)).size).toBe(durable.length);
  });
});

describe('completeness, staleness, and rebuild', () => {
  it('refuses cross-run answers for a project whose index does not cover it, and still replays runs', async () => {
    const { db, queries, local } = await corpusProject('incomplete');
    const runs = local.runs();
    const sample = runs[0] as ProjectedRun;
    // The state migration 4 leaves an existing archive in: rows, source, and no index at all.
    await db.pool.query('DELETE FROM qe_run_query_index');
    await db.pool.query('DELETE FROM qe_history_occurrences');
    const status = await queries.getIndexStatus('P');
    expect(status).toMatchObject({
      totalRuns: runs.length,
      currentRuns: 0,
      missingRuns: runs.length,
      staleRuns: 0,
      complete: false,
    });
    const key = historyKeys(local)[0] as { runnerName: string; historicalId: string };
    for (const ask of [
      (): Promise<unknown> => queries.listRuns({ projectId: 'P' }),
      (): Promise<unknown> => queries.getTestHistoryPage({ projectId: 'P', ...key }),
      (): Promise<unknown> => queries.getFlakinessSummary({ projectId: 'P', ...key }),
    ]) {
      await expect(ask()).rejects.toThrow(QueryIndexIncompleteError);
    }
    const refused = await ask(queries, key);
    expect(refused.status.missingRuns).toBe(runs.length);
    // A single run still answers, because it is replayed from its own source.
    const replayed = await queries.getRun('P', sample.runId);
    expect(replayed?.executions).toEqual(sample.executions);

    const rebuild = await queries.rebuildProjectIndex({ projectId: 'P', maxRuns: 3 });
    expect(rebuild.rebuilt).toBe(3);
    expect(rebuild.more).toBe(true);
    expect(rebuild.problems).toEqual([]);
    expect((await queries.getIndexStatus('P')).complete).toBe(false);
    let cursor = rebuild.lastIngestionSequence;
    for (let guard = 0; guard < 100; guard += 1) {
      const next = await queries.rebuildProjectIndex({
        projectId: 'P',
        maxRuns: 3,
        ...(cursor === undefined ? {} : { afterIngestionSequence: cursor }),
      });
      cursor = next.lastIngestionSequence;
      if (!next.more) break;
    }
    expect(await queries.getIndexStatus('P')).toMatchObject({
      currentRuns: runs.length,
      missingRuns: 0,
      staleRuns: 0,
      complete: true,
    });
    // And every answer is the one the in-memory model gives.
    for (const k of historyKeys(local)) {
      expect(await wholeHistory(queries, 'P', k.runnerName, k.historicalId, 4)).toEqual(
        local.getTestHistory('P', k.runnerName, k.historicalId).occurrences,
      );
    }
    expect((await wholeListing(queries, 'P')).length).toBe(runs.length);
  });

  it('treats an index built under another interpretation as stale until it is rebuilt', async () => {
    const { db, queries, local } = await corpusProject('stale');
    const runs = local.runs();
    const sample = runs[0] as ProjectedRun;
    // Any version that is not the one queries require is stale, older or newer alike.
    await db.pool.query('UPDATE qe_run_query_index SET index_version = $1 WHERE run_id = $2', [
      QUERY_INDEX_VERSION + 1,
      sample.runId,
    ]);
    expect(await queries.getIndexStatus('P')).toMatchObject({
      staleRuns: 1,
      missingRuns: 0,
      complete: false,
    });
    await expect(queries.listRuns({ projectId: 'P' })).rejects.toThrow(QueryIndexIncompleteError);
    expect((await queries.getRun('P', sample.runId))?.executions).toEqual(sample.executions);
    // A source fingerprint that no longer matches the archive is stale in the same way.
    await queries.rebuildProjectIndex({ projectId: 'P', maxRuns: runs.length });
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
    await db.pool.query('UPDATE qe_run_query_index SET source_fingerprint = $1 WHERE run_id = $2', [
      'f'.repeat(64),
      sample.runId,
    ]);
    expect(await queries.getIndexStatus('P')).toMatchObject({ staleRuns: 1, complete: false });
    await queries.rebuildProjectIndex({ projectId: 'P', maxRuns: runs.length });
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
    expect((await wholeListing(queries, 'P')).length).toBe(runs.length);
  });

  it('restores the whole query surface from the archive after every derived row is destroyed', async () => {
    const { db, queries, local } = await corpusProject('destructive');
    const before = {
      listing: await wholeListing(queries, 'P'),
      histories: await Promise.all(
        historyKeys(local).map((k) => wholeHistory(queries, 'P', k.runnerName, k.historicalId)),
      ),
    };
    const archive = {
      runs: await rowsIn(db.pool, 'qe_runs'),
      lines: await rowsIn(db.pool, 'qe_run_source_lines'),
      retention: await rowsIn(db.pool, 'qe_run_retention'),
      blobs: await rowsIn(db.pool, 'qe_blobs'),
      relations: await rowsIn(db.pool, 'qe_run_blobs'),
    };
    // Everything derived goes; nothing canonical is touched.
    await db.pool.query('DELETE FROM qe_history_occurrences');
    await db.pool.query('DELETE FROM qe_run_query_index');
    expect(await rowsIn(db.pool, 'qe_run_query_index')).toBe(0);
    expect({
      runs: await rowsIn(db.pool, 'qe_runs'),
      lines: await rowsIn(db.pool, 'qe_run_source_lines'),
      retention: await rowsIn(db.pool, 'qe_run_retention'),
      blobs: await rowsIn(db.pool, 'qe_blobs'),
      relations: await rowsIn(db.pool, 'qe_run_blobs'),
    }).toEqual(archive);

    const rebuild = await queries.rebuildProjectIndex({
      projectId: 'P',
      maxRuns: local.runs().length,
    });
    expect(rebuild.rebuilt).toBe(local.runs().length);
    expect(rebuild.skipped).toBe(0);
    expect(rebuild.problems).toEqual([]);
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
    expect(await wholeListing(queries, 'P')).toEqual(before.listing);
    expect(
      await Promise.all(
        historyKeys(local).map((k) => wholeHistory(queries, 'P', k.runnerName, k.historicalId)),
      ),
    ).toEqual(before.histories);
  });

  it('repairs a missing index through ordinary re-ingestion, without touching the archive', async () => {
    const db = await pgTest.database('reingest');
    const queries = new PostgresQueries(db.pool);
    const dir = fixture('runs/karate');
    const first = await db.store.persistRunDirectory({
      projectId: 'P',
      runDirectory: dir,
      expiresAt: NEVER,
    });
    expect(first.kind).toBe('inserted');
    const stored = await db.store.loadRun('P', 'run-karate-0001');
    await db.pool.query('DELETE FROM qe_history_occurrences');
    await db.pool.query('DELETE FROM qe_run_query_index');
    const repaired = await db.store.persistRunDirectory({
      projectId: 'P',
      runDirectory: dir,
      expiresAt: PAST,
    });
    expect(repaired).toMatchObject({ kind: 'already_present', queryIndexRebuilt: true });
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
    // The archive is exactly as it was: source, provenance, and the expiry first recorded.
    expect(await db.store.loadRun('P', 'run-karate-0001')).toEqual(stored);
    const again = await db.store.persistRunDirectory({
      projectId: 'P',
      runDirectory: dir,
      expiresAt: NEVER,
    });
    expect(again).toMatchObject({ kind: 'already_present', queryIndexRebuilt: false });
  });
});

describe('drift', () => {
  it('reports whether one indexed run still agrees with its source', async () => {
    const { db, queries, local } = await corpusProject('drift');
    const sample = local.runs()[0] as ProjectedRun;
    expect(await queries.verifyIndexedRun('P', sample.runId)).toEqual({
      projectId: 'P',
      runId: sample.runId,
      agrees: true,
      differences: [],
    });
    await db.pool.query(
      'UPDATE qe_run_query_index SET execution_count = execution_count + 1 WHERE run_id = $1',
      [sample.runId],
    );
    const drifted = await queries.verifyIndexedRun('P', sample.runId);
    expect(drifted.agrees).toBe(false);
    expect(drifted.differences.join(' ')).toMatch(/executions/u);
    await db.pool.query('DELETE FROM qe_history_occurrences WHERE run_id = $1', [sample.runId]);
    expect((await queries.verifyIndexedRun('P', sample.runId)).differences.join(' ')).toMatch(
      /history occurrences/u,
    );
    // A rebuild puts it right again.
    await queries.rebuildProjectIndex({ projectId: 'P', maxRuns: local.runs().length });
    expect(await queries.verifyIndexedRun('P', sample.runId)).toMatchObject({ agrees: true });
    expect(await queries.verifyIndexedRun('P', 'no-such-run')).toMatchObject({ agrees: false });
  });
});

describe('projects and retention', () => {
  it('keeps one runner and historical id apart in two projects', async () => {
    const db = await pgTest.database('projects');
    const queries = new PostgresQueries(db.pool);
    const dir = fixture('runs/flaky-session-passed');
    for (const projectId of ['A', 'B']) {
      expect(
        (await db.store.persistRunDirectory({ projectId, runDirectory: dir, expiresAt: NEVER }))
          .kind,
      ).toBe('inserted');
    }
    const local = (await buildReadModel([{ projectId: 'A', runDirectory: dir }])).model;
    const key = historyKeys(local)[0] as { runnerName: string; historicalId: string };
    for (const projectId of ['A', 'B']) {
      expect(await wholeHistory(queries, projectId, key.runnerName, key.historicalId)).toHaveLength(
        1,
      );
      expect(await queries.getFlakinessSummary({ projectId, ...key })).toMatchObject({
        totalOccurrences: 1,
      });
    }
    // Deleting one project's run leaves the other's history whole.
    await db.pool.query(`DELETE FROM qe_runs WHERE project_id = 'A'`);
    expect(await wholeHistory(queries, 'A', key.runnerName, key.historicalId)).toEqual([]);
    expect(await wholeHistory(queries, 'B', key.runnerName, key.historicalId)).toHaveLength(1);
    expect((await queries.getIndexStatus('A')).complete).toBe(true);
  });

  it('loses a retained run’s derived rows with the run itself', async () => {
    const { db, queries, local } = await corpusProject('retention', PAST);
    const before = await wholeListing(queries, 'P');
    const keys = historyKeys(local);
    const totals = new Map(
      await Promise.all(
        keys.map(
          async (k) =>
            [
              `${k.runnerName} ${k.historicalId}`,
              (await queries.getFlakinessSummary({ projectId: 'P', ...k })).totalOccurrences,
            ] as const,
        ),
      ),
    );
    const victim = before[0] as RunSummary;
    await db.pool.query('UPDATE qe_run_retention SET expires_at = $1 WHERE run_id = $2', [
      PAST,
      victim.runId,
    ]);
    await db.pool.query('UPDATE qe_run_retention SET expires_at = $1 WHERE run_id <> $2', [
      NEVER,
      victim.runId,
    ]);
    const report = await db.maintenance.run({ asOf: AFTER_PAST });
    expect(report.expiredRuns.map((r) => r.runId)).toEqual([victim.runId]);

    expect(await queries.getRun('P', victim.runId)).toBeUndefined();
    expect((await wholeListing(queries, 'P')).map((r) => r.runId)).toEqual(
      before.filter((r) => r.runId !== victim.runId).map((r) => r.runId),
    );
    // No occurrence of the deleted run survives, and the project is still fully indexed.
    const orphans = await db.pool.query('SELECT 1 FROM qe_history_occurrences WHERE run_id = $1', [
      victim.runId,
    ]);
    expect(orphans.rowCount).toBe(0);
    expect(await rowsIn(db.pool, 'qe_run_query_index')).toBe(before.length - 1);
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
    const lost = local.getRun('P', victim.runId) as ProjectedRun;
    for (const k of keys) {
      const now = await queries.getFlakinessSummary({ projectId: 'P', ...k });
      const gone = lost.executions.filter(
        (e) => e.runnerName === k.runnerName && e.test.historicalId === k.historicalId,
      ).length;
      expect(now.totalOccurrences, `${k.runnerName}/${k.historicalId}`).toBe(
        (totals.get(`${k.runnerName} ${k.historicalId}`) ?? 0) - gone,
      );
    }
  });
});

describe('coordination', () => {
  it('waits for destructive retention before rebuilding, and lets ingestion carry on beside it', async () => {
    const { db, queries } = await corpusProject('coordination');
    await db.pool.query('DELETE FROM qe_run_query_index');
    const sweeping = new pg.Client({ connectionString: pgTest.connectionUriFor(db) });
    await sweeping.connect();
    await sweeping.query('SELECT pg_advisory_lock($1)', [MAINTENANCE_LOCK_KEY]);
    const pending = queries.rebuildProjectIndex({ projectId: 'P', maxRuns: 50 });
    await waitFor(async () => {
      const waiting = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        [db.name],
      );
      return Number(waiting.rows[0]?.n) === 1;
    });
    expect(await rowsIn(db.pool, 'qe_run_query_index')).toBe(0);
    await sweeping.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK_KEY]);
    const rebuilt = await pending;
    expect(rebuilt.rebuilt).toBeGreaterThan(0);
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
    await sweeping.end();
  });

  it('lets two rebuilds of one project run together and leaves one correct index', async () => {
    const { db, queries, local } = await corpusProject('rebuilds');
    await db.pool.query('DELETE FROM qe_history_occurrences');
    await db.pool.query('DELETE FROM qe_run_query_index');
    const other = new PostgresQueries(pgTest.anotherPool(db));
    const [a, b] = await Promise.all([
      queries.rebuildProjectIndex({ projectId: 'P', maxRuns: 50 }),
      other.rebuildProjectIndex({ projectId: 'P', maxRuns: 50 }),
    ]);
    expect(a.problems).toEqual([]);
    expect(b.problems).toEqual([]);
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
    expect(await rowsIn(db.pool, 'qe_run_query_index')).toBe(local.runs().length);
    for (const k of historyKeys(local)) {
      expect(await wholeHistory(queries, 'P', k.runnerName, k.historicalId)).toEqual(
        local.getTestHistory('P', k.runnerName, k.historicalId).occurrences,
      );
    }
  });

  it('answers a history query while another run is being archived', async () => {
    const { db, queries, local } = await corpusProject('while-ingesting');
    const key = historyKeys(local)[0] as { runnerName: string; historicalId: string };
    const ingesting = pgTest.storeWith(db, db.blobs, pgTest.anotherPool(db)).persistRunDirectory({
      projectId: 'Q',
      runDirectory: fixture('runs/junit'),
      expiresAt: NEVER,
    });
    const history = await wholeHistory(queries, 'P', key.runnerName, key.historicalId);
    expect((await ingesting).kind).toBe('inserted');
    expect(history).toEqual(
      local.getTestHistory('P', key.runnerName, key.historicalId).occurrences,
    );
    // The other project indexed itself and neither project's completeness depends on the other.
    expect((await queries.getIndexStatus('Q')).complete).toBe(true);
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
  });
});

/** The refusal itself, so its status can be inspected. */
async function ask(
  queries: PostgresQueries,
  key: { runnerName: string; historicalId: string },
): Promise<QueryIndexIncompleteError> {
  try {
    await queries.getTestHistoryPage({ projectId: 'P', ...key });
  } catch (e) {
    if (e instanceof QueryIndexIncompleteError) return e;
    throw e;
  }
  throw new Error('expected a QueryIndexIncompleteError');
}

describe('what the history key is, and is not', () => {
  it('separates one historical id by runner, and joins it across producers', async () => {
    const db = await pgTest.database('runners');
    const queries = new PostgresQueries(db.pool);
    const root = freshRoot('runners');
    // One historical id under two runners is two histories that must never become one. The same
    // id under one runner but two producers is one history, because the producer is not the key.
    const runs: [string, string, string][] = [
      ['run-alpha', 'alpha', 'producer-one'],
      ['run-beta', 'beta', 'producer-one'],
      ['run-alpha-again', 'alpha', 'producer-two'],
    ];
    for (const [runId, runner, producer] of runs) {
      const dir = writeRun(root, runId, runId, [
        {
          sessionId: 's',
          events: [
            started(runner, producer),
            attemptStarted('e-1', 1, testCase('e', 'one-identity')),
            attemptFinished('e-1', 'passed'),
            finished(),
          ],
        },
      ]);
      expect(
        (
          await db.store.persistRunDirectory({
            projectId: 'P',
            runDirectory: dir,
            expiresAt: NEVER,
          })
        ).kind,
        runId,
      ).toBe('inserted');
    }
    const alpha = await wholeHistory(queries, 'P', 'alpha', 'one-identity');
    const beta = await wholeHistory(queries, 'P', 'beta', 'one-identity');
    expect(alpha.map((o) => o.runId).sort()).toEqual(['run-alpha', 'run-alpha-again']);
    expect(beta.map((o) => o.runId)).toEqual(['run-beta']);
    expect(alpha.every((o) => o.runnerName === 'alpha')).toBe(true);
    expect(
      await queries.getFlakinessSummary({
        projectId: 'P',
        runnerName: 'alpha',
        historicalId: 'one-identity',
      }),
    ).toMatchObject({ totalOccurrences: 2 });
    expect(
      await queries.getFlakinessSummary({
        projectId: 'P',
        runnerName: 'beta',
        historicalId: 'one-identity',
      }),
    ).toMatchObject({ totalOccurrences: 1 });
    const local = (
      await buildReadModel(
        runs.map(([runId]) => ({ projectId: 'P', runDirectory: join(root, 'runs', runId) })),
      )
    ).model;
    expect(alpha).toEqual(local.getTestHistory('P', 'alpha', 'one-identity').occurrences);
    expect(beta).toEqual(local.getTestHistory('P', 'beta', 'one-identity').occurrences);
  });

  it('pages a leap-second boundary in the in-memory history order', async () => {
    const db = await pgTest.database('leap');
    const queries = new PostgresQueries(db.pool);
    const root = freshRoot('leap');
    // The protocol admits 23:59:60 as the last second of a UTC day; Date.parse does not read it,
    // and one millisecond count cannot hold it apart from the 00:00:00 after it. The run ids run
    // against the clock, so an order that let a leap second tie with its neighbour and fell back
    // on the identifiers would come out visibly wrong. Two runs share one leap instant, and one
    // leap second is written in another offset.
    const chronological: [string, string][] = [
      ['run-9', '2026-12-31T23:59:59.000+00:00'],
      ['run-8', '2026-12-31T23:59:59.999+00:00'],
      ['run-7', '2027-01-01T00:59:60.000+01:00'],
      ['run-0', '2026-12-31T23:59:60.500+00:00'],
      ['run-6', '2026-12-31T23:59:60.500+00:00'],
      ['run-5', '2027-01-01T00:00:00.000+00:00'],
      ['run-4', '2027-01-01T00:00:00.500+00:00'],
    ];
    for (const [runId, at] of chronological) {
      const dir = writeRun(root, runId, runId, [
        {
          sessionId: 's',
          events: [
            { ...started('pw'), at },
            { ...attemptStarted('e-1', 1, testCase('e', 'leap')), at },
            { ...attemptFinished('e-1', 'passed'), at },
            { ...finished(), at },
          ],
        },
      ]);
      expect(
        (
          await db.store.persistRunDirectory({
            projectId: 'P',
            runDirectory: dir,
            expiresAt: NEVER,
          })
        ).kind,
        at,
      ).toBe('inserted');
    }
    const local = (
      await buildReadModel(
        chronological.map(([runId]) => ({
          projectId: 'P',
          runDirectory: join(root, 'runs', runId),
        })),
      )
    ).model;
    const memory = local.getTestHistory('P', 'pw', 'leap').occurrences;
    expect(memory.map((o) => o.runId)).toEqual(chronological.map(([runId]) => runId));
    for (const limit of [1, 2, 3, 100]) {
      const durable = await wholeHistory(queries, 'P', 'pw', 'leap', limit);
      expect(durable, `page size ${limit}`).toEqual(memory);
    }
    // The cursor carries the place inside the leap second, not only the instant.
    const first = await queries.getTestHistoryPage({
      projectId: 'P',
      runnerName: 'pw',
      historicalId: 'leap',
      limit: 3,
    });
    expect(first.next).toMatchObject({ runId: 'run-7', leap: 1 });
    for (const [runId] of chronological) {
      expect(await queries.verifyIndexedRun('P', runId), runId).toMatchObject({ agrees: true });
    }
  });
});

describe('bounds and cursors', () => {
  it('caps a page and refuses a cursor or a sequence it cannot use', async () => {
    const { queries, local } = await corpusProject('bounds');
    const key = historyKeys(local)[0] as { runnerName: string; historicalId: string };
    const huge = await queries.listRuns({ projectId: 'P', limit: 10_000_000 });
    expect(huge.runs.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(huge.runs.length).toBe(local.runs().length);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(queries.listRuns({ projectId: 'P', limit: bad })).rejects.toThrow(TypeError);
      await expect(
        queries.getTestHistoryPage({ projectId: 'P', ...key, limit: bad }),
      ).rejects.toThrow(TypeError);
    }
    for (const after of [
      { occurredAt: new Date(Number.NaN), leap: 0, runId: 'r', executionId: 'e' },
      { occurredAt: new Date(0), leap: 0, runId: '', executionId: 'e' },
      { occurredAt: new Date(0), leap: 0, runId: 'r', executionId: '' },
      { occurredAt: '2026-01-01' as unknown as Date, leap: 0, runId: 'r', executionId: 'e' },
      { occurredAt: new Date(0), leap: -1, runId: 'r', executionId: 'e' },
      { occurredAt: new Date(0), leap: 1001, runId: 'r', executionId: 'e' },
      { occurredAt: new Date(0), leap: 0.5, runId: 'r', executionId: 'e' },
      { occurredAt: new Date(0), leap: '0' as unknown as number, runId: 'r', executionId: 'e' },
    ]) {
      await expect(queries.getTestHistoryPage({ projectId: 'P', ...key, after })).rejects.toThrow(
        TypeError,
      );
    }
    await expect(
      queries.listRuns({ projectId: 'P', beforeIngestionSequence: -1n }),
    ).rejects.toThrow(TypeError);
    await expect(
      queries.listRuns({ projectId: 'P', beforeIngestionSequence: 1 as unknown as bigint }),
    ).rejects.toThrow(TypeError);
    await expect(
      queries.listRuns({ projectId: 'P', beforeIngestionSequence: 2n ** 63n }),
    ).rejects.toThrow(/beforeIngestionSequence/u);
    // The rebuild cursor lives in the same numeric domain and is refused in its own name.
    for (const bad of [-1n, 2n ** 63n, 1 as unknown as bigint, '1' as unknown as bigint]) {
      await expect(
        queries.rebuildProjectIndex({ projectId: 'P', afterIngestionSequence: bad }),
      ).rejects.toThrow(/afterIngestionSequence/u);
    }
    const edge = await queries.rebuildProjectIndex({
      projectId: 'P',
      afterIngestionSequence: 2n ** 63n - 1n,
    });
    expect(edge).toMatchObject({ rebuilt: 0, more: false, lastIngestionSequence: undefined });
    expect(
      (await queries.rebuildProjectIndex({ projectId: 'P', afterIngestionSequence: 0n })).rebuilt,
    ).toBe(local.runs().length);
  });
});

describe('rebuilding what cannot be rebuilt', () => {
  it('names the run it could not index, indexes the rest, and leaves the project incomplete', async () => {
    const { db, queries, local } = await corpusProject('rebuild-problem');
    const victim = local.runs()[0] as ProjectedRun;
    await db.pool.query('DELETE FROM qe_history_occurrences');
    await db.pool.query('DELETE FROM qe_run_query_index');
    // One run's stored source no longer says what it said, so its replay cannot agree with it.
    await db.pool.query(
      `UPDATE qe_run_source_lines SET raw_line = '{"not":"an event"}'
        WHERE project_id = 'P' AND run_id = $1 AND storage_ordinal = 0`,
      [victim.runId],
    );
    const report = await queries.rebuildProjectIndex({
      projectId: 'P',
      maxRuns: local.runs().length,
    });
    expect(report.problems.map((p) => p.runId)).toEqual([victim.runId]);
    const message = report.problems[0]?.message ?? '';
    expect(message.length).toBeLessThanOrEqual(305);
    expect(/[\u0000-\u001f]/u.test(message)).toBe(false);
    expect(report.rebuilt).toBe(local.runs().length - 1);
    expect(await queries.getIndexStatus('P')).toMatchObject({ missingRuns: 1, complete: false });
    await expect(queries.listRuns({ projectId: 'P' })).rejects.toThrow(QueryIndexIncompleteError);
    // The damaged run is refused loudly rather than answered wrongly.
    await expect(queries.getRun('P', victim.runId)).rejects.toThrow();
  });

  it('lets a rebuild and a repairing re-ingestion of one run run together', async () => {
    const db = await pgTest.database('rebuild-race');
    const queries = new PostgresQueries(db.pool);
    const dir = fixture('runs/karate');
    expect(
      (await db.store.persistRunDirectory({ projectId: 'P', runDirectory: dir, expiresAt: NEVER }))
        .kind,
    ).toBe('inserted');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.pool.query('DELETE FROM qe_history_occurrences');
      await db.pool.query('DELETE FROM qe_run_query_index');
      const ingesting = pgTest.storeWith(db, db.blobs, pgTest.anotherPool(db));
      const rebuilding = new PostgresQueries(pgTest.anotherPool(db));
      const [rebuild, reingest] = await Promise.all([
        rebuilding.rebuildProjectIndex({ projectId: 'P', maxRuns: 10 }),
        ingesting.persistRunDirectory({ projectId: 'P', runDirectory: dir, expiresAt: NEVER }),
      ]);
      expect(rebuild.problems, `attempt ${attempt}`).toEqual([]);
      expect(reingest.kind, `attempt ${attempt}`).toBe('already_present');
      expect((await queries.getIndexStatus('P')).complete, `attempt ${attempt}`).toBe(true);
      expect(await queries.verifyIndexedRun('P', 'run-karate-0001')).toMatchObject({
        agrees: true,
      });
    }
  });

  it('repairs an index left under another interpretation on re-ingestion', async () => {
    const db = await pgTest.database('stale-reingest');
    const queries = new PostgresQueries(db.pool);
    const dir = fixture('runs/karate');
    await db.store.persistRunDirectory({ projectId: 'P', runDirectory: dir, expiresAt: NEVER });
    await db.pool.query('UPDATE qe_run_query_index SET index_version = $1', [
      QUERY_INDEX_VERSION + 1,
    ]);
    expect((await queries.getIndexStatus('P')).staleRuns).toBe(1);
    expect(
      await db.store.persistRunDirectory({ projectId: 'P', runDirectory: dir, expiresAt: NEVER }),
    ).toMatchObject({ kind: 'already_present', queryIndexRebuilt: true });
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
    // And again when only the source fingerprint disagrees.
    await db.pool.query('UPDATE qe_run_query_index SET source_fingerprint = $1', ['f'.repeat(64)]);
    expect(
      await db.store.persistRunDirectory({ projectId: 'P', runDirectory: dir, expiresAt: NEVER }),
    ).toMatchObject({ queryIndexRebuilt: true });
    expect((await queries.getIndexStatus('P')).complete).toBe(true);
  });
});

describe('drift in the ordering key', () => {
  it('sees an ordering instant that is no longer what the clock reads to', async () => {
    const { db, queries, local } = await corpusProject('drift-instant');
    const sample = local
      .runs()
      .find((r) => r.executions.some((e) => e.test.historicalId !== undefined)) as ProjectedRun;
    expect(await queries.verifyIndexedRun('P', sample.runId)).toMatchObject({ agrees: true });
    await db.pool.query(
      `UPDATE qe_history_occurrences SET occurred_at_instant = occurred_at_instant + interval '1 day'
        WHERE project_id = 'P' AND run_id = $1`,
      [sample.runId],
    );
    const drifted = await queries.verifyIndexedRun('P', sample.runId);
    expect(drifted.agrees).toBe(false);
    expect(drifted.differences.join(' ')).toMatch(/ordering instant/u);
    await db.pool.query(
      `UPDATE qe_history_occurrences SET occurred_at_instant = occurred_at_instant - interval '1 day'
        WHERE project_id = 'P' AND run_id = $1`,
      [sample.runId],
    );
    await db.pool.query(
      `UPDATE qe_history_occurrences SET flaky = NOT flaky WHERE project_id = 'P' AND run_id = $1`,
      [sample.runId],
    );
    expect((await queries.verifyIndexedRun('P', sample.runId)).differences.join(' ')).toMatch(
      /flaky/u,
    );
  });
});

/**
 * An already-present run's query index is always derived from the archive's stored raw source,
 * never from an idempotent physical representation offered later.
 */
describe('canonical-source repair', () => {
  /** Validates a directory into the archive the store would build from it. */
  async function archiveOf(dir: string): Promise<RunArchive> {
    return buildArchive(
      await validateRunDirectorySnapshot(dir, { retainEvents: true, retainSourceLines: true }),
    );
  }

  /** One run in two physical forms: as written, and with one line repeated byte for byte. */
  function twoForms(root: string): { plain: string; doubled: string } {
    const events: EventSpec[] = [
      started('pw'),
      attemptStarted('e-1', 1, testCase('e', 'canonical')),
      attemptFinished('e-1', 'passed'),
      finished(),
    ];
    const plain = writeRun(root, 'plain', 'run-canonical', [{ sessionId: 's', events }]);
    const doubled = writeRun(root, 'doubled', 'run-canonical', [{ sessionId: 's', events }]);
    const file = join(doubled, 'events', 's.ndjson');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    writeFileSync(file, [lines[0], lines[1], lines[1], ...lines.slice(2)].join('\n') + '\n');
    return { plain, doubled };
  }

  const cases = [
    { archived: 'plain', offered: 'doubled', damage: 'missing', path: 'advisory' },
    { archived: 'plain', offered: 'doubled', damage: 'stale', path: 'advisory' },
    { archived: 'plain', offered: 'doubled', damage: 'missing', path: 'conflict' },
    { archived: 'doubled', offered: 'plain', damage: 'missing', path: 'advisory' },
    { archived: 'doubled', offered: 'plain', damage: 'stale', path: 'advisory' },
    { archived: 'doubled', offered: 'plain', damage: 'missing', path: 'conflict' },
  ] as const;

  it.each(cases)(
    'rebuilds a $damage index of the $archived archive from its own source when the $offered form is offered ($path path)',
    async ({ archived, offered, damage, path }) => {
      const db = await pgTest.database(`canonical_${archived}_${damage}_${path}`);
      const queries = new PostgresQueries(db.pool);
      const forms = twoForms(freshRoot('canonical'));
      const archivedDir = forms[archived];
      const offeredDir = forms[offered];

      // One semantic run: the same content fingerprint, different duplicate counts.
      const archivedArchive = await archiveOf(archivedDir);
      const offeredArchive = await archiveOf(offeredDir);
      expect(offeredArchive.contentFingerprint).toBe(archivedArchive.contentFingerprint);
      expect(archivedArchive.summary.duplicates).toBe(archived === 'doubled' ? 1 : 0);
      expect(offeredArchive.summary.duplicates).toBe(offered === 'doubled' ? 1 : 0);

      expect(
        (
          await db.store.persistRunDirectory({
            projectId: 'P',
            runDirectory: archivedDir,
            expiresAt: NEVER,
          })
        ).kind,
      ).toBe('inserted');
      const local = (await buildReadModel([{ projectId: 'P', runDirectory: archivedDir }])).model;
      const truth = local.getRun('P', 'run-canonical') as ProjectedRun;
      const before = await db.store.loadRun('P', 'run-canonical');

      if (damage === 'missing') {
        await db.pool.query('DELETE FROM qe_history_occurrences');
        await db.pool.query('DELETE FROM qe_run_query_index');
      } else {
        // A stale row that already says what the offered form would: only a rebuild from the
        // archive can put the archive's own facts back.
        await db.pool.query(
          'UPDATE qe_run_query_index SET index_version = $1, duplicate_event_count = $2',
          [QUERY_INDEX_VERSION + 1, offeredArchive.summary.duplicates],
        );
      }
      expect((await queries.getIndexStatus('P')).complete).toBe(false);

      const repaired =
        path === 'advisory'
          ? await db.store.persistRunDirectory({
              projectId: 'P',
              runDirectory: offeredDir,
              expiresAt: PAST,
            })
          : // The archive transaction's own same-content branch, reached directly with the index
            // the offered form derives, as a caller racing the first archiver would reach it.
            await archiveInto(
              db.pool,
              'P',
              offeredDir,
              offeredArchive,
              await publish(db, offeredDir, offeredArchive),
              PAST,
            );
      expect(repaired).toMatchObject({ kind: 'already_present', queryIndexRebuilt: true });

      const listed = await queries.listRuns({ projectId: 'P' });
      expect(listed.runs).toHaveLength(1);
      expect(listed.runs[0]?.duplicateEvents).toBe(truth.validator.duplicateEvents);
      expect(listed.runs[0]?.duplicateEvents).toBe(archivedArchive.summary.duplicates);
      expect(listed.runs[0]?.duplicateEvents).not.toBe(offeredArchive.summary.duplicates);
      expect(await queries.verifyIndexedRun('P', 'run-canonical')).toEqual({
        projectId: 'P',
        runId: 'run-canonical',
        agrees: true,
        differences: [],
      });
      expect(await wholeHistory(queries, 'P', 'pw', 'canonical')).toEqual(
        local.getTestHistory('P', 'pw', 'canonical').occurrences,
      );
      // Source, first-ingestion provenance, fingerprint, and the first expiry are untouched.
      expect(await db.store.loadRun('P', 'run-canonical')).toEqual(before);
    },
  );
});

describe('canonical-source repair of an archive that cannot be replayed', () => {
  it('fails the re-ingestion loudly rather than indexing the offered copy', async () => {
    const db = await pgTest.database('canonical_damaged');
    const queries = new PostgresQueries(db.pool);
    const dir = fixture('runs/karate');
    await db.store.persistRunDirectory({ projectId: 'P', runDirectory: dir, expiresAt: NEVER });
    await db.pool.query('DELETE FROM qe_history_occurrences');
    await db.pool.query('DELETE FROM qe_run_query_index');
    await db.pool.query(
      `UPDATE qe_run_source_lines SET raw_line = '{"not":"an event"}'
        WHERE project_id = 'P' AND run_id = 'run-karate-0001' AND storage_ordinal = 0`,
    );
    // The offered directory is perfectly valid, but it is not the archive, and only the archive
    // may say what this run's index holds.
    await expect(
      db.store.persistRunDirectory({ projectId: 'P', runDirectory: dir, expiresAt: NEVER }),
    ).rejects.toThrow(ReplayMismatchError);
    expect(await rowsIn(db.pool, 'qe_run_query_index')).toBe(0);
    expect(await queries.getIndexStatus('P')).toMatchObject({ missingRuns: 1, complete: false });
  });
});

describe('project ids', () => {
  it('serves a project id longer than 128 characters everywhere it is archived', async () => {
    const db = await pgTest.database('long_project');
    const queries = new PostgresQueries(db.pool);
    // Opaque and non-empty is the whole contract; nothing here gives it a length of its own.
    const projectId = `project/${'x'.repeat(300)}/é`;
    expect(projectId.length).toBeGreaterThan(128);
    const dir = fixture('runs/flaky-session-passed');
    expect(
      (await db.store.persistRunDirectory({ projectId, runDirectory: dir, expiresAt: NEVER })).kind,
    ).toBe('inserted');
    expect(await queries.getIndexStatus(projectId)).toMatchObject({
      totalRuns: 1,
      currentRuns: 1,
      complete: true,
    });
    await db.pool.query('DELETE FROM qe_history_occurrences');
    await db.pool.query('DELETE FROM qe_run_query_index');
    expect(await queries.rebuildProjectIndex({ projectId })).toMatchObject({
      rebuilt: 1,
      problems: [],
    });
    const local = (await buildReadModel([{ projectId, runDirectory: dir }])).model;
    const run = local.runs()[0] as ProjectedRun;
    expect((await queries.listRuns({ projectId })).runs.map((r) => r.runId)).toEqual([run.runId]);
    for (const key of historyKeys(local)) {
      expect(await wholeHistory(queries, projectId, key.runnerName, key.historicalId)).toEqual(
        local.getTestHistory(projectId, key.runnerName, key.historicalId).occurrences,
      );
      const flakiness = local.getFlakiness(projectId, key.runnerName, key.historicalId);
      expect(await queries.getFlakinessSummary({ projectId, ...key })).toMatchObject({
        totalOccurrences: flakiness.totalOccurrences,
        flakyOccurrences: flakiness.flakyOccurrences,
        everFlaky: flakiness.everFlaky,
      });
    }
    expect((await queries.getRun(projectId, run.runId))?.executions).toEqual(run.executions);
    expect(await queries.verifyIndexedRun(projectId, run.runId)).toMatchObject({ agrees: true });
    await expect(queries.getIndexStatus('')).rejects.toThrow(TypeError);
  });
});

describe('what a derived row may hold', () => {
  it('admits exactly the canonical attempt statuses as a final status', async () => {
    const db = await pgTest.database('final_status');
    await db.store.persistRunDirectory({
      projectId: 'P',
      runDirectory: fixture('runs/flaky-session-passed'),
      expiresAt: NEVER,
    });
    expect(await rowsIn(db.pool, 'qe_history_occurrences')).toBeGreaterThan(0);
    for (const status of ['passed', 'failed', 'skipped', 'inconclusive', null]) {
      await db.pool.query('UPDATE qe_history_occurrences SET final_status = $1', [status]);
    }
    // A runner-native status the protocol maps away is not a canonical one.
    for (const status of ['aborted', 'timedOut', 'interrupted', '']) {
      await expect(
        db.pool.query('UPDATE qe_history_occurrences SET final_status = $1', [status]),
      ).rejects.toThrow(/qe_history_occurrences_final_status_check/u);
    }
    for (const leap of [-1, 1001]) {
      await expect(
        db.pool.query('UPDATE qe_history_occurrences SET occurred_at_leap = $1', [leap]),
      ).rejects.toThrow(/qe_history_occurrences_leap_check/u);
    }
  });
});
