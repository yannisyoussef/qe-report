import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FullConfig } from '@playwright/test/reporter';
import { parseEvent, type Event, type UnknownEvent } from 'qe-report-protocol';
import { QeReportReporter, type ReporterHooks } from '../src/reporter.js';
import type { QeReportReporterOptions } from '../src/config.js';
import { ROOT, testCase, testResult, testStep } from './fakes.js';

/** Drives the reporter with fake Playwright objects; the consumer tests use the real runner. */
function reporter(options: QeReportReporterOptions, hooks: ReporterHooks = {}) {
  const lines: string[] = [];
  const r = new QeReportReporter(options, { env: {}, write: (l) => lines.push(l), ...hooks });
  const config = { rootDir: ROOT, version: '1.63.0', workers: 1, shard: null } as FullConfig;
  return { r, lines, begin: () => r.onBegin(config) };
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'qe-pw-'));
}

function events(dir: string): (Event | UnknownEvent)[] {
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
    r.onEnd();
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
    r.onEnd();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cannot open run directory');
    expect(lines[0]).toContain('this run is not reported');
  });

  it('refuses a session id whose file already exists', () => {
    const dir = temp();
    const first = reporter({ dir, sessionId: 'same' });
    first.begin();
    first.r.onEnd();
    const second = reporter({ dir, sessionId: 'same' });
    second.begin();
    expect(second.lines.join('\n')).toContain('EEXIST');
    expect(readdirSync(join(dir, 'events'))).toHaveLength(1);
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
    r.onEnd();
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
    r.onEnd();
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
    expect(r.onEnd()).toBeUndefined();
    expect(r.printsToStdio()).toBe(false);
  });

  it('closes the run only when it generated the run id', () => {
    const own = temp();
    const first = reporter({ dir: own });
    first.begin();
    first.r.onEnd();
    expect(events(own).map((e) => e.eventType)).toEqual([
      'session.started',
      'session.finished',
      'run.finished',
    ]);
    const shared = temp();
    const second = reporter({ dir: shared, runId: 'run-shared' });
    second.begin();
    second.r.onEnd();
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
    r.onEnd();
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
    r.onEnd();
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
    expect(existsSync(join(dir, 'events'))).toBe(true);
  });
});
