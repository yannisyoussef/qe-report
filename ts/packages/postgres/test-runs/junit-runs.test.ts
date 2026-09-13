import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadModel, buildReadModel } from 'qe-report-read-model';
import type { ProjectedRun } from 'qe-report-read-model';
import { PostgresQueries } from '../src/index.js';
import { NEVER, TestPostgres, facts, rowsIn } from '../test-integration/support.js';

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
    // The CI artifact drops empty directories, so a run without attachments may lack the folder.
    const isolated = readdirSync(isolatedRoot)
      .map((d) => join(isolatedRoot, d))
      .find(
        (d) => existsSync(join(d, 'attachments')) && readdirSync(join(d, 'attachments')).length > 0,
      );
    if (isolated === undefined) throw new Error('no isolated run carries the report entry');
    const local = await buildReadModel([
      { projectId: 'gradle', runDirectory: shared },
      { projectId: 'gradle-isolated', runDirectory: isolated },
    ]);
    expect(local.problems).toEqual([]);
    const gradleIsolatedRunId =
      local.model.runs().find((r) => r.projectId === 'gradle-isolated')?.runId ?? '';
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
      const result = await db.store.persistRunDirectory({
        projectId,
        runDirectory,
        expiresAt: NEVER,
      });
      expect(result.kind, runDirectory).toBe('inserted');
      const again = await db.store.persistRunDirectory({
        projectId,
        runDirectory,
        expiresAt: NEVER,
      });
      expect(again.kind, runDirectory).toBe('already_present');
    }
    // A second ingestion of the shared Gradle run, in another project and expiring at once: its
    // attachment bytes are the very bytes the retained copy references.
    const EXPIRED = new Date('2026-01-01T00:00:00.000Z');
    expect(
      (
        await db.store.persistRunDirectory({
          projectId: 'gradle-expiring',
          runDirectory: copies.gradle,
          expiresAt: EXPIRED,
        })
      ).kind,
    ).toBe('inserted');
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

    // The durable query surface over the same real output.
    const queries = new PostgresQueries(db.pool);
    for (const projectId of ['gradle', 'gradle-isolated', 'gradle-expiring']) {
      expect((await queries.getIndexStatus(projectId)).complete, projectId).toBe(true);
    }
    const listed = await queries.listRuns({ projectId: 'gradle' });
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]).toMatchObject({
      runId: 'run-gradle-consumer',
      verdict: 'failed',
      complete: true,
      closed: false,
      sessionCount: 3,
      scopeFailureCount: 1,
    });
    // The teardown scope failure still fails the run while its children stay passed.
    const childHistories = (gradle as ProjectedRun).executions.filter(
      (e) => e.runnerName !== undefined && e.test.historicalId !== undefined,
    );
    expect(childHistories.length).toBeGreaterThan(20);
    for (const e of childHistories) {
      const durable = await queries.getTestHistoryPage({
        projectId: 'gradle',
        runnerName: e.runnerName as string,
        historicalId: e.test.historicalId as string,
        limit: 50,
      });
      expect(durable.occurrences, e.executionId).toEqual(
        local.model.getTestHistory('gradle', e.runnerName as string, e.test.historicalId as string)
          .occurrences,
      );
      expect(
        await queries.getFlakinessSummary({
          projectId: 'gradle',
          runnerName: e.runnerName as string,
          historicalId: e.test.historicalId as string,
        }),
      ).toMatchObject({ flakyOccurrences: 0, everFlaky: false });
    }
    // The attachment the consumer publishes changes nothing about history.
    const withAttachment = (gradle as ProjectedRun).executions.find((e) =>
      e.attempts.some((a) => a.attachments.length > 0),
    );
    expect(withAttachment).toBeDefined();
    if (
      withAttachment?.runnerName !== undefined &&
      withAttachment.test.historicalId !== undefined
    ) {
      const page = await queries.getTestHistoryPage({
        projectId: 'gradle',
        runnerName: withAttachment.runnerName,
        historicalId: withAttachment.test.historicalId,
      });
      expect(page.occurrences.map((o) => o.executionId)).toContain(withAttachment.executionId);
    }
    // A full run still comes from its own source and equals the local projection.
    const fromSource = await queries.getRun('gradle', 'run-gradle-consumer');
    expect(fromSource && facts(fromSource)).toEqual(facts(gradle as ProjectedRun));

    // Retention on real output: the expiring copy goes, the run that shares its bytes keeps them.
    const sharedSha = reference.sha256;
    const isolatedRun = local.model.getRun('gradle-isolated', gradleIsolatedRunId);
    const isolatedSha = isolatedRun?.attachments[0]?.sha256;
    if (isolatedSha === undefined) throw new Error('the isolated run carries no attachment');
    expect(isolatedSha).not.toBe(sharedSha);
    await db.pool.query('UPDATE qe_run_retention SET expires_at = $1 WHERE project_id = $2', [
      EXPIRED,
      'gradle-isolated',
    ]);
    const report = await db.maintenance.run({ asOf: new Date('2026-06-01T00:00:00.000Z') });
    // The deleted runs took their derived rows with them; what remains is still fully indexed.
    expect((await queries.getIndexStatus('gradle')).complete).toBe(true);
    expect(await queries.getIndexStatus('gradle-isolated')).toMatchObject({
      totalRuns: 0,
      complete: true,
    });
    expect(
      await rowsIn(db.pool, 'qe_history_occurrences', 'project_id = $1', ['gradle-isolated']),
    ).toBe(0);
    expect((await queries.listRuns({ projectId: 'gradle' })).runs).toHaveLength(1);
    expect(report.expiredRuns.map((r) => r.projectId).sort()).toEqual([
      'gradle-expiring',
      'gradle-isolated',
    ]);
    expect(report.problems).toEqual([]);
    // The isolated run is gone from the archive entirely, and its own bytes with it.
    expect(await db.store.loadRun('gradle-isolated', gradleIsolatedRunId)).toBeUndefined();
    expect(await db.store.projectStoredRun('gradle-isolated', gradleIsolatedRunId)).toBeUndefined();
    expect(
      await rowsIn(db.pool, 'qe_run_source_lines', 'project_id = $1', ['gradle-isolated']),
    ).toBe(0);
    expect(await rowsIn(db.pool, 'qe_run_blobs', 'project_id = $1', ['gradle-isolated'])).toBe(0);
    expect(report.blobs.map((b) => b.sha256)).toEqual([isolatedSha]);
    expect(
      await db.store.openBlob('gradle-isolated', gradleIsolatedRunId, isolatedSha),
    ).toBeUndefined();
    // The retained Gradle run still replays, projects, and resolves its bytes.
    const retained = await db.store.projectStoredRun('gradle', 'run-gradle-consumer');
    expect(retained && facts(retained)).toEqual(facts(gradle as ProjectedRun));
    expect(await db.store.verifyStoredRunBlobs('gradle', 'run-gradle-consumer')).toEqual([
      {
        sha256: sharedSha,
        sizeBytes: reference.sizeBytes,
        storageKey: db.blobs.storageKey(sharedSha),
      },
    ]);
    const stillThere = await db.store.openBlob('gradle', 'run-gradle-consumer', sharedSha);
    expect(stillThere && (await readAll(stillThere.stream)).length).toBe(reference.sizeBytes);
  });
});
