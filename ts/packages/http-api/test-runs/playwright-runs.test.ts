import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReadModel, type ProjectedRun } from 'qe-report-read-model';
import { runPlaywright, type RunOutcome } from '../../playwright/test-consumer/harness.js';
import { occurrenceDto, runDto } from '../src/dto.js';
import { encodeRunRef } from '../src/run-ref.js';
import {
  HttpHarness,
  call,
  stagingEntries,
  uploadRun,
  wholeHistory,
} from '../test-integration/harness.js';

/** Fresh Playwright reporter output, uploaded and read back through API v1 alone. */
const harness = new HttpHarness();
beforeAll(() => harness.start());
afterAll(() => harness.stop());

describe('real Playwright runs through HTTP', () => {
  it('keeps plain flakiness apart from fail-on-flaky, and serves real attachments after the source is gone', async () => {
    const outcomes: Record<string, RunOutcome> = {
      ordinary: await runPlaywright({ args: ['pass.spec.ts', '--project', 'desktop'] }),
      flaky: await runPlaywright({
        env: { PW_RETRIES: '1' },
        args: ['-g', 'flaky passes on retry', '--project', 'desktop'],
      }),
      policy: await runPlaywright({
        config: 'configs/fail-on-flaky.config.ts',
        args: ['-g', 'flaky passes on retry'],
      }),
    };
    for (const [name, o] of Object.entries(outcomes)) expect(o.report.valid, name).toBe(true);
    const local = await buildReadModel(
      Object.values(outcomes).map((o) => ({ projectId: 'web', runDirectory: o.runDir })),
    );
    expect(local.problems).toEqual([]);

    const service = await harness.service('playwright');
    const token = await service.key('web');
    const runIds: Record<string, string> = {};
    const attachmentBytes = new Map<string, Buffer>();
    for (const [name, o] of Object.entries(outcomes)) {
      const runId = o.events[0]?.runId ?? '';
      runIds[name] = runId;
      for (const a of local.model.getRun('web', runId)?.attachments ?? []) {
        attachmentBytes.set(a.sha256, readFileSync(join(o.runDir, 'attachments', a.sha256)));
      }
      const answer = await uploadRun(service.base, token, o.runDir);
      expect(answer.status, name).toBe(201);
      rmSync(o.runDir, { recursive: true, force: true });
      expect(existsSync(o.runDir)).toBe(false);
    }
    expect(stagingEntries(service.stagingRoot)).toEqual([]);

    const read = async (name: string): Promise<Record<string, unknown>> => {
      const answer = await call(
        service.base,
        token,
        'GET',
        `/v1/runs/${encodeRunRef(runIds[name] ?? '')}`,
      );
      expect(answer.status, name).toBe(200);
      expect(answer.body, name).toEqual(
        runDto(local.model.getRun('web', runIds[name] ?? '') as ProjectedRun),
      );
      return answer.body;
    };
    const ordinary = await read('ordinary');
    const flaky = await read('flaky');
    const policy = await read('policy');

    // The same flaky execution: a passed run under the ordinary policy, a failed one under
    // failOnFlakyTests, and flaky in both.
    const executionOf = (run: Record<string, unknown>): Record<string, unknown> =>
      (run.executions as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(executionOf(flaky)).toMatchObject({ flaky: true, finalStatus: 'passed' });
    expect(flaky.validator).toMatchObject({ verdict: 'passed' });
    expect(executionOf(policy)).toMatchObject({ flaky: true, finalStatus: 'passed' });
    expect(policy.validator).toMatchObject({ verdict: 'failed' });

    const test = executionOf(flaky).test as { historicalId: string };
    const history = await wholeHistory(service.base, token, 'playwright', test.historicalId, 1);
    expect(history).toEqual(
      local.model
        .getTestHistory('web', 'playwright', test.historicalId)
        .occurrences.map(occurrenceDto),
    );
    const byRun = new Map(history.map((o) => [o.runId, o]));
    expect(byRun.get(runIds.flaky ?? '')).toMatchObject({ flaky: true, runVerdict: 'passed' });
    expect(byRun.get(runIds.policy ?? '')).toMatchObject({ flaky: true, runVerdict: 'failed' });
    const flakiness = await call(service.base, token, 'POST', '/v1/flakiness/query', {
      runnerName: 'playwright',
      historicalId: test.historicalId,
    });
    const expected = local.model.getFlakiness('web', 'playwright', test.historicalId);
    expect(flakiness.body).toMatchObject({
      totalOccurrences: expected.totalOccurrences,
      flakyOccurrences: expected.flakyOccurrences,
      everFlaky: true,
    });
    expect(expected.flakyOccurrences).toBe(2);

    // Real reporter attachments come back from the durable store, as octet streams.
    const references = [
      ...(ordinary.attachments as Record<string, string>[]),
      ...(flaky.attachments as Record<string, string>[]),
    ];
    expect(references.length).toBeGreaterThan(0);
    for (const a of references) {
      const bytes = await fetch(`${service.base}${a.href}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bytes.status, a.name).toBe(200);
      expect(bytes.headers.get('content-type')).toBe('application/octet-stream');
      expect(bytes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(attachmentBytes.get(a.sha256 ?? ''));
    }
  });
});
