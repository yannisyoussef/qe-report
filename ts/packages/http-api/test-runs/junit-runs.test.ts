import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReadModel, type ProjectedRun } from 'qe-report-read-model';
import { occurrenceDto, runDto } from '../src/dto.js';
import { encodeRunRef } from '../src/run-ref.js';
import {
  HttpHarness,
  call,
  stagingEntries,
  uploadRun,
  wholeHistory,
  wholeListing,
} from '../test-integration/harness.js';

/**
 * Real JUnit Platform adapter output, written by the Gradle consumer fixtures under
 * java/junit-platform/build/consumer-runs, uploaded through API v1 only: a project-scoped key
 * writes it, the directory it came from is deleted, and everything is read back over HTTP.
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

const harness = new HttpHarness();
beforeAll(() => harness.start());
afterAll(() => harness.stop());

describe('real JUnit runs through HTTP', () => {
  it('uploads the shared Gradle run and reads it back exactly as the local projection, bytes included', async () => {
    expect(existsSync(CONSUMER_RUNS), 'run ./gradlew :junit-platform:test first').toBe(true);
    const shared = join(
      CONSUMER_RUNS,
      'gradle',
      'runs',
      readdirSync(join(CONSUMER_RUNS, 'gradle', 'runs')).sort()[0] ?? '',
    );
    const local = await buildReadModel([{ projectId: 'gradle', runDirectory: shared }]);
    expect(local.problems).toEqual([]);
    const run = local.model.getRun('gradle', 'run-gradle-consumer') as ProjectedRun;
    const entry = run.attachments.find((a) => a.name === 'junit-report-entry');
    expect(entry, 'BravoTest publishes a TestReporter entry').toBeDefined();
    const entryBytes = readFileSync(join(shared, 'attachments', entry?.sha256 ?? ''));

    // Upload from a copy that is deleted afterwards: nothing below can read a run directory.
    const scratch = mkdtempSync(join(tmpdir(), 'qe-http-junit-'));
    mkdirSync(join(scratch, 'runs'));
    const copy = join(scratch, 'runs', 'shared');
    cpSync(shared, copy, { recursive: true });
    const service = await harness.service('junit');
    const token = await service.key('gradle');
    const uploaded = await uploadRun(service.base, token, copy);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({ outcome: 'inserted', runId: 'run-gradle-consumer' });
    rmSync(scratch, { recursive: true, force: true });
    expect(stagingEntries(service.stagingRoot)).toEqual([]);

    // A complete run the JUnit adapter never closed stays complete and open; the teardown
    // scope failure fails it while the children that passed stay passed.
    const listed = await wholeListing(service.base, token);
    expect(listed).toEqual([
      expect.objectContaining({
        runId: 'run-gradle-consumer',
        verdict: 'failed',
        complete: true,
        closed: false,
        scopeFailureCount: 1,
        executionCount: run.executions.length,
        attachmentCount: run.attachments.length,
      }),
    ]);
    const read = await call(service.base, token, 'GET', `/v1/runs/${encodeRunRef(run.runId)}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(runDto(run));
    expect(run.scopeFailures).toHaveLength(1);
    const foxtrot = run.executions.filter((e) =>
      e.test.path.some((s) => s.name === 'consumer.FoxtrotTest'),
    );
    expect(foxtrot.length).toBeGreaterThan(0);
    expect(foxtrot.some((e) => e.finalStatus === 'passed')).toBe(true);
    expect(foxtrot.some((e) => e.finalStatus === 'failed')).toBe(false);

    // Every history equals the local model's, page by page.
    let keys = 0;
    for (const e of run.executions) {
      if (e.runnerName === undefined || e.test.historicalId === undefined) continue;
      keys += 1;
      expect(
        await wholeHistory(service.base, token, e.runnerName, e.test.historicalId, 1),
        e.test.historicalId,
      ).toEqual(
        local.model
          .getTestHistory('gradle', e.runnerName, e.test.historicalId)
          .occurrences.map(occurrenceDto),
      );
    }
    expect(keys).toBeGreaterThan(3);

    // The TestReporter entry comes back from the durable store, byte for byte.
    const bytes = await fetch(
      `${service.base}/v1/runs/${encodeRunRef(run.runId)}/attachments/${entry?.sha256 ?? ''}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(entryBytes);
    // And it changes nothing about history: the execution that published it is one occurrence.
    const publisher = run.executions.find((e) =>
      e.attempts.some((a) => a.attachments.some((x) => x.sha256 === entry?.sha256)),
    );
    if (publisher?.runnerName !== undefined && publisher.test.historicalId !== undefined) {
      const history = await wholeHistory(
        service.base,
        token,
        publisher.runnerName,
        publisher.test.historicalId,
      );
      expect(history.filter((o) => o.runId === run.runId)).toHaveLength(1);
    }
  });
});
