import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadModel, buildReadModel } from 'qe-report-read-model';
import type { ProjectedRun } from 'qe-report-read-model';
import { runPlaywright, type RunOutcome } from '../../playwright/test-consumer/harness.js';
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
    };
    for (const [name, o] of Object.entries(outcomes)) expect(o.report.valid, name).toBe(true);
    const local = await buildReadModel(
      Object.values(outcomes).map((o) => ({ projectId: 'web', outputRoot: o.outputRoot })),
    );
    expect(local.problems).toEqual([]);
    expect(local.model.runs()).toHaveLength(3);
    const db = await pgTest.database('playwright');
    for (const [name, o] of Object.entries(outcomes)) {
      const result = await db.store.persistRunDirectory({
        projectId: 'web',
        runDirectory: o.runDir,
        expiresAt: name === 'flaky' ? EXPIRED : NEVER,
      });
      expect(result.kind, name).toBe('inserted');
      rmSync(o.runDir, { recursive: true, force: true });
      expect(existsSync(o.runDir)).toBe(false);
    }
    const fromDb: ProjectedRun[] = [];
    for (const run of local.model.runs()) {
      const projected = await db.store.projectStoredRun('web', run.runId);
      if (!projected) throw new Error(`missing ${run.runId}`);
      fromDb.push(projected);
      const verified = await db.store.verifyStoredRunBlobs('web', run.runId);
      expect(verified?.map((b) => b.sha256).sort()).toEqual(
        [...new Set(run.attachments.map((a) => a.sha256))].sort(),
      );
    }
    const rebuilt = ReadModel.assemble(fromDb);
    expect(rebuilt.model.runs().map(facts)).toEqual(local.model.runs().map(facts));
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
