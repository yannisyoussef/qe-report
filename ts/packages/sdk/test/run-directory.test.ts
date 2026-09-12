import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRunDirectory, runDirectoryName, sessionFileName } from '../src/index.js';

interface NamingCase {
  runId: string;
  directory: string;
  note: string;
}

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../protocol/fixtures/naming/run-directories.json', import.meta.url),
    'utf8',
  ),
) as { cases: NamingCase[] };

const SAFE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,47}-[0-9a-f]{12}$/u;

describe('run directories', () => {
  for (const c of corpus.cases) {
    it(c.note, () => {
      const name = runDirectoryName(c.runId);
      expect(name).toBe(c.directory);
      expect(name).toMatch(SAFE);
      expect(resolveRunDirectory('out', c.runId)).toBe(join('out', 'runs', name));
    });
  }

  it('keeps hostile identifiers below the runs directory', () => {
    const runs = resolve('out', 'runs');
    for (const id of [
      '../escape',
      '..\\escape',
      '/abs/olute',
      'C:\\evil',
      'a:b',
      '..',
      '.',
      '....//x',
      'x/../../y',
      '~/home',
      'a b',
    ]) {
      const dir = resolve(resolveRunDirectory('out', id));
      expect(dirname(dir), id).toBe(runs);
      expect(relative(runs, dir).startsWith('..'), id).toBe(false);
      expect(basename(dir), id).not.toMatch(/[/\\]/u);
    }
  });

  it('separates colliding stems and shares the contract with session files', () => {
    expect(runDirectoryName('run/a')).not.toBe(runDirectoryName('run_a'));
    expect(runDirectoryName('build-123')).toBe(runDirectoryName('build-123'));
    expect(`${runDirectoryName('build-123')}.ndjson`).toBe(sessionFileName('build-123'));
  });
});
