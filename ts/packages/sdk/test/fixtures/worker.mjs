// Spawned by multi-process.test.ts: one producer process writing one session into a shared run directory.
import { FileSink, ReportSession } from '../../dist/index.js';
const [runDir, sessionId, rounds] = process.argv.slice(2);
const shared = Buffer.alloc(512 * 1024, 42);
const session = ReportSession.start(
  {
    runId: 'run-mp',
    sessionId,
    sink: FileSink.open(runDir, sessionId),
    onProblem: (p) => {
      process.stderr.write(JSON.stringify(p) + '\n');
      process.exitCode = 3;
    },
  },
  { producer: { name: 'worker', version: '0' }, runner: { name: 'fixture-runner' } },
);
for (let i = 0; i < Number(rounds); i++) {
  const attemptId = `${sessionId}-a-${i}`;
  session.emit({
    eventType: 'attempt.started',
    payload: {
      attemptId,
      attemptNumber: 1,
      test: {
        executionId: `${sessionId}-t-${i}`,
        historicalId: `suite::t-${i}`,
        historicalIdStability: 'stable',
        displayName: `test ${i}`,
        path: [],
      },
    },
  });
  session.attach({ attemptId, name: 'shared', mediaType: 'application/octet-stream' }, shared);
  session.attach(
    { attemptId, name: 'own', mediaType: 'text/plain' },
    Buffer.from(`${sessionId} round ${i} password=x\n`),
  );
  session.emit({ eventType: 'attempt.finished', payload: { attemptId, status: 'passed' } });
}
session.close();
