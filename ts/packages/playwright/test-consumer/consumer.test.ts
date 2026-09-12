import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parseEvent } from 'qe-report-protocol';
import { resolveRunDirectory } from 'qe-report-sdk';
import { validateRunDirectory } from 'qe-report-validator';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE,
  attemptsNamed,
  freshDir,
  noErrors,
  one,
  pathOf,
  runPlaywright,
  storedAttachment,
  type Attempt,
  type RunOutcome,
} from './harness.js';

function readText(run: RunOutcome, a: Attempt, name: string): string {
  const found = a.attachments.find((x) => x.payload.name === name);
  expect(found, name).toBeDefined();
  return found === undefined ? '' : storedAttachment(run, found).toString('utf8');
}

/**
 * Real Playwright Test executions of the consumer fixture, every one validated by the protocol
 * validator. Playwright's own final status comes from a probe reporter in the fixture so that the
 * derived protocol verdict can be compared with it.
 */
describe('qe-report-playwright consumer', () => {
  describe('one invocation with retries', () => {
    let run: RunOutcome;

    beforeAll(async () => {
      run = await runPlaywright({ runId: 'run-main', env: { PW_RETRIES: '1' } });
    });

    it('runs, validates as a complete open run, and fails as Playwright does', () => {
      noErrors(run);
      expect(run.exitCode).toBe(1);
      expect(run.playwright?.status).toBe('failed');
      expect(run.report.summary).toMatchObject({
        sessions: 1,
        files: 1,
        complete: true,
        closed: false,
        scopeFailures: 0,
        verdict: 'failed',
      });
      expect(run.events.some((e) => e.eventType === 'run.finished')).toBe(false);
      expect(run.finished.map((e) => e.payload)).toEqual([
        { status: 'failed', rawStatus: 'failed' },
      ]);
      expect(run.report.summary.failedSessions).toBe(1);
      expect(run.sessions[0]?.payload).toMatchObject({
        producer: { name: 'qe-report-playwright' },
        runner: { name: 'playwright' },
        labels: { 'playwright.workers': '2' },
      });
      expect(run.sessions[0]?.payload.runner?.version).toMatch(/^1\.\d+\.\d+$/u);
      expect(Object.keys(run.sessions[0]?.payload.environment ?? {})).toEqual(['node.version']);
    });

    it('keeps retries under one execution id with attempt numbers from the retry index', () => {
      const flaky = attemptsNamed(run, 'flaky passes on retry', 'desktop');
      expect(flaky.map((a) => a.started.payload.attemptNumber)).toEqual([1, 2]);
      expect(flaky.map((a) => a.finished.payload.status)).toEqual(['failed', 'passed']);
      expect(new Set(flaky.map((a) => a.started.payload.test.executionId)).size).toBe(1);
      expect(new Set(flaky.map((a) => a.started.payload.test.historicalId)).size).toBe(1);
      const exhausted = attemptsNamed(run, 'fails on every attempt', 'desktop');
      expect(exhausted.map((a) => a.finished.payload.status)).toEqual(['failed', 'failed']);
      expect(attemptsNamed(run, 'passes on the first attempt', 'desktop')).toHaveLength(1);
    });

    it('maps statuses and the authored expectations', () => {
      expect(one(run, 'skipped by the author').finished.payload).toMatchObject({
        status: 'skipped',
        rawStatus: 'skipped',
        expectedStatus: 'skipped',
      });
      expect(one(run, 'marked fixme').finished.payload).toMatchObject({
        status: 'skipped',
        expectedStatus: 'skipped',
      });
      expect(one(run, 'expected to fail and fails').finished.payload).toMatchObject({
        status: 'failed',
        expectedStatus: 'failed',
      });
      const unexpectedPass = attemptsNamed(run, 'expected to fail but passes', 'desktop');
      expect(unexpectedPass, 'Playwright retries an unexpected pass').toHaveLength(2);
      for (const a of unexpectedPass)
        expect(a.finished.payload).toMatchObject({ status: 'passed', expectedStatus: 'failed' });
      expect(one(run, 'conditionally expected to fail').finished.payload).toMatchObject({
        status: 'failed',
        expectedStatus: 'failed',
      });
      const timedOut = attemptsNamed(run, 'times out', 'desktop');
      expect(timedOut.map((a) => a.finished.payload.rawStatus)).toEqual(['timedOut', 'timedOut']);
      expect(timedOut[0]?.finished.payload.status).toBe('failed');
      expect(timedOut[0]?.finished.payload.failures?.[0]?.message).toContain('Test timeout of');
      expect(one(run, 'passes with nested steps').finished.payload).toMatchObject({
        status: 'passed',
        expectedStatus: 'passed',
      });
    });

    it('attributes hook failures the way Playwright does, with a phase from the step tree', () => {
      for (const title of ['a never runs', 'b never runs']) {
        const a = attemptsNamed(run, title, 'desktop')[0];
        expect(a?.finished.payload.status).toBe('failed');
        expect(a?.finished.payload.failures?.[0]).toMatchObject({
          message: 'Error: beforeAll broke',
          type: 'Error',
          phase: 'setup',
        });
      }
      expect(
        attemptsNamed(run, 'body skipped', 'desktop')[0]?.finished.payload.failures?.[0],
      ).toMatchObject({ message: 'Error: beforeEach broke', phase: 'setup' });
      expect(
        attemptsNamed(run, 'body passed', 'desktop')[0]?.finished.payload.failures?.[0],
      ).toMatchObject({ message: 'Error: afterEach broke', phase: 'teardown' });
      for (const title of ['first passes', 'second passes']) {
        const a = attemptsNamed(run, title, 'desktop')[0];
        expect(a?.finished.payload.status).toBe('failed');
        expect(a?.finished.payload.failures?.[0]).toMatchObject({
          message: 'Error: afterAll broke',
          phase: 'teardown',
        });
      }
      expect(run.events.some((e) => e.eventType === 'scope.failed')).toBe(false);
    });

    it('builds path, identity, tags, and annotations from the Playwright hierarchy', () => {
      const desktop = one(run, 'passes with nested steps', 'desktop');
      const mobile = one(run, 'passes with nested steps', 'mobile');
      expect(pathOf(desktop)).toBe('project:desktop/file:pass.spec.ts/group:outer/group:inner');
      expect(pathOf(mobile)).toBe('project:mobile/file:pass.spec.ts/group:outer/group:inner');
      expect(desktop.started.payload.test.executionId).not.toBe(
        mobile.started.payload.test.executionId,
      );
      expect(desktop.started.payload.test.historicalId).not.toBe(
        mobile.started.payload.test.historicalId,
      );
      expect(desktop.started.payload.test).toMatchObject({
        historicalIdStability: 'stable',
        displayName: 'passes with nested steps',
        location: { file: 'pass.spec.ts' },
        tags: ['@smoke', '@fast'],
        labels: { 'annotation.issue': 'QE-3' },
      });
      expect(desktop.started.payload.test.executionId).toMatch(/^[0-9a-f]{20}-[0-9a-f]{20}$/u);
      expect(JSON.stringify(run.events)).not.toContain(FIXTURE);
      expect(JSON.stringify(run.events)).not.toContain(dirname(dirname(dirname(FIXTURE))));
    });

    it('streams nested steps with parents, kinds, and step-level failures', () => {
      const a = one(run, 'passes with nested steps');
      const named = (n: string) => a.steps.find((s) => s.started.payload.name === n);
      const outer = named('outer step');
      const inner = named('inner step');
      expect(outer?.started.payload.kind).toBe('test.step');
      expect(inner?.started.payload.parentStepId).toBe(outer?.started.payload.stepId);
      expect(inner?.finished.payload.status).toBe('passed');
      const expectStep = a.steps.find((s) => s.started.payload.kind === 'expect');
      expect(expectStep?.started.payload.parentStepId).toBe(inner?.started.payload.stepId);
      const hooks = a.steps.filter(
        (s) => s.started.payload.kind === 'hook' && !s.started.payload.parentStepId,
      );
      expect(hooks.map((s) => s.started.payload.name)).toContain('Before Hooks');
      const failing = attemptsNamed(run, 'assertion fails inside a step', 'desktop')[0];
      const failedStep = failing?.steps.find((s) => s.started.payload.name === 'failing step');
      expect(failedStep?.finished.payload.status).toBe('failed');
      expect(failedStep?.finished.payload.failures?.[0]?.phase).toBe('test');
      expect(failing?.finished.payload.failures?.[0]?.phase).toBe('test');
      for (const attempt of run.attempts) {
        const finishedAt = attempt.finished.sequence;
        for (const s of attempt.steps) expect(s.finished.sequence).toBeLessThan(finishedAt);
      }
    });

    it('stores body and file attachments before the attempt finishes, redacted when textual', () => {
      const a = one(run, 'attaches bodies and a file');
      const names = a.attachments.map((x) => x.payload.name).sort();
      expect(names).toEqual(['data', 'log', 'note', 'shot']);
      for (const x of a.attachments) {
        expect(x.sequence).toBeLessThan(a.finished.sequence);
        const bytes = storedAttachment(run, x);
        expect(bytes.length).toBe(x.payload.sizeBytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(x.payload.sha256);
      }
      expect(readText(run, a, 'note')).toBe('user note with token=[REDACTED]');
      expect(readText(run, a, 'data')).toContain('"password":"[REDACTED]"');
      expect(readText(run, a, 'log')).toBe('Authorization: [REDACTED]\nline two\n');
      expect(a.attachments.find((x) => x.payload.name === 'shot')?.payload.mediaType).toBe(
        'image/png',
      );
      const inStep = one(run, 'attaches inside a step');
      const att = inStep.attachments.find((x) => x.payload.name === 'in-step');
      expect(att?.payload.stepId).toBeDefined();
      const owner = inStep.steps.find((s) => s.started.payload.stepId === att?.payload.stepId);
      expect(owner?.started.payload.kind).toBe('test.attach');
      expect(owner?.started.payload.parentStepId).toBe(
        inStep.steps.find((s) => s.started.payload.name === 'step with attachment')?.started.payload
          .stepId,
      );
    });

    it('keeps Playwright traces, screenshots, and videos as opaque attachments', () => {
      const failing = attemptsNamed(run, 'assertion fails inside a step', 'desktop')[0];
      const byName = new Map(failing?.attachments.map((x) => [x.payload.name, x.payload]));
      expect(byName.get('trace')?.mediaType).toBe('application/zip');
      expect(byName.get('screenshot')?.mediaType).toBe('image/png');
      expect(byName.get('video')?.mediaType).toBe('video/webm');
      expect(byName.get('error-context')?.mediaType).toBe('text/markdown');
      const trace = failing?.attachments.find((x) => x.payload.name === 'trace');
      expect(trace).toBeDefined();
      if (trace) expect(storedAttachment(run, trace).subarray(0, 2).toString('latin1')).toBe('PK');
      expect(Object.values(Object.fromEntries(byName)).every((p) => p.sizeBytes > 0)).toBe(true);
      const plain = attemptsNamed(run, 'throws a plain error', 'desktop')[0];
      expect(plain?.finished.payload.failures?.[0]).toMatchObject({
        message: 'TypeError: plain error with password=[REDACTED]',
        type: 'TypeError',
      });
      expect(plain?.finished.payload.failures?.[0]?.stackTrace).toContain('at fail.spec.ts:');
    });

    it('keeps one session while workers restart after failures', () => {
      const workers = new Set(
        run.attempts.map((a) => a.started.payload.test.labels?.['playwright.workerIndex']),
      );
      expect(workers.size).toBeGreaterThan(2);
      expect(run.report.summary.sessions).toBe(1);
    });
  });

  it('numbers exhausted retries from one and keeps the execution id', async () => {
    const run = await runPlaywright({
      runId: 'run-retries',
      env: { PW_RETRIES: '2' },
      args: ['retry.spec.ts', '--project', 'desktop'],
    });
    noErrors(run);
    const exhausted = attemptsNamed(run, 'fails on every attempt', 'desktop');
    expect(exhausted.map((a) => a.started.payload.attemptNumber)).toEqual([1, 2, 3]);
    expect(new Set(exhausted.map((a) => a.started.payload.test.executionId)).size).toBe(1);
    expect(attemptsNamed(run, 'flaky passes on retry', 'desktop')).toHaveLength(2);
    expect(run.report.summary.verdict).toBe('failed');
    expect(run.playwright?.status).toBe('failed');
  });

  it('treats repeat-each as separate executions of one authored test', async () => {
    const run = await runPlaywright({
      runId: 'run-repeat',
      env: { PW_REPEAT_EACH: '2' },
      args: ['pass.spec.ts'],
    });
    noErrors(run);
    expect(run.report.summary).toMatchObject({ attempts: 12, verdict: 'passed' });
    expect(run.finished.map((e) => e.payload)).toEqual([{ status: 'passed', rawStatus: 'passed' }]);
    expect(run.attempts.every((a) => a.started.payload.attemptNumber === 1)).toBe(true);
    expect(new Set(run.attempts.map((a) => a.started.payload.test.executionId)).size).toBe(12);
    expect(new Set(run.attempts.map((a) => a.started.payload.test.historicalId)).size).toBe(6);
    expect(run.playwright?.status).toBe('passed');
  });

  it('runs shards as sessions of one run without run.finished', async () => {
    const outputRoot = freshDir('shards');
    const first = await runPlaywright({ outputRoot, runId: 'run-shards', args: ['--shard=1/2'] });
    const second = await runPlaywright({ outputRoot, runId: 'run-shards', args: ['--shard=2/2'] });
    noErrors(second);
    expect(readdirSync(join(second.runDir, 'events'))).toHaveLength(2);
    expect(second.runDirs).toEqual([second.runDir]);
    expect(second.report.summary).toMatchObject({
      sessions: 2,
      files: 2,
      attempts: 40,
      complete: true,
      closed: false,
      verdict: 'failed',
    });
    expect(second.events.some((e) => e.eventType === 'run.finished')).toBe(false);
    expect(second.sessions.map((s) => s.payload.labels?.['playwright.shard']).sort()).toEqual([
      '1/2',
      '2/2',
    ]);
    expect(new Set(second.attempts.map((a) => a.started.payload.test.executionId)).size).toBe(40);
    for (const a of second.attempts) expect(a.finished.sessionId).toBe(a.started.sessionId);
    expect(first.report.summary.sessions).toBe(1);
    expect(second.finished.map((e) => e.payload.status)).toEqual(['failed', 'failed']);
    expect(second.report.summary.failedSessions).toBe(2);
  });

  it('derives a passed run from shards that all passed', async () => {
    const outputRoot = freshDir('shards-passed');
    await runPlaywright({
      outputRoot,
      runId: 'run-shards-passed',
      args: ['pass.spec.ts', '--shard=1/2'],
    });
    const run = await runPlaywright({
      outputRoot,
      runId: 'run-shards-passed',
      args: ['pass.spec.ts', '--shard=2/2'],
    });
    noErrors(run);
    expect(run.finished.map((e) => e.payload)).toEqual([
      { status: 'passed', rawStatus: 'passed' },
      { status: 'passed', rawStatus: 'passed' },
    ]);
    expect(run.report.summary).toMatchObject({ sessions: 2, closed: false, verdict: 'passed' });
  });

  it('derives an inconclusive run from an interrupted shard beside a passed one', async () => {
    const outputRoot = freshDir('shards-mixed');
    const interrupted = await runPlaywright({
      config: 'configs/slow.config.ts',
      outputRoot,
      runId: 'run-shards-mixed',
      args: ['--shard=1/2'],
      interruptWhenStarted: true,
    });
    expect(interrupted.playwright?.status).toBe('interrupted');
    const run = await runPlaywright({
      config: 'configs/slow.config.ts',
      outputRoot,
      runId: 'run-shards-mixed',
      args: ['--shard=2/2'],
    });
    noErrors(run);
    expect(run.finished.map((e) => e.payload.status).sort()).toEqual(['inconclusive', 'passed']);
    expect(run.report.summary).toMatchObject({
      sessions: 2,
      complete: true,
      inconclusiveSessions: 1,
      failedSessions: 0,
      verdict: 'inconclusive',
    });
  });

  it('lets reporter options win over the environment', async () => {
    const optionsDir = freshDir('options');
    const run = await runPlaywright({
      config: 'configs/options.config.ts',
      runId: 'run-from-env',
      env: { OPTIONS_DIR: optionsDir, QE_REPORT_SESSION_ID: 'session-from-env' },
      args: ['pass.spec.ts'],
    });
    expect(run.runDirs).toEqual([]);
    const optionsRun = resolveRunDirectory(optionsDir, 'run-from-options');
    const files = readdirSync(join(optionsRun, 'events'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^session-from-options-/u);
    const rerun = await runPlaywright({
      config: 'configs/options.config.ts',
      env: { OPTIONS_DIR: optionsDir },
      args: ['pass.spec.ts', '-g', 'nested'],
    });
    expect(rerun.diagnostics.join('\n')).toContain('EEXIST');
  });

  it('keeps two sequential default invocations in two run directories under one root', async () => {
    const outputRoot = freshDir('sequential');
    const first = await runPlaywright({
      outputRoot,
      args: ['pass.spec.ts', '--project', 'desktop'],
    });
    const second = await runPlaywright({
      outputRoot,
      args: ['pass.spec.ts', '--project', 'desktop'],
    });
    expect(first.runDirs).toHaveLength(1);
    expect(second.runDirs).toHaveLength(2);
    const runIds = new Set<string>();
    for (const dir of second.runDirs) {
      const report = await validateRunDirectory(dir, { requireComplete: true });
      expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(report.summary).toMatchObject({
        sessions: 1,
        attempts: 3,
        closed: true,
        verdict: 'passed',
      });
      const files = readdirSync(join(dir, 'events'));
      expect(files).toHaveLength(1);
      const line = readFileSync(join(dir, 'events', files[0] ?? ''), 'utf8').split('\n')[0] ?? '';
      const runId = parseEvent(line).runId;
      expect(dir).toBe(resolveRunDirectory(outputRoot, runId));
      runIds.add(runId);
    }
    expect(runIds.size).toBe(2);
  });

  it('writes nothing when disabled', async () => {
    const run = await runPlaywright({
      env: { QE_REPORT_ENABLED: 'false' },
      args: ['pass.spec.ts'],
    });
    expect(run.exitCode).toBe(0);
    expect(existsSync(run.outputRoot)).toBe(false);
    expect(run.diagnostics).toEqual([]);
  });

  describe('run verdict against Playwright status', () => {
    it('a flaky test that finally passes is a passed run for both', async () => {
      const run = await runPlaywright({
        env: { PW_RETRIES: '1' },
        args: ['-g', 'flaky passes on retry'],
      });
      noErrors(run);
      expect(run.report.summary).toMatchObject({
        failedAttempts: 2,
        verdict: 'passed',
        closed: true,
      });
      expect(run.finished[0]?.payload).toEqual({ status: 'passed', rawStatus: 'passed' });
      expect(run.playwright?.status).toBe('passed');
      expect(run.exitCode).toBe(0);
    });

    it('a flaky test under failOnFlakyTests fails the session, and so the run, without any failure object', async () => {
      const run = await runPlaywright({
        config: 'configs/fail-on-flaky.config.ts',
        args: ['-g', 'flaky passes on retry'],
      });
      noErrors(run);
      const attempts = attemptsNamed(run, 'flaky passes on retry', 'desktop');
      expect(attempts.map((a) => a.finished.payload.status)).toEqual(['failed', 'passed']);
      expect(run.finished[0]?.payload).toEqual({ status: 'failed', rawStatus: 'failed' });
      expect(run.report.summary).toMatchObject({
        failedAttempts: 1,
        scopeFailures: 0,
        failedSessions: 1,
        sessionFailures: 0,
        verdict: 'failed',
      });
      expect(run.playwright?.status).toBe('failed');
      expect(run.exitCode).toBe(1);
    });

    it('expected failures only pass for both', async () => {
      const run = await runPlaywright({ args: ['-g', 'expected to fail and fails|conditionally'] });
      noErrors(run);
      expect(run.report.summary.verdict).toBe('passed');
      expect(run.playwright?.status).toBe('passed');
    });

    it('all tests skipped pass for both', async () => {
      const run = await runPlaywright({ args: ['-g', 'skipped by the author|marked fixme'] });
      noErrors(run);
      expect(run.report.summary).toMatchObject({ attempts: 4, verdict: 'passed' });
      expect(run.playwright?.status).toBe('passed');
    });

    it('an unhandled error in a worker is attributed to the running test by Playwright', async () => {
      const run = await runPlaywright({ config: 'configs/worker-error.config.ts' });
      noErrors(run);
      const a = one(run, 'leaves an unhandled error behind');
      expect(a.finished.payload.status).toBe('failed');
      expect(a.finished.payload.failures?.[0]?.message).toContain(
        'unhandled error outside the test body',
      );
      expect(one(run, 'runs after the error').finished.payload.status).toBe('passed');
      expect(run.report.summary.verdict).toBe('failed');
      expect(run.finished[0]?.payload).toEqual({ status: 'failed', rawStatus: 'failed' });
      expect(run.playwright).toEqual({ status: 'failed', errors: [] });
    });

    /**
     * Invocation-level outcomes: Playwright's aggregate status is the session outcome, so the
     * derived verdict agrees with Playwright without any invented attempt or scope.
     */
    it('global setup failure: a failed session with a setup failure and no attempt', async () => {
      const run = await runPlaywright({ config: 'configs/global-setup-fails.config.ts' });
      noErrors(run);
      expect(run.exitCode).toBe(1);
      expect(run.playwright).toEqual({ status: 'failed', errors: ['Error: global setup broke'] });
      expect(run.finished[0]?.payload).toMatchObject({
        status: 'failed',
        rawStatus: 'failed',
        failures: [{ message: 'Error: global setup broke', phase: 'setup' }],
      });
      expect(run.finished[0]?.payload.failures?.[0]?.location).toEqual({
        file: 'setup-fails.ts',
        line: 2,
        column: 9,
      });
      expect(run.report.summary).toMatchObject({
        attempts: 0,
        scopeFailures: 0,
        failedSessions: 1,
        sessionFailures: 1,
        complete: true,
        closed: true,
        verdict: 'failed',
      });
      expect(run.events.some((e) => e.eventType === 'scope.failed')).toBe(false);
    });

    it('global teardown failure: the passed attempt keeps its verdict, the session fails', async () => {
      const run = await runPlaywright({ config: 'configs/global-teardown-fails.config.ts' });
      noErrors(run);
      expect(run.playwright).toEqual({
        status: 'failed',
        errors: ['Error: global teardown broke'],
      });
      expect(one(run, 'passes').finished.payload.status).toBe('passed');
      expect(run.finished[0]?.payload).toMatchObject({
        status: 'failed',
        rawStatus: 'failed',
        failures: [{ message: 'Error: global teardown broke', phase: 'teardown' }],
      });
      expect(run.report.summary).toMatchObject({
        attempts: 1,
        failedAttempts: 0,
        failedSessions: 1,
        sessionFailures: 1,
        verdict: 'failed',
      });
    });

    it('global timeout: a failed session with the raw word timedout outranks the inconclusive attempt', async () => {
      const run = await runPlaywright({ config: 'configs/global-timeout.config.ts' });
      noErrors(run);
      expect(run.playwright?.status).toBe('timedout');
      expect(
        run.attempts.map((a) => [a.finished.payload.status, a.finished.payload.rawStatus]),
      ).toEqual([['inconclusive', 'unfinished']]);
      expect(run.finished[0]?.payload).toEqual({ status: 'failed', rawStatus: 'timedout' });
      expect(run.report.summary).toMatchObject({
        complete: true,
        failedSessions: 1,
        verdict: 'failed',
      });
    });

    it('interruption: an inconclusive session and an inconclusive run, not a passed or incomplete one', async () => {
      const run = await runPlaywright({
        config: 'configs/slow.config.ts',
        interruptWhenStarted: true,
      });
      noErrors(run);
      expect(run.playwright?.status).toBe('interrupted');
      expect(
        run.attempts.map((a) => [a.finished.payload.status, a.finished.payload.rawStatus]),
      ).toEqual([['inconclusive', 'interrupted']]);
      expect(run.finished[0]?.payload).toEqual({
        status: 'inconclusive',
        rawStatus: 'interrupted',
      });
      expect(run.report.summary).toMatchObject({
        complete: true,
        closed: true,
        inconclusiveSessions: 1,
        verdict: 'inconclusive',
      });
    });

    it('spec load error: the file is a scope that failed in set-up, and both verdicts agree', async () => {
      const run = await runPlaywright({ config: 'configs/load-error.config.ts' });
      noErrors(run);
      expect(run.playwright?.status).toBe('failed');
      expect(run.playwright?.errors[0]).toContain('SyntaxError');
      const scopes = run.events.filter((e) => e.eventType === 'scope.failed');
      expect(scopes).toHaveLength(1);
      expect(scopes[0]?.payload).toMatchObject({
        path: [{ kind: 'file', name: 'broken.spec.ts' }],
        failures: [{ type: 'SyntaxError', phase: 'setup' }],
      });
      // Playwright aborts the invocation on a load error, so the other file never runs either.
      // The file scope carries the concrete failure; the session carries Playwright's verdict.
      expect(run.finished[0]?.payload).toEqual({ status: 'failed', rawStatus: 'failed' });
      expect(run.report.summary).toMatchObject({
        attempts: 0,
        scopeFailures: 1,
        failedSessions: 1,
        sessionFailures: 0,
        verdict: 'failed',
      });
      expect(run.diagnostics.join('\n')).toContain('recorded as a scope failure');
      expect(run.diagnostics.join('\n')).not.toContain(process.cwd());
    });
  });
});
