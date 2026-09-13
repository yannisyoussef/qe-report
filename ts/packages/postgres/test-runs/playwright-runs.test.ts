import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadModel, buildReadModel } from 'qe-report-read-model';
import type { ProjectedRun } from 'qe-report-read-model';
import { runPlaywright, type RunOutcome } from '../../playwright/test-consumer/harness.js';
import { TestPostgres, facts } from '../test-integration/support.js';

/** Fresh Playwright reporter output archived in PostgreSQL and replayed: ordinary, flaky, and fail-on-flaky runs. */
const pgTest = new TestPostgres();
beforeAll(() => pgTest.start());
afterAll(() => pgTest.stop());

describe('real Playwright runs in PostgreSQL', () => {
  it('archive three runs and replay them with attempt, session, and run facts intact', async () => {
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
    for (const o of Object.values(outcomes)) {
      const result = await db.store.persistRunDirectory({
        projectId: 'web',
        runDirectory: o.runDir,
      });
      expect(result.kind).toBe('inserted');
    }
    const fromDb: ProjectedRun[] = [];
    for (const run of local.model.runs()) {
      const projected = await db.store.projectStoredRun('web', run.runId);
      if (!projected) throw new Error(`missing ${run.runId}`);
      fromDb.push(projected);
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
    const historicalId = runOf('flaky').executions[0]?.test.historicalId ?? '';
    expect(rebuilt.model.getFlakiness('web', 'playwright', historicalId)).toEqual(
      local.model.getFlakiness('web', 'playwright', historicalId),
    );
  });
});
