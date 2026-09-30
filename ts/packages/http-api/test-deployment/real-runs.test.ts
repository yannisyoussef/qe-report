import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReadModel, type ProjectedRun } from 'qe-report-read-model';
import { runDto } from '../src/dto.js';
import { ReferenceStack } from './stack.js';

/**
 * Real runner output through the reference deployment: an actual JUnit Platform run from the
 * Gradle consumer build, and an actual Playwright run, uploaded by the producer command over
 * HTTPS and read back through the proxy.
 *
 * Neither adapter's semantics are re-tested here; QE-008 and QE-010 cover those exhaustively.
 * What this proves is that a real producer's output survives the deployment: the edge, the
 * container boundary, the volume, and the read path, with the projection unchanged.
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

/** The projected run without its locator, which is the one field a transfer is allowed to change. */
function facts<T extends { runDirectory: string }>(run: T): Omit<T, 'runDirectory'> {
  const { runDirectory: _dir, ...rest } = run;
  void _dir;
  return rest;
}

const stack = new ReferenceStack('real');
let token = '';

beforeAll(async () => {
  await ReferenceStack.build();
  await stack.start();
  token = await stack.createKey('runners');
}, 900_000);

afterAll(async () => {
  await stack.stop();
}, 300_000);

describe('a real JUnit run through the deployment', () => {
  it('uploads with the producer command and reads back the same projection', async () => {
    const gradle = join(CONSUMER_RUNS, 'gradle', 'runs');
    expect(existsSync(gradle), 'run ./gradlew :junit-platform:test first').toBe(true);
    const directory = join(gradle, readdirSync(gradle).sort()[0] ?? '');

    // What the read model makes of the directory locally, before it goes anywhere.
    const local = await buildReadModel([{ projectId: 'runners', runDirectory: directory }]);
    expect(local.problems).toEqual([]);
    const expected = local.model.runs()[0] as ProjectedRun;

    const uploaded = await stack.uploadRun(directory, token);
    expect(uploaded.code, uploaded.stderr).toBe(0);
    const answer = JSON.parse(uploaded.stdout) as {
      runId: string;
      runRef: string;
      outcome: string;
    };
    expect(answer.outcome).toBe('inserted');
    expect(answer.runId).toBe(expected.runId);

    // The same run, as the deployment serves it: identical to the local projection in every fact.
    const served = await stack.request(`/v1/runs/${answer.runRef}`, { token });
    expect(served.status).toBe(200);
    expect(served.json()).toEqual(
      JSON.parse(JSON.stringify(runDto(facts(expected) as ProjectedRun))),
    );

    // The scope failure the Gradle fixture produces is still what makes the run fail.
    const summary = served.json<{
      validator: { verdict: string; complete: boolean; closed: boolean };
      scopeFailures: unknown[];
      sessions: unknown[];
    }>();
    expect(summary.validator).toMatchObject({ verdict: 'failed', complete: true, closed: false });
    expect(summary.scopeFailures).toHaveLength(1);
    expect(summary.sessions).toHaveLength(3);

    // The report entry the fixture publishes is an attachment, and it downloads byte for byte.
    const reference = expected.attachments[0];
    expect(reference, 'the consumer fixture publishes a report entry').toBeDefined();
    if (reference !== undefined) {
      const download = await stack.request(
        `/v1/runs/${answer.runRef}/attachments/${reference.sha256}`,
        { token },
      );
      expect(download.status).toBe(200);
      expect(download.body.length).toBe(reference.sizeBytes);
      const { createHash } = await import('node:crypto');
      expect(createHash('sha256').update(download.body).digest('hex')).toBe(reference.sha256);
    }

    // And the history of one of its tests answers, through the same edge.
    const execution = expected.executions.find(
      (e) => e.test.historicalId !== undefined && e.runnerName !== undefined,
    );
    expect(execution).toBeDefined();
    if (execution?.runnerName !== undefined && execution.test.historicalId !== undefined) {
      const history = await stack.request('/v1/history/query', {
        method: 'POST',
        token,
        contentType: 'application/json',
        body: JSON.stringify({
          runnerName: execution.runnerName,
          historicalId: execution.test.historicalId,
        }),
      });
      expect(history.status).toBe(200);
      expect(history.json<{ occurrences: unknown[] }>().occurrences.length).toBeGreaterThan(0);
    }
  });
});

describe('a real Playwright run through the deployment', () => {
  it('uploads one representative run and reads it back unchanged', async () => {
    // Produced here rather than fetched: this is the job that has the fixture and a browser.
    const { runPlaywright } = await import('../../playwright/test-consumer/harness.js');
    const outcome = await runPlaywright({ args: ['pass.spec.ts', '--project', 'desktop'] });
    expect(outcome.report.valid).toBe(true);

    const local = await buildReadModel([{ projectId: 'runners', outputRoot: outcome.outputRoot }]);
    expect(local.problems).toEqual([]);
    const expected = local.model.runs()[0] as ProjectedRun;

    const uploaded = await stack.uploadRun(outcome.runDir, token);
    expect(uploaded.code, uploaded.stderr).toBe(0);
    const answer = JSON.parse(uploaded.stdout) as {
      runId: string;
      runRef: string;
      outcome: string;
    };
    expect(answer.outcome).toBe('inserted');

    const served = await stack.request(`/v1/runs/${answer.runRef}`, { token });
    expect(served.status).toBe(200);
    expect(served.json()).toEqual(
      JSON.parse(JSON.stringify(runDto(facts(expected) as ProjectedRun))),
    );
    expect(served.json<{ validator: { verdict: string } }>().validator.verdict).toBe('passed');

    // Playwright attaches real files; they come back as the bytes they are named by.
    expect(expected.attachments.length).toBeGreaterThan(0);
    const { createHash } = await import('node:crypto');
    for (const reference of expected.attachments.slice(0, 3)) {
      const download = await stack.request(
        `/v1/runs/${answer.runRef}/attachments/${reference.sha256}`,
        { token },
      );
      expect(download.status, reference.sha256).toBe(200);
      expect(createHash('sha256').update(download.body).digest('hex')).toBe(reference.sha256);
    }
  });
});
