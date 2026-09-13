import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { TestCase } from 'qe-report-protocol';

/** Test-only: writes small protocol-valid run directories to exercise the projector. */
const ROOTS: string[] = [];
afterAll(() => {
  for (const d of ROOTS) rmSync(d, { recursive: true, force: true });
});
export interface EventSpec {
  readonly type: string;
  readonly payload: unknown;
  /** Producer clock; defaults to a second per event from the session's start. */
  readonly at?: string;
  readonly ignorable?: boolean;
}

export interface SessionSpec {
  readonly sessionId: string;
  readonly events: readonly EventSpec[];
  /** ISO instant of the first event; later events add one second each. */
  readonly startAt?: string;
}

export function freshRoot(name = 'root'): string {
  const d = mkdtempSync(join(tmpdir(), `qe-rm-${name}-`));
  ROOTS.push(d);
  return d;
}

/** Writes `<root>/runs/<dirName>` with one file per session and the attachment bytes given. */
export function writeRun(
  root: string,
  dirName: string,
  runId: string,
  sessions: readonly SessionSpec[],
  attachments: readonly Buffer[] = [],
): string {
  const dir = join(root, 'runs', dirName);
  mkdirSync(join(dir, 'events'), { recursive: true });
  for (const s of sessions) {
    const startAt = s.startAt ?? '2026-09-12T10:00:00.000+00:00';
    const base = Date.parse(startAt);
    const lines = s.events.map((e, i) =>
      JSON.stringify({
        protocolVersion: '0.3.0',
        eventId: `${s.sessionId}-${i + 1}`,
        eventType: e.type,
        runId,
        sessionId: s.sessionId,
        sequence: i + 1,
        occurredAt:
          e.at ??
          (i === 0 ? startAt : new Date(base + i * 1000).toISOString().replace('Z', '+00:00')),
        ...(e.ignorable === undefined ? {} : { ignorable: e.ignorable }),
        payload: e.payload,
      }),
    );
    writeFileSync(join(dir, 'events', `${s.sessionId}.ndjson`), lines.join('\n') + '\n');
  }
  if (attachments.length > 0) {
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    for (const bytes of attachments) writeFileSync(join(dir, 'attachments', sha256(bytes)), bytes);
  }
  return dir;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function started(runner: string | undefined, producer = 'fixture-producer'): EventSpec {
  return {
    type: 'session.started',
    payload: {
      producer: { name: producer },
      ...(runner === undefined ? {} : { runner: { name: runner } }),
    },
  };
}

export function finished(payload: Record<string, unknown> = {}): EventSpec {
  return { type: 'session.finished', payload };
}

export function testCase(
  executionId: string,
  historicalId: string | undefined,
  stability: TestCase['historicalIdStability'] = historicalId === undefined
    ? 'unavailable'
    : 'stable',
  extra: Partial<TestCase> = {},
): TestCase {
  return {
    executionId,
    ...(historicalId === undefined ? {} : { historicalId }),
    historicalIdStability: stability,
    displayName: extra.displayName ?? executionId,
    path: extra.path ?? [{ kind: 'file', name: 'spec.ts' }],
    ...(extra.tags === undefined ? {} : { tags: extra.tags }),
    ...(extra.labels === undefined ? {} : { labels: extra.labels }),
    ...(extra.location === undefined ? {} : { location: extra.location }),
  };
}

export function attemptStarted(
  attemptId: string,
  attemptNumber: number,
  test: TestCase,
): EventSpec {
  return { type: 'attempt.started', payload: { attemptId, attemptNumber, test } };
}

export function attemptFinished(
  attemptId: string,
  status: string,
  extra: Record<string, unknown> = {},
): EventSpec {
  return { type: 'attempt.finished', payload: { attemptId, status, ...extra } };
}

/** A whole execution in one session: attempts numbered from 1, each `[status, extra]`. */
export function execution(
  test: TestCase,
  attempts: readonly (readonly [string, Record<string, unknown>?])[],
  options: { readonly unfinishedLast?: boolean } = {},
): EventSpec[] {
  const out: EventSpec[] = [];
  attempts.forEach(([status, extra], i) => {
    const id = `${test.executionId}-a${i + 1}`;
    out.push(attemptStarted(id, i + 1, test));
    if (!(options.unfinishedLast === true && i === attempts.length - 1))
      out.push(attemptFinished(id, status, extra ?? {}));
  });
  return out;
}

export function attachment(
  attemptId: string,
  bytes: Buffer,
  extra: Record<string, unknown> = {},
): EventSpec {
  return {
    type: 'attachment.added',
    payload: {
      attemptId,
      name: 'log',
      mediaType: 'text/plain',
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      ...extra,
    },
  };
}

export function scopeFailed(
  path: readonly { kind: string; name: string }[],
  message: string,
): EventSpec {
  return { type: 'scope.failed', payload: { path, failures: [{ message }] } };
}

/** One session, one runner, the given attempts of one test; the default shape of most cases. */
export function simpleRun(
  root: string,
  dirName: string,
  runId: string,
  runner: string,
  body: readonly EventSpec[],
  sessionFinished: Record<string, unknown> = {},
  options: {
    readonly sessionId?: string;
    readonly startAt?: string;
    readonly producer?: string;
  } = {},
): string {
  return writeRun(root, dirName, runId, [
    {
      sessionId: options.sessionId ?? 's-1',
      ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
      events: [started(runner, options.producer), ...body, finished(sessionFinished)],
    },
  ]);
}
