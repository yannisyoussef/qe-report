import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseEvent,
  type AttachmentAddedEvent,
  type UnknownEvent,
  type Event,
} from 'qe-report-protocol';
import {
  FileSink,
  REDACTED,
  ReportSession,
  captureEnvironment,
  Redactor,
  type ReportProblem,
  type ReportSink,
} from '../src/index.js';

const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'qe-session-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixed() {
  let t = Date.UTC(2026, 0, 1, 0, 0, 0);
  let n = 0;
  return {
    clock: () => new Date((t += 1000) - 1000),
    ids: () => `evt-${String(++n).padStart(4, '0')}`,
  };
}

const test = {
  executionId: 't-1',
  historicalId: 'suite::t-1',
  historicalIdStability: 'stable' as const,
  displayName: 'a test',
  path: [{ kind: 'file', name: 'a.spec' }],
};

describe('ReportSession', () => {
  it('produces deterministic output for a fixed clock and id generator', () => {
    const run = (): string => {
      const d = temp();
      const problems: ReportProblem[] = [];
      const s = ReportSession.start(
        {
          runId: 'run-1',
          sessionId: 'sess-1',
          sink: FileSink.open(d),
          ...fixed(),
          onProblem: (p) => problems.push(p),
        },
        { producer: { name: 'test', version: '0' } },
      );
      s.emit({
        eventType: 'attempt.started',
        payload: { attemptId: 'a-1', attemptNumber: 1, test },
      });
      s.attach(
        { attemptId: 'a-1', name: 'log', mediaType: 'text/plain' },
        Buffer.from('password=hunter2'),
      );
      s.emit({
        eventType: 'attempt.finished',
        payload: { attemptId: 'a-1', status: 'failed', failures: [{ message: 'token=abc' }] },
      });
      s.finishRun();
      s.close();
      expect(problems).toEqual([]);
      expect(s.summary()).toEqual({ eventsWritten: 6, eventsDropped: 0 });
      return readFileSync(join(d, 'events.ndjson'), 'utf8');
    };
    const a = run();
    expect(a).toBe(run());
    const lines = a
      .split('\n')
      .filter(Boolean)
      .map((l) => parseEvent(l) as Event);
    expect(lines.map((e) => e.eventType)).toEqual([
      'session.started',
      'attempt.started',
      'attachment.added',
      'attempt.finished',
      'session.finished',
      'run.finished',
    ]);
    expect(lines.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lines[0]?.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(lines[1]?.occurredAt).toBe('2026-01-01T00:00:01.000Z');
    const attachment = lines[2] as AttachmentAddedEvent;
    const redacted = Buffer.from(`password=${REDACTED}`);
    expect(attachment.payload.sha256).toBe(createHash('sha256').update(redacted).digest('hex'));
    expect(attachment.payload.sizeBytes).toBe(redacted.byteLength);
    const finished = lines[3] as Extract<Event, { eventType: 'attempt.finished' }>;
    expect(finished.payload.failures?.[0]?.message).toBe(`token=${REDACTED}`);
  });
  it('stores binary attachments untouched', () => {
    const d = temp();
    const s = ReportSession.start(
      { runId: 'r', sessionId: 's', sink: FileSink.open(d), ...fixed() },
      { producer: { name: 'test' } },
    );
    s.emit({ eventType: 'attempt.started', payload: { attemptId: 'a-1', attemptNumber: 1, test } });
    const png = Buffer.from('password=notreallyapng');
    s.attach({ attemptId: 'a-1', name: '../../etc/passwd', mediaType: 'image/png' }, png);
    s.close();
    const hash = createHash('sha256').update(png).digest('hex');
    expect(readFileSync(join(d, 'attachments', hash))).toEqual(png);
  });
  it('drops and reports an oversized event without throwing', () => {
    const problems: ReportProblem[] = [];
    const s = ReportSession.start(
      {
        runId: 'r',
        sessionId: 's',
        sink: FileSink.open(temp()),
        ...fixed(),
        onProblem: (p) => problems.push(p),
        maxEventBytes: 400,
      },
      { producer: { name: 'test' } },
    );
    expect(
      s.emit({
        eventType: 'attempt.finished',
        payload: { attemptId: 'a', status: 'failed', failures: [{ message: 'x'.repeat(500) }] },
      }),
    ).toBe(false);
    expect(problems.map((p) => p.kind)).toEqual(['EVENT_TOO_LARGE']);
    expect(
      s.emit({ eventType: 'attempt.finished', payload: { attemptId: 'a', status: 'passed' } }),
    ).toBe(true);
    s.close();
    expect(s.summary()).toEqual({ eventsWritten: 3, eventsDropped: 1 });
  });
  it('never lets a sink failure escape', () => {
    const broken: ReportSink = {
      write: () => {
        throw new Error('disk full');
      },
      storeAttachment: () => {
        throw new Error('disk full');
      },
      storeAttachmentStream: () => Promise.reject(new Error('disk full')),
      close: () => {
        throw new Error('disk full');
      },
    };
    const problems: ReportProblem[] = [];
    const s = ReportSession.start(
      { runId: 'r', sessionId: 's', sink: broken, ...fixed(), onProblem: (p) => problems.push(p) },
      { producer: { name: 'test' } },
    );
    expect(s.attach({ attemptId: 'a', name: 'x', mediaType: 'text/plain' }, Buffer.from('y'))).toBe(
      false,
    );
    s.close();
    expect(problems.map((p) => p.kind)).toEqual([
      'SINK_FAILURE',
      'SINK_FAILURE',
      'SINK_FAILURE',
      'SINK_FAILURE',
    ]);
  });
  it('drops events after the session finished and reports them', () => {
    const problems: ReportProblem[] = [];
    const s = ReportSession.start(
      {
        runId: 'r',
        sessionId: 's',
        sink: FileSink.open(temp()),
        ...fixed(),
        onProblem: (p) => problems.push(p),
      },
      { producer: { name: 'test' } },
    );
    s.finish();
    expect(
      s.emit({ eventType: 'attempt.finished', payload: { attemptId: 'a', status: 'passed' } }),
    ).toBe(false);
    expect(problems.map((p) => p.kind)).toEqual(['SESSION_FINISHED']);
    s.close();
  });
  it('rejects a raised event limit', () => {
    expect(() =>
      ReportSession.start(
        { runId: 'r', sessionId: 's', sink: FileSink.open(temp()), maxEventBytes: 2_000_000 },
        { producer: { name: 'x' } },
      ),
    ).toThrow();
  });
  it('captures environment by allowlist only, redacted', () => {
    const env = {
      CI: 'true',
      SECRET_TOKEN: 'abc',
      PATH: '/usr/bin',
      DB_URL: 'postgres://user:pw@host/db',
    };
    expect(captureEnvironment(['CI', 'DB_URL', 'MISSING'], Redactor.defaults(), env)).toEqual({
      CI: 'true',
      DB_URL: `postgres://${REDACTED}@host/db`,
    });
    expect(captureEnvironment(['SECRET_TOKEN'], Redactor.defaults(), env)).toEqual({
      SECRET_TOKEN: 'abc',
    });
  });
  it('keeps unknown ignorable events flowing through the sink', () => {
    const d = temp();
    const sink = FileSink.open(d);
    const unknown: UnknownEvent = {
      protocolVersion: '0.1.0',
      eventId: 'u',
      eventType: 'attempt.heartbeat',
      runId: 'r',
      sessionId: 's',
      sequence: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      ignorable: true,
      payload: { attemptId: 'a' },
    };
    sink.write(unknown);
    sink.close();
    expect(readFileSync(join(d, 'events.ndjson'), 'utf8')).toContain(
      '"eventType":"attempt.heartbeat"',
    );
  });
});
