import { existsSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReadModel, type ProjectedRun } from 'qe-report-read-model';
import { runPlaywright, type RunOutcome } from '../../playwright/test-consumer/harness.js';
import { runDto } from '../../http-api/src/dto.js';
import { HttpHarness, call, type Service } from '../../http-api/test-integration/harness.js';
import { runUpload } from '../src/index.js';

/**
 * Real Playwright runs that upload themselves: the reporter writes its run directory, closes
 * it, and delivers it to a real service, because it generated the run id and therefore owns the
 * whole run. A run whose id was configured is left for the coordinator, as the last case shows.
 */
const harness = new HttpHarness();
beforeAll(() => harness.start());
afterAll(() => harness.stop());

/** The environment a fixture run needs to upload itself to this service. */
function uploading(service: Service, token: string): Record<string, string> {
  return {
    QE_REPORT_UPLOAD: 'true',
    QE_REPORT_URL: service.base,
    QE_REPORT_API_KEY: token,
    QE_REPORT_RETENTION_MS: '86400000',
  };
}

describe('real Playwright runs that upload themselves', () => {
  it('archives each kind of run remotely, keeping every distinction the projector makes', async () => {
    const service = await harness.service('pw_upload');
    const token = await service.key('web');
    const env = uploading(service, token);
    const outcomes: Record<string, RunOutcome> = {
      ordinary: await runPlaywright({ env, args: ['pass.spec.ts', '--project', 'desktop'] }),
      flaky: await runPlaywright({
        env: { ...env, PW_RETRIES: '1' },
        args: ['-g', 'flaky passes on retry', '--project', 'desktop'],
      }),
      policy: await runPlaywright({
        env,
        config: 'configs/fail-on-flaky.config.ts',
        args: ['-g', 'flaky passes on retry'],
      }),
    };
    for (const [name, outcome] of Object.entries(outcomes)) {
      expect(outcome.report.valid, name).toBe(true);
      // The reporter said what it did, once, and said nothing of the key.
      expect(outcome.stderr, name).toContain('uploaded (inserted)');
      expect(outcome.stderr, name).not.toContain(token);
    }

    const local = await buildReadModel(
      Object.values(outcomes).map((o) => ({ projectId: 'web', runDirectory: o.runDir })),
    );
    expect(local.problems).toEqual([]);
    const runIds = Object.fromEntries(
      Object.entries(outcomes).map(([name, o]) => [name, o.events[0]?.runId ?? '']),
    );
    // Every run reached the service without any command being run.
    const listed = await call(service.base, token, 'GET', '/v1/runs');
    expect((listed.body.runs as { runId: string }[]).map((r) => r.runId).sort()).toEqual(
      Object.values(runIds).sort(),
    );

    // The producer's directories go; what the service holds came over HTTP.
    for (const outcome of Object.values(outcomes)) {
      rmSync(outcome.runDir, { recursive: true, force: true });
      expect(existsSync(outcome.runDir)).toBe(false);
    }

    const remoteRun = async (name: string): Promise<Record<string, unknown>> => {
      const runRef = Buffer.from(runIds[name] ?? '', 'utf8').toString('base64url');
      const answer = await call(service.base, token, 'GET', `/v1/runs/${runRef}`);
      expect(answer.status, name).toBe(200);
      expect(answer.body, name).toEqual(
        runDto(local.model.getRun('web', runIds[name] ?? '') as ProjectedRun),
      );
      return answer.body;
    };
    const flaky = await remoteRun('flaky');
    const policy = await remoteRun('policy');
    const ordinary = await remoteRun('ordinary');

    // The same flaky execution: a passed run under the ordinary policy, a failed one under
    // failOnFlakyTests, and flaky in both.
    const executionOf = (run: Record<string, unknown>): Record<string, unknown> =>
      (run.executions as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(executionOf(flaky)).toMatchObject({ flaky: true });
    expect(flaky.validator).toMatchObject({ verdict: 'passed' });
    expect(executionOf(policy)).toMatchObject({ flaky: true });
    expect(policy.validator).toMatchObject({ verdict: 'failed' });

    // History and flakiness answer for the uploaded runs, from the service alone.
    const test = executionOf(flaky).test as { historicalId: string };
    const flakiness = await call(service.base, token, 'POST', '/v1/flakiness/query', {
      runnerName: 'playwright',
      historicalId: test.historicalId,
    });
    expect(flakiness.body).toMatchObject({ flakyOccurrences: 2, everFlaky: true });

    // Real attachments download from the service after the producer's copies are gone.
    const references = [
      ...(ordinary.attachments as { href: string; sha256: string }[]),
      ...(flaky.attachments as { href: string; sha256: string }[]),
    ];
    expect(references.length).toBeGreaterThan(0);
    for (const attachment of references) {
      const bytes = await fetch(`${service.base}${attachment.href}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bytes.status, attachment.sha256).toBe(200);
      expect(bytes.headers.get('content-type')).toBe('application/octet-stream');
      const { createHash } = await import('node:crypto');
      expect(
        createHash('sha256')
          .update(Buffer.from(await bytes.arrayBuffer()))
          .digest('hex'),
      ).toBe(attachment.sha256);
    }
  });

  it('leaves a configured run id to the coordinator, which uploads it once', async () => {
    const service = await harness.service('pw_shared');
    const token = await service.key('web');
    const env = uploading(service, token);
    // Two invocations of one configured run: neither may archive a run the other is still adding to.
    const first = await runPlaywright({
      env,
      runId: 'run-shared-consumer',
      args: ['pass.spec.ts', '--project', 'desktop'],
    });
    const second = await runPlaywright({
      env,
      runId: 'run-shared-consumer',
      outputRoot: first.outputRoot,
      args: ['-g', 'flaky passes on retry', '--project', 'desktop'],
    });
    for (const outcome of [first, second]) {
      expect(outcome.stderr).toContain('automatic upload skipped');
      expect(outcome.stderr).toContain('shared or configured');
      expect(outcome.stderr).not.toContain('uploaded (');
    }
    expect((await call(service.base, token, 'GET', '/v1/runs')).body.runs).toEqual([]);

    // The coordinator uploads the finished directory once, with both sessions in it.
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await runUpload(
        ['--run-dir', second.runDir, '--retention-ms', '86400000', '--json'],
        { QE_REPORT_API_KEY: token, QE_REPORT_URL: service.base },
        { out: (t) => out.push(t), err: (t) => err.push(t) },
      ),
      err.join(''),
    ).toBe(0);
    const uploaded = JSON.parse(out.join('')) as { runId: string; runRef: string };
    expect(uploaded.runId).toBe('run-shared-consumer');
    const run = await call(service.base, token, 'GET', `/v1/runs/${uploaded.runRef}`);
    expect((run.body.sessions as unknown[]).length).toBe(2);
    expect(run.body.validator).toMatchObject({ complete: true, closed: false });
  });
});
