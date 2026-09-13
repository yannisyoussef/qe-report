import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadModel, buildReadModel, projectRunDirectory } from '../src/index.js';
import type { ProjectedRun } from '../src/index.js';
import {
  attachment,
  attemptFinished,
  attemptStarted,
  execution,
  finished,
  freshRoot,
  simpleRun,
  started,
  testCase,
  writeRun,
} from './synthetic.js';

const PW = 'playwright';
const JU = 'junit-platform';

describe('project and run keys', () => {
  it('keeps the same run id apart in two projects', async () => {
    const root = freshRoot();
    const dir = simpleRun(root, 'r', 'run-1', PW, execution(testCase('e', 'h'), [['passed']]));
    const { model, problems } = await buildReadModel([
      { projectId: 'A', runDirectory: dir },
      { projectId: 'B', runDirectory: dir },
    ]);
    expect(problems).toEqual([]);
    expect(model.runs().map((r) => [r.projectId, r.runId])).toEqual([
      ['A', 'run-1'],
      ['B', 'run-1'],
    ]);
    expect(model.getRun('A', 'run-1')).not.toBe(model.getRun('B', 'run-1'));
    expect(model.getRun('C', 'run-1')).toBeUndefined();
    expect(model.getTestHistory('A', PW, 'h').occurrences).toHaveLength(1);
    expect(model.getTestHistory('B', PW, 'h').occurrences).toHaveLength(1);
    expect(model.getTestHistory('C', PW, 'h').occurrences).toHaveLength(0);
  });

  it('refuses an empty project id as a caller error, never as a run fact', async () => {
    const root = freshRoot();
    const dir = simpleRun(root, 'r', 'run-1', PW, execution(testCase('e', 'h'), [['passed']]));
    await expect(projectRunDirectory({ projectId: '', runDirectory: dir })).rejects.toThrow(
      TypeError,
    );
    const { model } = await buildReadModel([{ projectId: 'A', runDirectory: dir }]);
    expect(() => model.getRun('', 'run-1')).toThrow(TypeError);
  });

  it('never derives the project or the run from the directory name', async () => {
    const root = freshRoot();
    const dir = simpleRun(
      root,
      'project-x-run-999',
      'run-1',
      PW,
      execution(testCase('e', 'h'), [['passed']]),
    );
    const { model } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(model.getRun('A', 'run-1')?.runDirectory).toBe(dir);
    expect(model.getRun('A', 'run-999')).toBeUndefined();
    expect(model.getRun('project-x', 'run-1')).toBeUndefined();
  });

  it('reports the same run key from two run directories as a conflict and keeps neither', async () => {
    const root = freshRoot();
    const body = execution(testCase('e', 'h'), [['passed']]);
    const first = simpleRun(root, 'first', 'run-1', PW, body);
    const second = simpleRun(root, 'second', 'run-1', PW, body);
    const other = simpleRun(root, 'other', 'run-2', PW, body);
    const { model, problems } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(model.runs().map((r) => r.runId)).toEqual(['run-2']);
    expect(problems.map((p) => [p.code, p.runId, p.runDirectory])).toEqual([
      ['DUPLICATE_RUN', 'run-1', first],
      ['DUPLICATE_RUN', 'run-1', second],
    ]);
    expect(problems[0]?.message).toContain(second);
    expect(model.getTestHistory('A', PW, 'h').occurrences.map((o) => o.runId)).toEqual(['run-2']);
    expect(model.getRun('A', 'run-2')?.runDirectory).toBe(other);
  });

  it('treats one run directory listed twice as one run, not a conflict', async () => {
    const root = freshRoot();
    const dir = simpleRun(root, 'r', 'run-1', PW, execution(testCase('e', 'h'), [['passed']]));
    const { model, problems } = await buildReadModel([
      { projectId: 'A', runDirectory: dir },
      { projectId: 'A', outputRoot: root },
    ]);
    expect(problems).toEqual([]);
    expect(model.runs().map((r) => r.runId)).toEqual(['run-1']);
    expect(model.getTestHistory('A', PW, 'h').occurrences).toHaveLength(1);
  });

  it('ingests the valid runs of a root and rejects the invalid one whole', async () => {
    const root = freshRoot();
    simpleRun(root, 'good', 'run-1', PW, execution(testCase('e', 'h'), [['passed']]));
    writeRun(root, 'bad', 'run-2', [
      {
        sessionId: 's',
        events: [
          started(PW),
          ...execution(testCase('e', 'h'), [['passed']]),
          finished(),
          finished(),
        ],
      },
    ]);
    const { model, problems } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(model.runs().map((r) => r.runId)).toEqual(['run-1']);
    expect(problems.map((p) => [p.code, p.projectId, p.runId])).toEqual([
      ['RUN_INVALID', 'A', 'run-2'],
    ]);
    expect(problems[0]?.diagnostics.map((d) => d.detail)).toEqual(['SESSION_ALREADY_FINISHED']);
    expect(model.getTestHistory('A', PW, 'h').occurrences.map((o) => o.runId)).toEqual(['run-1']);
  });
});

describe('history key', () => {
  it('is project, runner name, and historical id: runners never share history', async () => {
    const root = freshRoot();
    simpleRun(root, 'j', 'run-j', JU, execution(testCase('e', 'same-id'), [['passed']]));
    simpleRun(root, 'p', 'run-p', PW, execution(testCase('e', 'same-id'), [['failed']]));
    const { model } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(model.getTestHistory('A', JU, 'same-id').occurrences.map((o) => o.finalStatus)).toEqual([
      'passed',
    ]);
    expect(model.getTestHistory('A', PW, 'same-id').occurrences.map((o) => o.finalStatus)).toEqual([
      'failed',
    ]);
  });

  it('does not include the producer: replacing the adapter keeps the history', async () => {
    const root = freshRoot();
    const body = execution(testCase('e', 'h'), [['passed']]);
    simpleRun(root, 'old', 'run-1', PW, body, {}, { producer: 'old-adapter' });
    simpleRun(root, 'new', 'run-2', PW, body, {}, { producer: 'new-adapter' });
    const { model } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(model.getTestHistory('A', PW, 'h').occurrences.map((o) => o.runId)).toEqual([
      'run-1',
      'run-2',
    ]);
  });

  it('keeps repeat-each executions of one test as separate occurrences in one run', async () => {
    const root = freshRoot();
    simpleRun(root, 'r', 'run-1', PW, [
      ...execution(testCase('e-1', 'h'), [['passed']]),
      ...execution(testCase('e-2', 'h'), [['failed'], ['passed']]),
    ]);
    const { model } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    const history = model.getTestHistory('A', PW, 'h');
    expect(history.occurrences.map((o) => [o.executionId, o.attemptCount, o.flaky])).toEqual([
      ['e-1', 1, false],
      ['e-2', 2, true],
    ]);
  });

  it('does not index an execution without a historical id, and keeps uncertain stability as such', async () => {
    const root = freshRoot();
    simpleRun(root, 'r', 'run-1', PW, [
      ...execution(testCase('anon', undefined), [['passed']]),
      ...execution(testCase('maybe', 'h', 'uncertain'), [['passed']]),
    ]);
    const { model } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    const run = model.getRun('A', 'run-1');
    expect(run?.executions.map((e) => e.executionId)).toEqual(['anon', 'maybe']);
    const history = model.getTestHistory('A', PW, 'h');
    expect(history.occurrences.map((o) => [o.executionId, o.historicalIdStability])).toEqual([
      ['maybe', 'uncertain'],
    ]);
  });

  it('orders occurrences by producer instant, then run id, then execution id', async () => {
    const root = freshRoot();
    const body = execution(testCase('e', 'h'), [['passed']]);
    simpleRun(root, 'a', 'run-b', PW, body, {}, { startAt: '2026-09-12T12:00:00.000+02:00' });
    simpleRun(root, 'b', 'run-a', PW, body, {}, { startAt: '2026-09-12T10:00:00.000+00:00' });
    simpleRun(root, 'c', 'run-c', PW, body, {}, { startAt: '2026-09-12T09:00:00.000+00:00' });
    // Same instant as run-a and run-b, written in an offset whose text sorts first.
    simpleRun(root, 'e', 'run-z', PW, body, {}, { startAt: '2026-09-12T05:00:00.000-05:00' });
    // Text sorts before run-c but the instant is later.
    simpleRun(root, 'f', 'run-y', PW, body, {}, { startAt: '2026-09-12T08:30:00.000-03:00' });
    const at = '2026-09-12T11:00:00.000+00:00';
    simpleRun(
      root,
      'd',
      'run-d',
      PW,
      [
        { ...attemptStarted('a2', 1, testCase('e-2', 'h')), at },
        { ...attemptStarted('a1', 1, testCase('e-1', 'h')), at },
        attemptFinished('a2', 'passed'),
        attemptFinished('a1', 'passed'),
      ],
      {},
      { startAt: at },
    );
    const { model } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(
      model.getTestHistory('A', PW, 'h').occurrences.map((o) => `${o.runId}/${o.executionId}`),
    ).toEqual(['run-c/e', 'run-a/e', 'run-b/e', 'run-z/e', 'run-d/e-1', 'run-d/e-2', 'run-y/e']);
    const written = readFileSync(join(root, 'runs', 'e', 'events', 's-1.ndjson'), 'utf8');
    expect(written).toContain('"occurredAt":"2026-09-12T05:00:00.000-05:00"');
  });

  it('carries the run and session context of each occurrence', async () => {
    const root = freshRoot();
    simpleRun(root, 'r', 'run-1', PW, execution(testCase('e', 'h'), [['failed'], ['passed']]), {
      status: 'failed',
      rawStatus: 'failed',
    });
    const { model } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(model.getTestHistory('A', PW, 'h').occurrences[0]).toMatchObject({
      runId: 'run-1',
      sessionIds: ['s-1'],
      finalStatus: 'passed',
      flaky: true,
      runVerdict: 'failed',
      runComplete: true,
      sessionStatus: 'failed',
    });
  });
});

describe('flakiness', () => {
  async function flakyOf(
    attempts: readonly (readonly [string, Record<string, unknown>?])[],
    unfinishedLast = false,
  ): Promise<[boolean, string | undefined]> {
    const root = freshRoot();
    const body = execution(testCase('e', 'h'), attempts, { unfinishedLast });
    // An unfinished attempt keeps its session open: a valid, incomplete run.
    const dir = unfinishedLast
      ? writeRun(root, 'r', 'run-1', [{ sessionId: 's-1', events: [started(PW), ...body] }])
      : simpleRun(root, 'r', 'run-1', PW, body);
    const result = await projectRunDirectory({ projectId: 'A', runDirectory: dir });
    expect(result.kind).toBe('projected');
    if (result.kind !== 'projected') throw new Error('unreachable');
    const e = result.run.executions[0];
    expect(result.run.validator.complete).toBe(!unfinishedLast);
    return [e?.flaky ?? false, e?.finalStatus];
  }

  it('is a failed-then-passed retry sequence expecting to pass', async () => {
    expect(await flakyOf([['failed'], ['passed']])).toEqual([true, 'passed']);
    expect(await flakyOf([['failed'], ['failed'], ['passed']])).toEqual([true, 'passed']);
    expect(await flakyOf([['inconclusive'], ['failed'], ['passed']])).toEqual([true, 'passed']);
    expect(
      await flakyOf([
        ['failed', { expectedStatus: 'passed' }],
        ['passed', { expectedStatus: 'passed' }],
      ]),
    ).toEqual([true, 'passed']);
  });

  it('is not a single attempt, an exhausted retry, a skipped sequence, or an inconclusive-only sequence', async () => {
    expect(await flakyOf([['passed']])).toEqual([false, 'passed']);
    expect(await flakyOf([['failed']])).toEqual([false, 'failed']);
    expect(await flakyOf([['failed'], ['failed']])).toEqual([false, 'failed']);
    expect(await flakyOf([['skipped'], ['skipped']])).toEqual([false, 'skipped']);
    expect(await flakyOf([['inconclusive'], ['passed']])).toEqual([false, 'passed']);
    expect(await flakyOf([['inconclusive'], ['inconclusive']])).toEqual([false, 'inconclusive']);
  });

  it('is not an expected failure, an unexpected pass, or a retry that finally failed as expected', async () => {
    expect(await flakyOf([['failed', { expectedStatus: 'failed' }]])).toEqual([false, 'failed']);
    expect(await flakyOf([['passed', { expectedStatus: 'failed' }]])).toEqual([false, 'passed']);
    expect(await flakyOf([['failed'], ['passed', { expectedStatus: 'failed' }]])).toEqual([
      false,
      'passed',
    ]);
    expect(await flakyOf([['failed', { expectedStatus: 'failed' }], ['passed']])).toEqual([
      false,
      'passed',
    ]);
    expect(
      await flakyOf([
        ['passed', { expectedStatus: 'failed' }],
        ['failed', { expectedStatus: 'failed' }],
      ]),
    ).toEqual([false, 'failed']);
  });

  it('is never an unfinished execution', async () => {
    expect(await flakyOf([['failed'], ['passed']], true)).toEqual([false, undefined]);
    expect(await flakyOf([['failed'], ['failed'], ['passed']], true)).toEqual([false, undefined]);
  });

  it('is independent of the session policy that failed the run', async () => {
    const root = freshRoot();
    simpleRun(
      root,
      'p',
      'run-policy',
      PW,
      execution(testCase('e', 'h'), [['failed'], ['passed']]),
      {
        status: 'failed',
        rawStatus: 'failed',
      },
    );
    simpleRun(
      root,
      'n',
      'run-normal',
      PW,
      execution(testCase('e', 'h'), [['failed'], ['passed']]),
      {
        status: 'passed',
        rawStatus: 'passed',
      },
    );
    const { model } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    for (const [runId, verdict, status] of [
      ['run-policy', 'failed', 'failed'],
      ['run-normal', 'passed', 'passed'],
    ] as const) {
      const run = model.getRun('A', runId);
      expect(run?.executions[0]?.flaky, runId).toBe(true);
      expect(run?.sessions[0]?.status, runId).toBe(status);
      expect(run?.validator.verdict, runId).toBe(verdict);
    }
    const flakiness = model.getFlakiness('A', PW, 'h');
    expect(flakiness).toMatchObject({ totalOccurrences: 2, flakyOccurrences: 2, everFlaky: true });
    expect(flakiness.flaky.map((o) => o.runId)).toEqual(['run-normal', 'run-policy']);
  });

  it('counts occurrences without a score', async () => {
    const root = freshRoot();
    simpleRun(root, 'a', 'run-1', PW, execution(testCase('e', 'h'), [['passed']]));
    simpleRun(
      root,
      'b',
      'run-2',
      PW,
      execution(testCase('e', 'h'), [['failed'], ['passed']]),
      {},
      {
        startAt: '2026-09-12T11:00:00.000+00:00',
      },
    );
    const { model } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(model.getFlakiness('A', PW, 'h')).toMatchObject({
      totalOccurrences: 2,
      flakyOccurrences: 1,
      everFlaky: true,
    });
    expect(model.getFlakiness('A', PW, 'h').flaky.map((o) => o.runId)).toEqual(['run-2']);
    expect(model.getFlakiness('A', PW, 'unknown')).toMatchObject({
      totalOccurrences: 0,
      flakyOccurrences: 0,
      everFlaky: false,
      flaky: [],
    });
    expect(Object.keys(model.getFlakiness('A', PW, 'h'))).not.toContain('score');
  });
});

describe('attachment catalog', () => {
  it('indexes bytes by full SHA-256 across runs and keeps every reference', async () => {
    const root = freshRoot();
    const shared = Buffer.from('shared bytes');
    const only = Buffer.from('only in run 2');
    writeRun(
      root,
      'a',
      'run-1',
      [
        {
          sessionId: 's',
          events: [
            started(PW),
            {
              type: 'attempt.started',
              payload: { attemptId: 'a1', attemptNumber: 1, test: testCase('e', 'h') },
            },
            attachment('a1', shared),
            { type: 'attempt.finished', payload: { attemptId: 'a1', status: 'passed' } },
            finished(),
          ],
        },
      ],
      [shared],
    );
    writeRun(
      root,
      'b',
      'run-2',
      [
        {
          sessionId: 's',
          events: [
            started(PW),
            {
              type: 'attempt.started',
              payload: { attemptId: 'b1', attemptNumber: 1, test: testCase('e', 'h') },
            },
            attachment('b1', shared, { name: 'again' }),
            attachment('b1', only),
            { type: 'attempt.finished', payload: { attemptId: 'b1', status: 'passed' } },
            finished(),
          ],
        },
      ],
      [shared, only],
    );
    const { model, problems } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(problems).toEqual([]);
    expect(model.blobs()).toHaveLength(2);
    const blob = model.getBlob(model.getRun('A', 'run-1')?.attachments[0]?.sha256 ?? '');
    expect(blob?.sizeBytes).toBe(shared.length);
    expect(blob?.sources.map((s) => s.runId)).toEqual(['run-1', 'run-2']);
    expect(blob?.references.map((r) => [r.runId, r.reference.name])).toEqual([
      ['run-1', 'log'],
      ['run-2', 'again'],
    ]);
    expect(blob?.sources[1]?.runDirectory).toBe(join(root, 'runs', 'b'));
  });

  it('treats one hash with two sizes as a consistency error rather than choosing', async () => {
    const root = freshRoot();
    const bytes = Buffer.from('bytes');
    const events = [
      started(PW),
      {
        type: 'attempt.started',
        payload: { attemptId: 'a1', attemptNumber: 1, test: testCase('e', 'h') },
      },
      attachment('a1', bytes),
      { type: 'attempt.finished', payload: { attemptId: 'a1', status: 'passed' } },
      finished(),
    ];
    const dir = writeRun(root, 'a', 'run-1', [{ sessionId: 's', events }], [bytes]);
    const result = await projectRunDirectory({ projectId: 'A', runDirectory: dir });
    if (result.kind !== 'projected') throw new Error('expected a projected run');
    const run = result.run;
    const contradicting: ProjectedRun = {
      ...run,
      runId: 'run-2',
      runDirectory: join(root, 'runs', 'elsewhere'),
      attachments: run.attachments.map((a) => ({ ...a, sizeBytes: a.sizeBytes + 1 })),
    };
    const { model, problems } = ReadModel.assemble([run, contradicting]);
    expect(model.runs().map((r) => r.runId)).toEqual(['run-1']);
    expect(problems.map((p) => [p.code, p.runId])).toEqual([['BLOB_SIZE_CONFLICT', 'run-2']]);
    expect(model.blobs()[0]?.sizeBytes).toBe(bytes.length);
  });
});
