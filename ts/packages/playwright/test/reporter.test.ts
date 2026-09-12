import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FullConfig } from '@playwright/test/reporter';
import { parseEvent, type Event, type UnknownEvent } from 'qe-report-protocol';
import { FileSink } from 'qe-report-sdk';
import { QeReportReporter, type ReporterHooks } from '../src/reporter.js';
import type { QeReportReporterOptions } from '../src/config.js';
import { ROOT, fullResult, testCase, testResult, testStep } from './fakes.js';

/** Drives the reporter with fake Playwright objects; the consumer tests use the real runner. */
function reporter(
  options: QeReportReporterOptions,
  hooks: ReporterHooks = {},
  configOverrides: Partial<FullConfig> = {},
) {
  const lines: string[] = [];
  const r = new QeReportReporter(options, { env: {}, write: (l) => lines.push(l), ...hooks });
  const config = {
    rootDir: ROOT,
    version: '1.63.0',
    workers: 1,
    shard: null,
    globalSetup: null,
    globalTeardown: null,
    ...configOverrides,
  } as FullConfig;
  return { r, lines, begin: () => r.onBegin(config) };
}

function terminal(dir: string): { status?: string; rawStatus?: string; failures?: unknown[] } {
  const e = events(dir).find((x) => x.eventType === 'session.finished');
  return (e as { payload: { status?: string; rawStatus?: string; failures?: unknown[] } }).payload;
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'qe-pw-'));
}

/** The single run directory written below the output root. */
function runDir(root: string): string {
  const runs = readdirSync(join(root, 'runs'));
  expect(runs).toHaveLength(1);
  return join(root, 'runs', runs[0] ?? '');
}

function events(root: string): (Event | UnknownEvent)[] {
  const dir = runDir(root);
  const files = readdirSync(join(dir, 'events'));
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, 'events', files[0] ?? ''), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => parseEvent(l));
}

describe('QeReportReporter isolation', () => {
  it('writes nothing when disabled and stays silent', () => {
    const dir = join(temp(), 'off');
    const { r, lines, begin } = reporter({ enabled: false, dir });
    begin();
    r.onTestBegin(testCase(), testResult());
    r.onTestEnd(testCase(), testResult());
    r.onEnd(fullResult('passed'));
    expect(existsSync(dir)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('reports once and continues unreported when the directory cannot be created', () => {
    const base = temp();
    const file = join(base, 'a-file');
    writeFileSync(file, 'x');
    const { r, lines, begin } = reporter({ dir: join(file, 'below') });
    begin();
    r.onTestBegin(testCase(), testResult());
    r.onTestEnd(testCase(), testResult());
    r.onEnd(fullResult('passed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cannot open run directory');
    expect(lines[0]).toContain('this run is not reported');
  });

  it('refuses a session id whose file already exists', () => {
    const dir = temp();
    // The same run id resolves the same run directory; only then can the session file collide.
    const first = reporter({ dir, runId: 'run-same', sessionId: 'same' });
    first.begin();
    first.r.onEnd(fullResult('passed'));
    const second = reporter({ dir, runId: 'run-same', sessionId: 'same' });
    second.begin();
    expect(second.lines.join('\n')).toContain('EEXIST');
    expect(readdirSync(join(runDir(dir), 'events'))).toHaveLength(1);
  });

  it('records the attempt when an attachment is missing or too large, and says so once', () => {
    const dir = temp();
    const { r, lines, begin } = reporter({ dir, runId: 'run-a', maxAttachmentBytes: 8 });
    begin();
    const big = join(dir, 'big.bin');
    writeFileSync(big, Buffer.alloc(9));
    const test = testCase();
    r.onTestBegin(test, testResult());
    r.onTestEnd(
      test,
      testResult({
        attachments: [
          { name: 'gone', contentType: 'image/png', path: join(dir, 'missing.png') },
          { name: 'big', contentType: 'image/png', path: big },
          { name: 'small', contentType: 'text/plain', body: Buffer.from('ok') },
        ],
      }),
    );
    r.onEnd(fullResult('passed'));
    const types = events(dir).map((e) => e.eventType);
    expect(types).toEqual([
      'session.started',
      'attempt.started',
      'attachment.added',
      'attempt.finished',
      'session.finished',
    ]);
    expect(lines.filter((l) => l.includes('SINK_FAILURE'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('ATTACHMENT_TOO_LARGE'))).toHaveLength(1);
  });

  it('contains an internal mapping failure and keeps reporting the rest', () => {
    const dir = temp();
    const { r, lines, begin } = reporter({ dir, runId: 'run-b' });
    begin();
    const broken = testCase();
    Object.defineProperty(broken, 'location', {
      get() {
        throw new Error('no location');
      },
    });
    r.onTestBegin(broken, testResult());
    const fine = testCase({ id: 'cccccccccccccccccccc-dddddddddddddddddddd', title: 'fine' });
    r.onTestBegin(fine, testResult());
    r.onTestEnd(fine, testResult());
    r.onEnd(fullResult('passed'));
    expect(lines.some((l) => l.includes('internal error in onTestBegin'))).toBe(true);
    expect(events(dir).filter((e) => e.eventType === 'attempt.finished')).toHaveLength(1);
  });

  it('never returns a status from onEnd and never throws from a callback', () => {
    const dir = temp();
    const { r, begin } = reporter({ dir, runId: 'run-c' });
    begin();
    expect(() =>
      r.onStepEnd(testCase(), testResult(), testStep({ title: 'x', category: 'y' })),
    ).not.toThrow();
    expect(() => r.onTestEnd(testCase(), testResult())).not.toThrow();
    expect(r.onEnd(fullResult('passed'))).toBeUndefined();
    expect(r.printsToStdio()).toBe(false);
  });

  it('closes the run only when it generated the run id', () => {
    const own = temp();
    const first = reporter({ dir: own });
    first.begin();
    first.r.onEnd(fullResult('passed'));
    expect(events(own).map((e) => e.eventType)).toEqual([
      'session.started',
      'session.finished',
      'run.finished',
    ]);
    const shared = temp();
    const second = reporter({ dir: shared, runId: 'run-shared' });
    second.begin();
    second.r.onEnd(fullResult('passed'));
    expect(events(shared).map((e) => e.eventType)).toEqual(['session.started', 'session.finished']);
  });

  it('redacts what it prints and sanitises annotation label keys', () => {
    const dir = temp();
    const { r, lines, begin } = reporter({ dir, runId: 'run-d' });
    begin();
    const test = testCase({
      annotations: [
        { type: 'token=abc secret', description: 'x' },
        { type: 'issue', description: 'QE-1' },
        { type: 'issue', description: 'QE-2' },
      ],
    });
    r.onTestBegin(test, testResult());
    r.onTestEnd(test, testResult());
    r.onError({ message: 'Error: connect postgres://u:hunter2@db failed' });
    r.onEnd(fullResult('passed'));
    const started = events(dir).find((e) => e.eventType === 'attempt.started');
    const labels = (started as { payload: { test: { labels: Record<string, string> } } }).payload
      .test.labels;
    expect(Object.keys(labels)).toContain('annotation.token_abc_secret');
    expect(labels['annotation.issue']).toBe('QE-1; QE-2');
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(lines.join('\n')).toContain('[REDACTED]');
  });

  it('records an error located in a test file as that file scope failing, set-up when nothing ran', () => {
    const dir = temp();
    const { r, lines, begin } = reporter({ dir, runId: 'run-e' });
    begin();
    r.onError({
      message: 'SyntaxError: Unexpected token',
      location: { file: `${ROOT}/tests/broken.spec.ts`, line: 4, column: 12 },
    });
    r.onError({
      message: 'Error: global setup broke',
      location: { file: '/elsewhere/setup.ts', line: 1, column: 1 },
    });
    r.onEnd(fullResult('passed'));
    const scopes = events(dir).filter((e) => e.eventType === 'scope.failed');
    expect(scopes).toHaveLength(1);
    expect((scopes[0] as { payload: unknown }).payload).toMatchObject({
      path: [{ kind: 'file', name: 'tests/broken.spec.ts' }],
      displayName: 'tests/broken.spec.ts',
      location: { file: 'tests/broken.spec.ts', line: 4, column: 12 },
      failures: [{ message: 'SyntaxError: Unexpected token', type: 'SyntaxError', phase: 'setup' }],
    });
    expect(lines.filter((l) => l.includes('recorded as a scope failure'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('is not recorded'))).toHaveLength(1);
  });

  it('reports malformed configuration once and uses the defaults', () => {
    const dir = temp();
    const { lines, begin } = reporter({ dir }, { env: { QE_REPORT_RUN_ID: 'bad id' } });
    begin();
    expect(lines.filter((l) => l.includes("run id 'bad id'"))).toHaveLength(1);
    expect(existsSync(join(dir, 'runs'))).toBe(true);
  });

  it("records Playwright's aggregate status as the session outcome", () => {
    const cases = [
      ['passed', 'passed'],
      ['failed', 'failed'],
      ['timedout', 'failed'],
      ['interrupted', 'inconclusive'],
    ] as const;
    for (const [raw, status] of cases) {
      const dir = temp();
      const { r, begin } = reporter({ dir, runId: `run-${raw}` });
      begin();
      r.onEnd(fullResult(raw));
      expect(terminal(dir), raw).toEqual({ status, rawStatus: raw });
    }
  });

  it('keeps global setup and teardown errors for session.finished with their phase', () => {
    const dir = temp();
    const setup = `${ROOT}/global-setup.ts`;
    const teardown = `${ROOT}/global-teardown.ts`;
    const { r, lines, begin } = reporter(
      { dir, runId: 'run-g' },
      {},
      { globalSetup: setup, globalTeardown: teardown },
    );
    begin();
    r.onError({ message: 'Error: setup broke', location: { file: setup, line: 3, column: 9 } });
    r.onError({
      message: 'Error: teardown broke',
      location: { file: teardown, line: 2, column: 1 },
    });
    r.onEnd(fullResult('failed'));
    const t = terminal(dir);
    expect(t.status).toBe('failed');
    expect(t.failures).toEqual([
      expect.objectContaining({
        message: 'Error: setup broke',
        phase: 'setup',
        location: { file: 'global-setup.ts', line: 3, column: 9 },
      }),
      expect.objectContaining({ message: 'Error: teardown broke', phase: 'teardown' }),
    ]);
    expect(events(dir).some((e) => e.eventType === 'scope.failed')).toBe(false);
    expect(lines.filter((l) => l.includes('recorded on session.finished'))).toHaveLength(2);
  });

  it('never attaches failures to a passed session and bounds them to the protocol maximum', () => {
    const dir = temp();
    const setup = `${ROOT}/global-setup.ts`;
    const { r, lines, begin } = reporter({ dir, runId: 'run-p' }, {}, { globalSetup: setup });
    begin();
    for (let i = 0; i < 40; i += 1)
      r.onError({
        message: `Error: setup broke ${i}`,
        location: { file: setup, line: i + 1, column: 1 },
      });
    r.onEnd(fullResult('passed'));
    expect(terminal(dir)).toEqual({ status: 'passed', rawStatus: 'passed' });
    expect(lines.some((l) => l.includes('more than 32 invocation-level errors'))).toBe(true);
    expect(lines.some((l) => l.includes('although the run passed'))).toBe(true);
  });

  it('records at most 32 session failures on a failed session', () => {
    const dir = temp();
    const setup = `${ROOT}/global-setup.ts`;
    const { r, begin } = reporter({ dir, runId: 'run-q' }, {}, { globalSetup: setup });
    begin();
    for (let i = 0; i < 40; i += 1)
      r.onError({
        message: `Error: setup broke ${i}`,
        location: { file: setup, line: i + 1, column: 1 },
      });
    r.onEnd(fullResult('failed'));
    expect(terminal(dir).failures).toHaveLength(32);
  });

  it('does not close the run when the session outcome could not be written', () => {
    const dir = temp();
    const { r, lines, begin } = reporter(
      { dir },
      {
        openSink: (d, sessionId) => {
          const real = FileSink.open(d, sessionId);
          return {
            maxAttachmentBytes: real.maxAttachmentBytes,
            write: (event) => {
              if (event.eventType === 'session.finished') throw new Error('disk full');
              real.write(event);
            },
            storeAttachment: (bytes) => real.storeAttachment(bytes),
            storeAttachmentStream: (stream) => real.storeAttachmentStream(stream),
            close: () => real.close(),
          };
        },
      },
    );
    begin();
    const t = testCase();
    r.onTestBegin(t, testResult());
    r.onTestEnd(t, testResult());
    r.onEnd(fullResult('failed'));
    expect(events(dir).map((e) => e.eventType)).toEqual([
      'session.started',
      'attempt.started',
      'attempt.finished',
    ]);
    expect(lines.some((l) => l.includes('TERMINAL_OUTCOME_NOT_WRITTEN'))).toBe(true);
    expect(lines.some((l) => l.includes('run.finished'))).toBe(false);
  });
});
