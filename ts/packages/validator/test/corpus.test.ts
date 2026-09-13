import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EVENT_TYPES, LIMITS, type Event } from 'qe-report-protocol';
import {
  RunValidator,
  formatDiagnostic,
  validateFile,
  validateLines,
  validateRunDirectory,
  type Report,
  validateRunDirectorySnapshot,
} from '../src/index.js';
import { FIXTURES_DIR, manifest, runLines, sessionFiles } from '../../protocol/test/helpers.js';

const m = manifest();
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

describe('run directory fixtures', () => {
  for (const run of m.runs) {
    it(`${run.dir} is ${run.outcome}${run.reason ? ` (${run.reason}${run.detail ? '/' + run.detail : ''})` : ''}`, async () => {
      const report = await validateRunDirectory(join(FIXTURES_DIR, run.dir));
      const errors = report.diagnostics.filter((d) => d.severity === 'error');
      if (run.outcome === 'VALID') {
        expect(errors, JSON.stringify(errors)).toEqual([]);
        expect(report.valid).toBe(true);
        expect(report.summary.complete).toBe(run.complete);
        expect(report.summary.closed).toBe(run.closed);
        expect(report.summary.sessions).toBe(run.sessions);
        expect(report.summary.attempts).toBe(run.attempts);
        expect(report.summary.ignored).toBe(run.ignored ?? 0);
        expect(report.summary.duplicates).toBe(run.duplicates ?? 0);
        if (run.attachments !== undefined) expect(report.summary.attachments).toBe(run.attachments);
        expect(report.summary.scopeFailures).toBe(run.scopeFailures ?? 0);
        expect(report.summary.failedSessions).toBe(run.failedSessions ?? 0);
        expect(report.summary.inconclusiveSessions).toBe(run.inconclusiveSessions ?? 0);
        expect(report.summary.sessionFailures).toBe(run.sessionFailures ?? 0);
        if (run.failedAttempts !== undefined)
          expect(report.summary.failedAttempts).toBe(run.failedAttempts);
        if (run.verdict !== undefined) expect(report.summary.verdict).toBe(run.verdict);
      } else {
        expect(report.valid).toBe(false);
        const match = errors.find(
          (d) =>
            d.code === run.reason &&
            (run.detail === undefined || d.detail === run.detail) &&
            (run.file === undefined || d.file.endsWith(run.file)),
        );
        expect(match, JSON.stringify(errors)).toBeDefined();
        expect(match?.line).toBe(run.line);
      }
    });
  }
});

describe('single files as streams', () => {
  it('validates one session file with the attachments of its run', async () => {
    const [file] = sessionFiles('runs/karate');
    const report = await validateFile(join(FIXTURES_DIR, file ?? ''));
    expect(report.valid).toBe(true);
    expect(report.summary.attachments).toBe(2);
  });
  it('accepts several sessions in one stream, which a session file may not hold', async () => {
    const lines = sessionFiles('runs/forked').flatMap((f) =>
      readFileSync(join(FIXTURES_DIR, f), 'utf8').split('\n'),
    );
    const report = await validateLines(lines);
    expect(report.valid).toBe(true);
    expect(report.summary.sessions).toBe(3);
  });
});

describe('scope failures in the derived verdict', () => {
  it('fails a run whose attempts all passed', async () => {
    const report = await validateRunDirectory(join(FIXTURES_DIR, 'runs/scope-failure-all-passed'));
    expect(report.valid).toBe(true);
    expect(report.summary).toMatchObject({
      attempts: 2,
      failedAttempts: 0,
      scopeFailures: 1,
      verdict: 'failed',
      complete: true,
    });
  });
  it('does not count a scope failure as a failed attempt, and a retried test counts by its final attempt', async () => {
    const line = (seq: number, type: string, payload: unknown): string =>
      JSON.stringify({
        protocolVersion: '0.3.0',
        eventId: `e-${seq}`,
        eventType: type,
        runId: 'r',
        sessionId: 's',
        sequence: seq,
        occurredAt: '2026-01-01T00:00:00Z',
        payload,
      });
    const test = {
      executionId: 't',
      historicalId: 'h',
      historicalIdStability: 'stable',
      displayName: 't',
      path: [],
    };
    const report = await validateLines([
      line(1, 'session.started', { producer: { name: 'x' }, runner: { name: 'y' } }),
      line(2, 'attempt.started', { attemptId: 'a1', attemptNumber: 1, test }),
      line(3, 'attempt.finished', { attemptId: 'a1', status: 'failed' }),
      line(4, 'attempt.started', { attemptId: 'a2', attemptNumber: 2, test }),
      line(5, 'attempt.finished', { attemptId: 'a2', status: 'passed' }),
      line(6, 'session.finished', {}),
    ]);
    expect(report.summary).toMatchObject({
      failedAttempts: 1,
      scopeFailures: 0,
      verdict: 'passed',
    });
    const withScope = await validateLines([
      line(1, 'session.started', { producer: { name: 'x' } }),
      line(2, 'scope.failed', {
        path: [{ kind: 'file', name: 'f' }],
        failures: [{ message: 'm' }],
      }),
      line(3, 'session.finished', {}),
    ]);
    expect(withScope.summary).toMatchObject({
      attempts: 0,
      failedAttempts: 0,
      scopeFailures: 1,
      verdict: 'failed',
    });
  });
  it('keeps diagnostics on one line whatever the producer wrote', async () => {
    const bad = JSON.stringify({
      protocolVersion: '0.3.0',
      eventId: 'e',
      eventType: 'scope.failed',
      runId: 'r',
      sessionId: 's',
      sequence: 1,
      occurredAt: '2026-01-01T00:00:00Z',
      payload: {
        path: [{ kind: 'file', name: 'f' }],
        failures: [{ message: 'm', phase: 'setup\nforged: line' }],
      },
    });
    const report = await validateLines([bad]);
    const text = report.diagnostics.map((d) => formatDiagnostic(d)).join('\n');
    expect(text.split('\n')).toHaveLength(report.diagnostics.length);
    expect(text).not.toContain('forged: line\n');
  });
});

describe('options', () => {
  it('reports an incomplete run as an error only when required', async () => {
    const dir = join(FIXTURES_DIR, 'runs/crashed');
    expect((await validateRunDirectory(dir)).valid).toBe(true);
    const strict = await validateRunDirectory(dir, { requireComplete: true });
    expect(strict.valid).toBe(false);
    expect(strict.diagnostics.find((d) => d.code === 'INCOMPLETE_RUN')?.severity).toBe('error');
  });
  it('flags an event over the size limit', async () => {
    const big = JSON.stringify({
      protocolVersion: '0.3.0',
      eventId: 'e',
      eventType: 'session.started',
      runId: 'r',
      sessionId: 's',
      sequence: 1,
      occurredAt: '2026-01-01T00:00:00Z',
      payload: { producer: { name: 'x' }, labels: { big: 'x'.repeat(1000) } },
    });
    const report = await validateLines([big], { maxEventBytes: 500 });
    expect(report.diagnostics.map((d) => d.code)).toEqual(['EVENT_TOO_LARGE']);
  });
  it('reports a reused event id with different content', async () => {
    const line = (seq: number, id: string): string =>
      JSON.stringify({
        protocolVersion: '0.3.0',
        eventId: id,
        eventType: seq === 1 ? 'session.started' : 'session.finished',
        runId: 'r',
        sessionId: 's',
        sequence: seq,
        occurredAt: '2026-01-01T00:00:00Z',
        payload: seq === 1 ? { producer: { name: 'x' } } : {},
      });
    const report = await validateLines([line(1, 'same'), line(2, 'same')]);
    expect(report.diagnostics.filter((d) => d.severity === 'error').map((d) => d.detail)).toEqual([
      'DUPLICATE_EVENT_ID',
    ]);
  });
  it('rejects a directory without events', async () => {
    await expect(validateRunDirectory(join(FIXTURES_DIR, 'redaction'))).rejects.toThrow(
      /events directory/,
    );
  });
});

describe('cli', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  it('exits 0 on a valid run directory and prints a summary', () => {
    const r = run(join(FIXTURES_DIR, 'runs/forked'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^valid: 3 files, \d+ events, 3 sessions/);
  });
  it('validates a single session file', () => {
    const [file] = sessionFiles('runs/junit');
    const r = run(join(FIXTURES_DIR, file ?? ''));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^valid: 1 files/);
  });
  it('exits 1 on an invalid run with a located diagnostic', () => {
    const r = run(join(FIXTURES_DIR, 'runs/invalid/sequence-gap'));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /s-1-[0-9a-f]{12}\.ndjson:3 \[s-1-0004\] ERROR LIFECYCLE_INVALID\(SEQUENCE_GAP\)/,
    );
  });
  it('exits 1 with --require-complete on a crashed run and 0 without', () => {
    const dir = join(FIXTURES_DIR, 'runs/crashed');
    expect(run(dir).status).toBe(0);
    expect(run(dir, '--require-complete').status).toBe(1);
  });
  it('emits JSON on request', () => {
    const r = run(join(FIXTURES_DIR, 'runs/compat/unknown-event-ignorable'), '--json');
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { summary: { ignored: number } }).summary.ignored).toBe(1);
  });
  it('exits 2 on usage errors and missing paths', () => {
    expect(run().status).toBe(2);
    expect(run('--bogus').status).toBe(2);
    expect(run('/nonexistent/run').status).toBe(2);
  });
});

describe('execution invariants', () => {
  const line = (
    seq: number,
    type: string,
    payload: unknown,
    session = 's',
    runId = 'r',
    eventId = `${session}-${seq}`,
  ): string =>
    JSON.stringify({
      protocolVersion: '0.3.0',
      eventId,
      eventType: type,
      runId,
      sessionId: session,
      sequence: seq,
      occurredAt: '2026-01-01T00:00:00Z',
      payload,
    });
  const test = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    executionId: 'e',
    historicalId: 'h',
    historicalIdStability: 'stable',
    displayName: 't',
    path: [],
    ...extra,
  });
  const session = (runner: string | undefined, producer = 'p'): Record<string, unknown> => ({
    producer: { name: producer },
    ...(runner === undefined ? {} : { runner: { name: runner } }),
  });
  const details = (report: Report): (string | undefined)[] =>
    report.diagnostics.filter((d) => d.severity === 'error').map((d) => d.detail);

  it('allows a gap in attempt numbers and a single attempt numbered above one', async () => {
    const gap = await validateLines([
      line(1, 'session.started', session('pw')),
      line(2, 'attempt.started', { attemptId: 'a', attemptNumber: 1, test: test() }),
      line(3, 'attempt.finished', { attemptId: 'a', status: 'failed' }),
      line(4, 'attempt.started', { attemptId: 'b', attemptNumber: 3, test: test() }),
      line(5, 'attempt.finished', { attemptId: 'b', status: 'passed' }),
      line(6, 'session.finished', {}),
    ]);
    expect(details(gap)).toEqual([]);
    expect(gap.summary.verdict).toBe('passed');
    const lone = await validateLines([
      line(1, 'session.started', session('pw')),
      line(2, 'attempt.started', { attemptId: 'a', attemptNumber: 2, test: test() }),
      line(3, 'attempt.finished', { attemptId: 'a', status: 'passed' }),
      line(4, 'session.finished', {}),
    ]);
    expect(lone.valid).toBe(true);
  });

  it('allows retries across sessions of one runner from different producers, with different labels and tags', async () => {
    const run = new RunValidator();
    run.feed(
      [
        line(1, 'session.started', session('pw', 'adapter-a'), 's1'),
        line(
          2,
          'attempt.started',
          {
            attemptId: 'a',
            attemptNumber: 1,
            test: test({ labels: { worker: '1' }, tags: ['x'] }),
          },
          's1',
        ),
        line(3, 'attempt.finished', { attemptId: 'a', status: 'failed' }, 's1'),
        line(4, 'session.finished', {}, 's1'),
      ],
      's1',
      true,
    );
    run.feed(
      [
        line(1, 'session.started', session('pw', 'adapter-b'), 's2'),
        line(
          2,
          'attempt.started',
          {
            attemptId: 'b',
            attemptNumber: 2,
            test: test({ labels: { worker: '2' }, tags: ['y'], displayName: 'renamed' }),
          },
          's2',
        ),
        line(3, 'attempt.finished', { attemptId: 'b', status: 'passed' }, 's2'),
        line(4, 'session.finished', {}, 's2'),
      ],
      's2',
      true,
    );
    const report = await run.finish();
    expect(details(report)).toEqual([]);
    expect(report.summary).toMatchObject({ sessions: 2, attempts: 2, verdict: 'passed' });
  });

  it('keeps repeat-each repetitions apart because they use distinct execution ids', async () => {
    const report = await validateLines([
      line(1, 'session.started', session('pw')),
      line(2, 'attempt.started', {
        attemptId: 'a',
        attemptNumber: 1,
        test: test({ executionId: 'e-1' }),
      }),
      line(3, 'attempt.finished', { attemptId: 'a', status: 'passed' }),
      line(4, 'attempt.started', {
        attemptId: 'b',
        attemptNumber: 1,
        test: test({ executionId: 'e-2' }),
      }),
      line(5, 'attempt.finished', { attemptId: 'b', status: 'passed' }),
      line(6, 'session.finished', {}),
    ]);
    expect(details(report)).toEqual([]);
  });

  it('rejects a reused attempt number and names the execution, the number, and the event', async () => {
    const report = await validateLines([
      line(1, 'session.started', session('pw')),
      line(2, 'attempt.started', { attemptId: 'a', attemptNumber: 1, test: test() }),
      line(3, 'attempt.finished', { attemptId: 'a', status: 'failed' }),
      line(4, 'attempt.started', { attemptId: 'b', attemptNumber: 1, test: test() }),
      line(5, 'attempt.finished', { attemptId: 'b', status: 'passed' }),
      line(6, 'session.finished', {}),
    ]);
    expect(report.valid).toBe(false);
    const d = report.diagnostics.find((x) => x.detail === 'DUPLICATE_ATTEMPT_NUMBER');
    expect(d).toMatchObject({ code: 'LIFECYCLE_INVALID', line: 4, eventId: 's-4' });
    expect(d?.message).toBe('execution e has attempts a (<stream>:2) and b both numbered 1');
  });

  it('rejects every change of history identity between attempts', async () => {
    const changed = async (
      first: Record<string, unknown>,
      second: Record<string, unknown>,
    ): Promise<(string | undefined)[]> =>
      details(
        await validateLines([
          line(1, 'session.started', session('pw')),
          line(2, 'attempt.started', { attemptId: 'a', attemptNumber: 1, test: test(first) }),
          line(3, 'attempt.finished', { attemptId: 'a', status: 'failed' }),
          line(4, 'attempt.started', { attemptId: 'b', attemptNumber: 2, test: test(second) }),
          line(5, 'attempt.finished', { attemptId: 'b', status: 'passed' }),
          line(6, 'session.finished', {}),
        ]),
      );
    expect(await changed({}, { historicalId: 'h2' })).toEqual(['HISTORICAL_IDENTITY_CHANGED']);
    expect(await changed({}, { historicalIdStability: 'uncertain' })).toEqual([
      'HISTORICAL_IDENTITY_CHANGED',
    ]);
    const unavailable = { historicalId: undefined, historicalIdStability: 'unavailable' };
    expect(await changed(unavailable, {})).toEqual(['HISTORICAL_IDENTITY_CHANGED']);
    expect(await changed({}, unavailable)).toEqual(['HISTORICAL_IDENTITY_CHANGED']);
    expect(await changed(unavailable, unavailable)).toEqual([]);
  });

  it('rejects a duplicate attempt number across sessions whatever the feed order, naming the other attempt', async () => {
    const s1 = [
      line(1, 'session.started', session('pw'), 's1'),
      line(2, 'attempt.started', { attemptId: 'a', attemptNumber: 2, test: test() }, 's1'),
      line(3, 'attempt.finished', { attemptId: 'a', status: 'failed' }, 's1'),
      line(4, 'session.finished', {}, 's1'),
    ];
    const s2 = [
      line(1, 'session.started', session('pw'), 's2'),
      line(2, 'attempt.started', { attemptId: 'b', attemptNumber: 2, test: test() }, 's2'),
      line(3, 'attempt.finished', { attemptId: 'b', status: 'passed' }, 's2'),
      line(4, 'session.finished', {}, 's2'),
    ];
    const feed = async (order: [string[], string][]): Promise<Report> => {
      const run = new RunValidator();
      for (const [lines, file] of order) run.feed(lines, file, true);
      return run.finish();
    };
    const forward = await feed([
      [s1, 's1'],
      [s2, 's2'],
    ]);
    const backward = await feed([
      [s2, 's2'],
      [s1, 's1'],
    ]);
    for (const report of [forward, backward]) {
      expect(report.valid).toBe(false);
      expect(details(report)).toEqual(['DUPLICATE_ATTEMPT_NUMBER']);
    }
    const f = forward.diagnostics.find((d) => d.detail === 'DUPLICATE_ATTEMPT_NUMBER');
    const b = backward.diagnostics.find((d) => d.detail === 'DUPLICATE_ATTEMPT_NUMBER');
    expect([f?.file, f?.line, f?.message]).toEqual([
      's2',
      2,
      'execution e has attempts a (s1:2) and b both numbered 2',
    ]);
    expect([b?.file, b?.line, b?.message]).toEqual([
      's1',
      2,
      'execution e has attempts b (s2:2) and a both numbered 2',
    ]);
  });

  it('describes both identities and the other attempt when the history identity changes', async () => {
    const report = await validateLines([
      line(1, 'session.started', session('pw')),
      line(2, 'attempt.started', {
        attemptId: 'a',
        attemptNumber: 1,
        test: test({ historicalId: undefined, historicalIdStability: 'unavailable' }),
      }),
      line(3, 'attempt.finished', { attemptId: 'a', status: 'failed' }),
      line(4, 'attempt.started', { attemptId: 'b', attemptNumber: 2, test: test() }),
      line(5, 'attempt.finished', { attemptId: 'b', status: 'passed' }),
      line(6, 'session.finished', {}),
    ]);
    const d = report.diagnostics.find((x) => x.detail === 'HISTORICAL_IDENTITY_CHANGED');
    expect(d?.message).toBe(
      'execution e changes history identity between attempts a (unavailable, <stream>:2) and b (h, stable)',
    );
  });

  it('does not blame a runner change on a session that was never started', async () => {
    const report = await validateLines([
      line(1, 'session.started', session('pw'), 's1'),
      line(
        2,
        'attempt.started',
        {
          attemptId: 'a',
          attemptNumber: 1,
          test: test({ historicalId: undefined, historicalIdStability: 'unavailable' }),
        },
        's1',
      ),
      line(3, 'attempt.finished', { attemptId: 'a', status: 'failed' }, 's1'),
      line(4, 'session.finished', {}, 's1'),
      line(
        2,
        'attempt.started',
        {
          attemptId: 'b',
          attemptNumber: 2,
          test: test({ historicalId: undefined, historicalIdStability: 'unavailable' }),
        },
        's2',
      ),
      line(3, 'attempt.finished', { attemptId: 'b', status: 'passed' }, 's2'),
      line(4, 'session.finished', {}, 's2'),
    ]);
    expect(details(report)).toEqual(['SESSION_NOT_STARTED']);
  });

  it('rejects an execution whose sessions declare different runners, or a runner in only one', async () => {
    const spanning = async (
      first: string | undefined,
      second: string | undefined,
    ): Promise<Report> => {
      const run = new RunValidator();
      const t =
        first === undefined || second === undefined
          ? { historicalId: undefined, historicalIdStability: 'unavailable' }
          : {};
      run.feed(
        [
          line(1, 'session.started', session(first), 's1'),
          line(2, 'attempt.started', { attemptId: 'a', attemptNumber: 1, test: test(t) }, 's1'),
          line(3, 'attempt.finished', { attemptId: 'a', status: 'failed' }, 's1'),
          line(4, 'session.finished', {}, 's1'),
        ],
        's1',
        true,
      );
      run.feed(
        [
          line(1, 'session.started', session(second), 's2'),
          line(2, 'attempt.started', { attemptId: 'b', attemptNumber: 2, test: test(t) }, 's2'),
          line(3, 'attempt.finished', { attemptId: 'b', status: 'passed' }, 's2'),
          line(4, 'session.finished', {}, 's2'),
        ],
        's2',
        true,
      );
      return run.finish();
    };
    expect(details(await spanning('junit-platform', 'playwright'))).toEqual([
      'EXECUTION_RUNNER_CHANGED',
    ]);
    expect(details(await spanning(undefined, 'playwright'))).toEqual(['EXECUTION_RUNNER_CHANGED']);
    expect(details(await spanning('playwright', undefined))).toEqual(['EXECUTION_RUNNER_CHANGED']);
    expect(details(await spanning('playwright', 'playwright'))).toEqual([]);
    const d = (await spanning('junit-platform', 'playwright')).diagnostics.find(
      (x) => x.detail === 'EXECUTION_RUNNER_CHANGED',
    );
    expect(d).toMatchObject({ file: 's2', line: 2, eventId: 's2-2' });
    expect(d?.message).toContain('junit-platform');
    expect(d?.message).toContain('playwright');
  });
});

describe('validated run snapshot', () => {
  it('returns the accepted known events once each, in feed order, beside the same report', async () => {
    const dir = join(FIXTURES_DIR, 'runs/duplicate-event-identical');
    const { report, events } = await validateRunDirectorySnapshot(dir);
    expect(report).toEqual(await validateRunDirectory(dir));
    expect(report.summary.duplicates).toBe(1);
    expect(events).toHaveLength(report.summary.events);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    expect(events.map((e) => e.sequence)).toEqual([...events].map((_, i) => i + 1));
  });
  it('lists no unknown ignorable event but keeps its count', async () => {
    const { report, events } = await validateRunDirectorySnapshot(
      join(FIXTURES_DIR, 'runs/compat/unknown-event-ignorable'),
    );
    expect(report.summary.ignored).toBe(1);
    expect(events).toHaveLength(report.summary.events - 1);
    expect(events.every((e) => EVENT_TYPES.includes(e.eventType))).toBe(true);
  });
  it('reports an execution-invariant violation identically with and without events', async () => {
    for (const fixture of [
      'runs/invalid/duplicate-attempt-number',
      'runs/invalid/historical-identity-appeared',
      'runs/invalid/execution-runner-changed',
    ]) {
      const dir = join(FIXTURES_DIR, fixture);
      const plain = await validateRunDirectory(dir);
      const { report, events } = await validateRunDirectorySnapshot(dir);
      expect(report, fixture).toEqual(plain);
      expect(report.valid, fixture).toBe(false);
      expect(events.length, fixture).toBeGreaterThan(0);
    }
  });

  it('retains nothing unless asked', async () => {
    const { events } = await validateRunDirectorySnapshot(join(FIXTURES_DIR, 'runs/forked'), {
      retainEvents: false,
    });
    expect(events).toEqual([]);
    const run = new RunValidator();
    run.feed(runLines('runs/forked'), 'stream', false);
    expect(run.acceptedEvents()).toEqual([]);
  });
});

/** Links are part of the contract on every platform but Windows, where creating one needs a privilege. */
const symlinkIt = process.platform === 'win32' ? it.skip : it;
/** Every temporary directory made by these tests, removed when the file is done. */
const TEMP: string[] = [];
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TEMP.push(d);
  return d;
}
const UNREADABLE: string[] = [];
afterAll(() => {
  for (const t of UNREADABLE) chmodSync(t, 0o700);
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});
/** A link whose target no one may read: following it would throw, not return bytes. */
function unreadableLink(target: string, link: string): void {
  symlinkSync(target, link);
  chmodSync(target, 0);
  UNREADABLE.push(target);
}

describe('filesystem containment', () => {
  /** A private copy of the karate fixture run (one session file, two attachments). */
  function copyOfKarate(name: string): { dir: string; outside: string } {
    const base = temp(`qe-fs-${name}-`);
    const dir = join(base, 'run');
    cpSync(join(FIXTURES_DIR, 'runs/karate'), dir, { recursive: true });
    const outside = join(base, 'outside');
    mkdirSync(outside);
    return { dir, outside };
  }
  const OUTSIDE_MARK = 'run-OUTSIDE-never-read';
  function outsideSessionText(): string {
    return readFileSync(
      join(FIXTURES_DIR, 'runs/karate/events', sessionFileOf('runs/karate')),
      'utf8',
    )
      .split('run-karate-0001')
      .join(OUTSIDE_MARK);
  }
  function sessionFileOf(run: string): string {
    return sessionFiles(run).map((f) => f.split('/').pop() ?? '')[0] ?? '';
  }
  function unsafe(report: Report): [string, string][] {
    return report.diagnostics
      .filter((d) => d.code === 'UNSAFE_FILESYSTEM_ENTRY')
      .map((d) => [d.file, d.message]);
  }
  async function bothReports(dir: string): Promise<{ report: Report; events: readonly Event[] }> {
    const snapshot = await validateRunDirectorySnapshot(dir);
    expect(await validateRunDirectory(dir)).toEqual(snapshot.report);
    return snapshot;
  }

  it('still validates an ordinary copy of a run', async () => {
    const { dir } = copyOfKarate('plain');
    const { report } = await bothReports(dir);
    expect(report.valid).toBe(true);
    expect(report.summary.attachments).toBe(2);
  });

  symlinkIt('refuses a linked events directory and reads nothing through it', async () => {
    const { dir, outside } = copyOfKarate('events-link');
    mkdirSync(join(outside, 'events'));
    writeFileSync(join(outside, 'events', 'x.ndjson'), outsideSessionText());
    rmSync(join(dir, 'events'), { recursive: true });
    unreadableLink(join(outside, 'events'), join(dir, 'events'));
    const { report, events } = await bothReports(dir);
    expect(report.valid).toBe(false);
    expect(unsafe(report)).toEqual([
      [
        join(dir, 'events'),
        'a symbolic link where a directory is required; nothing below it is read',
      ],
    ]);
    expect(report.summary.files).toBe(0);
    expect(events).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(OUTSIDE_MARK);
  });

  symlinkIt(
    'refuses a linked event file beside the real one, without reading its target',
    async () => {
      const { dir, outside } = copyOfKarate('event-link');
      writeFileSync(join(outside, 'secret.ndjson'), outsideSessionText());
      unreadableLink(join(outside, 'secret.ndjson'), join(dir, 'events', 'zz.ndjson'));
      const { report, events } = await bothReports(dir);
      expect(report.valid).toBe(false);
      expect(unsafe(report)).toEqual([
        [join(dir, 'events', 'zz.ndjson'), 'a symbolic link; only regular files are read'],
      ]);
      expect(report.summary.files).toBe(1);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.runId === 'run-karate-0001')).toBe(true);
      expect(JSON.stringify(report)).not.toContain(OUTSIDE_MARK);
    },
  );

  it('refuses a directory named like an event file', async () => {
    const { dir } = copyOfKarate('event-dir');
    mkdirSync(join(dir, 'events', 'nested.ndjson'));
    const { report } = await bothReports(dir);
    expect(report.valid).toBe(false);
    expect(unsafe(report)).toEqual([
      [join(dir, 'events', 'nested.ndjson'), 'a directory; only regular files are read'],
    ]);
    expect(report.summary.files).toBe(1);
  });

  symlinkIt('refuses a linked attachment even when its target has the declared bytes', async () => {
    const { dir, outside } = copyOfKarate('attachment-link');
    const [sha] = readdirSync(join(dir, 'attachments')).sort();
    if (sha === undefined) throw new Error('fixture has no attachment');
    const bytes = readFileSync(join(dir, 'attachments', sha));
    writeFileSync(join(outside, 'same-bytes'), bytes);
    rmSync(join(dir, 'attachments', sha));
    unreadableLink(join(outside, 'same-bytes'), join(dir, 'attachments', sha));
    const { report } = await bothReports(dir);
    expect(report.valid).toBe(false);
    const codes = report.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
    expect(codes).toEqual(['UNSAFE_FILESYSTEM_ENTRY']);
    expect(report.diagnostics[0]?.message).toBe(
      `attachment ${sha} is a symbolic link; only regular files are read`,
    );
    expect(report.diagnostics[0]?.line).toBeGreaterThan(0);
  });

  it('refuses an attachment path that is a directory, and keeps missing, size, and hash checks', async () => {
    const { dir } = copyOfKarate('attachment-dir');
    const [first, second] = readdirSync(join(dir, 'attachments')).sort();
    if (first === undefined || second === undefined) throw new Error('fixture has two attachments');
    rmSync(join(dir, 'attachments', first));
    mkdirSync(join(dir, 'attachments', first));
    rmSync(join(dir, 'attachments', second));
    const { report } = await bothReports(dir);
    expect(
      report.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => d.code)
        .sort(),
    ).toEqual(['ATTACHMENT_MISSING', 'UNSAFE_FILESYSTEM_ENTRY']);
    const { dir: tampered } = copyOfKarate('attachment-bytes');
    writeFileSync(join(tampered, 'attachments', first), 'not the declared bytes');
    const bad = await validateRunDirectory(tampered);
    expect(bad.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['ATTACHMENT_SIZE_MISMATCH', 'ATTACHMENT_HASH_MISMATCH']),
    );
  });

  symlinkIt('refuses a linked attachments directory as a whole', async () => {
    const { dir, outside } = copyOfKarate('attachments-dir-link');
    cpSync(join(dir, 'attachments'), join(outside, 'attachments'), { recursive: true });
    rmSync(join(dir, 'attachments'), { recursive: true });
    unreadableLink(join(outside, 'attachments'), join(dir, 'attachments'));
    const { report } = await bothReports(dir);
    expect(report.valid).toBe(false);
    expect(unsafe(report)).toEqual([
      [
        join(dir, 'attachments'),
        'a symbolic link where a directory is required; nothing below it is read',
      ],
    ]);
    expect(report.diagnostics.filter((d) => d.code.startsWith('ATTACHMENT_'))).toEqual([]);
    // The same directory named explicitly by the caller is a trusted entry point.
    chmodSync(join(outside, 'attachments'), 0o700);
    const explicit = await validateRunDirectory(dir, { attachmentsDir: join(dir, 'attachments') });
    expect(explicit.valid).toBe(true);
  });

  it('refuses a regular file where the events or attachments directory should be', async () => {
    const { dir } = copyOfKarate('events-file');
    rmSync(join(dir, 'events'), { recursive: true });
    writeFileSync(join(dir, 'events'), 'not a directory');
    const events = await bothReports(dir);
    expect(events.report.valid).toBe(false);
    expect(unsafe(events.report)).toEqual([
      [
        join(dir, 'events'),
        'a regular file where a directory is required; nothing below it is read',
      ],
    ]);
    expect(events.events).toEqual([]);
    const { dir: other } = copyOfKarate('attachments-file');
    rmSync(join(other, 'attachments'), { recursive: true });
    writeFileSync(join(other, 'attachments'), 'not a directory');
    const attachments = await bothReports(other);
    expect(unsafe(attachments.report)).toEqual([
      [
        join(other, 'attachments'),
        'a regular file where a directory is required; nothing below it is read',
      ],
    ]);
  });

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  (process.platform === 'win32' || asRoot ? it.skip : it)(
    'surfaces an unsearchable events directory as an I/O error, never as an empty valid run',
    async () => {
      const { dir } = copyOfKarate('unsearchable');
      chmodSync(join(dir, 'events'), 0o444);
      UNREADABLE.push(join(dir, 'events'));
      await expect(validateRunDirectory(dir)).rejects.toThrow(/EACCES/u);
      const { dir: other } = copyOfKarate('unsearchable-attachments');
      chmodSync(join(other, 'attachments'), 0o444);
      UNREADABLE.push(join(other, 'attachments'));
      await expect(validateRunDirectory(other)).rejects.toThrow(/EACCES/u);
    },
  );

  const fifoIt = process.platform === 'win32' ? it.skip : it;
  fifoIt('refuses a named pipe where the platform can create one, without opening it', async () => {
    const { dir } = copyOfKarate('fifo');
    const fifo = join(dir, 'events', 'pipe.ndjson');
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr?.toString()}`);
    const { report } = await bothReports(dir);
    expect(unsafe(report)).toEqual([[fifo, 'not a regular file; only regular files are read']]);
    expect(report.summary.files).toBe(1);
  });
});

describe('duplicate canonicalisation', () => {
  const envelope = (eventId: string, payload: string): string =>
    `{"protocolVersion":"0.3.0","eventId":"${eventId}","eventType":"session.started","runId":"r","sessionId":"s","sequence":1,"occurredAt":"2026-01-01T00:00:00Z","payload":${payload}}`;
  const finished = (seq: number): string =>
    `{"protocolVersion":"0.3.0","eventId":"e-${seq}","eventType":"session.finished","runId":"r","sessionId":"s","sequence":${seq},"occurredAt":"2026-01-01T00:00:00Z","payload":{}}`;
  const base = '"producer":{"name":"p"}';
  async function classify(first: string, second: string): Promise<'identical' | 'different'> {
    const report = await validateLines([
      envelope('e-1', first),
      envelope('e-1', second),
      finished(2),
    ]);
    const info = report.diagnostics.some((d) => d.code === 'DUPLICATE_EVENT');
    const error = report.diagnostics.some(
      (d) => d.code === 'LIFECYCLE_INVALID' && d.detail === 'DUPLICATE_EVENT_ID',
    );
    expect(info !== error).toBe(true);
    expect(report.summary.duplicates).toBe(info ? 1 : 0);
    return info ? 'identical' : 'different';
  }

  it('ignores object key order at every level and keeps array order', async () => {
    expect(await classify(`{${base},"x":{"a":1,"b":2}}`, `{"x":{"b":2,"a":1},${base}}`)).toBe(
      'identical',
    );
    expect(
      await classify(
        `{${base},"x":{"n":{"a":[1,{"p":1,"q":2}]}}}`,
        `{${base},"x":{"n":{"a":[1,{"q":2,"p":1}]}}}`,
      ),
    ).toBe('identical');
    expect(await classify(`{${base},"x":[1,2]}`, `{${base},"x":[2,1]}`)).toBe('different');
    expect(await classify(`{${base},"x":[[1],[2]]}`, `{${base},"x":[[2],[1]]}`)).toBe('different');
  });

  it('distinguishes primitives and keeps prototype-named keys as data', async () => {
    expect(await classify(`{${base},"x":null}`, `{${base},"x":null}`)).toBe('identical');
    expect(await classify(`{${base},"x":null}`, `{${base},"x":false}`)).toBe('different');
    expect(await classify(`{${base},"x":true}`, `{${base},"x":"true"}`)).toBe('different');
    expect(await classify(`{${base},"x":1}`, `{${base},"x":1.0}`)).toBe('identical');
    expect(await classify(`{${base},"x":1}`, `{${base},"x":"1"}`)).toBe('different');
    expect(await classify(`{${base},"x":"a"}`, `{${base},"x":"b"}`)).toBe('different');
    expect(
      await classify(
        `{${base},"labels":{"__proto__":"one","b":"2"}}`,
        `{${base},"labels":{"b":"2","__proto__":"one"}}`,
      ),
    ).toBe('identical');
    expect(
      await classify(
        `{${base},"labels":{"__proto__":"one"}}`,
        `{${base},"labels":{"__proto__":"two"}}`,
      ),
    ).toBe('different');
    expect(await classify(`{${base},"x":{}}`, `{${base},"x":[]}`)).toBe('different');
  });

  const DEPTH = 100_000;
  const deep = (leaf: string): string =>
    `{${base},"extra":${'['.repeat(DEPTH)}${leaf}${']'.repeat(DEPTH)}}`;

  it('uses a depth the old recursive walk could not survive', () => {
    const walk = (v: unknown): number => (Array.isArray(v) ? 1 + walk(v[0]) : 0);
    expect(() => walk((JSON.parse(deep('')) as { extra: unknown }).extra)).toThrow(RangeError);
    expect(Buffer.byteLength(envelope('e-1', deep('1')))).toBeLessThan(LIMITS.maxEventBytes);
  });

  it('validates a deeply nested unknown property without a RangeError, and still compares duplicates', async () => {
    const single = await validateLines([envelope('e-1', deep('')), finished(2)]);
    expect(single.valid).toBe(true);
    expect(single.summary.events).toBe(2);
    expect(await classify(deep(''), deep(''))).toBe('identical');
    expect(await classify(deep(''), deep('1'))).toBe('different');
    const snapshotDir = temp('qe-deep-');
    mkdirSync(join(snapshotDir, 'events'));
    writeFileSync(
      join(snapshotDir, 'events', 's.ndjson'),
      `${envelope('e-1', deep(''))}\n${finished(2)}\n`,
    );
    const { report, events } = await validateRunDirectorySnapshot(snapshotDir);
    expect(report).toEqual(await validateRunDirectory(snapshotDir));
    expect(report.valid).toBe(true);
    expect(events).toHaveLength(2);
  });
});

describe('command line on hardened inputs', () => {
  const cli = (dir: string): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [CLI, dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  function karateCopy(name: string): { dir: string; outside: string } {
    const base = temp(`qe-cli-${name}-`);
    const dir = join(base, 'run');
    cpSync(join(FIXTURES_DIR, 'runs/karate'), dir, { recursive: true });
    const outside = join(base, 'outside');
    mkdirSync(outside);
    return { dir, outside };
  }
  it('validates a normal run with exit 0', () => {
    const { dir } = karateCopy('normal');
    const r = cli(dir);
    expect(r.status).toBe(0);
    expect(r.out).toContain('valid:');
  });

  symlinkIt(
    'reports a linked event file and a linked attachment as invalid, exit 1, no crash',
    () => {
      const { dir, outside } = karateCopy('links');
      writeFileSync(join(outside, 'x.ndjson'), 'not read\n');
      unreadableLink(join(outside, 'x.ndjson'), join(dir, 'events', 'zz.ndjson'));
      const [sha] = readdirSync(join(dir, 'attachments')).sort();
      if (sha === undefined) throw new Error('fixture has no attachment');
      const bytes = readFileSync(join(dir, 'attachments', sha));
      writeFileSync(join(outside, 'bytes'), bytes);
      rmSync(join(dir, 'attachments', sha));
      unreadableLink(join(outside, 'bytes'), join(dir, 'attachments', sha));
      const r = cli(dir);
      expect(r.status).toBe(1);
      expect(r.out.match(/UNSAFE_FILESYSTEM_ENTRY/gu)?.length).toBe(2);
      expect(r.out).toContain('invalid:');
      expect(r.out).not.toContain('not read');
    },
  );

  it('validates a run with a deeply nested unknown property with exit 0', () => {
    const base = temp('qe-cli-deep-');
    const dir = join(base, 'run');
    mkdirSync(join(dir, 'events'), { recursive: true });
    const depth = 100_000;
    const line = `{"protocolVersion":"0.3.0","eventId":"e-1","eventType":"session.started","runId":"r","sessionId":"s","sequence":1,"occurredAt":"2026-01-01T00:00:00Z","payload":{"producer":{"name":"p"},"extra":${'['.repeat(depth)}${']'.repeat(depth)}}}`;
    const done = `{"protocolVersion":"0.3.0","eventId":"e-2","eventType":"session.finished","runId":"r","sessionId":"s","sequence":2,"occurredAt":"2026-01-01T00:00:00Z","payload":{}}`;
    writeFileSync(join(dir, 'events', 's.ndjson'), `${line}\n${done}\n`);
    const r = cli(dir);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('RangeError');
  });
});

describe('source-line archive', () => {
  it('retains every accepted line verbatim with its disposition, only when asked', async () => {
    const dir = join(FIXTURES_DIR, 'runs/duplicate-event-identical');
    const plain = await validateRunDirectorySnapshot(dir);
    expect(plain.sourceLines).toEqual([]);
    const { report, events, sourceLines } = await validateRunDirectorySnapshot(dir, {
      retainSourceLines: true,
    });
    expect(report).toEqual(plain.report);
    expect(sourceLines.map((l) => l.disposition)).toContain('duplicate');
    expect(sourceLines.filter((l) => l.disposition === 'accepted')).toHaveLength(events.length);
    expect(sourceLines.filter((l) => l.disposition === 'duplicate')).toHaveLength(
      report.summary.duplicates,
    );
    const [file] = sessionFiles('runs/duplicate-event-identical');
    const fileLines = readFileSync(join(FIXTURES_DIR, file ?? ''), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    expect(sourceLines.map((l) => l.rawLine)).toEqual(fileLines);
    expect(sourceLines.map((l) => l.sourceLine)).toEqual(fileLines.map((_, i) => i + 1));
    for (const l of sourceLines) {
      const parsed = JSON.parse(l.rawLine) as Record<string, unknown>;
      expect([l.eventId, l.runId, l.sessionId, l.sequence, l.protocolVersion, l.eventType]).toEqual(
        [
          parsed['eventId'],
          parsed['runId'],
          parsed['sessionId'],
          parsed['sequence'],
          parsed['protocolVersion'],
          parsed['eventType'],
        ],
      );
      expect(l.canonicalSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    const duplicate = sourceLines.find((l) => l.disposition === 'duplicate');
    const original = sourceLines.find(
      (l) => l.disposition === 'accepted' && l.eventId === duplicate?.eventId,
    );
    expect(original?.canonicalSha256).toBe(duplicate?.canonicalSha256);
  });

  it('keeps an unknown ignorable event and unknown properties as raw text', async () => {
    const { report, sourceLines } = await validateRunDirectorySnapshot(
      join(FIXTURES_DIR, 'runs/compat/unknown-event-ignorable'),
      { retainSourceLines: true },
    );
    expect(report.summary.ignored).toBe(1);
    const ignored = sourceLines.filter((l) => l.disposition === 'ignored');
    expect(ignored).toHaveLength(1);
    expect(EVENT_TYPES.includes(ignored[0]?.eventType as (typeof EVENT_TYPES)[number])).toBe(false);
    expect(ignored[0]?.rawLine).toContain(ignored[0]?.eventType ?? '');
    const forward = new RunValidator({ retainSourceLines: true });
    const line =
      '{"protocolVersion":"0.3.0","eventId":"e-1","eventType":"session.started","runId":"r","sessionId":"s","sequence":1,"occurredAt":"2026-01-01T00:00:00Z","payload":{"producer":{"name":"p"},"vendor":{"__proto__":"kept","x":[1,2]}},"extraEnvelope":true}';
    forward.feed([line], 'f', true);
    expect(forward.sourceLines()[0]?.rawLine).toBe(line);
    expect(forward.sourceLines()[0]?.disposition).toBe('accepted');
  });

  it('digests the canonical form, so property order and whitespace do not change it', () => {
    const a = new RunValidator({ retainSourceLines: true });
    a.feed(
      [
        '{"protocolVersion":"0.3.0","eventId":"e-1","eventType":"session.started","runId":"r","sessionId":"s","sequence":1,"occurredAt":"2026-01-01T00:00:00Z","payload":{"producer":{"name":"p"},"x":{"b":2,"a":1}}}',
      ],
      'f',
      true,
    );
    const b = new RunValidator({ retainSourceLines: true });
    b.feed(
      [
        '{ "payload": {"x": {"a": 1, "b": 2}, "producer": {"name": "p"}}, "occurredAt":"2026-01-01T00:00:00Z", "sequence":1, "sessionId":"s", "runId":"r", "eventType":"session.started", "eventId":"e-1", "protocolVersion":"0.3.0" }',
      ],
      'f',
      true,
    );
    const c = new RunValidator({ retainSourceLines: true });
    c.feed(
      [
        '{"protocolVersion":"0.3.0","eventId":"e-1","eventType":"session.started","runId":"r","sessionId":"s","sequence":1,"occurredAt":"2026-01-01T00:00:00Z","payload":{"producer":{"name":"p"},"x":{"b":2,"a":[1]}}}',
      ],
      'f',
      true,
    );
    expect(a.sourceLines()[0]?.canonicalSha256).toBe(b.sourceLines()[0]?.canonicalSha256);
    expect(a.sourceLines()[0]?.canonicalSha256).not.toBe(c.sourceLines()[0]?.canonicalSha256);
    expect(a.sourceLines()[0]?.rawLine).not.toBe(b.sourceLines()[0]?.rawLine);
  });
});
