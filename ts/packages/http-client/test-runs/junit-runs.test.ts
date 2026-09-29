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
import { runDto } from '../../http-api/src/dto.js';
import { HttpHarness, call } from '../../http-api/test-integration/harness.js';
import { runUpload } from '../src/index.js';

/**
 * The producer-neutral path: a real Gradle JUnit Platform build writes a run directory, the
 * build finishes, and the generic command uploads that directory to the service. No Java code
 * speaks HTTP, and the uploader knows nothing of JUnit.
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

describe('a real Gradle run, uploaded after the build', () => {
  it('is archived by the command and reads back as the local projection does', async () => {
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

    // The build's output is copied and the copy uploaded, then deleted: what the service holds
    // came over HTTP, and nothing below reads a run directory.
    const scratch = mkdtempSync(join(tmpdir(), 'qe-upload-junit-'));
    mkdirSync(join(scratch, 'runs'));
    const copy = join(scratch, 'runs', 'gradle');
    cpSync(shared, copy, { recursive: true });

    const service = await harness.service('junit_upload');
    const token = await service.key('gradle');
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUpload(
      ['--run-dir', copy, '--retention-ms', '86400000', '--json'],
      { QE_REPORT_API_KEY: token, QE_REPORT_URL: service.base },
      { out: (t) => out.push(t), err: (t) => err.push(t) },
    );
    expect(code, err.join('')).toBe(0);
    const uploaded = JSON.parse(out.join('')) as { outcome: string; runId: string; runRef: string };
    expect(uploaded).toMatchObject({ outcome: 'inserted', runId: 'run-gradle-consumer' });
    expect(err.join('')).not.toContain(token);
    rmSync(scratch, { recursive: true, force: true });

    // The Java-produced bytes were archived untransformed: the service projects them into
    // exactly what the read model projects locally.
    const remote = await call(service.base, token, 'GET', `/v1/runs/${uploaded.runRef}`);
    expect(remote.status).toBe(200);
    expect(remote.body).toEqual(runDto(run));
    // A complete run the adapter never closed stays complete and open; the teardown scope
    // failure fails the run and leaves its passed children alone.
    expect(remote.body.validator).toMatchObject({
      verdict: 'failed',
      complete: true,
      closed: false,
    });
    expect((remote.body.scopeFailures as unknown[]).length).toBe(1);
    const foxtrot = (
      remote.body.executions as { test: { path: { name: string }[] }; finalStatus?: string }[]
    ).filter((e) => e.test.path.some((s) => s.name === 'consumer.FoxtrotTest'));
    expect(foxtrot.length).toBeGreaterThan(0);
    expect(foxtrot.some((e) => e.finalStatus === 'passed')).toBe(true);
    expect(foxtrot.some((e) => e.finalStatus === 'failed')).toBe(false);

    // The TestReporter attachment comes back from the service's own store.
    const bytes = await fetch(
      `${service.base}/v1/runs/${uploaded.runRef}/attachments/${entry?.sha256 ?? ''}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(bytes.status).toBe(200);
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(entryBytes);

    // Uploading the same build output again is the same run, not a second one.
    const againOut: string[] = [];
    expect(
      await runUpload(
        ['--run-dir', shared, '--retention-ms', '86400000'],
        { QE_REPORT_API_KEY: token, QE_REPORT_URL: service.base },
        { out: (t) => againOut.push(t), err: (t) => err.push(t) },
      ),
    ).toBe(0);
    expect(againOut.join('')).toContain('(already_present)');
    const listed = await call(service.base, token, 'GET', '/v1/runs');
    expect((listed.body.runs as unknown[]).length).toBe(1);
  });
});
