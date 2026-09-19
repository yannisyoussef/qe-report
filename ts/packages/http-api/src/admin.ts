import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  API_KEY_SCOPES,
  PostgresApiKeys,
  migrate,
  schemaStatus,
  type ApiKeyScope,
} from 'qe-report-postgres';

export const USAGE = `qe-report-admin: operator actions against DATABASE_URL; nothing here is reachable over HTTP

  qe-report-admin migrate
      Applies pending schema migrations.
  qe-report-admin schema
      Reports whether the schema is current, without changing it.
  qe-report-admin key create --project <projectId> --scope <runs:read|runs:write> [--scope ...]
                             [--label <text>] [--expires-at <RFC 3339 instant>]
      Issues a project-scoped API key and prints its bearer token, once, on standard output.
  qe-report-admin key revoke --public-id <publicId>
      Revokes a key at once.
`;

/** Where the command writes: the token alone goes to `out`, everything else to `err`. */
export interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

class UsageError extends Error {}

/** Runs one command against a pool; returns the process exit code. */
export async function runAdmin(
  argv: readonly string[],
  pool: pg.Pool,
  streams: Streams,
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
        const text = values['expires-at'];
        if (!/(Z|[+-]\d{2}:\d{2})$/u.test(text) || !Number.isFinite(Date.parse(text))) {
          throw new UsageError('--expires-at must be an RFC 3339 instant with an explicit offset');
        }
        expiresAt = new Date(text);
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
    throw new UsageError(
      command === undefined ? 'a command is required' : `unknown command ${argv.join(' ')}`,
    );
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      streams.err(`${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof TypeError) {
      streams.err(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
