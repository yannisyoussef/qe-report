import { describe, expect, it } from 'vitest';
import { errorType, expectedStatus, failure, location, status } from '../src/mapping.js';
import type { TestResult } from '@playwright/test/reporter';
import { ROOT } from './fakes.js';

const ROOTS = { rootDir: ROOT, all: [ROOT] };

const ESC = String.fromCharCode(0x1b);

describe('status', () => {
  it('maps every Playwright result status', () => {
    expect(status('passed')).toBe('passed');
    expect(status('failed')).toBe('failed');
    expect(status('timedOut')).toBe('failed');
    expect(status('skipped')).toBe('skipped');
    expect(status('interrupted')).toBe('inconclusive');
    expect(status('later' as TestResult['status'])).toBeUndefined();
  });

  it('carries only the expectations the protocol has', () => {
    expect(expectedStatus('passed')).toBe('passed');
    expect(expectedStatus('failed')).toBe('failed');
    expect(expectedStatus('skipped')).toBe('skipped');
    expect(expectedStatus('timedOut')).toBeUndefined();
    expect(expectedStatus('interrupted')).toBeUndefined();
  });
});

describe('failure', () => {
  it('strips escapes, removes the root, types the error, and relativises the location', () => {
    const f = failure(
      {
        message: `TypeError: ${ESC}[31mbad${ESC}[39m value`,
        stack: `TypeError: bad value\n    at ${ROOT}/tests/a.spec.ts:3:5`,
        location: { file: `${ROOT}/tests/a.spec.ts`, line: 3, column: 5 },
        cause: { message: 'root cause', stack: `Error: root cause\n    at ${ROOT}/lib.ts:1:1` },
      },
      ROOTS,
      'test',
    );
    expect(f).toEqual({
      message: 'TypeError: bad value',
      type: 'TypeError',
      stackTrace:
        'TypeError: bad value\n    at tests/a.spec.ts:3:5\nCaused by: Error: root cause\n    at lib.ts:1:1',
      phase: 'test',
      location: { file: 'tests/a.spec.ts', line: 3, column: 5 },
    });
  });

  it('falls back to the value and omits what it cannot know', () => {
    expect(failure({ value: 'thrown string' }, ROOTS, undefined)).toEqual({
      message: 'thrown string',
    });
    expect(failure({}, ROOTS, undefined)).toEqual({ message: 'error without a message' });
  });

  it('types only a leading class name', () => {
    expect(errorType('Error: expect(received).toBe(expected)', undefined)).toBe('Error');
    expect(errorType('Test timeout of 700ms exceeded.', undefined)).toBeUndefined();
    expect(errorType('boom', 'TimeoutError: boom\n at x')).toBe('TimeoutError');
    expect(errorType('boom', 'at x')).toBeUndefined();
  });

  it('bounds a huge message and stack', () => {
    const f = failure(
      { message: 'm'.repeat(100_000), stack: 's'.repeat(300_000) },
      ROOTS,
      undefined,
    );
    expect(f.message.length).toBeLessThanOrEqual(65_536);
    expect(f.stackTrace?.length).toBeLessThanOrEqual(262_144);
    expect(f.message).toContain('[truncated');
  });
});

describe('location', () => {
  it('reports only files inside the root', () => {
    expect(location(ROOT, { file: `${ROOT}/tests/a.spec.ts`, line: 2, column: 0 })).toEqual({
      file: 'tests/a.spec.ts',
      line: 2,
    });
    expect(location(ROOT, { file: '/elsewhere/x.ts', line: 1, column: 1 })).toBeUndefined();
    expect(location(ROOT, undefined)).toBeUndefined();
  });
});

describe('mediaType', () => {
  it('keeps a well-formed type and replaces anything else by the opaque default', async () => {
    const { mediaType } = await import('../src/mapping.js');
    expect(mediaType('image/png')).toBe('image/png');
    expect(mediaType(' text/plain; charset=utf-8 ')).toBe('text/plain; charset=utf-8');
    expect(mediaType('application/vnd.api+json')).toBe('application/vnd.api+json');
    expect(mediaType('')).toBe('application/octet-stream');
    expect(mediaType('text/plain;version=1')).toBe('text/plain;version=1');
    expect(mediaType('text/plain; x="quoted"')).toBe('application/octet-stream');
    expect(mediaType('not a type')).toBe('application/octet-stream');
  });
});

describe('withinBudget', () => {
  it('keeps every failure while the text fits, then drops stacks, then failures', async () => {
    const { withinBudget } = await import('../src/mapping.js');
    const small = [{ message: 'a' }, { message: 'b', stackTrace: 'x' }];
    expect(withinBudget(small)).toEqual(small);
    const stacks = Array.from({ length: 6 }, (_, i) => ({
      message: `failure ${i}`,
      stackTrace: 's'.repeat(200 * 1024),
    }));
    const kept = withinBudget(stacks);
    expect(kept).toHaveLength(6);
    expect(kept.slice(0, 3).every((f) => f.stackTrace !== undefined)).toBe(true);
    expect(kept.slice(3).every((f) => f.stackTrace === undefined)).toBe(true);
    const messages = Array.from({ length: 4 }, (_, i) => ({ message: `${i}`.repeat(300 * 1024) }));
    const cut = withinBudget(messages);
    expect(cut).toHaveLength(3);
    expect(cut.at(-1)?.message).toBe(
      '[2 further failure(s) omitted: their text exceeded the event size budget]',
    );
    const bytes = (fs: readonly { message: string; stackTrace?: string }[]) =>
      fs.reduce(
        (n, f) => n + Buffer.byteLength(f.message) + Buffer.byteLength(f.stackTrace ?? ''),
        0,
      );
    expect(bytes(kept)).toBeLessThanOrEqual(768 * 1024);
    expect(bytes(cut)).toBeLessThanOrEqual(768 * 1024 + 100);
  });
});
