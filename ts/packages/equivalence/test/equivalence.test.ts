import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateRunDirectory } from 'qe-report-validator';
import { replay } from '../src/replay.js';
import { scripted } from '../src/scripted.js';
import { FIXTURES_DIR, canonical } from '../../protocol/test/helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_OUT = join(HERE, '..', 'out');
const JAVA_OUT = join(HERE, '..', '..', '..', '..', 'java', 'sdk', 'build', 'equivalence');
const SCENARIOS = [
  'replay/junit',
  'replay/playwright',
  'replay/karate',
  'replay/forked',
  'scripted',
];

beforeAll(() => {
  rmSync(TS_OUT, { recursive: true, force: true });
  for (const name of ['junit', 'playwright', 'karate', 'forked'])
    replay(join(FIXTURES_DIR, 'runs', name), join(TS_OUT, 'replay', name));
  scripted(join(TS_OUT, 'scripted'));
});

describe('Java and TypeScript outputs are semantically equivalent', () => {
  it('Java reference output exists (run ./gradlew :sdk:equivalenceOutput first)', () => {
    expect(existsSync(join(JAVA_OUT, 'scripted', 'events'))).toBe(true);
  });
  for (const scenario of SCENARIOS) {
    describe(scenario, () => {
      const tsDir = join(TS_OUT, scenario);
      const javaDir = join(JAVA_OUT, scenario);
      it('both outputs validate as run directories and are complete', async () => {
        for (const dir of [tsDir, javaDir]) {
          const report = await validateRunDirectory(dir, { requireComplete: true });
          expect(
            report.diagnostics.filter((d) => d.severity === 'error'),
            dir,
          ).toEqual([]);
        }
      });
      it('session files have the same names and equal events after canonicalization, in order', () => {
        const tsFiles = readdirSync(join(tsDir, 'events')).sort();
        expect(tsFiles).toEqual(readdirSync(join(javaDir, 'events')).sort());
        for (const f of tsFiles) {
          const ts = readFileSync(join(tsDir, 'events', f), 'utf8')
            .split('\n')
            .filter(Boolean);
          const java = readFileSync(join(javaDir, 'events', f), 'utf8')
            .split('\n')
            .filter(Boolean);
          expect(ts.length, f).toBe(java.length);
          ts.forEach((line, i) =>
            expect(canonical(JSON.parse(line)), `${f} line ${i + 1}`).toBe(
              canonical(JSON.parse(java[i] ?? '')),
            ),
          );
        }
      });
      it('attachments have identical hashes and bytes', () => {
        const tsFiles = readdirSync(join(tsDir, 'attachments')).sort();
        const javaFiles = readdirSync(join(javaDir, 'attachments')).sort();
        expect(tsFiles).toEqual(javaFiles);
        for (const f of tsFiles) {
          expect(
            readFileSync(join(tsDir, 'attachments', f)).equals(
              readFileSync(join(javaDir, 'attachments', f)),
            ),
            f,
          ).toBe(true);
        }
      });
    });
  }
  it('the scripted run redacted the secrets it was given', () => {
    const dir = join(TS_OUT, 'scripted', 'events');
    const text = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('');
    for (const secret of [
      'abc.def.ghi',
      'user:pw@',
      'hunter2',
      'token=abc',
      'otp=1234',
      'password=secret',
      'token=xyz',
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('password=[REDACTED]');
  });
});
