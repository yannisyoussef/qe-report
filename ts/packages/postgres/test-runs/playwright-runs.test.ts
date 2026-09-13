import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadModel, buildReadModel } from 'qe-report-read-model';
import type { ProjectedRun } from 'qe-report-read-model';
import { runPlaywright, type RunOutcome } from '../../playwright/test-consumer/harness.js';
import { PostgresQueries } from '../src/index.js';
import { NEVER, TestPostgres, facts, rowsIn } from '../test-integration/support.js';

/** Already past when maintenance is asked about "now"; the flaky run is ingested to expire. */
const EXPIRED = new Date('2026-01-01T00:00:00.000Z');
const MAINTENANCE_AT = new Date('2026-06-01T00:00:00.000Z');

/** Fresh Playwright reporter output archived in PostgreSQL with its attachment bytes and replayed: ordinary, flaky, and fail-on-flaky runs. */
const pgTest = new TestPostgres();
beforeAll(() => pgTest.start());
afterAll(() => pgTest.stop());

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('real Playwright runs in PostgreSQL', () => {
  it('archive three runs with their bytes and replay them without the run directories, attempt, session, and run facts intact', async () => {
    const outcomes: Record<string, RunOutcome> = {
      ordinary: await runPlaywright({ args: ['pass.spec.ts', '--project', 'desktop'] }),
      flaky: await runPlaywright({
        env: { PW_RETRIES: '1' },
        args: ['-g', 'flaky passes on retry', '--project', 'desktop'],
      }),
      policy: await runPlaywright({
        config: 'configs/fail-on-flaky.config.ts',
        args: ['-g', 'flaky passes on retry'],
      }),
      teardown: await runPlaywright({ config: 'configs/global-teardown-fails.config.ts' }),
      repeat: await runPlaywright({
        env: { PW_REPEAT_EACH: '2' },
        args: ['pass.spec.ts', '--project', 'desktop'],
      }),
      interrupted: await runPlaywright({
        config: 'configs/slow.config.ts',
        interruptWhenStarted: true,
      }),
    };
    for (const [name, o] of Object.entries(outcomes)) expect(o.report.valid, name).toBe(true);
    const local = await buildReadModel(
      Object.values(outcomes).map((o) => ({ projectId: 'web', outputRoot: o.outputRoot })),
    );
    expect(local.problems).toEqual([]);
    expect(local.model.runs()).toHaveLength(Object.keys(outcomes).length);
    const db = await pgTest.database('playwright');
    const archived = new Map<string, string>();
    for (const [name, o] of Object.entries(outcomes)) {
      const runId = o.events[0]?.runId ?? '';
      const complete = local.model.getRun('web', runId)?.validator.complete === true;
      const result = await db.store.persistRunDirectory({
        projectId: 'web',
        runDirectory: o.runDir,
        expiresAt: name === 'flaky' ? EXPIRED : NEVER,
      });
      if (complete) {
        expect(result.kind, name).toBe('inserted');
        archived.set(name, runId);
      } else {
        // An interrupted run is valid and incomplete: the archive takes complete runs only, so
        // it is never stored and never queryable, which is the whole of its effect here.
        expect(result, name).toMatchObject({ kind: 'rejected', reason: 'RUN_INCOMPLETE' });
      }
      rmSync(o.runDir, { recursive: true, force: true });
      expect(existsSync(o.runDir)).toBe(false);
    }
    expect(archived.size).toBeGreaterThanOrEqual(4);
    const fromDb: ProjectedRun[] = [];
    for (const run of local.model.runs()) {
      if (![...archived.values()].includes(run.runId)) continue;
      const projected = await db.store.projectStoredRun('web', run.runId);
      if (!projected) throw new Error(`missing ${run.runId}`);
      fromDb.push(projected);
      const verified = await db.store.verifyStoredRunBlobs('web', run.runId);
      expect(verified?.map((b) => b.sha256).sort()).toEqual(
        [...new Set(run.attachments.map((a) => a.sha256))].sort(),
      );
    }
    const rebuilt = ReadModel.assemble(fromDb);
    expect(rebuilt.model.runs().map(facts)).toEqual(
      local.model
        .runs()
        .filter((r) => [...archived.values()].includes(r.runId))
        .map(facts),
    );
    const runOf = (name: string): ProjectedRun => {
      const id = outcomes[name]?.events[0]?.runId ?? '';
      const run = rebuilt.model.getRun('web', id);
      if (!run) throw new Error(`no ${name}`);
      return run;
    };
    expect(runOf('flaky').executions[0]?.flaky).toBe(true);
    expect(runOf('flaky').sessions[0]?.status).toBe('passed');
    expect(runOf('flaky').validator.verdict).toBe('passed');
    expect(runOf('policy').executions[0]?.flaky).toBe(true);
    expect(runOf('policy').sessions[0]?.status).toBe('failed');
    expect(runOf('policy').validator.verdict).toBe('failed');
    expect(runOf('ordinary').attachments.length).toBeGreaterThan(0);
    expect(rebuilt.model.blobs().length).toBe(local.model.blobs().length);
    // Every catalogued blob resolves from the store, at its declared size and hash.
    for (const blob of rebuilt.model.blobs()) {
      const source = blob.references[0];
      if (!source) throw new Error('a blob has a reference');
      const opened = await db.store.openBlob(source.projectId, source.runId, blob.sha256);
      if (!opened) throw new Error(`blob ${blob.sha256} not catalogued`);
      const bytes = await readAll(opened.stream);
      expect(bytes.length).toBe(blob.sizeBytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(blob.sha256);
    }
    const historicalId = runOf('flaky').executions[0]?.test.historicalId ?? '';
    expect(rebuilt.model.getFlakiness('web', 'playwright', historicalId)).toEqual(
      local.model.getFlakiness('web', 'playwright', historicalId),
    );

    // The durable query surface over the same real runs.
    const queries = new PostgresQueries(db.pool);
    expect(await queries.getIndexStatus('web')).toMatchObject({
      totalRuns: archived.size,
      currentRuns: archived.size,
      complete: true,
    });
    const listed = await queries.listRuns({ projectId: 'web' });
    expect(listed.runs.map((r) => r.runId).sort()).toEqual([...archived.values()].sort());
    const keys = new Map<string, { runnerName: string; historicalId: string }>();
    for (const run of rebuilt.model.runs()) {
      for (const e of run.executions) {
        if (e.runnerName === undefined || e.test.historicalId === undefined) continue;
        keys.set(`${e.runnerName} ${e.test.historicalId}`, {
          runnerName: e.runnerName,
          historicalId: e.test.historicalId,
        });
      }
    }
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys.values()) {
      const label = `${key.runnerName}/${key.historicalId}`;
      const page = await queries.getTestHistoryPage({
        projectId: 'web',
        runnerName: key.runnerName,
        historicalId: key.historicalId,
        limit: 50,
      });
      expect(page.next, label).toBeUndefined();
      expect(page.occurrences, label).toEqual(
        rebuilt.model.getTestHistory('web', key.runnerName, key.historicalId).occurrences,
      );
      const expected = rebuilt.model.getFlakiness('web', key.runnerName, key.historicalId);
      expect(await queries.getFlakinessSummary({ projectId: 'web', ...key }), label).toMatchObject({
        totalOccurrences: expected.totalOccurrences,
        flakyOccurrences: expected.flakyOccurrences,
        everFlaky: expected.everFlaky,
      });
    }
    // The distinction the whole layer exists to preserve, on real runner output.
    const flakyHistory = await queries.getTestHistoryPage({
      projectId: 'web',
      runnerName: 'playwright',
      historicalId,
      limit: 50,
    });
    expect(flakyHistory.occurrences.find((o) => o.runId === archived.get('flaky'))).toMatchObject({
      flaky: true,
      runVerdict: 'passed',
    });
    expect(flakyHistory.occurrences.find((o) => o.runId === archived.get('policy'))).toMatchObject({
      flaky: true,
      runVerdict: 'failed',
    });
    // A retried test is one occurrence; a repeated one is several.
    expect(flakyHistory.occurrences.filter((o) => o.runId === archived.get('flaky'))).toHaveLength(
      1,
    );
    const repeatRun = rebuilt.model.getRun('web', archived.get('repeat') as string);
    const repeated = repeatRun?.executions[0];
    if (repeated?.runnerName !== undefined && repeated.test.historicalId !== undefined) {
      const page = await queries.getTestHistoryPage({
        projectId: 'web',
        runnerName: repeated.runnerName,
        historicalId: repeated.test.historicalId,
        limit: 50,
      });
      expect(page.occurrences.filter((o) => o.runId === repeatRun?.runId).length).toBeGreaterThan(
        1,
      );
    }
    // A failing global teardown fails its session and run while the tests themselves passed.
    const teardownRun = rebuilt.model.getRun('web', archived.get('teardown') as string);
    if (teardownRun !== undefined) {
      expect(listed.runs.find((r) => r.runId === teardownRun.runId)?.verdict).toBe(
        teardownRun.validator.verdict,
      );
      expect(teardownRun.executions.every((e) => e.finalStatus !== 'failed')).toBe(true);
    }

    // Retention on real output: the run ingested with a past expiry goes, and the runs that were
    // not ingested to expire keep their source, their projection, and their bytes.
    const flakyId = outcomes['flaky']?.events[0]?.runId ?? '';
    const flakyBlobs = (await db.store.loadRun('web', flakyId))?.blobs.map((b) => b.sha256) ?? [];
    const report = await db.maintenance.run({ asOf: MAINTENANCE_AT });
    expect(report.expiredRuns.map((r) => r.runId)).toEqual([flakyId]);
    expect(report.problems).toEqual([]);
    expect(await db.store.loadRun('web', flakyId)).toBeUndefined();
    expect(await db.store.projectStoredRun('web', flakyId)).toBeUndefined();
    expect(await rowsIn(db.pool, 'qe_run_source_lines', 'run_id = $1', [flakyId])).toBe(0);
    expect(await rowsIn(db.pool, 'qe_run_blobs', 'run_id = $1', [flakyId])).toBe(0);
    expect(await rowsIn(db.pool, 'qe_history_occurrences', 'run_id = $1', [flakyId])).toBe(0);
    expect(await rowsIn(db.pool, 'qe_run_query_index', 'run_id = $1', [flakyId])).toBe(0);
    expect((await queries.getIndexStatus('web')).complete).toBe(true);
    expect((await queries.listRuns({ projectId: 'web' })).runs.map((r) => r.runId)).not.toContain(
      flakyId,
    );
    for (const sha of flakyBlobs) {
      expect(await db.store.openBlob('web', flakyId, sha), sha).toBeUndefined();
    }
    // Every blob a retained run still references is still there, whoever else referenced it.
    for (const name of ['ordinary', 'policy']) {
      const id = outcomes[name]?.events[0]?.runId ?? '';
      const projected = await db.store.projectStoredRun('web', id);
      expect(projected && facts(projected), name).toEqual(facts(runOf(name)));
      const verified = await db.store.verifyStoredRunBlobs('web', id);
      expect(verified?.map((b) => b.sha256).sort(), name).toEqual(
        [...new Set(runOf(name).attachments.map((a) => a.sha256))].sort(),
      );
    }
  });
});
