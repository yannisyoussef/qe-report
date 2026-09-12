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
    outputRoot,
    runDirectory: resolveRunDirectory(outputRoot, runId),
    runId,
    runIdGenerated: runIdValue === undefined,
    sessionId,
    maxAttachmentBytes,
    notes,
  };
}

function identifier(what: string, value: string | undefined, notes: string[]): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (IDENTIFIER.test(value)) return value;
  notes.push(
    `${what} '${value.slice(0, 40)}' is not an identifier (1 to 128 printable ASCII characters, no spaces); generated`,
  );
  return undefined;
}
