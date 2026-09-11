import { FileSink, ReportSession, Redactor, captureEnvironment } from 'qe-report-sdk';

/** A clock that advances one second per reading, starting at 2026-01-01T00:00:00Z. */
export function tickingClock(): () => Date {
  let t = Date.UTC(2026, 0, 1, 0, 0, 0);
  return () => {
    const now = new Date(t);
    t += 1000;
    return now;
  };
}

export function counter(): () => string {
  let n = 0;
  return () => `evt-${String(++n).padStart(4, '0')}`;
}

/** The same program as java/sdk/src/test/java/.../EquivalenceHarness.java#scripted. */
export function scripted(out: string): void {
  const redactor = Redactor.create({ sensitiveKeys: ['otp'] });
  const fakeEnv = {
    CI: 'true',
    SECRET_TOKEN: 'Bearer abc.def.ghi',
    DB_URL: 'postgres://user:pw@host/db',
    HOME: '/home/nobody',
  };
  const s = ReportSession.start(
    {
      runId: 'run-eq-0001',
      sessionId: 'session-eq-1',
      sink: FileSink.open(out),
      clock: tickingClock(),
      ids: counter(),
      redactor,
    },
    {
      producer: { name: 'equivalence-harness', version: '0.1.0' },
      runner: { name: 'scripted', version: '1' },
      environment: captureEnvironment(
        ['CI', 'SECRET_TOKEN', 'DB_URL', 'MISSING'],
        redactor,
        fakeEnv,
      ),
      executor: { name: 'local', buildId: '1' },
      source: {
        repository: 'https://example.invalid/r.git',
        revision: 'abc123',
        branch: 'develop',
      },
      labels: { team: 'qa' },
    },
  );
  const t1 = {
    executionId: 't-1',
    historicalId: 'spec.ts::group::first',
    historicalIdStability: 'stable' as const,
    displayName: 'first test password=inname',
    path: [
      { kind: 'project', name: 'desktop' },
      { kind: 'file', name: 'spec.ts' },
      { kind: 'group', name: 'group' },
    ],
    location: { file: 'spec.ts', line: 3, column: 1 },
    tags: ['@smoke', 'token=tag'],
    labels: { issue: 'QE-1' },
  };
  s.emit({
    eventType: 'attempt.started',
    payload: { attemptId: 'a-1', attemptNumber: 1, test: t1 },
  });
  s.emit({
    eventType: 'step.started',
    payload: {
      stepId: 'st-1',
      attemptId: 'a-1',
      name: 'outer secret: value',
      kind: 'test.step',
      location: { file: 'spec.ts', line: 4 },
    },
  });
  s.emit({
    eventType: 'step.started',
    payload: {
      stepId: 'st-2',
      attemptId: 'a-1',
      parentStepId: 'st-1',
      name: 'inner',
      kind: 'expect',
    },
  });
  s.attach(
    { attemptId: 'a-1', stepId: 'st-2', name: 'log', mediaType: 'text/plain' },
    Buffer.from('Authorization: Bearer xyz\npassword=hunter2\notp=1234\n'),
  );
  s.attach(
    { attemptId: 'a-1', name: 'body', mediaType: 'application/json; charset=utf-8' },
    Buffer.from('{"token":"t1","ok":true}'),
  );
  const binary = new Uint8Array(256);
  for (let i = 0; i < 256; i++) binary[i] = i;
  s.attach({ attemptId: 'a-1', name: '../../evil.png', mediaType: 'image/png' }, binary);
  s.emit({
    eventType: 'step.finished',
    payload: {
      stepId: 'st-2',
      attemptId: 'a-1',
      status: 'failed',
      rawStatus: 'failed',
      durationMs: 3,
      failures: [{ message: 'expect failed token=abc' }],
    },
  });
  s.emit({
    eventType: 'step.finished',
    payload: { stepId: 'st-1', attemptId: 'a-1', status: 'failed', durationMs: 7 },
  });
  s.emit({
    eventType: 'attempt.finished',
    payload: {
      attemptId: 'a-1',
      status: 'failed',
      rawStatus: 'failed',
      durationMs: 42,
      failures: [
        {
          message: 'token=abc',
          type: 'AssertionError',
          stackTrace: 'at spec.ts:5 password=x',
          phase: 'test',
          location: { file: 'spec.ts', line: 5, column: 9 },
        },
      ],
    },
  });
  s.emit({
    eventType: 'attempt.started',
    payload: { attemptId: 'a-2', attemptNumber: 2, test: t1 },
  });
  s.emit({
    eventType: 'attempt.finished',
    payload: {
      attemptId: 'a-2',
      status: 'passed',
      rawStatus: 'passed',
      expectedStatus: 'failed',
      durationMs: 1,
    },
  });
  const t2 = {
    executionId: 't-2',
    historicalIdStability: 'unavailable' as const,
    displayName: 'dynamic #1',
    path: [{ kind: 'file', name: 'spec.ts' }],
  };
  s.emit({
    eventType: 'attempt.started',
    payload: { attemptId: 'a-3', attemptNumber: 1, test: t2 },
  });
  s.emit({
    eventType: 'attempt.finished',
    payload: {
      attemptId: 'a-3',
      status: 'skipped',
      rawStatus: 'aborted',
      failures: [{ message: 'assumption' }],
    },
  });
  s.finishRun();
  s.close();
}
