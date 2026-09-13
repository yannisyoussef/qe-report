import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadModel, buildReadModel } from 'qe-report-read-model';
import type { ProjectedRun } from 'qe-report-read-model';
import { TestPostgres, facts } from '../test-integration/support.js';

/**
 * Real JUnit Platform adapter output, written by the Gradle and Maven consumer fixtures under
 * java/junit-platform/build/consumer-runs: the shared Gradle run and one isolated Gradle run are
 * archived in PostgreSQL and replayed into the same projection the local directories give.
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

const pgTest = new TestPostgres();
beforeAll(() => pgTest.start());
afterAll(() => pgTest.stop());

describe('real JUnit runs in PostgreSQL', () => {
  it('archive the shared Gradle run and an isolated run and replay them into the same projection', async () => {
    expect(existsSync(CONSUMER_RUNS), 'run ./gradlew :junit-platform:test first').toBe(true);
    const shared = join(
      CONSUMER_RUNS,
      'gradle',
      'runs',
      readdirSync(join(CONSUMER_RUNS, 'gradle', 'runs')).sort()[0] ?? '',
    );
    const isolatedRoot = join(CONSUMER_RUNS, 'gradle-isolated', 'runs');
    const isolated = join(isolatedRoot, readdirSync(isolatedRoot).sort()[0] ?? '');
    const local = await buildReadModel([
      { projectId: 'gradle', runDirectory: shared },
      { projectId: 'gradle-isolated', runDirectory: isolated },
    ]);
    expect(local.problems).toEqual([]);
    const db = await pgTest.database('junit');
    for (const [projectId, runDirectory] of [
      ['gradle', shared],
      ['gradle-isolated', isolated],
    ] as const) {
      const result = await db.store.persistRunDirectory({ projectId, runDirectory });
      expect(result.kind, runDirectory).toBe('inserted');
      const again = await db.store.persistRunDirectory({ projectId, runDirectory });
      expect(again.kind, runDirectory).toBe('already_present');
    }
    const fromDb: ProjectedRun[] = [];
    for (const run of local.model.runs()) {
      const stored = await db.store.loadRun(run.projectId, run.runId);
      expect(stored?.validationSummary).toMatchObject({ complete: true, closed: false });
      expect(stored?.attachmentsVerified).toBe(true);
      const projected = await db.store.projectStoredRun(run.projectId, run.runId);
      if (!projected) throw new Error(`missing ${run.runId}`);
      fromDb.push(projected);
    }
    const rebuilt = ReadModel.assemble(fromDb);
    expect(rebuilt.model.runs().map(facts)).toEqual(local.model.runs().map(facts));
    const gradle = rebuilt.model.getRun('gradle', 'run-gradle-consumer');
    expect(gradle?.sessions).toHaveLength(3);
    expect(gradle?.scopeFailures).toHaveLength(1);
    expect(gradle?.validator).toMatchObject({ verdict: 'failed', complete: true, closed: false });
    const children =
      gradle?.executions.filter((e) =>
        e.test.path.some((s) => s.name === 'consumer.FoxtrotTest'),
      ) ?? [];
    expect(children.map((e) => e.finalStatus).sort()).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
      'skipped',
    ]);
    for (const run of local.model.runs()) {
      for (const e of run.executions) {
        if (e.test.historicalId === undefined || e.runnerName === undefined) continue;
        expect(
          rebuilt.model.getTestHistory(run.projectId, e.runnerName, e.test.historicalId),
        ).toEqual(local.model.getTestHistory(run.projectId, e.runnerName, e.test.historicalId));
      }
    }
  });
});
