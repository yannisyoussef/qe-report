import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadModel, buildReadModel } from 'qe-report-read-model';
import type { ProjectedRun } from 'qe-report-read-model';
import { TestPostgres, facts } from '../test-integration/support.js';

/**
 * Real JUnit Platform adapter output, written by the Gradle and Maven consumer fixtures under
 * java/junit-platform/build/consumer-runs: the shared Gradle run and one isolated Gradle run are
 * archived in PostgreSQL with their attachment bytes, the copies they were read from are deleted,
 * and they are replayed into the same projection the original directories give.
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

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('real JUnit runs in PostgreSQL', () => {
  it('archive the shared Gradle run and an isolated run with their attachment bytes and replay them without the directories', async () => {
    expect(existsSync(CONSUMER_RUNS), 'run ./gradlew :junit-platform:test first').toBe(true);
    const shared = join(
      CONSUMER_RUNS,
      'gradle',
      'runs',
      readdirSync(join(CONSUMER_RUNS, 'gradle', 'runs')).sort()[0] ?? '',
    );
    const isolatedRoot = join(CONSUMER_RUNS, 'gradle-isolated', 'runs');
    const isolated = readdirSync(isolatedRoot)
      .map((d) => join(isolatedRoot, d))
      .find((d) => readdirSync(join(d, 'attachments')).length > 0);
    if (isolated === undefined) throw new Error('no isolated run carries the report entry');
    const local = await buildReadModel([
      { projectId: 'gradle', runDirectory: shared },
      { projectId: 'gradle-isolated', runDirectory: isolated },
    ]);
    expect(local.problems).toEqual([]);
    const gradleLocal = local.model.getRun('gradle', 'run-gradle-consumer');
    const entry = gradleLocal?.attachments.find((a) => a.name === 'junit-report-entry');
    expect(entry, 'BravoTest publishes a TestReporter entry').toBeDefined();
    expect(entry?.mediaType).toBe('text/plain');

    // Ingest from copies, then delete them: the verification phase has no run directory.
    const scratch = pgTest.scratch('junit');
    const copies = {
      gradle: join(scratch, 'runs', 'shared'),
      'gradle-isolated': join(scratch, 'runs', 'isolated'),
    };
    mkdirSync(join(scratch, 'runs'), { recursive: true });
    cpSync(shared, copies.gradle, { recursive: true });
    cpSync(isolated, copies['gradle-isolated'], { recursive: true });
    const db = await pgTest.database('junit');
    for (const [projectId, runDirectory] of Object.entries(copies)) {
      const result = await db.store.persistRunDirectory({ projectId, runDirectory });
      expect(result.kind, runDirectory).toBe('inserted');
      const again = await db.store.persistRunDirectory({ projectId, runDirectory });
      expect(again.kind, runDirectory).toBe('already_present');
    }
    rmSync(scratch, { recursive: true, force: true });

    const fromDb: ProjectedRun[] = [];
    for (const run of local.model.runs()) {
      const stored = await db.store.loadRun(run.projectId, run.runId);
      expect(stored?.validationSummary).toMatchObject({ complete: true, closed: false });
      expect(stored?.sourceAttachmentsVerified).toBe(true);
      expect(stored?.blobs.map((b) => b.sha256)).toEqual(
        [...new Set(run.attachments.map((a) => a.sha256))].sort(),
      );
      const verified = await db.store.verifyStoredRunBlobs(run.projectId, run.runId);
      expect(verified?.length).toBe(stored?.blobs.length);
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
    // The report entry resolves from the blob store alone, hashes to its declaration, and is the
    // text the consumer test published.
    const reference = gradle?.attachments.find((a) => a.name === 'junit-report-entry');
    if (!reference) throw new Error('report entry lost in replay');
    const opened = await db.store.openBlob('gradle', 'run-gradle-consumer', reference.sha256);
    if (!opened) throw new Error('report entry not catalogued');
    const bytes = await readAll(opened.stream);
    expect(bytes.length).toBe(reference.sizeBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(reference.sha256);
    expect(bytes.toString('utf8')).toContain('evidence: bravo report entry');
    expect(rebuilt.model.blobs().length).toBe(local.model.blobs().length);
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
