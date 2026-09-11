import type { TestCase, TestError, TestResult } from '@playwright/test/reporter';
import type { ExpectedStatus, Failure, FailurePhase, Location, Status } from 'qe-report-protocol';
import {
  bounded,
  FAILURE_TEXT_BUDGET,
  MAX_FILE,
  MAX_MEDIA_TYPE,
  MAX_MESSAGE,
  MAX_STACK,
  MAX_TYPE,
  relativeSource,
  stripAnsi,
  withoutRoots,
} from './text.js';

/** Playwright's result status to the protocol status; the native word travels in rawStatus. */
export function status(raw: TestResult['status']): Status | undefined {
  switch (raw) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'timedOut':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'interrupted':
      return 'inconclusive';
    default:
      return undefined;
  }
}

/**
 * The author's declared expectation. `test.fail` declares `failed`, `test.skip` and `test.fixme`
 * declare `skipped`; anything else Playwright's type admits is not an authored expectation the
 * protocol can carry and yields undefined.
 */
export function expectedStatus(raw: TestCase['expectedStatus']): ExpectedStatus | undefined {
  switch (raw) {
    case 'passed':
    case 'failed':
    case 'skipped':
      return raw;
    default:
      return undefined;
  }
}

/** A source location inside the root directory; nothing outside it is reported. */
export function location(
  rootDir: string,
  loc: { file: string; line?: number; column?: number } | undefined,
): Location | undefined {
  if (loc === undefined) return undefined;
  const file = relativeSource(rootDir, loc.file);
  if (file.startsWith('../') || file === '..') return undefined;
  return {
    file: bounded(file, MAX_FILE),
    ...(loc.line !== undefined && loc.line > 0 ? { line: loc.line } : {}),
    ...(loc.column !== undefined && loc.column > 0 ? { column: loc.column } : {}),
  };
}

const ERROR_TYPE = /^((?:[A-Za-z_$][\w$]*)?(?:Error|Exception)): /u;

/** The error's own class name when its message or stack starts with one, as Node prints them. */
export function errorType(message: string, stack: string | undefined): string | undefined {
  const m = ERROR_TYPE.exec(message) ?? (stack === undefined ? null : ERROR_TYPE.exec(stack));
  return m?.[1];
}

/** Where sources live: Playwright's root directory, the configuration's, and the working one. */
export interface Roots {
  /** Playwright's `rootDir`: locations and paths are relative to it. */
  readonly rootDir: string;
  /** Every directory removed from free text, `rootDir` first. */
  readonly all: readonly string[];
}

/** One Playwright error as a protocol failure. Free text is plain (no terminal escapes). */
export function failure(error: TestError, roots: Roots, phase: FailurePhase | undefined): Failure {
  const rootDir = roots.rootDir;
  const rawMessage = error.message ?? error.value ?? 'error without a message';
  const message = withoutRoots(stripAnsi(rawMessage), roots.all);
  const stackParts: string[] = [];
  if (error.stack !== undefined) stackParts.push(withoutRoots(stripAnsi(error.stack), roots.all));
  let cause = error.cause;
  for (let depth = 0; cause !== undefined && depth < 8; depth += 1) {
    const text = cause.stack ?? cause.message ?? cause.value ?? '';
    stackParts.push(`Caused by: ${withoutRoots(stripAnsi(text), roots.all)}`);
    cause = cause.cause;
  }
  const type = errorType(message, stackParts[0]);
  const loc = location(rootDir, error.location);
  return {
    message: bounded(message, MAX_MESSAGE),
    ...(type !== undefined ? { type: bounded(type, MAX_TYPE) } : {}),
    ...(stackParts.length > 0 ? { stackTrace: bounded(stackParts.join('\n'), MAX_STACK) } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(loc !== undefined ? { location: loc } : {}),
  };
}

/** The key under which a step's error is matched with the same error on the attempt. */
export function errorKey(error: TestError): string {
  return `${error.message ?? ''}\n${error.stack ?? ''}`;
}

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(?:;\\s*${TOKEN}=${TOKEN})*$`, 'u');

/** A media type as the protocol expects it; anything else becomes the opaque default. */
export function mediaType(contentType: string): string {
  const t = contentType.trim();
  return t.length <= MAX_MEDIA_TYPE && MEDIA_TYPE.test(t) ? t : 'application/octet-stream';
}

function withoutStack(f: Failure): Failure {
  return {
    message: f.message,
    ...(f.type !== undefined ? { type: f.type } : {}),
    ...(f.phase !== undefined ? { phase: f.phase } : {}),
    ...(f.location !== undefined ? { location: f.location } : {}),
  };
}

/**
 * Keeps a failure list within the event budget: every failure keeps its message; beyond the
 * budget, stack traces go first, then whole failures, replaced by one marker that counts them.
 */
export function withinBudget(failures: readonly Failure[]): Failure[] {
  const size = (f: Failure): number =>
    Buffer.byteLength(f.message, 'utf8') + Buffer.byteLength(f.stackTrace ?? '', 'utf8');
  if (failures.reduce((n, f) => n + size(f), 0) <= FAILURE_TEXT_BUDGET) return [...failures];
  const out: Failure[] = [];
  let omitted = 0;
  let used = 0;
  for (const f of failures) {
    let candidate = f;
    if (used + size(candidate) > FAILURE_TEXT_BUDGET && candidate.stackTrace !== undefined)
      candidate = withoutStack(candidate);
    if (used + size(candidate) > FAILURE_TEXT_BUDGET) {
      omitted += 1;
      continue;
    }
    used += size(candidate);
    out.push(candidate);
  }
  if (omitted > 0)
    out.push({
      message: `[${omitted} further failure(s) omitted: their text exceeded the event size budget]`,
    });
  return out;
}
