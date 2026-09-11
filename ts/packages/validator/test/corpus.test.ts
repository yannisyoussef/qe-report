import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateFile, validateLines, validateRunDirectory } from '../src/index.js';
import { FIXTURES_DIR, manifest, sessionFiles } from '../../protocol/test/helpers.js';

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
      protocolVersion: '0.1.0',
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
        protocolVersion: '0.1.0',
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
