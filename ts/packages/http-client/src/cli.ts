import { parseArgs } from 'node:util';
import { QeReportHttpClient } from './client.js';
import { LocalRunDirectoryError, UploadRejectedError, UploadTransportError } from './errors.js';
import { expiryAfter } from './instants.js';
import { UploadAborted } from './transport.js';

export const USAGE = `qe-report-upload: uploads one completed run directory to a qe-report service

  qe-report-upload --run-dir <directory> [--url <base URL>]
                   (--expires-at <RFC 3339 instant> | --retention-ms <milliseconds>)
                   [--max-attempts <n>] [--attempt-timeout-ms <ms>] [--allow-insecure-http] [--json]

The API key is read from QE_REPORT_API_KEY and is never accepted as an argument: an argument is
visible in shell history and in the process list of every user on the machine. The service URL
may come from QE_REPORT_URL instead of --url.

Exactly one retention choice is required; there is no default. --retention-ms is turned into an
absolute instant once, when the command starts, so every attempt offers the same deadline.

Exit codes:
  0  the run is archived (newly, or it was already there)
  2  usage, configuration, or a local run directory that cannot be uploaded
  3  the service refused the run (a conflict, an invalid run, a credential, a limit)
  4  the run could not be delivered: the attempts ran out, or the upload was cancelled
`;

export interface CliStreams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

class UsageError extends Error {}

/** Runs one upload command. Returns the process exit code; nothing here throws for a caller. */
export async function runUpload(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  streams: CliStreams,
  make: (options: ConstructorParameters<typeof QeReportHttpClient>[0]) => QeReportHttpClient = (
    options,
  ) => new QeReportHttpClient(options),
): Promise<number> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        'run-dir': { type: 'string' },
        url: { type: 'string' },
        'expires-at': { type: 'string' },
        'retention-ms': { type: 'string' },
        'max-attempts': { type: 'string' },
        'attempt-timeout-ms': { type: 'string' },
        'allow-insecure-http': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
    });
    if (values.help === true) {
      streams.err(USAGE);
      return 0;
    }
    const runDirectory = values['run-dir'];
    if (runDirectory === undefined || runDirectory === '') {
      throw new UsageError('--run-dir is required');
    }
    // An explicit option wins over the environment; the key never comes from an option at all.
    const baseUrl = values.url ?? env.QE_REPORT_URL;
    if (baseUrl === undefined || baseUrl === '') {
      throw new UsageError('--url or QE_REPORT_URL is required');
    }
    const apiKey = env.QE_REPORT_API_KEY;
    if (apiKey === undefined || apiKey === '') {
      throw new UsageError('QE_REPORT_API_KEY must hold the API key of the project to upload into');
    }
    const expiresAt = retentionOf(values['expires-at'], values['retention-ms']);
    const client = make({
      baseUrl,
      apiKey,
      ...(values['allow-insecure-http'] === true ? { allowInsecureHttp: true } : {}),
      ...(values['max-attempts'] === undefined
        ? {}
        : { retry: { maxAttempts: whole('--max-attempts', values['max-attempts']) } }),
      ...(values['attempt-timeout-ms'] === undefined
        ? {}
        : { attemptTimeoutMs: whole('--attempt-timeout-ms', values['attempt-timeout-ms']) }),
    });
    const result = await client.uploadRunDirectory({ runDirectory, expiresAt });
    streams.out(
      values.json === true
        ? `${JSON.stringify({
            outcome: result.outcome,
            runId: result.runId,
            runRef: result.runRef,
            ingestionSequence: result.ingestionSequence,
            requestId: result.requestId,
            attempts: result.attempts,
          })}\n`
        : `uploaded run ${result.runId} (${result.outcome})\n`,
    );
    return 0;
  } catch (e) {
    return report(e, streams);
  }
}

function report(e: unknown, streams: CliStreams): number {
  if (e instanceof UsageError || (e as { code?: string })?.code?.startsWith('ERR_PARSE_ARGS')) {
    streams.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (e instanceof LocalRunDirectoryError) {
    streams.err(`the run directory cannot be uploaded (${e.problem}): ${e.message}\n`);
    return 2;
  }
  if (e instanceof TypeError) {
    streams.err(`${e.message}\n`);
    return 2;
  }
  if (e instanceof UploadRejectedError) {
    streams.err(`${e.message}${e.requestId === undefined ? '' : ` [request ${e.requestId}]`}\n`);
    for (const d of e.diagnostics.slice(0, 20)) {
      const where =
        d.file === undefined ? '' : `${d.file}${d.line === undefined ? '' : `:${d.line}`} `;
      streams.err(`  ${where}${d.code ?? ''}: ${d.message ?? ''}\n`);
    }
    if (e.diagnostics.length > 20) {
      streams.err(`  and ${e.diagnostics.length - 20} further diagnostics\n`);
    }
    return 3;
  }
  if (e instanceof UploadTransportError || e instanceof UploadAborted) {
    const requestId =
      e instanceof UploadTransportError && e.requestId !== undefined
        ? ` [request ${e.requestId}]`
        : '';
    streams.err(`${e.message}${requestId}\n`);
    return 4;
  }
  // Nothing else is expected; its message is shown, never a body or a header.
  streams.err(`the upload failed: ${e instanceof Error ? e.message : 'unknown error'}\n`);
  return 4;
}

/** Exactly one retention choice, turned into an absolute instant now. */
function retentionOf(expiresAt: string | undefined, retentionMs: string | undefined): Date {
  if ((expiresAt === undefined) === (retentionMs === undefined)) {
    throw new UsageError('exactly one of --expires-at or --retention-ms is required');
  }
  if (retentionMs !== undefined) return expiryAfter(whole('--retention-ms', retentionMs));
  const at = new Date(expiresAt as string);
  if (!Number.isFinite(at.getTime())) {
    throw new UsageError('--expires-at must be an RFC 3339 instant with an explicit offset');
  }
  return at;
}

function whole(name: string, value: string): number {
  if (!/^[1-9][0-9]{0,9}$/u.test(value)) {
    throw new UsageError(`${name} must be a positive whole number`);
  }
  return Number(value);
}
