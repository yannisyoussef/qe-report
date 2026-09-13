import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildReadModel } from '../src/index.js';
import type { ProjectedRun, ReadModel } from '../src/index.js';

/**
 * Real JUnit Platform adapter output: the Gradle and Maven consumer fixtures write run
 * directories under java/junit-platform/build/consumer-runs/<group>/runs, one output root per
 * group. The shared Gradle and Surefire runs hold several forked sessions of one run; the
 * isolated Gradle group holds three generated runs of one fork each.
 */
const CONSUMER_RUNS = join(
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

const groups = existsSync(CONSUMER_RUNS) ? readdirSync(CONSUMER_RUNS).sort() : [];

describe('real JUnit Platform runs', () => {
  let model: ReadModel;

  beforeAll(async () => {
    expect(groups).toEqual(['gradle', 'gradle-isolated', 'maven']);
    const build = await buildReadModel(
      groups.map((g) => ({ projectId: g, outputRoot: join(CONSUMER_RUNS, g) })),
    );
    expect(build.problems).toEqual([]);
    model = build.model;
    expect(model.runs().map((r) => r.projectId)).toEqual([
      'gradle',
      'gradle-isolated',
      'gradle-isolated',
      'gradle-isolated',
      'maven',
    ]);
  });

  it('reproduce the counts and verdict the Java side observed, complete and open', () => {
    for (const run of model.runs()) {
      const expected = JSON.parse(
        readFileSync(join(run.runDirectory, 'expectations.json'), 'utf8'),
      ) as Expectations;
      const attempts = run.executions.flatMap((e) => e.attempts);
      expect(run.sessions.length, run.runDirectory).toBe(expected.sessions);
      expect(attempts.length, run.runDirectory).toBe(expected.attempts);
      expect(attempts.filter((a) => a.status === 'failed').length, run.runDirectory).toBe(
        expected.failedAttempts,
      );
      expect(run.scopeFailures.length, run.runDirectory).toBe(expected.scopeFailures);
      expect(run.validator, run.runDirectory).toMatchObject({
        verdict: expected.verdict,
        closed: expected.closed,
        complete: true,
      });
      expect(run.executions.every((e) => e.attempts.length === 1 && e.complete)).toBe(true);
      expect(run.executions.every((e) => e.runnerName === 'junit-platform')).toBe(true);
      expect(run.sessions.every((s) => s.finished && s.status === undefined)).toBe(true);
      expect(run.sessions.every((s) => s.producer.name === 'qe-report-junit-platform')).toBe(true);
    }
  });

  it('keep the AfterAll scope failure beside the passed tests of its class', () => {
    const shared = model.runs().filter((r) => r.scopeFailures.length > 0);
    expect(shared.map((r) => r.projectId)).toEqual(['gradle', 'gradle-isolated', 'maven']);
    for (const run of shared) {
      const [failure] = run.scopeFailures;
      expect(failure?.path.map((s) => s.kind)).toEqual(['engine', 'class']);
      expect(failure?.path[1]?.name).toBe('consumer.FoxtrotTest');
      expect(failure?.failures[0]?.phase).toBe('teardown');
      const children = run.executions.filter((e) =>
        e.test.path.some((s) => s.kind === 'class' && s.name === 'consumer.FoxtrotTest'),
      );
      expect(children.map((e) => e.finalStatus).sort(), run.runDirectory).toEqual([
        'passed',
        'passed',
        'passed',
        'passed',
        'skipped',
      ]);
      expect(children.map((e) => e.attempts[0]?.rawStatus).sort()).toEqual([
        'SKIPPED',
        'SUCCESSFUL',
        'SUCCESSFUL',
        'SUCCESSFUL',
        'SUCCESSFUL',
      ]);
      const failing = run.executions.filter((e) => e.finalStatus === 'failed');
      expect(failing.map((e) => e.test.path[1]?.name)).toEqual(['consumer.CharlieTest']);
      expect(run.validator.verdict).toBe('failed');
    }
  });

  it('spread the shared runs over several sessions that each keep their own metadata', () => {
    const gradle = model.getRun('gradle', 'run-gradle-consumer') as ProjectedRun;
    const maven = model.getRun('maven', 'run-maven-consumer') as ProjectedRun;
    expect(gradle.sessions).toHaveLength(3);
    expect(maven.sessions).toHaveLength(6);
    for (const run of [gradle, maven]) {
      expect(run.sessions.every((s) => s.runner?.name === 'junit-platform')).toBe(true);
      expect(new Set(run.sessions.map((s) => s.sessionId)).size).toBe(run.sessions.length);
      const claimed = run.sessions.flatMap((s) => s.executionIds);
      expect(new Set(claimed).size).toBe(run.executions.length);
    }
  });

  it('index history by project, runner, and historical id; forks and projects never share', () => {
    const isolated = model.runs().filter((r) => r.projectId === 'gradle-isolated');
    expect(isolated).toHaveLength(3);
    const ids = [
      ...new Set(model.runs().flatMap((r) => r.executions.map((e) => e.test.historicalId ?? ''))),
    ].sort();
    expect(ids).toHaveLength(30);
    for (const id of ids) {
      // Every class ran in exactly one isolated fork, and once in each shared build.
      for (const project of ['gradle', 'gradle-isolated', 'maven']) {
        const history = model.getTestHistory(project, 'junit-platform', id);
        expect(
          history.occurrences.map((o) => o.runnerName),
          `${project} ${id}`,
        ).toEqual(['junit-platform']);
        expect(history.occurrences[0]?.projectId).toBe(project);
        expect(history.occurrences[0]?.historicalIdStability).toBe(
          id.includes('parameterized') ? 'uncertain' : 'stable',
        );
        expect(history.occurrences[0]?.attemptCount).toBe(1);
        expect(model.getFlakiness(project, 'junit-platform', id).everFlaky).toBe(false);
      }
      expect(model.getTestHistory('gradle', 'playwright', id).occurrences).toHaveLength(0);
    }
    const acrossForks = isolated.flatMap((r) => r.executions.map((e) => e.test.historicalId));
    expect(new Set(acrossForks).size).toBe(acrossForks.length);
  });

  it('keep the failing test failed in every run and the JUnit path native', () => {
    for (const run of model.runs()) {
      const failed = run.executions.filter((e) => e.finalStatus === 'failed');
      expect(failed.length, run.runDirectory).toBe(
        JSON.parse(readFileSync(join(run.runDirectory, 'expectations.json'), 'utf8'))
          .failedAttempts,
      );
      for (const e of run.executions) {
        expect(e.test.path.slice(0, 2).map((s) => s.kind)).toEqual(['engine', 'class']);
        expect(e.test.historicalId).toMatch(/^junit-jupiter:/u);
      }
    }
  });
});
