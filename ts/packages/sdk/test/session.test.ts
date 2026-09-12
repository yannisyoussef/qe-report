import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  sessionFileName,
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
const producer = { producer: { name: 'test', version: '0' }, runner: { name: 'fixture-runner' } };
const events = (d: string, sessionId: string): Event[] =>
  readFileSync(join(d, 'events', sessionFileName(sessionId)), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => parseEvent(l) as Event);

describe('ReportSession', () => {
  it('produces deterministic output for a fixed clock and id generator', () => {
    const run = (): string => {
      const d = temp();
      const problems: ReportProblem[] = [];
      const s = ReportSession.start(
        {
          runId: 'run-1',
          sessionId: 'sess-1',
          sink: FileSink.open(d, 'sess-1'),
          ...fixed(),
          onProblem: (p) => problems.push(p),
        },
        producer,
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
      return readFileSync(join(d, 'events', sessionFileName('sess-1')), 'utf8');
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
    const attachment = lines[2] as AttachmentAddedEvent;
    const redacted = Buffer.from(`password=${REDACTED}`);
    expect(attachment.payload.sha256).toBe(createHash('sha256').update(redacted).digest('hex'));
    const finished = lines[3] as Extract<Event, { eventType: 'attempt.finished' }>;
    expect(finished.payload.failures?.[0]?.message).toBe(`token=${REDACTED}`);
  });

  describe('lifecycle', () => {
    it('active -> session-finished -> run-finished, then nothing', () => {
      const d = temp();
      const problems: ReportProblem[] = [];
      const s = ReportSession.start(
        {
          runId: 'r',
          sessionId: 's',
          sink: FileSink.open(d, 's'),
          ...fixed(),
          onProblem: (p) => problems.push(p),
        },
        producer,
      );
      expect(s.state).toBe('active');
      expect(s.finish()).toBe(true);
      expect(s.state).toBe('session-finished');
      expect(
        s.emit({
          eventType: 'attempt.started',
          payload: { attemptId: 'a', attemptNumber: 1, test },
        }),
      ).toBe(false);
      expect(
        s.attach({ attemptId: 'a', name: 'x', mediaType: 'text/plain' }, Buffer.from('y')),
      ).toBe(false);
      expect(s.finish()).toBe(false);
      expect(s.finishRun()).toBe(true);
      expect(s.state).toBe('run-finished');
      expect(s.finishRun()).toBe(false);
      expect(s.emit({ eventType: 'session.finished', payload: {} })).toBe(false);
      s.close();
      expect(s.state).toBe('closed');
      expect(problems.map((p) => p.kind)).toEqual([
        'SESSION_FINISHED',
        'SESSION_FINISHED',
        'SESSION_FINISHED',
        'RUN_FINISHED',
        'RUN_FINISHED',
      ]);
      expect(events(d, 's').map((e) => e.eventType)).toEqual([
        'session.started',
        'session.finished',
        'run.finished',
      ]);
      expect(readdirSync(join(d, 'attachments'))).toEqual([]);
    });
    it('accepts scope failures while active and drops them after session.finished', () => {
      const d = temp();
      const problems: ReportProblem[] = [];
      const s = ReportSession.start(
        {
          runId: 'r',
          sessionId: 's',
          sink: FileSink.open(d, 's'),
          ...fixed(),
          onProblem: (p) => problems.push(p),
        },
        producer,
      );
      const failure = {
        eventType: 'scope.failed' as const,
        payload: {
          path: [{ kind: 'file', name: 'suite.spec' }],
          failures: [{ message: 'teardown token=abc' }],
        },
      };
      expect(s.emit(failure)).toBe(true);
      expect(s.finish()).toBe(true);
      expect(s.emit(failure)).toBe(false);
      s.close();
      expect(problems.map((p) => p.kind)).toEqual(['SESSION_FINISHED']);
      const written = events(d, 's');
      expect(written.map((e) => e.eventType)).toEqual([
        'session.started',
        'scope.failed',
        'session.finished',
      ]);
      const scope = written[1] as Extract<Event, { eventType: 'scope.failed' }>;
      expect(scope.payload.failures[0]?.message).toBe(`teardown token=${REDACTED}`);
    });

    it('run.finished from an active session finishes the session first', () => {
      const d = temp();
      const s = ReportSession.start(
        { runId: 'r', sessionId: 's', sink: FileSink.open(d, 's'), ...fixed() },
        producer,
      );
      expect(s.emit({ eventType: 'run.finished', payload: {} })).toBe(true);
      s.close();
      expect(events(d, 's').map((e) => e.eventType)).toEqual([
        'session.started',
        'session.finished',
        'run.finished',
      ]);
    });
    it('close finishes an active session and accepts nothing afterwards', () => {
      const d = temp();
      const problems: ReportProblem[] = [];
      const s = ReportSession.start(
        {
          runId: 'r',
          sessionId: 's',
          sink: FileSink.open(d, 's'),
          ...fixed(),
          onProblem: (p) => problems.push(p),
        },
        producer,
      );
      s.close();
      expect(s.finishRun()).toBe(false);
      expect(problems.map((p) => p.kind)).toEqual(['RUN_FINISHED']);
      expect(events(d, 's').map((e) => e.eventType)).toEqual([
        'session.started',
        'session.finished',
      ]);
    });
  });

  describe('bounded text attachments', () => {
    it('stores a text file exactly at the limit and refuses one byte more without reading it in', async () => {
      const d = temp();
      const problems: ReportProblem[] = [];
      const limit = 100_000;
      const s = ReportSession.start(
        {
          runId: 'r',
          sessionId: 's',
          sink: FileSink.open(d, 's', { maxAttachmentBytes: limit }),
          ...fixed(),
          onProblem: (p) => problems.push(p),
        },
        producer,
      );
      s.emit({
        eventType: 'attempt.started',
        payload: { attemptId: 'a-1', attemptNumber: 1, test },
      });
      const exact = join(d, 'exact.txt');
      const over = join(d, 'over.txt');
      writeFileSync(exact, 'x'.repeat(limit));
      writeFileSync(over, 'x'.repeat(limit + 1));
      expect(
        await s.attachFile({ attemptId: 'a-1', name: 'exact', mediaType: 'text/plain' }, exact),
      ).toBe(true);
      expect(
        await s.attachFile({ attemptId: 'a-1', name: 'over', mediaType: 'text/plain' }, over),
      ).toBe(false);
      expect(problems.map((p) => p.kind)).toEqual(['ATTACHMENT_TOO_LARGE']);
      expect(readdirSync(join(d, 'attachments'))).toHaveLength(1);
      s.close();
    });
    it('redacts a text file before hashing and streams a binary file untouched', async () => {
      const d = temp();
      const s = ReportSession.start(
        { runId: 'r', sessionId: 's', sink: FileSink.open(d, 's'), ...fixed() },
        producer,
      );
      s.emit({
        eventType: 'attempt.started',
        payload: { attemptId: 'a-1', attemptNumber: 1, test },
      });
      const text = join(d, 'log.txt');
      const bin = join(d, 'img.png');
      writeFileSync(text, 'Authorization: Bearer x');
      writeFileSync(bin, Buffer.from('password=notreallyapng'));
      expect(
        await s.attachFile({ attemptId: 'a-1', name: 'log', mediaType: 'text/plain' }, text),
      ).toBe(true);
      expect(
        await s.attachFile({ attemptId: 'a-1', name: '../../evil', mediaType: 'image/png' }, bin),
      ).toBe(true);
      s.close();
      const stored = readdirSync(join(d, 'attachments'))
        .map((n) => readFileSync(join(d, 'attachments', n), 'utf8'))
        .sort();
      expect(stored).toEqual([`Authorization: ${REDACTED}`, 'password=notreallyapng']);
    });
  });

  describe('session outcome', () => {
    it('writes the outcome redacted and closes the session, while a plain finish stays empty', () => {
      const d = temp();
      const problems: ReportProblem[] = [];
      const s = ReportSession.start(
        {
          runId: 'r',
          sessionId: 's',
          sink: FileSink.open(d, 's'),
          ...fixed(),
          onProblem: (p) => problems.push(p),
        },
        producer,
      );
      expect(
        s.finish({
          status: 'failed',
          rawStatus: 'timedout',
          failures: [
            {
              message: 'global setup broke Authorization: Bearer abc.def.ghi',
              type: 'Error',
              stackTrace: 'at global-setup.ts:3 password=hunter2',
              phase: 'setup',
            },
          ],
        }),
      ).toBe(true);
      expect(s.finish()).toBe(false);
      expect(s.state).toBe('session-finished');
      expect(problems.map((p) => p.kind)).toEqual(['SESSION_FINISHED']);
      s.close();
      const lines = readFileSync(join(d, 'events', readdirSync(join(d, 'events'))[0] ?? ''), 'utf8')
        .split('\n')
        .filter((l) => l !== '');
      const finished = JSON.parse(lines[1] ?? '{}') as {
        eventType: string;
        payload: {
          status: string;
          rawStatus: string;
          failures: { message: string; stackTrace: string; phase: string }[];
        };
      };
      expect(finished.eventType).toBe('session.finished');
      expect(finished.payload.status).toBe('failed');
      expect(finished.payload.rawStatus).toBe('timedout');
      expect(finished.payload.failures[0]?.message).toBe(
        'global setup broke Authorization: [REDACTED]',
      );
      expect(finished.payload.failures[0]?.stackTrace).toBe(
        'at global-setup.ts:3 password=[REDACTED]',
      );
      expect(finished.payload.failures[0]?.phase).toBe('setup');
      const plain = ReportSession.start(
        { runId: 'r', sessionId: 'p', sink: FileSink.open(d, 'p'), ...fixed() },
        producer,
      );
      plain.close();
      const plainLines = readFileSync(
        join(d, 'events', readdirSync(join(d, 'events')).find((n) => n.startsWith('p-')) ?? ''),
        'utf8',
      )
        .split('\n')
        .filter((l) => l !== '');
      expect((JSON.parse(plainLines[1] ?? '{}') as { payload: unknown }).payload).toEqual({});
    });
  });

  describe('session outcome fallbacks', () => {
    it('drops an outcome the protocol forbids, reports it, and still closes on close()', () => {
      const d = temp();
      const problems: ReportProblem[] = [];
      const s = ReportSession.start(
        {
          runId: 'r',
          sessionId: 's',
          sink: FileSink.open(d, 's'),
          ...fixed(),
          onProblem: (p) => problems.push(p),
        },
        producer,
      );
      expect(s.finish({ rawStatus: 'timedout' })).toBe(false);
      expect(s.finish({ failures: [{ message: 'x' }] })).toBe(false);
      expect(s.finish({ status: 'passed', failures: [{ message: 'x' }] })).toBe(false);
      expect(s.state).toBe('active');
      expect(problems.map((p) => p.kind)).toEqual([
        'INVALID_PAYLOAD',
        'INVALID_PAYLOAD',
        'INVALID_PAYLOAD',
      ]);
      s.close();
      expect(s.state).toBe('closed');
    });

    it('closes the session with what fits when the outcome exceeds the event limit', () => {
      const d = temp();
      const problems: ReportProblem[] = [];
      const s = ReportSession.start(
        {
          runId: 'r',
          sessionId: 's',
          sink: FileSink.open(d, 's'),
          ...fixed(),
          maxEventBytes: 700,
          onProblem: (p) => problems.push(p),
        },
        producer,
      );
      expect(
        s.finish({
          status: 'failed',
          rawStatus: 'timedout',
          failures: [{ message: 'x'.repeat(2_000) }],
        }),
      ).toBe(true);
      expect(s.state).toBe('session-finished');
      expect(problems.map((p) => p.kind)).toEqual(['EVENT_TOO_LARGE', 'EVENT_TOO_LARGE']);
      const lines = readFileSync(join(d, 'events', readdirSync(join(d, 'events'))[0] ?? ''), 'utf8')
        .split('\n')
        .filter((l) => l !== '');
      expect((JSON.parse(lines[1] ?? '{}') as { payload: unknown }).payload).toEqual({
        status: 'failed',
        rawStatus: 'timedout',
      });
    });
  });

  it('drops and reports an oversized event without throwing', () => {
    const problems: ReportProblem[] = [];
    const s = ReportSession.start(
      {
        runId: 'r',
        sessionId: 's',
        sink: FileSink.open(temp(), 's'),
        ...fixed(),
        onProblem: (p) => problems.push(p),
        maxEventBytes: 400,
      },
      producer,
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
      maxAttachmentBytes: 1,
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
      producer,
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
  it('rejects a raised event limit', () => {
    expect(() =>
      ReportSession.start(
        { runId: 'r', sessionId: 's', sink: FileSink.open(temp(), 's'), maxEventBytes: 2_000_000 },
        producer,
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
  });
  it('keeps unknown ignorable events flowing through the sink', () => {
    const d = temp();
    const sink = FileSink.open(d, 's');
    const unknown: UnknownEvent = {
      protocolVersion: '0.3.0',
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
    expect(readFileSync(join(d, 'events', sessionFileName('s')), 'utf8')).toContain(
      '"eventType":"attempt.heartbeat"',
    );
  });
});
