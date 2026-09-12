import { beforeAll, describe, expect, it } from 'vitest';
import { buildReadModel } from '../src/index.js';
import type { ProjectedRun, ReadModel } from '../src/index.js';
import { runPlaywright, type RunOutcome } from '../../playwright/test-consumer/harness.js';

/**
 * Real Playwright Test reporter output: the consumer fixture is run for the scenarios the read
 * model must answer, every invocation into its own output root, and all of them are projected
 * under one project.
 */
describe('real Playwright runs', () => {
  const outcomes: Record<string, RunOutcome> = {};
  let model: ReadModel;

  function runOf(name: string): ProjectedRun {
    const outcome = outcomes[name];
    if (!outcome) throw new Error(`no outcome ${name}`);
    const runId = outcome.events[0]?.runId ?? '';
    const run = model.getRun('web', runId);
    if (!run) throw new Error(`run ${name} (${runId}) not projected`);
    return run;
  }

  beforeAll(async () => {
    outcomes.ordinary = await runPlaywright({ args: ['pass.spec.ts', '--project', 'desktop'] });
    outcomes.flaky = await runPlaywright({
      env: { PW_RETRIES: '1' },
      args: ['-g', 'flaky passes on retry', '--project', 'desktop'],
    });
    outcomes.policy = await runPlaywright({
      config: 'configs/fail-on-flaky.config.ts',
      args: ['-g', 'flaky passes on retry'],
    });
    outcomes.teardown = await runPlaywright({ config: 'configs/global-teardown-fails.config.ts' });
    outcomes.interrupted = await runPlaywright({
      config: 'configs/slow.config.ts',
      interruptWhenStarted: true,
    });
    outcomes.repeat = await runPlaywright({
      env: { PW_REPEAT_EACH: '2' },
      args: ['pass.spec.ts', '--project', 'desktop'],
    });
    for (const [name, o] of Object.entries(outcomes)) {
      expect(o.report.valid, `${name}: ${JSON.stringify(o.report.diagnostics)}`).toBe(true);
    }
    const build = await buildReadModel(
      Object.values(outcomes).map((o) => ({ projectId: 'web', outputRoot: o.outputRoot })),
    );
    expect(build.problems).toEqual([]);
    model = build.model;
    expect(model.runs()).toHaveLength(6);
  });

  it('answer what happened in an ordinary run', () => {
    const run = runOf('ordinary');
    expect(run.validator).toMatchObject({ verdict: 'passed', complete: true, closed: true });
    expect(run.sessions).toHaveLength(1);
    expect(run.sessions[0]).toMatchObject({
      producer: { name: 'qe-report-playwright' },
      runner: { name: 'playwright' },
      status: 'passed',
      rawStatus: 'passed',
      failures: [],
    });
    expect(run.executions.length).toBeGreaterThan(0);
    expect(run.executions.every((e) => e.finalStatus === 'passed' && !e.flaky)).toBe(true);
    expect(
      run.executions.every((e) =>
        e.test.path
          .map((s) => s.kind)
          .join('/')
          .startsWith('project/file'),
      ),
    ).toBe(true);
    expect(run.attachments.length).toBeGreaterThan(0);
    for (const a of run.attachments)
      expect(model.getBlob(a.sha256)?.references.length).toBeGreaterThan(0);
    const withSteps = run.executions.flatMap((e) => e.attempts).filter((a) => a.steps.length > 0);
    expect(withSteps.length).toBeGreaterThan(0);
  });

  it('derive flakiness from the retry, with a passed session and a passed run', () => {
    const run = runOf('flaky');
    const [e] = run.executions;
    expect(run.executions).toHaveLength(1);
    expect(e?.attempts.map((a) => [a.attemptNumber, a.status])).toEqual([
      [1, 'failed'],
      [2, 'passed'],
    ]);
    expect(e?.flaky).toBe(true);
    expect(run.sessions[0]?.status).toBe('passed');
    expect(run.validator.verdict).toBe('passed');
  });

  it('keep flakiness and the fail-on-flaky policy as two facts', () => {
    const run = runOf('policy');
    const [e] = run.executions;
    expect(e?.flaky).toBe(true);
    expect(e?.finalStatus).toBe('passed');
    expect(run.sessions[0]).toMatchObject({ status: 'failed', rawStatus: 'failed', failures: [] });
    expect(run.validator.verdict).toBe('failed');
    const history = model.getTestHistory('web', 'playwright', e?.test.historicalId ?? '');
    expect(
      history.occurrences.map((o) => [o.runId, o.flaky, o.sessionStatus, o.runVerdict]),
    ).toEqual([
      [runOf('flaky').runId, true, 'passed', 'passed'],
      [run.runId, true, 'failed', 'failed'],
    ]);
    expect(model.getFlakiness('web', 'playwright', e?.test.historicalId ?? '')).toMatchObject({
      totalOccurrences: 2,
      flakyOccurrences: 2,
      everFlaky: true,
    });
  });

  it('keep a global teardown failure on the session and the passed attempt passed', () => {
    const run = runOf('teardown');
    expect(run.executions.map((e) => e.finalStatus)).toEqual(['passed']);
    expect(run.sessions[0]?.status).toBe('failed');
    expect(run.sessions[0]?.failures.map((f) => f.phase)).toEqual(['teardown']);
    expect(run.validator.verdict).toBe('failed');
  });

  it('keep an interrupted run inconclusive and complete, never incomplete or passed', () => {
    const run = runOf('interrupted');
    expect(run.validator).toMatchObject({ verdict: 'inconclusive', complete: true, closed: true });
    expect(run.sessions[0]).toMatchObject({ status: 'inconclusive', rawStatus: 'interrupted' });
    expect(run.executions.map((e) => [e.finalStatus, e.finalAttempt.rawStatus, e.flaky])).toEqual([
      ['inconclusive', 'interrupted', false],
    ]);
  });

  it('keep repeat-each repetitions as separate occurrences of one historical test', () => {
    const run = runOf('repeat');
    expect(run.executions.every((e) => e.attempts.length === 1)).toBe(true);
    const byHistorical = new Map<string, number>();
    for (const e of run.executions) {
      const id = e.test.historicalId ?? '';
      byHistorical.set(id, (byHistorical.get(id) ?? 0) + 1);
    }
    expect([...byHistorical.values()].every((n) => n === 2)).toBe(true);
    for (const id of byHistorical.keys()) {
      const inRun = model
        .getTestHistory('web', 'playwright', id)
        .occurrences.filter((o) => o.runId === run.runId);
      expect(inRun).toHaveLength(2);
      expect(new Set(inRun.map((o) => o.executionId)).size).toBe(2);
    }
  });

  it('keep the run directory a locator and the run id the identity', () => {
    for (const run of model.runs()) {
      expect(run.runDirectory).toContain('/runs/');
      expect(run.runDirectory.endsWith(run.runId)).toBe(false);
      expect(model.getRun('web', run.runId)).toBe(run);
    }
  });
});
