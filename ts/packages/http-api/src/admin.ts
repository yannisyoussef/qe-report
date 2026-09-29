import { parseArgs } from 'node:util';
import pg from 'pg';
import { FileBlobStore } from 'qe-report-blob-fs';
import { parseOperationalInstant } from './instants.js';
import { scrubConnectionStrings } from './secrets.js';
import { StagingMaintenance, type StagingReport } from './staging-maintenance.js';
import {
  API_KEY_SCOPES,
  PostgresApiKeys,
  PostgresQueries,
  RetentionMaintenance,
  migrate,
  schemaStatus,
  type ApiKeyScope,
  type MaintenanceOptions,
} from 'qe-report-postgres';

export const USAGE = `qe-report-admin: operator actions against DATABASE_URL; nothing here is reachable over HTTP

  qe-report-admin migrate
      Applies pending schema migrations.
  qe-report-admin schema
      Reports whether the schema is current, without changing it.
  qe-report-admin key create --project <projectId> --scope <runs:read|runs:write> [--scope ...]
                             [--label <text>] [--expires-at <RFC 3339 instant, offset, <=ms>]
      Issues a project-scoped API key and prints its bearer token, once, on standard output.
  qe-report-admin key revoke --public-id <publicId>
      Revokes a key at once.
  qe-report-admin key list [--project <projectId>] [--all] [--limit <n>] [--after <publicId>] [--json]
      Lists key metadata. Never a secret: no token can be recovered once it was shown.
  qe-report-admin index status --project <projectId> [--json]
      Reports how much of a project's query index is current.
  qe-report-admin index rebuild --project <projectId> [--max-runs <n>]
                               [--after-sequence <ingestionSequence>] [--json]
      Rebuilds derived query rows from the archived source, one bounded pass.
  qe-report-admin index verify --project <projectId> --run-id <runId> [--json]
      Replays one archived run and reports any drift from its indexed rows.
  qe-report-admin maintenance preview|run (--as-of <instant> | --now)
      [--lock-timeout-ms <n>] [--temp-before <instant>] [--orphan-objects-before <instant>]
      [--max-runs <n>] [--max-blobs <n>] [--max-uncatalogued-blobs <n>]
      [--max-bytes-examined <n>] [--max-temporary-files <n>] [--max-legacy-reported <n>]
      [--after-sha256 <hex>] [--json]
      Retention and blob collection. preview changes nothing; run deletes what is eligible.
      Needs QE_REPORT_BLOB_ROOT.
  qe-report-admin staging preview (--before <instant> | --older-than-ms <n>) [--max <n>] [--json]
  qe-report-admin staging clean   (--before <instant> | --older-than-ms <n>) [--max <n>] [--json]
                                  --execute
      Removes request directories a killed server left behind. Stop the API instance that owns the
      staging root first: nothing here can tell an abandoned request from one still being written.
      Needs QE_REPORT_STAGING_ROOT.
`;

/** Where the command writes: the token alone goes to `out`, everything else to `err`. */
export interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

class UsageError extends Error {}

/**
 * Runs one command against a pool; returns the process exit code. The environment is read only
 * by the commands that need a filesystem root, and only for that root.
 */
export async function runAdmin(
  argv: readonly string[],
  pool: pg.Pool,
  streams: Streams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const [command, sub] = argv;
    if (command === 'migrate') {
      const applied = await migrate(pool);
      const now = applied.filter((m) => m.appliedNow).map((m) => m.version);
      streams.err(
        now.length === 0
          ? 'the schema is already current\n'
          : `applied migrations ${now.join(', ')}\n`,
      );
      return 0;
    }
    if (command === 'schema') {
      const status = await schemaStatus(pool);
      streams.err(
        status.current
          ? `the schema is current at version ${status.expectedVersion}\n`
          : `the schema is not current: ${status.problems.join('; ')}\n`,
      );
      return status.current ? 0 : 1;
    }
    if (command === 'key' && sub === 'create') {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          project: { type: 'string' },
          scope: { type: 'string', multiple: true },
          label: { type: 'string' },
          'expires-at': { type: 'string' },
        },
        strict: true,
      });
      if (values.project === undefined) throw new UsageError('--project is required');
      const scopes = values.scope ?? [];
      for (const scope of scopes) {
        if (!API_KEY_SCOPES.includes(scope as ApiKeyScope)) {
          throw new UsageError(
            `unknown scope ${scope}; the scopes are ${API_KEY_SCOPES.join(', ')}`,
          );
        }
      }
      let expiresAt: Date | undefined;
      if (values['expires-at'] !== undefined) {
        try {
          expiresAt = parseOperationalInstant(values['expires-at'], '--expires-at');
        } catch (e) {
          throw new UsageError((e as Error).message);
        }
      }
      const created = await new PostgresApiKeys(pool).create({
        projectId: values.project,
        scopes: scopes as ApiKeyScope[],
        ...(values.label === undefined ? {} : { label: values.label }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      streams.err(
        `issued key ${created.publicId} for project ${JSON.stringify(created.projectId)} with ${created.scopes.join(', ')}${created.expiresAt === undefined ? '' : `, expiring ${created.expiresAt.toISOString()}`}; the token is shown once and cannot be recovered\n`,
      );
      streams.out(`${created.token}\n`);
      return 0;
    }
    if (command === 'key' && sub === 'revoke') {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { 'public-id': { type: 'string' } },
        strict: true,
      });
      if (values['public-id'] === undefined) throw new UsageError('--public-id is required');
      const revoked = await new PostgresApiKeys(pool).revoke(values['public-id']);
      streams.err(revoked ? 'revoked\n' : 'no active key has that public id\n');
      return revoked ? 0 : 1;
    }
    if (command === 'key' && sub === 'list') {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          project: { type: 'string' },
          all: { type: 'boolean' },
          limit: { type: 'string' },
          after: { type: 'string' },
          json: { type: 'boolean' },
        },
        strict: true,
      });
      const page = await new PostgresApiKeys(pool).list({
        ...(values.project === undefined ? {} : { projectId: values.project }),
        ...(values.all === true ? { includeInactive: true } : {}),
        ...(values.limit === undefined ? {} : { limit: whole('--limit', values.limit) }),
        ...(values.after === undefined ? {} : { after: values.after }),
      });
      if (values.json === true) {
        streams.out(`${asJson({ keys: page.keys, next: page.next })}\n`);
        return 0;
      }
      if (page.keys.length === 0) streams.err('no key matches\n');
      for (const key of page.keys) {
        streams.out(
          `${key.publicId}  ${key.active ? 'active  ' : 'inactive'}  ${JSON.stringify(key.projectId)}  ${key.scopes.join(',')}  created ${key.createdAt.toISOString()}${
            key.expiresAt === undefined ? '' : `  expires ${key.expiresAt.toISOString()}`
          }${key.revokedAt === undefined ? '' : `  revoked ${key.revokedAt.toISOString()}`}${
            key.label === undefined ? '' : `  ${JSON.stringify(key.label)}`
          }\n`,
        );
      }
      if (page.next !== undefined) streams.err(`more keys follow; continue after ${page.next}\n`);
      return 0;
    }
    if (command === 'index') {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          project: { type: 'string' },
          'run-id': { type: 'string' },
          'max-runs': { type: 'string' },
          'after-sequence': { type: 'string' },
          json: { type: 'boolean' },
        },
        strict: true,
      });
      if (values.project === undefined) throw new UsageError('--project is required');
      const queries = new PostgresQueries(pool);
      const json = values.json === true;
      if (sub === 'status') {
        const status = await queries.getIndexStatus(values.project);
        if (json) streams.out(`${asJson(status)}\n`);
        else {
          streams.out(
            `${status.complete ? 'complete' : 'incomplete'}: ${status.currentRuns} of ${status.totalRuns} runs indexed, ${status.missingRuns} missing, ${status.staleRuns} stale\n`,
          );
        }
        return status.complete ? 0 : 1;
      }
      if (sub === 'rebuild') {
        const result = await queries.rebuildProjectIndex({
          projectId: values.project,
          ...(values['max-runs'] === undefined
            ? {}
            : { maxRuns: whole('--max-runs', values['max-runs']) }),
          ...(values['after-sequence'] === undefined
            ? {}
            : { afterIngestionSequence: bigWhole('--after-sequence', values['after-sequence']) }),
        });
        if (json) streams.out(`${asJson(result)}\n`);
        else {
          streams.out(
            `rebuilt ${result.rebuilt}, skipped ${result.skipped}${result.problems.length === 0 ? '' : `, ${result.problems.length} could not be indexed`}\n`,
          );
          for (const problem of result.problems) {
            streams.err(`  ${problem.runId}: ${problem.message}\n`);
          }
          if (result.more) {
            streams.err(
              `more runs remain; continue with --after-sequence ${String(result.lastIngestionSequence ?? '')}\n`,
            );
          }
        }
        return result.problems.length === 0 ? 0 : 1;
      }
      if (sub === 'verify') {
        if (values['run-id'] === undefined) throw new UsageError('--run-id is required');
        const drift = await queries.verifyIndexedRun(values.project, values['run-id']);
        if (json) streams.out(`${asJson(drift)}\n`);
        else {
          streams.out(
            drift.agrees
              ? `${drift.runId} agrees with its indexed rows\n`
              : `${drift.runId} differs from its indexed rows:\n${drift.differences.map((d) => `  ${d}\n`).join('')}`,
          );
        }
        return drift.agrees ? 0 : 1;
      }
      throw new UsageError(`unknown command ${argv.join(' ')}`);
    }
    if (command === 'maintenance' && (sub === 'preview' || sub === 'run')) {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          'as-of': { type: 'string' },
          now: { type: 'boolean' },
          'lock-timeout-ms': { type: 'string' },
          'temp-before': { type: 'string' },
          'orphan-objects-before': { type: 'string' },
          'max-runs': { type: 'string' },
          'max-blobs': { type: 'string' },
          'max-uncatalogued-blobs': { type: 'string' },
          'max-bytes-examined': { type: 'string' },
          'max-temporary-files': { type: 'string' },
          'max-legacy-reported': { type: 'string' },
          'after-sha256': { type: 'string' },
          json: { type: 'boolean' },
        },
        strict: true,
      });
      if ((values['as-of'] === undefined) === (values.now !== true)) {
        throw new UsageError('exactly one of --as-of or --now is required');
      }
      // A destructive pass never reads a clock the operator did not ask it to read, and when
      // they do ask, the instant it settled on is printed before anything is deleted.
      const asOf = values.now === true ? new Date() : instant('--as-of', values['as-of'] as string);
      if (values.now === true) {
        streams.err(`--now resolved to ${asOf.toISOString()}\n`);
      }
      const options: MaintenanceOptions = {
        asOf,
        ...maybeInstant('--temp-before', values['temp-before'], 'tempBefore'),
        ...maybeInstant(
          '--orphan-objects-before',
          values['orphan-objects-before'],
          'orphanObjectsBefore',
        ),
        ...maybeWhole('--lock-timeout-ms', values['lock-timeout-ms'], 'lockTimeoutMs'),
        ...maybeWhole('--max-runs', values['max-runs'], 'maxRuns'),
        ...maybeWhole('--max-blobs', values['max-blobs'], 'maxBlobs'),
        ...maybeWhole(
          '--max-uncatalogued-blobs',
          values['max-uncatalogued-blobs'],
          'maxUncataloguedBlobs',
        ),
        ...maybeWhole('--max-bytes-examined', values['max-bytes-examined'], 'maxBytesExamined'),
        ...maybeWhole('--max-temporary-files', values['max-temporary-files'], 'maxTemporaryFiles'),
        ...maybeWhole('--max-legacy-reported', values['max-legacy-reported'], 'maxLegacyReported'),
        ...(values['after-sha256'] === undefined ? {} : { afterSha256: values['after-sha256'] }),
      };
      const maintenance = new RetentionMaintenance(
        pool,
        new FileBlobStore(rootFrom(env, 'QE_REPORT_BLOB_ROOT')),
      );
      const report =
        sub === 'preview' ? await maintenance.preview(options) : await maintenance.run(options);
      if (values.json === true) {
        streams.out(`${asJson(report)}\n`);
      } else {
        streams.out(
          `${report.dryRun ? 'preview' : 'run'} as of ${report.asOf.toISOString()}\n` +
            `  runs expired            ${report.expiredRuns.length}\n` +
            `  source lines released   ${report.sourceLinesReleased}\n` +
            `  blob relations released ${report.blobRelationsReleased}\n` +
            `  blobs reclaimed         ${report.blobs.filter((b) => b.origin === 'catalogued').length} catalogued, ${report.blobs.filter((b) => b.origin === 'uncatalogued').length} uncatalogued\n` +
            `  temporary files         ${report.temporaryFiles.length}\n` +
            `  bytes reclaimed         ${report.bytesReclaimed}\n` +
            `  unmanaged runs          ${report.legacyRunCount}\n` +
            `  problems                ${report.problems.length}\n` +
            `  truncated               runs ${report.truncated.runs}, blobs ${report.truncated.blobs}, temporary ${report.truncated.temporaryFiles}\n`,
        );
        for (const problem of report.problems) {
          streams.err(
            `  ${problem.code}${problem.sha256 === undefined ? '' : ` ${problem.sha256}`}: ${problem.message}\n`,
          );
        }
      }
      return report.problems.length === 0 ? 0 : 1;
    }
    if (command === 'staging' && (sub === 'preview' || sub === 'clean')) {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          before: { type: 'string' },
          'older-than-ms': { type: 'string' },
          max: { type: 'string' },
          execute: { type: 'boolean' },
          json: { type: 'boolean' },
        },
        strict: true,
      });
      if ((values.before === undefined) === (values['older-than-ms'] === undefined)) {
        throw new UsageError('exactly one of --before or --older-than-ms is required');
      }
      // One absolute cutoff, decided here, so a long pass does not move its own boundary.
      const before =
        values.before !== undefined
          ? instant('--before', values.before)
          : new Date(Date.now() - whole('--older-than-ms', values['older-than-ms'] as string));
      if (sub === 'clean' && values.execute !== true) {
        throw new UsageError(
          'staging clean removes directories; pass --execute, and stop the API instance that owns the staging root first',
        );
      }
      const maintenance = new StagingMaintenance(rootFrom(env, 'QE_REPORT_STAGING_ROOT'));
      const options = {
        before,
        ...(values.max === undefined ? {} : { max: whole('--max', values.max) }),
      };
      const report: StagingReport =
        sub === 'preview' ? maintenance.preview(options) : maintenance.clean(options);
      if (values.json === true) {
        streams.out(`${asJson(report)}\n`);
      } else {
        streams.out(
          `${report.dryRun ? 'preview' : 'clean'}: ${report.entries.length} abandoned request ${
            report.entries.length === 1 ? 'directory' : 'directories'
          } before ${report.before.toISOString()}${report.dryRun ? '' : `, ${report.removed} removed`}${report.truncated ? ', more remain' : ''}\n`,
        );
        for (const entry of report.entries) {
          streams.out(`  ${entry.requestId}  ${entry.modifiedAt.toISOString()}\n`);
        }
        for (const problem of report.problems) {
          streams.err(`  ${problem.code} ${JSON.stringify(problem.name)}: ${problem.message}\n`);
        }
      }
      return report.problems.length === 0 ? 0 : 1;
    }
    throw new UsageError(
      command === undefined ? 'a command is required' : `unknown command ${argv.join(' ')}`,
    );
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      streams.err(`${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof TypeError) {
      streams.err(`${scrubConnectionStrings(e.message)}\n`);
      return 2;
    }
    throw e;
  }
}

/** A filesystem root a command needs, or a usage error naming the variable that supplies it. */
function rootFrom(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new UsageError(`${name} must be set`);
  return value;
}

function instant(name: string, text: string): Date {
  try {
    return parseOperationalInstant(text, name);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function maybeInstant<K extends string>(
  name: string,
  text: string | undefined,
  key: K,
): Record<K, Date> | Record<string, never> {
  return text === undefined ? {} : ({ [key]: instant(name, text) } as Record<K, Date>);
}

function maybeWhole<K extends string>(
  name: string,
  text: string | undefined,
  key: K,
): Record<K, number> | Record<string, never> {
  return text === undefined ? {} : ({ [key]: whole(name, text) } as Record<K, number>);
}

function whole(name: string, value: string): number {
  if (!/^[0-9]{1,15}$/u.test(value)) {
    throw new UsageError(`${name} must be a whole number`);
  }
  return Number(value);
}

function bigWhole(name: string, value: string): bigint {
  if (!/^[0-9]{1,19}$/u.test(value)) throw new UsageError(`${name} must be a whole number`);
  return BigInt(value);
}

/**
 * Operator output a script can read. A sequence counted by the database is a `bigint`, which JSON
 * has no room for, so it is written as the decimal string it already is everywhere else.
 */
function asJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
