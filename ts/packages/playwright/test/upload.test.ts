import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FullConfig } from '@playwright/test/reporter';
import {
  QeReportReporter,
  type ReporterHooks,
  type RunUploader,
  type UploaderOptions,
} from '../src/reporter.js';
import type { QeReportReporterOptions } from '../src/config.js';
import { ROOT, fullResult, testCase, testResult } from './fakes.js';

interface Delivery {
  readonly runDirectory: string;
  readonly expiresAt: Date;
  readonly options: UploaderOptions;
  /** The event types on disk when the upload began: the sink must be closed by then. */
  readonly eventsOnDisk: readonly string[];
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'qe-pw-upload-'));
}

function eventTypes(runDirectory: string): string[] {
  const dir = join(runDirectory, 'events');
  return readdirSync(dir).flatMap((file) =>
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { eventType: string }).eventType),
  );
}

/** A reporter whose uploads are recorded rather than sent. */
function reporter(
  options: QeReportReporterOptions,
  env: Record<string, string | undefined> = {},
  upload: { readonly fails?: boolean } = {},
) {
  const lines: string[] = [];
  const deliveries: Delivery[] = [];
  const uploader = (uploaderOptions: UploaderOptions): RunUploader => ({
    uploadRunDirectory: async (request) => {
      deliveries.push({
        runDirectory: request.runDirectory,
        expiresAt: request.expiresAt,
        options: uploaderOptions,
        eventsOnDisk: eventTypes(request.runDirectory),
      });
      if (upload.fails === true) throw new Error('the service could not be reached');
      return { outcome: 'inserted', runId: 'run-uploaded' };
    },
  });
  // The reporter says once where it is writing; everything else it prints is about the upload.
  const hooks: ReporterHooks = {
    env,
    write: (l) => {
      if (!l.includes('writing run ')) lines.push(l);
    },
    upload: uploader,
  };
  const r = new QeReportReporter(options, hooks);
  const config = {
    rootDir: ROOT,
    version: '1.63.0',
    workers: 1,
    shard: null,
    globalSetup: null,
    globalTeardown: null,
  } as FullConfig;
  return { r, lines, deliveries, begin: () => r.onBegin(config) };
}

/** One finished run: begin, one test, end. */
async function runOnce(
  options: QeReportReporterOptions,
  env: Record<string, string | undefined> = {},
  upload: { readonly fails?: boolean } = {},
): ReturnType<typeof reporter> extends infer R ? Promise<R> : never {
  const harness = reporter(options, env, upload);
  harness.begin();
  harness.r.onTestBegin(testCase(), testResult());
  harness.r.onTestEnd(testCase(), testResult());
  await harness.r.onEnd(fullResult('passed'));
  return harness;
}

const KEY = {
  QE_REPORT_API_KEY: 'qer_k1_abcdefghijklmnop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

describe('the reporter uploads only a run it owns', () => {
  it('does not upload at all unless it is asked to', async () => {
    const dir = temp();
    const quiet = await runOnce({ dir }, { ...KEY, QE_REPORT_URL: 'https://reports.example' });
    expect(quiet.deliveries).toEqual([]);
    expect(quiet.lines).toEqual([]);
    // Local reporting is exactly what it was.
    expect(eventTypes(join(dir, 'runs', readdirSync(join(dir, 'runs'))[0] ?? ''))).toEqual([
      'session.started',
      'attempt.started',
      'attempt.finished',
      'session.finished',
      'run.finished',
    ]);
  });

  it('uploads the finished directory when it generated the run id', async () => {
    const dir = temp();
    const before = Date.now();
    const harness = await runOnce(
      {
        dir,
        upload: { enabled: true, baseUrl: 'https://reports.example', retentionMs: 86_400_000 },
      },
      KEY,
    );
    expect(harness.deliveries).toHaveLength(1);
    const delivery = harness.deliveries[0] as Delivery;
    expect(delivery.runDirectory).toBe(join(dir, 'runs', readdirSync(join(dir, 'runs'))[0] ?? ''));
    // The whole run was on disk before a byte was uploaded.
    expect(delivery.eventsOnDisk).toEqual([
      'session.started',
      'attempt.started',
      'attempt.finished',
      'session.finished',
      'run.finished',
    ]);
    // A relative retention became one absolute instant.
    expect(delivery.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(delivery.expiresAt.getTime()).toBeLessThan(Date.now() + 86_400_001);
    expect(delivery.options).toMatchObject({
      baseUrl: 'https://reports.example',
      apiKey: KEY.QE_REPORT_API_KEY,
    });
    expect(harness.lines).toEqual(['qe-report-playwright: run run-uploaded uploaded (inserted)']);
  });

  it('never uploads a run id it was given, and says who should', async () => {
    const dir = temp();
    const harness = await runOnce(
      {
        dir,
        runId: 'run-shared',
        upload: { enabled: true, baseUrl: 'https://reports.example', retentionMs: 1000 },
      },
      KEY,
    );
    expect(harness.deliveries).toEqual([]);
    expect(harness.lines.join('')).toContain('automatic upload skipped');
    expect(harness.lines.join('')).toContain('shared or configured');
    expect(harness.lines.join('')).toContain('qe-report-upload --run-dir');
    // The run is still reported locally, and left open for whoever finishes it.
    const runDirectory = join(dir, 'runs', readdirSync(join(dir, 'runs'))[0] ?? '');
    expect(eventTypes(runDirectory)).toEqual([
      'session.started',
      'attempt.started',
      'attempt.finished',
      'session.finished',
    ]);
  });

  it('never uploads from a shard of a shared run, however many shards there are', async () => {
    const dir = temp();
    const shards = [];
    for (const current of [1, 2]) {
      const harness = reporter(
        {
          dir,
          runId: 'run-sharded',
          sessionId: `shard-${current}`,
          upload: { enabled: true, baseUrl: 'https://reports.example', retentionMs: 1000 },
        },
        KEY,
      );
      harness.r.onBegin({
        rootDir: ROOT,
        version: '1.63.0',
        workers: 1,
        shard: { current, total: 2 },
        globalSetup: null,
        globalTeardown: null,
      } as FullConfig);
      harness.r.onTestBegin(testCase(), testResult());
      harness.r.onTestEnd(testCase(), testResult());
      await harness.r.onEnd(fullResult('passed'));
      shards.push(harness);
    }
    for (const shard of shards) {
      expect(shard.deliveries).toEqual([]);
      expect(shard.lines.join('')).toContain('automatic upload skipped');
    }
    // Both shards wrote into one run directory, which a coordinator uploads once, whole.
    const runDirectory = join(dir, 'runs', readdirSync(join(dir, 'runs'))[0] ?? '');
    expect(readdirSync(join(runDirectory, 'events'))).toHaveLength(2);
    expect(eventTypes(runDirectory).filter((t) => t === 'session.started')).toHaveLength(2);
    expect(eventTypes(runDirectory)).not.toContain('run.finished');
  });

  it('says what is missing rather than guessing it', async () => {
    const withoutKey = await runOnce(
      {
        dir: temp(),
        upload: { enabled: true, baseUrl: 'https://reports.example', retentionMs: 1 },
      },
      {},
    );
    expect(withoutKey.deliveries).toEqual([]);
    expect(withoutKey.lines.join('')).toContain('QE_REPORT_API_KEY');

    const withoutUrl = await runOnce(
      { dir: temp(), upload: { enabled: true, retentionMs: 1 } },
      KEY,
    );
    expect(withoutUrl.deliveries).toEqual([]);
    expect(withoutUrl.lines.join('')).toContain('no service was configured');

    // There is no default retention: a run is never archived without an expiry.
    const withoutRetention = await runOnce(
      { dir: temp(), upload: { enabled: true, baseUrl: 'https://reports.example' } },
      KEY,
    );
    expect(withoutRetention.deliveries).toEqual([]);
    expect(withoutRetention.lines.join('')).toContain('no retention was configured');
  });

  it('takes its configuration from the environment, and an option over it', async () => {
    const fromEnv = await runOnce(
      { dir: temp() },
      {
        ...KEY,
        QE_REPORT_UPLOAD: 'true',
        QE_REPORT_URL: 'https://from-env.example',
        QE_REPORT_EXPIRES_AT: '2027-01-01T00:00:00.500Z',
        QE_REPORT_UPLOAD_MAX_ATTEMPTS: '2',
      },
    );
    expect(fromEnv.deliveries).toHaveLength(1);
    expect(fromEnv.deliveries[0]?.expiresAt.toISOString()).toBe('2027-01-01T00:00:00.500Z');
    expect(fromEnv.deliveries[0]?.options).toMatchObject({
      baseUrl: 'https://from-env.example',
      maxAttempts: 2,
    });

    const optionWins = await runOnce(
      {
        dir: temp(),
        upload: { enabled: true, baseUrl: 'https://from-option.example', retentionMs: 5 },
      },
      { ...KEY, QE_REPORT_URL: 'https://from-env.example', QE_REPORT_UPLOAD: 'false' },
    );
    expect(optionWins.deliveries[0]?.options.baseUrl).toBe('https://from-option.example');

    // An expiry that is not an instant the service takes is refused, and said so.
    const badInstant = await runOnce(
      { dir: temp() },
      {
        ...KEY,
        QE_REPORT_UPLOAD: '1',
        QE_REPORT_URL: 'https://reports.example',
        QE_REPORT_EXPIRES_AT: '2027-01-01T00:00:60Z',
      },
    );
    expect(badInstant.deliveries).toEqual([]);
    expect(badInstant.lines.join('')).toContain('not an instant');
  });

  it('keeps a failed upload out of the test outcome', async () => {
    const dir = temp();
    const harness = await runOnce(
      { dir, upload: { enabled: true, baseUrl: 'https://reports.example', retentionMs: 1000 } },
      KEY,
      { fails: true },
    );
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.lines.join('')).toContain('the run was not uploaded');
    expect(harness.lines.join('')).toContain('the run directory is kept at');
    // The local run is complete and untouched: another command can deliver it later.
    const runDirectory = join(dir, 'runs', readdirSync(join(dir, 'runs'))[0] ?? '');
    expect(eventTypes(runDirectory)).toContain('run.finished');
  });
});
