import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { FileBlobStore } from 'qe-report-blob-fs';
import {
  PostgresApiKeys,
  PostgresQueries,
  PostgresRunStore,
  schemaStatus,
} from 'qe-report-postgres';
import { createQeReportApi } from './app.js';
import type { TransportLimits } from './limits.js';

/** The environment the standalone server reads, and nothing else. */
export interface ServerConfig {
  readonly databaseUrl: string;
  readonly blobRoot: string;
  readonly stagingRoot: string;
  /** Loopback unless the operator says otherwise: the server never binds publicly by default. */
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly limits: Partial<TransportLimits>;
}

/** Each limit and the variable that overrides it. */
const LIMIT_VARIABLES: Readonly<Record<keyof TransportLimits, string>> = {
  maxRequestBytes: 'QE_REPORT_MAX_REQUEST_BYTES',
  maxEventParts: 'QE_REPORT_MAX_EVENT_PARTS',
  maxEventBytes: 'QE_REPORT_MAX_EVENT_BYTES',
  maxAttachmentParts: 'QE_REPORT_MAX_ATTACHMENT_PARTS',
  maxAttachmentBytes: 'QE_REPORT_MAX_ATTACHMENT_BYTES',
  maxTotalAttachmentBytes: 'QE_REPORT_MAX_TOTAL_ATTACHMENT_BYTES',
  maxJsonBodyBytes: 'QE_REPORT_MAX_JSON_BODY_BYTES',
};

export function configFrom(env: NodeJS.ProcessEnv): ServerConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} must be set`);
    return value;
  };
  const port = Number(env.QE_REPORT_PORT ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('QE_REPORT_PORT must be a port number');
  }
  const limits: Partial<Record<keyof TransportLimits, number>> = {};
  for (const [limit, name] of Object.entries(LIMIT_VARIABLES) as [
    keyof TransportLimits,
    string,
  ][]) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive whole number`);
    limits[limit] = Number(value);
  }
  return {
    databaseUrl: required('DATABASE_URL'),
    blobRoot: required('QE_REPORT_BLOB_ROOT'),
    stagingRoot: required('QE_REPORT_STAGING_ROOT'),
    host: env.QE_REPORT_HOST ?? '127.0.0.1',
    port,
    logLevel: env.QE_REPORT_LOG_LEVEL ?? 'info',
    limits,
  };
}

export interface RunningServer {
  readonly app: FastifyInstance;
  /** Where it listens, as the operating system bound it. */
  readonly address: string;
  close(): Promise<void>;
}

/**
 * Starts API v1 against an already migrated database. A schema that is absent or not the one
 * this code expects stops the start with the reason; migrating is the operator's explicit
 * action (`qe-report-admin migrate`), never a side effect of a process starting.
 */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  pool.on('error', () => undefined);
  try {
    const schema = await schemaStatus(pool);
    if (!schema.current) {
      throw new Error(
        `the database schema is not current (${schema.problems.join('; ')}); run qe-report-admin migrate first`,
      );
    }
    const blobs = new FileBlobStore(config.blobRoot);
    const app = await createQeReportApi({
      runStore: new PostgresRunStore(pool, blobs),
      queries: new PostgresQueries(pool),
      apiKeys: new PostgresApiKeys(pool),
      stagingRoot: config.stagingRoot,
      blobRoot: blobs.root,
      maxBlobBytes: blobs.maxBlobBytes,
      limits: config.limits,
      logger: { level: config.logLevel },
      checkDatabase: async () => {
        await pool.query('SELECT 1');
        return (await schemaStatus(pool)).problems;
      },
    });
    const address = await app.listen({ host: config.host, port: config.port });
    return {
      app,
      address,
      close: async () => {
        await app.close();
        await pool.end();
      },
    };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}
