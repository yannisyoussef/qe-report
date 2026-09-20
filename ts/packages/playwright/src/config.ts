import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { resolveRunDirectory } from 'qe-report-sdk';

/** Options given in `playwright.config`; each one wins over its environment variable. */
export interface QeReportReporterOptions {
  /** Default true; `QE_REPORT_ENABLED`. */
  readonly enabled?: boolean;
  /**
   * Output root; `QE_REPORT_DIR`; default `qe-report` under the working directory. The run is
   * written to `<root>/runs/<run directory>`, named from the run id by the SDK's contract.
   */
  readonly dir?: string;
  /** `QE_REPORT_RUN_ID`; generated when absent, and then this process is a run of its own. */
  readonly runId?: string;
  /** `QE_REPORT_SESSION_ID`; generated when absent. Give each shard its own or none at all. */
  readonly sessionId?: string;
  /** Per-attachment byte limit; default is the SDK's. */
  readonly maxAttachmentBytes?: number;
  /**
   * Uploading the finished run to a qe-report service. Off unless it is turned on: a reporter
   * that used to write only local files goes on doing exactly that. The API key is never given
   * here; it is read from `QE_REPORT_API_KEY` when the upload happens.
   */
  readonly upload?: QeReportUploadOptions;
}

/** What an automatic upload needs, beside the key. Each one wins over its environment variable. */
export interface QeReportUploadOptions {
  /** Default false; `QE_REPORT_UPLOAD`. */
  readonly enabled?: boolean;
  /** The service's base URL; `QE_REPORT_URL`. */
  readonly baseUrl?: string;
  /** When retention may delete the run: an instant. `QE_REPORT_EXPIRES_AT`. */
  readonly expiresAt?: string;
  /** How long to keep the run, from the upload; `QE_REPORT_RETENTION_MS`. There is no default. */
  readonly retentionMs?: number;
  readonly maxAttempts?: number;
  readonly attemptTimeoutMs?: number;
  /** Plaintext HTTP to a host that is not this machine, for a development service only. */
  readonly allowInsecureHttp?: boolean;
}

export interface ResolvedUpload {
  readonly enabled: boolean;
  readonly baseUrl: string | undefined;
  /** The absolute instant, when one was configured outright. */
  readonly expiresAt: Date | undefined;
  readonly retentionMs: number | undefined;
  readonly maxAttempts: number | undefined;
  readonly attemptTimeoutMs: number | undefined;
  readonly allowInsecureHttp: boolean;
}

export interface ResolvedConfig {
  readonly enabled: boolean;
  readonly outputRoot: string;
  /** `<outputRoot>/runs/<run directory>`, the same for every process reporting into the run. */
  readonly runDirectory: string;
  readonly runId: string;
  /** True when no run id was configured: this process is then the only session of its run. */
  readonly runIdGenerated: boolean;
  readonly sessionId: string;
  readonly maxAttachmentBytes: number | undefined;
  readonly upload: ResolvedUpload;
  /** Values that were malformed and replaced by their default. */
  readonly notes: readonly string[];
}

export interface ConfigContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Present when Playwright runs one shard of several; part of the generated session id. */
  readonly shard?: { readonly current: number; readonly total: number } | null;
}

const IDENTIFIER = /^[\x21-\x7e]{1,128}$/u;

export function resolveConfig(
  options: QeReportReporterOptions | undefined,
  context: ConfigContext,
): ResolvedConfig {
  const notes: string[] = [];
  const o = options ?? {};
  const env = context.env;

  let enabled = true;
  if (typeof o.enabled === 'boolean') enabled = o.enabled;
  else if (env.QE_REPORT_ENABLED !== undefined) {
    const v = env.QE_REPORT_ENABLED.trim().toLowerCase();
    if (v === 'true' || v === '1') enabled = true;
    else if (v === 'false' || v === '0') enabled = false;
    else notes.push(`QE_REPORT_ENABLED is '${env.QE_REPORT_ENABLED}', not true or false; enabled`);
  }

  const dirValue = o.dir ?? env.QE_REPORT_DIR;
  const outputRoot = resolve(
    context.cwd,
    dirValue === undefined || dirValue === '' ? 'qe-report' : dirValue,
  );

  const runIdValue = identifier('run id', o.runId ?? env.QE_REPORT_RUN_ID, notes);
  const runId = runIdValue ?? randomUUID();
  const sessionValue = identifier('session id', o.sessionId ?? env.QE_REPORT_SESSION_ID, notes);
  const shard = context.shard ? `s${context.shard.current}of${context.shard.total}-` : '';
  const sessionId = sessionValue ?? `pw-${shard}${process.pid}-${randomBytes(4).toString('hex')}`;

  let maxAttachmentBytes: number | undefined;
  if (o.maxAttachmentBytes !== undefined) {
    if (Number.isInteger(o.maxAttachmentBytes) && o.maxAttachmentBytes >= 0)
      maxAttachmentBytes = o.maxAttachmentBytes;
    else
      notes.push(
        `maxAttachmentBytes ${String(o.maxAttachmentBytes)} is not a whole number; default`,
      );
  }

  return {
    enabled,
    upload: resolveUpload(o.upload, env, notes),
    outputRoot,
    runDirectory: resolveRunDirectory(outputRoot, runId),
    runId,
    runIdGenerated: runIdValue === undefined,
    sessionId,
    maxAttachmentBytes,
    notes,
  };
}

/** The operational instant a service takes: RFC 3339, an offset, at most milliseconds. */
const OPERATIONAL_INSTANT =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u;

function resolveUpload(
  options: QeReportUploadOptions | undefined,
  env: Readonly<Record<string, string | undefined>>,
  notes: string[],
): ResolvedUpload {
  const o = options ?? {};
  let enabled = false;
  if (typeof o.enabled === 'boolean') enabled = o.enabled;
  else if (env.QE_REPORT_UPLOAD !== undefined) {
    const v = env.QE_REPORT_UPLOAD.trim().toLowerCase();
    if (v === 'true' || v === '1') enabled = true;
    else if (v !== 'false' && v !== '0') {
      notes.push(`QE_REPORT_UPLOAD is '${env.QE_REPORT_UPLOAD}', not true or false; not uploading`);
    }
  }
  const baseUrlValue = o.baseUrl ?? env.QE_REPORT_URL;
  const expiresValue = o.expiresAt ?? env.QE_REPORT_EXPIRES_AT;
  let expiresAt: Date | undefined;
  if (expiresValue !== undefined && expiresValue !== '') {
    if (OPERATIONAL_INSTANT.test(expiresValue) && Number.isFinite(Date.parse(expiresValue))) {
      expiresAt = new Date(expiresValue);
    } else {
      notes.push(
        `expiresAt '${expiresValue.slice(0, 40)}' is not an instant with an explicit offset and at most millisecond precision; ignored`,
      );
    }
  }
  return {
    enabled,
    baseUrl: baseUrlValue === '' ? undefined : baseUrlValue,
    expiresAt,
    retentionMs: whole('retentionMs', o.retentionMs ?? env.QE_REPORT_RETENTION_MS, notes),
    maxAttempts: whole('maxAttempts', o.maxAttempts ?? env.QE_REPORT_UPLOAD_MAX_ATTEMPTS, notes),
    attemptTimeoutMs: whole(
      'attemptTimeoutMs',
      o.attemptTimeoutMs ?? env.QE_REPORT_UPLOAD_TIMEOUT_MS,
      notes,
    ),
    allowInsecureHttp: o.allowInsecureHttp === true || env.QE_REPORT_ALLOW_INSECURE_HTTP === 'true',
  };
}

function whole(
  what: string,
  value: number | string | undefined,
  notes: string[],
): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  notes.push(`${what} '${String(value).slice(0, 40)}' is not a positive whole number; ignored`);
  return undefined;
}

function identifier(what: string, value: string | undefined, notes: string[]): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (IDENTIFIER.test(value)) return value;
  notes.push(
    `${what} '${value.slice(0, 40)}' is not an identifier (1 to 128 printable ASCII characters, no spaces); generated`,
  );
  return undefined;
}
