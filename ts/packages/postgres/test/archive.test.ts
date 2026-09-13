import { cpSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRunDirectorySnapshot, type ValidatedSourceLine } from 'qe-report-validator';
import {
  FINGERPRINT_VERSION,
  buildArchive,
  contentFingerprint,
  orderLines,
} from '../src/archive.js';
import { FIXTURES_DIR, manifest } from '../../protocol/test/helpers.js';
import { freshRoot } from '../../read-model/test/synthetic.js';

const line = (
  overrides: Partial<ValidatedSourceLine> & { readonly eventId: string },
): ValidatedSourceLine => ({
  rawLine: `{"eventId":"${overrides.eventId}"}`,
  runId: 'r',
  sessionId: 's',
  sequence: 1,
  protocolVersion: '0.3.0',
  eventType: 'session.started',
  canonicalSha256: 'a'.repeat(64),
  disposition: 'accepted',
  sourceFile: 'f',
  sourceLine: 1,
  ...overrides,
});

describe('storage order', () => {
  it('orders by session id, sequence, event id, then source occurrence, and numbers from zero', () => {
    const lines = [
      line({ eventId: 'b-2', sessionId: 'b', sequence: 2 }),
      line({ eventId: 'a-1', sessionId: 'a', sequence: 1 }),
      line({ eventId: 'b-1', sessionId: 'b', sequence: 1 }),
      line({
        eventId: 'b-1',
        sessionId: 'b',
        sequence: 1,
        disposition: 'duplicate',
        sourceLine: 9,
      }),
      line({ eventId: 'a-2', sessionId: 'a', sequence: 2 }),
    ];
    const ordered = orderLines(lines);
    expect(
      ordered.map((l) => [l.storageOrdinal, l.sessionId, l.sequence, l.eventId, l.disposition]),
    ).toEqual([
      [0, 'a', 1, 'a-1', 'accepted'],
      [1, 'a', 2, 'a-2', 'accepted'],
      [2, 'b', 1, 'b-1', 'accepted'],
      [3, 'b', 1, 'b-1', 'duplicate'],
      [4, 'b', 2, 'b-2', 'accepted'],
    ]);
    expect(orderLines([...lines].reverse()).map((l) => l.eventId)).toEqual(
      ordered.map((l) => l.eventId),
    );
  });

  it('compares session ids by code unit, not by locale', () => {
    const ids = orderLines([
      line({ eventId: 'x', sessionId: 'worker-10' }),
      line({ eventId: 'y', sessionId: 'worker-2' }),
      line({ eventId: 'z', sessionId: 'Worker-1' }),
    ]).map((l) => l.sessionId);
    expect(ids).toEqual(['Worker-1', 'worker-10', 'worker-2']);
  });
});

describe('content fingerprint', () => {
  it('ignores line order, duplicates, and duplicated digests, and is versioned', () => {
    const a = line({ eventId: 'a', canonicalSha256: '1'.repeat(64) });
    const b = line({ eventId: 'b', canonicalSha256: '2'.repeat(64), disposition: 'ignored' });
    const dup = line({ eventId: 'a', canonicalSha256: '1'.repeat(64), disposition: 'duplicate' });
    const f = contentFingerprint([a, b]);
    expect(f).toMatch(/^[0-9a-f]{64}$/u);
    expect(contentFingerprint([b, a])).toBe(f);
    expect(contentFingerprint([a, b, dup])).toBe(f);
    expect(contentFingerprint([a, dup, b, dup])).toBe(f);
    expect(contentFingerprint([a])).not.toBe(f);
    expect(
      contentFingerprint([
        a,
        line({ eventId: 'b', canonicalSha256: '3'.repeat(64), disposition: 'ignored' }),
      ]),
    ).not.toBe(f);
    expect(FINGERPRINT_VERSION).toBe(1);
  });

  it('is the same for a fixture run whatever the enumeration order of its session files', async () => {
    for (const fixture of [
      'runs/forked',
      'runs/playwright',
      'runs/coordinator',
      'runs/retry-across-sessions',
    ]) {
      const original = await validateRunDirectorySnapshot(join(FIXTURES_DIR, fixture), {
        retainSourceLines: true,
      });
      const root = freshRoot('fp');
      const copy = join(root, 'copy');
      mkdirSync(root, { recursive: true });
      cpSync(join(FIXTURES_DIR, fixture), copy, { recursive: true });
      const files = readdirSync(join(copy, 'events')).sort();
      files.forEach((f, i) =>
        renameSync(
          join(copy, 'events', f),
          join(copy, 'events', `${String(files.length - i).padStart(3, '0')}-${f}`),
        ),
      );
      const reversed = await validateRunDirectorySnapshot(copy, { retainSourceLines: true });
      expect(contentFingerprint(reversed.sourceLines), fixture).toBe(
        contentFingerprint(original.sourceLines),
      );
      const a = buildArchive(original, true);
      const b = buildArchive(reversed, true);
      expect(
        b.lines.map((l) => [l.storageOrdinal, l.eventId, l.disposition, l.canonicalSha256]),
        fixture,
      ).toEqual(
        a.lines.map((l) => [l.storageOrdinal, l.eventId, l.disposition, l.canonicalSha256]),
      );
      expect(b.lines.map((l) => l.rawLine)).toEqual(a.lines.map((l) => l.rawLine));
    }
  });

  it('changes when an unknown optional field changes, and not when only a duplicate line is added', async () => {
    const base = await validateRunDirectorySnapshot(
      join(FIXTURES_DIR, 'runs/duplicate-event-identical'),
      {
        retainSourceLines: true,
      },
    );
    const withoutDuplicate = base.sourceLines.filter((l) => l.disposition !== 'duplicate');
    expect(contentFingerprint(withoutDuplicate)).toBe(contentFingerprint(base.sourceLines));
    const forward = base.sourceLines.map((l, i) =>
      i === 0 ? { ...l, canonicalSha256: 'f'.repeat(64) } : l,
    );
    expect(contentFingerprint(forward)).not.toBe(contentFingerprint(base.sourceLines));
  });

  it('builds an archive for every valid fixture with the validator summary and protocol versions', async () => {
    for (const run of manifest().runs.filter((r) => r.outcome === 'VALID')) {
      const validated = await validateRunDirectorySnapshot(join(FIXTURES_DIR, run.dir), {
        retainSourceLines: true,
      });
      const archive = buildArchive(validated, true);
      expect(archive.lines.length, run.dir).toBe(validated.sourceLines.length);
      expect(
        archive.lines.map((l) => l.storageOrdinal),
        run.dir,
      ).toEqual(archive.lines.map((_, i) => i));
      expect(archive.summary, run.dir).toEqual(validated.report.summary);
      expect(
        archive.protocolVersions.every((v) => v.startsWith('0.3.')),
        run.dir,
      ).toBe(true);
      expect(
        archive.lines.filter((l) => l.disposition === 'duplicate'),
        run.dir,
      ).toHaveLength(validated.report.summary.duplicates);
      expect(
        archive.lines.filter((l) => l.disposition === 'ignored'),
        run.dir,
      ).toHaveLength(validated.report.summary.ignored);
    }
  });
});
