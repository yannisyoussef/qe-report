import { afterAll, describe, expect, it } from 'vitest';
import { QeReportHttpClient, runUpload } from '../src/index.js';
import {
  LocalRunDirectoryError,
  UploadRejectedError,
  UploadTransportError,
} from '../src/errors.js';
import { archived, cleanup, freshDir, service, writeRunDirectory } from './support.js';

afterAll(cleanup);

const TOKEN = 'qer_k1_abcdefghijklmnop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Runs the command, collecting what it writes where. */
async function run(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  make?: Parameters<typeof runUpload>[3],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUpload(
    argv,
    env,
    { out: (t) => out.push(t), err: (t) => err.push(t) },
    make,
  );
  return { code, out: out.join(''), err: err.join('') };
}

/** A client that answers however the test says, without a network. */
function fakeClient(answer: () => Promise<unknown>): Parameters<typeof runUpload>[3] {
  return () =>
    ({
      uploadRunDirectory: answer,
    }) as unknown as QeReportHttpClient;
}

describe('qe-report-upload', () => {
  it('uploads one directory and says what happened', async () => {
    const dir = writeRunDirectory(freshDir('cli'));
    const server = await service((_request, response) => archived(response));
    const answer = await run(
      ['--run-dir', dir, '--url', server.baseUrl, '--expires-at', '2027-01-01T00:00:00.000Z'],
      { QE_REPORT_API_KEY: TOKEN },
    );
    expect(answer.code).toBe(0);
    expect(answer.out).toBe('uploaded run run-1 (inserted)\n');
    expect(answer.err).toBe('');
    expect(server.seen).toHaveLength(1);

    // The service URL and the key may come from the environment; an option wins over it.
    const fromEnv = await run(['--run-dir', dir, '--retention-ms', '86400000'], {
      QE_REPORT_API_KEY: TOKEN,
      QE_REPORT_URL: server.baseUrl,
    });
    expect(fromEnv.code).toBe(0);
    const json = await run(
      ['--run-dir', dir, '--url', server.baseUrl, '--retention-ms', '1000', '--json'],
      { QE_REPORT_API_KEY: TOKEN },
    );
    expect(JSON.parse(json.out)).toMatchObject({
      outcome: 'inserted',
      runId: 'run-1',
      runRef: 'cnVuLTE',
      ingestionSequence: '7',
      attempts: 1,
    });
  });

  it('refuses usage it cannot act on, and never takes the key as an argument', async () => {
    const dir = writeRunDirectory(freshDir('cli-usage'));
    const ok = { QE_REPORT_API_KEY: TOKEN, QE_REPORT_URL: 'https://reports.example.com' };
    const cases: [string, readonly string[], Record<string, string | undefined>][] = [
      ['no run directory', ['--expires-at', '2027-01-01T00:00:00Z'], ok],
      [
        'no service',
        ['--run-dir', dir, '--expires-at', '2027-01-01T00:00:00Z'],
        { QE_REPORT_API_KEY: TOKEN },
      ],
      [
        'no key',
        ['--run-dir', dir, '--expires-at', '2027-01-01T00:00:00Z'],
        { QE_REPORT_URL: 'https://x.example' },
      ],
      ['no retention', ['--run-dir', dir], ok],
      [
        'two retentions',
        ['--run-dir', dir, '--expires-at', '2027-01-01T00:00:00Z', '--retention-ms', '1000'],
        ok,
      ],
      ['a retention that is not a number', ['--run-dir', dir, '--retention-ms', 'soon'], ok],
      ['an expiry that is not an instant', ['--run-dir', dir, '--expires-at', 'tomorrow'], ok],
      ['an unknown option', ['--run-dir', dir, '--retention-ms', '1000', '--api-key', TOKEN], ok],
      [
        'plaintext to another host',
        ['--run-dir', dir, '--url', 'http://reports.example.test', '--retention-ms', '1000'],
        { QE_REPORT_API_KEY: TOKEN },
      ],
    ];
    for (const [label, argv, env] of cases) {
      const answer = await run(argv, env);
      expect(answer.code, label).toBe(2);
      expect(answer.out, label).toBe('');
      expect(answer.err, label).not.toContain(TOKEN);
    }
    // There is no --api-key option at all: a secret does not belong in a process list.
    expect((await run(['--help'], {})).err).not.toContain('--api-key');
    expect((await run(['--help'], {})).err).toContain('QE_REPORT_API_KEY');
  });

  it('separates a local problem, a refusal, and a delivery that never arrived', async () => {
    const dir = writeRunDirectory(freshDir('cli-exits'));
    const argv = [
      '--run-dir',
      dir,
      '--url',
      'https://reports.example.com',
      '--retention-ms',
      '1000',
    ];
    const env = { QE_REPORT_API_KEY: TOKEN };

    const local = await run(
      argv,
      env,
      fakeClient(async () => {
        throw new LocalRunDirectoryError('RUN_DIRECTORY_CHANGED', 'events/a.ndjson changed');
      }),
    );
    expect(local.code).toBe(2);
    expect(local.err).toContain('RUN_DIRECTORY_CHANGED');

    const refused = await run(
      argv,
      env,
      fakeClient(async () => {
        throw new UploadRejectedError(422, 'the service refused the run (422 RUN_INVALID)', {
          code: 'RUN_INVALID',
          requestId: 'abc',
          diagnostics: [
            { code: 'MALFORMED_JSON', message: 'line 2', file: 'events/000001.ndjson', line: 2 },
          ],
        });
      }),
    );
    expect(refused.code).toBe(3);
    expect(refused.err).toContain('RUN_INVALID');
    expect(refused.err).toContain('[request abc]');
    expect(refused.err).toContain('events/000001.ndjson:2');

    const undelivered = await run(
      argv,
      env,
      fakeClient(async () => {
        throw new UploadTransportError(
          'the upload was not delivered after 4 attempts: ECONNRESET',
          {
            attempts: 4,
            requestId: 'xyz',
          },
        );
      }),
    );
    expect(undelivered.code).toBe(4);
    expect(undelivered.err).toContain('4 attempts');
    expect(undelivered.err).toContain('[request xyz]');
    for (const answer of [local, refused, undelivered]) {
      expect(answer.err).not.toContain(TOKEN);
      expect(answer.err.toLowerCase()).not.toContain('authorization');
    }
  });
});
