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
  closed: boolean;
}

const names = existsSync(RUNS)
  ? readdirSync(RUNS).filter((n) => existsSync(join(RUNS, n, 'expectations.json')))
  : [];

describe('consumer fixture runs', () => {
  it('exist (run ./gradlew :junit-platform:test first)', () => {
    expect(names.sort()).toEqual(['gradle', 'maven']);
  });
  for (const name of names) {
    it(`${name} validates as a complete, open run with the observed counts`, async () => {
      const dir = join(RUNS, name);
      const expected = JSON.parse(
        readFileSync(join(dir, 'expectations.json'), 'utf8'),
      ) as Expectations;
      const report = await validateRunDirectory(dir, { requireComplete: true });
      expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(report.summary).toMatchObject({
        sessions: expected.sessions,
        attempts: expected.attempts,
        closed: expected.closed,
        complete: true,
        files: expected.sessions,
      });
    });
  }
});
