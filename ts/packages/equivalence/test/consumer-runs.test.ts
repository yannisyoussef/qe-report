import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateRunDirectory } from 'qe-report-validator';

/**
 * The Gradle and Maven consumer fixtures of the JUnit Platform adapter write real run directories
 * under java/junit-platform/build/consumer-runs together with the counts the Java side observed.
 * This validates them with the protocol validator, as a platform would.
 */
const RUNS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'java',
  'junit-platform',
  'build',
  'consumer-runs',
);

interface Expectations {
  sessions: number;
  attempts: number;
  failedAttempts: number;
  scopeFailures: number;
  verdict: 'passed' | 'failed' | 'incomplete';
  closed: boolean;
}

/** Each consumer build wrote its runs under `<name>/runs/<run directory>`; every one validates alone. */
const runDirs: { name: string; dir: string }[] = existsSync(RUNS)
  ? readdirSync(RUNS).flatMap((name) => {
      const runs = join(RUNS, name, 'runs');
      if (!existsSync(runs)) return [];
      return readdirSync(runs)
        .filter((d) => existsSync(join(runs, d, 'expectations.json')))
        .map((d) => ({ name: `${name}/${d}`, dir: join(runs, d) }));
    })
  : [];

describe('consumer fixture runs', () => {
  it('exist (run ./gradlew :junit-platform:test first)', () => {
    const groups = new Set(runDirs.map((r) => r.name.split('/')[0]));
    expect([...groups].sort()).toEqual(['gradle', 'gradle-isolated', 'maven']);
    expect(runDirs.filter((r) => r.name.startsWith('gradle-isolated/'))).toHaveLength(3);
  });
  for (const { name, dir } of runDirs) {
    it(`${name} validates as a complete, open run with the observed counts and verdict`, async () => {
      const expected = JSON.parse(
        readFileSync(join(dir, 'expectations.json'), 'utf8'),
      ) as Expectations;
      const report = await validateRunDirectory(dir, { requireComplete: true });
      expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(report.summary).toMatchObject({
        sessions: expected.sessions,
        attempts: expected.attempts,
        failedAttempts: expected.failedAttempts,
        scopeFailures: expected.scopeFailures,
        verdict: expected.verdict,
        closed: expected.closed,
        complete: true,
        files: expected.sessions,
      });
    });
  }
});
