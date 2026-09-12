import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { validateRunDirectory, validateRunDirectorySnapshot } from 'qe-report-validator';
import { buildReadModel, projectRun, projectRunDirectory } from '../src/index.js';
import { freshRoot } from './synthetic.js';
import { FIXTURES_DIR, manifest } from '../../protocol/test/helpers.js';

const P = 'fixtures';

async function projected(dir: string) {
  const result = await projectRunDirectory({ projectId: P, runDirectory: join(FIXTURES_DIR, dir) });
  expect(result.kind, dir).toBe('projected');
  if (result.kind !== 'projected') throw new Error('unreachable');
  return result.run;
}

describe('protocol fixture runs', () => {
  it('takes the verdict, completeness, and closure from the validator for every valid fixture', async () => {
    for (const run of manifest().runs.filter((r) => r.outcome === 'VALID')) {
      const dir = join(FIXTURES_DIR, run.dir);
      const report = await validateRunDirectory(dir);
      const p = await projected(run.dir);
      expect(p.validator, run.dir).toEqual({
        valid: true,
        complete: report.summary.complete,
        closed: report.summary.closed,
        verdict: report.summary.verdict,
        ignoredEvents: report.summary.ignored,
        duplicateEvents: report.summary.duplicates,
      });
      expect(p.sessions, run.dir).toHaveLength(report.summary.sessions);
      expect(
        p.executions.reduce((n, e) => n + e.attempts.length, 0),
        run.dir,
      ).toBe(report.summary.attempts);
      expect(p.scopeFailures, run.dir).toHaveLength(report.summary.scopeFailures);
      expect(p.attachments, run.dir).toHaveLength(report.summary.attachments);
      expect(
        p.executions.flatMap((e) => e.attempts).filter((a) => a.status === 'failed'),
        run.dir,
      ).toHaveLength(report.summary.failedAttempts);
      expect(
        p.sessions.filter((s) => s.status === 'failed'),
        run.dir,
      ).toHaveLength(report.summary.failedSessions);
      expect(
        p.sessions.filter((s) => s.status === 'inconclusive'),
        run.dir,
      ).toHaveLength(report.summary.inconclusiveSessions);
      expect(
        p.sessions.reduce((n, s) => n + s.failures.length, 0),
        run.dir,
      ).toBe(report.summary.sessionFailures);
    }
  });

  it('passes the validator verdict through even when the events would say otherwise', async () => {
    const snapshot = await validateRunDirectorySnapshot(join(FIXTURES_DIR, 'runs/forked'));
    expect(snapshot.report.summary.verdict).toBe('passed');
    for (const verdict of ['failed', 'inconclusive', 'incomplete'] as const) {
      const forged = {
        ...snapshot,
        report: { ...snapshot.report, summary: { ...snapshot.report.summary, verdict } },
      };
      expect(projectRun(P, 'dir', forged).validator.verdict).toBe(verdict);
    }
    expect(() =>
      projectRun(P, 'dir', { ...snapshot, report: { ...snapshot.report, valid: false } }),
    ).toThrow(/valid run/u);
  });

  it('rejects a directory without events and one whose events name no run, without throwing', async () => {
    const root = freshRoot('empty');
    mkdirSync(join(root, 'runs', 'bare'), { recursive: true });
    mkdirSync(join(root, 'runs', 'empty', 'events'), { recursive: true });
    const bare = await projectRunDirectory({
      projectId: P,
      runDirectory: join(root, 'runs', 'bare'),
    });
    expect(bare.kind === 'rejected' && bare.problem.code).toBe('NOT_A_RUN_DIRECTORY');
    const empty = await projectRunDirectory({
      projectId: P,
      runDirectory: join(root, 'runs', 'empty'),
    });
    expect(empty.kind === 'rejected' && empty.problem.code).toBe('EMPTY_RUN');
    const { model, problems } = await buildReadModel([{ projectId: P, outputRoot: root }]);
    expect(model.runs()).toEqual([]);
    expect(problems.map((p) => [p.code, p.runDirectory])).toEqual([
      ['NO_EVENTS_DIRECTORY', join(root, 'runs', 'bare')],
      ['EMPTY_RUN', join(root, 'runs', 'empty')],
    ]);
  });

  it('never projects an invalid fixture, and reports the validator diagnostics', async () => {
    for (const run of manifest().runs.filter((r) => r.outcome === 'INVALID')) {
      const result = await projectRunDirectory({
        projectId: P,
        runDirectory: join(FIXTURES_DIR, run.dir),
      });
      expect(result.kind, run.dir).toBe('rejected');
      if (result.kind !== 'rejected') continue;
      expect(result.problem.code, run.dir).toBe('RUN_INVALID');
      expect(
        result.problem.diagnostics.some((d) => d.code === run.reason),
        run.dir,
      ).toBe(true);
    }
  });

  it('rejects a directory with two run ids before projection', async () => {
    const dir = join(FIXTURES_DIR, 'runs/invalid/mixed-run-ids');
    const result = await projectRunDirectory({ projectId: P, runDirectory: dir });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.problem.diagnostics.map((d) => d.detail)).toContain('RUN_ID_MISMATCH');
    const { model, problems } = await buildReadModel([{ projectId: P, runDirectory: dir }]);
    expect(model.runs()).toEqual([]);
    expect(problems.map((p) => p.code)).toEqual(['RUN_INVALID']);
  });

  it('projects a passed, complete, open forked run with one session per fork', async () => {
    const run = await projected('runs/forked');
    expect(run.validator).toMatchObject({ verdict: 'passed', complete: true, closed: false });
    expect(run.sessions.map((s) => s.sessionId)).toEqual(['fork-1', 'fork-2', 'fork-3']);
    expect(run.executions.every((e) => e.finalStatus === 'passed' && e.complete)).toBe(true);
    expect(run.sessions.every((s) => s.finished && s.status === undefined)).toBe(true);
  });

  it('keeps a failed attempt as the execution outcome', async () => {
    const run = await projected('runs/karate');
    const failed = run.executions.filter((e) => e.finalStatus === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((e) => e.finalAttempt.failures.length > 0)).toBe(true);
    expect(run.validator.verdict).toBe('failed');
  });

  it('keeps a scope failure beside passed children: A passed, B passed, one scope failure, run failed', async () => {
    const run = await projected('runs/scope-failure-all-passed');
    expect(run.executions.map((e) => e.finalStatus)).toEqual(['passed', 'passed']);
    expect(run.scopeFailures).toHaveLength(1);
    expect(run.scopeFailures[0]).toMatchObject({
      sessionId: run.sessions[0]?.sessionId,
      path: expect.arrayContaining([expect.objectContaining({ kind: expect.any(String) })]),
    });
    expect(run.scopeFailures[0]?.failures.length).toBeGreaterThan(0);
    expect(run.validator.verdict).toBe('failed');
  });

  it('keeps a failed session beside passed attempts: attempt passed, session failed, run failed', async () => {
    const run = await projected('runs/session-failed-all-passed');
    expect(run.executions.every((e) => e.finalStatus === 'passed')).toBe(true);
    expect(run.sessions[0]).toMatchObject({ status: 'failed', finished: true });
    expect(run.validator.verdict).toBe('failed');
  });

  it('keeps session failures of the invocation itself, with no attempt to attach them to', async () => {
    const run = await projected('runs/session-failed-with-setup-failure');
    expect(run.executions).toEqual([]);
    expect(run.sessions[0]?.failures).toHaveLength(1);
    expect(run.sessions[0]?.status).toBe('failed');
    expect(run.validator.verdict).toBe('failed');
  });

  it('keeps an inconclusive session and the inconclusive verdict', async () => {
    const run = await projected('runs/session-inconclusive-all-passed');
    expect(run.sessions[0]?.status).toBe('inconclusive');
    expect(run.validator.verdict).toBe('inconclusive');
  });

  it('represents an incomplete run honestly: no invented final status, not flaky, verdict incomplete', async () => {
    const run = await projected('runs/crashed');
    expect(run.validator).toMatchObject({ verdict: 'incomplete', complete: false });
    const open = run.executions.filter((e) => !e.complete);
    expect(open.length).toBeGreaterThan(0);
    for (const e of open) {
      expect(e.finalStatus).toBeUndefined();
      expect(e.finalAttempt.finished).toBe(false);
      expect(e.flaky).toBe(false);
    }
    expect(run.scopeFailures).toHaveLength(1);
  });

  it('projects an identical duplicate event once', async () => {
    const run = await projected('runs/duplicate-event-identical');
    expect(run.validator.duplicateEvents).toBe(1);
    expect(run.executions).toHaveLength(1);
    expect(run.executions[0]?.attempts).toHaveLength(1);
  });

  it('keeps attachment references and catalogues their bytes by hash', async () => {
    const run = await projected('runs/karate');
    expect(run.attachments).toHaveLength(2);
    for (const a of run.attachments) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/u);
      const attempt = run.executions
        .flatMap((e) => e.attempts)
        .find((x) => x.attemptId === a.attemptId);
      expect(attempt?.attachments).toContainEqual(a);
    }
    const { model } = await buildReadModel([
      { projectId: P, runDirectory: join(FIXTURES_DIR, 'runs/karate') },
    ]);
    expect(model.blobs().map((b) => b.references.length)).toEqual(
      model.blobs().map((b) => run.attachments.filter((a) => a.sha256 === b.sha256).length),
    );
  });

  it('lets an unknown ignorable event through without making it a fact', async () => {
    const run = await projected('runs/compat/unknown-event-ignorable');
    expect(run.validator.ignoredEvents).toBe(1);
    expect(run.validator.verdict).toBe('passed');
  });

  it('flaky with a passed session: execution flaky, session passed, run passed', async () => {
    const run = await projected('runs/flaky-session-passed');
    expect(run.executions.map((e) => [e.flaky, e.attempts.length, e.finalStatus])).toEqual([
      [true, 2, 'passed'],
    ]);
    expect(run.sessions[0]?.status).toBe('passed');
    expect(run.validator.verdict).toBe('passed');
  });

  it('flaky under a fail-on-flaky policy: execution flaky, session failed, run failed', async () => {
    const run = await projected('runs/flaky-session-failed');
    expect(run.executions.map((e) => [e.flaky, e.finalStatus])).toEqual([[true, 'passed']]);
    expect(run.sessions[0]?.status).toBe('failed');
    expect(run.validator.verdict).toBe('failed');
  });

  it('projects a retry across two sessions of one runner as one flaky execution with one occurrence', async () => {
    const run = await projected('runs/retry-across-sessions');
    expect(run.validator).toMatchObject({ verdict: 'passed', complete: true, closed: false });
    expect(
      run.sessions.map((s) => [s.sessionId, s.producer.name, s.runner?.name, s.runner?.version]),
    ).toEqual([
      ['worker-1', 'fixture', 'fixture-runner', '1'],
      ['worker-2', 'other-fixture', 'fixture-runner', '2'],
    ]);
    expect(run.executions).toHaveLength(1);
    const [e] = run.executions;
    expect(e?.executionId).toBe('t-1');
    expect(e?.runnerName).toBe('fixture-runner');
    expect(e?.attempts.map((a) => [a.attemptNumber, a.sessionId, a.status])).toEqual([
      [1, 'worker-1', 'failed'],
      [3, 'worker-2', 'passed'],
    ]);
    expect(e?.finalAttempt.attemptNumber).toBe(3);
    expect(e?.finalStatus).toBe('passed');
    expect(e?.complete).toBe(true);
    expect(e?.flaky).toBe(true);
    expect(e?.attempts.map((a) => a.test.labels)).toEqual([{ worker: '1' }, { worker: '2' }]);
    expect(e?.attempts.map((a) => a.test.tags)).toEqual([['first'], ['retry']]);
    expect(e?.test.labels).toEqual({ worker: '1' });
    const { model } = await buildReadModel([
      { projectId: P, runDirectory: join(FIXTURES_DIR, 'runs/retry-across-sessions') },
    ]);
    const history = model.getTestHistory(P, 'fixture-runner', 'suite::t-1');
    expect(
      history.occurrences.map((o) => [o.executionId, o.attemptCount, o.flaky, o.sessionIds]),
    ).toEqual([['t-1', 2, true, ['worker-1', 'worker-2']]]);
    expect(model.getFlakiness(P, 'fixture-runner', 'suite::t-1')).toMatchObject({
      totalOccurrences: 1,
      flakyOccurrences: 1,
      everFlaky: true,
    });
  });

  it('preserves prototype-named map keys through projection without special handling', async () => {
    const root = freshRoot('proto');
    const dir = join(root, 'runs', 'r');
    mkdirSync(join(dir, 'events'), { recursive: true });
    const map = '{"__proto__":"one","constructor":"two","prototype":"three","toString":"four"}';
    const env = (seq: number, type: string, payload: string): string =>
      `{"protocolVersion":"0.3.0","eventId":"s-${seq}","eventType":"${type}","runId":"run-proto",` +
      `"sessionId":"s","sequence":${seq},"occurredAt":"2026-09-12T10:00:0${seq}.000+00:00","payload":${payload}}`;
    writeFileSync(
      join(dir, 'events', 's.ndjson'),
      [
        env(
          1,
          'session.started',
          `{"producer":{"name":"p"},"runner":{"name":"pw"},"environment":${map},"labels":${map}}`,
        ),
        env(
          2,
          'attempt.started',
          `{"attemptId":"a","attemptNumber":1,"test":{"executionId":"e","historicalId":"h","historicalIdStability":"stable","displayName":"t","path":[],"labels":${map}}}`,
        ),
        env(3, 'attempt.finished', '{"attemptId":"a","status":"passed"}'),
        env(4, 'session.finished', '{}'),
      ].join('\n') + '\n',
    );
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const result = await projectRunDirectory({ projectId: P, runDirectory: dir });
    expect(result.kind).toBe('projected');
    if (result.kind !== 'projected') return;
    const session = result.run.sessions[0];
    const test = result.run.executions[0]?.test;
    for (const m of [session?.environment, session?.labels, test?.labels]) {
      const own = m as Record<string, string>;
      expect(Object.getPrototypeOf(own)).toBe(Object.prototype);
      expect(Object.keys(own)).toEqual(['__proto__', 'constructor', 'prototype', 'toString']);
      expect(Object.prototype.hasOwnProperty.call(own, '__proto__')).toBe(true);
      expect([own['__proto__'], own['constructor'], own['prototype'], own['toString']]).toEqual([
        'one',
        'two',
        'three',
        'four',
      ]);
      expect(JSON.stringify(own)).toBe(map);
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });

  it('projects the JUnit fixture with its scope failure and native engine/class/method path', async () => {
    const run = await projected('runs/junit');
    expect(run.scopeFailures).toHaveLength(1);
    expect(run.executions[0]?.test.path.map((s) => s.kind)).toEqual(['engine', 'class']);
    expect(run.executions.every((e) => e.runnerName === 'junit-platform')).toBe(true);
  });

  it('projects the Playwright fixture with its native project/file/group path and two sessions', async () => {
    const run = await projected('runs/playwright');
    expect(run.sessions).toHaveLength(2);
    expect(run.sessions.every((s) => s.status === 'failed')).toBe(true);
    const kinds = new Set(run.executions.map((e) => e.test.path.map((s) => s.kind).join('/')));
    expect([...kinds].every((k) => k.startsWith('project/file'))).toBe(true);
  });
});
