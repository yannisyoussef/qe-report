import fastifyMultipart from '@fastify/multipart';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { Ajv } from 'ajv';
import { randomUUID } from 'node:crypto';
import {
  QueryIndexIncompleteError,
  type ApiKeyPrincipal,
  type ApiKeyScope,
  type PostgresApiKeys,
  type PostgresQueries,
  type PostgresRunStore,
} from 'qe-report-postgres';
import { isSha256 } from 'qe-report-blob-fs';
import {
  decodeHistoryCursor,
  decodeRunsCursor,
  encodeHistoryCursor,
  encodeRunsCursor,
} from './cursors.js';
import { flakinessDto, historyPageDto, runDto, runSummaryDto } from './dto.js';
import { ingestUpload } from './ingest.js';
import { resolveLimits, type TransportLimits } from './limits.js';
import { Problem, problemBody, type ProblemCode } from './problems.js';
import { decodeRunRef } from './run-ref.js';
import { ROUTES, type RouteSpec } from './schemas.js';
import { checkRoots, rootUsable } from './staging.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who the request's API key speaks for; set on every authenticated route before its handler. */
    principal: ApiKeyPrincipal | null;
  }
}

export interface QeReportApiOptions {
  readonly runStore: Pick<PostgresRunStore, 'persistRunDirectory' | 'openBlob'>;
  readonly queries: Pick<
    PostgresQueries,
    'getRun' | 'listRuns' | 'getTestHistoryPage' | 'getFlakinessSummary'
  >;
  readonly apiKeys: Pick<PostgresApiKeys, 'authenticate'>;
  /** Where uploads are staged; a real directory, apart from the blob root. */
  readonly stagingRoot: string;
  /** The durable blob root, checked to be apart from staging and usable for readiness. */
  readonly blobRoot: string;
  /** The database's readiness: one sentence per problem, none when it can serve. */
  readonly checkDatabase: () => Promise<readonly string[]>;
  readonly limits?: Partial<TransportLimits>;
  /** The blob store's own ceiling, which the attachment limit may not exceed. */
  readonly maxBlobBytes?: number;
  /** Fastify's logger option; requests are logged without headers, bodies, or tokens. */
  readonly logger?: FastifyServerOptions['logger'];
}

const REALM = 'Bearer realm="qe-report"';
/** `Bearer <token>`: one space, one token, the scheme in any case. */
const BEARER = /^Bearer ([!-~]+)$/iu;

/**
 * API v1 over the existing store and queries. Every authenticated route acts on the project its
 * key belongs to and on nothing else: no path, query, header, or body names a project. The API
 * holds no state of its own; everything it answers comes from the store and the query layer.
 */
export async function createQeReportApi(options: QeReportApiOptions): Promise<FastifyInstance> {
  const limits = resolveLimits(options.limits, options.maxBlobBytes);
  const stagingRoot = checkRoots(options.stagingRoot, options.blobRoot);
  const logger = loggerOptions(options.logger, stagingRoot);
  const app = Fastify({
    ...(logger === undefined ? {} : { logger }),
    // One line per request is written by the onResponse hook below, and nothing else.
    logController: new LogController({ disableRequestLogging: true }),
    // A runRef of a 128-character run id is 171 characters; the default of 100 would lose it.
    routerOptions: { maxParamLength: 256 },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: false,
    bodyLimit: limits.maxJsonBodyBytes,
  });
  // A query string is text, so it alone is coerced; a JSON body and a path parameter must
  // already have the declared types, and nothing unknown is silently dropped from either.
  const strict = new Ajv({ removeAdditional: false, coerceTypes: false, useDefaults: false });
  const lenient = new Ajv({ removeAdditional: false, coerceTypes: true, useDefaults: false });
  app.setValidatorCompiler(({ schema, httpPart }) =>
    (httpPart === 'querystring' ? lenient : strict).compile(schema),
  );
  app.decorateRequest('principal', null);
  await app.register(fastifyMultipart, { throwFileSizeLimit: true });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        keyId: request.principal?.publicId,
      },
      'request completed',
    );
  });
  app.setNotFoundHandler(async () => {
    throw new Problem('NOT_FOUND', 'no such resource');
  });
  app.setErrorHandler(async (error: FastifyError | Error, request, reply) =>
    sendProblem(request, reply, asProblem(error, request)),
  );

  const handlers: Record<string, (request: FastifyRequest, reply: FastifyReply) => unknown> = {
    getHealth: async () => ({ status: 'ok' }),
    getReadiness: async (_request, reply) => {
      const problems = [...(await safely(options.checkDatabase))];
      if (!(await rootUsable(options.blobRoot))) problems.push('the blob root is not usable');
      if (!(await rootUsable(stagingRoot))) problems.push('the staging root is not usable');
      if (problems.length > 0)
        throw new Problem('NOT_READY', 'a dependency is not usable', { problems });
      reply.code(200);
      return { status: 'ok' };
    },
    ingestRun: async (request, reply) => {
      const answer = await ingestUpload(
        request,
        principalOf(request).projectId,
        options.runStore,
        stagingRoot,
        limits,
      );
      if (answer.location !== undefined) reply.header('location', answer.location);
      reply.code(answer.status);
      return answer.body;
    },
    listRuns: async (request) => {
      const { projectId } = principalOf(request);
      const query = request.query as { limit?: number; cursor?: string };
      const page = await options.queries.listRuns({
        projectId,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined
          ? {}
          : { beforeIngestionSequence: decodeRunsCursor(projectId, query.cursor) }),
      });
      return {
        runs: page.runs.map(runSummaryDto),
        ...(page.next === undefined ? {} : { nextCursor: encodeRunsCursor(projectId, page.next) }),
      };
    },
    getRun: async (request) => {
      const { projectId } = principalOf(request);
      const runId = runIdOf((request.params as { runRef: string }).runRef);
      const run = await options.queries.getRun(projectId, runId);
      if (run === undefined) throw new Problem('NOT_FOUND', 'no such run in this project');
      return runDto(run);
    },
    getAttachment: async (request, reply) => {
      const { projectId } = principalOf(request);
      const params = request.params as { runRef: string; sha256: string };
      const runId = runIdOf(params.runRef);
      if (!isSha256(params.sha256)) throw new Problem('BAD_REQUEST', 'not a SHA-256 in hex');
      // Only through a run of this project that references the hash: never by the hash alone.
      const opened = await options.runStore.openBlob(projectId, runId, params.sha256);
      if (opened === undefined) {
        throw new Problem('NOT_FOUND', 'no such attachment on a run in this project');
      }
      reply
        .code(200)
        .header('content-type', 'application/octet-stream')
        .header('x-content-type-options', 'nosniff')
        .header('content-length', String(opened.sizeBytes))
        .header('content-disposition', `attachment; filename="${opened.sha256}"`);
      return reply.send(opened.stream);
    },
    queryHistory: async (request) => {
      const { projectId } = principalOf(request);
      const body = request.body as {
        runnerName: string;
        historicalId: string;
        limit?: number;
        cursor?: string;
      };
      const page = await options.queries.getTestHistoryPage({
        projectId,
        runnerName: body.runnerName,
        historicalId: body.historicalId,
        ...(body.limit === undefined ? {} : { limit: body.limit }),
        ...(body.cursor === undefined
          ? {}
          : {
              after: decodeHistoryCursor(
                projectId,
                body.runnerName,
                body.historicalId,
                body.cursor,
              ),
            }),
      });
      return historyPageDto(
        page,
        page.next === undefined
          ? undefined
          : encodeHistoryCursor(projectId, body.runnerName, body.historicalId, page.next),
      );
    },
    queryFlakiness: async (request) => {
      const { projectId } = principalOf(request);
      const body = request.body as { runnerName: string; historicalId: string };
      return flakinessDto(
        await options.queries.getFlakinessSummary({
          projectId,
          runnerName: body.runnerName,
          historicalId: body.historicalId,
        }),
      );
    },
  };

  for (const route of ROUTES) {
    const handler = handlers[route.operationId];
    if (handler === undefined) throw new Error(`no handler for ${route.operationId}`);
    app.route({
      method: route.method,
      url: route.url,
      schema: requestSchema(route),
      ...(route.scope === undefined
        ? {}
        : { onRequest: authenticate(options.apiKeys, route.scope) }),
      handler,
    });
  }
  return app;
}

function requestSchema(route: RouteSpec): Record<string, unknown> {
  return {
    ...(route.params === undefined ? {} : { params: route.params }),
    ...(route.querystring === undefined ? {} : { querystring: route.querystring }),
    ...(route.body === undefined ? {} : { body: route.body }),
  };
}

/**
 * Resolves the bearer token before anything else about the request is read, the body included.
 * A key is the only credential: nothing in the query, a cookie, or the body is ever looked at.
 */
function authenticate(
  apiKeys: Pick<PostgresApiKeys, 'authenticate'>,
  scope: ApiKeyScope,
): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    const header = request.headers.authorization;
    const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
    const principal = token === undefined ? undefined : await apiKeys.authenticate(token);
    if (principal === undefined) {
      throw new Problem('AUTHENTICATION_REQUIRED', 'a valid API key is required');
    }
    request.principal = principal;
    if (!principal.scopes.includes(scope)) {
      throw new Problem('FORBIDDEN', `this operation needs the ${scope} scope`);
    }
  };
}

/** The run a runRef names; one that is not a canonical encoding of a run id is refused. */
function runIdOf(runRef: string): string {
  const runId = decodeRunRef(runRef);
  if (runId === undefined) throw new Problem('BAD_REQUEST', 'not a runRef');
  return runId;
}

function principalOf(request: FastifyRequest): ApiKeyPrincipal {
  if (request.principal === null) throw new Error('an authenticated route ran without a principal');
  return request.principal;
}

async function safely(check: () => Promise<readonly string[]>): Promise<readonly string[]> {
  try {
    return await check();
  } catch {
    return ['the database is not reachable'];
  }
}

/** Fastify's own refusals, by status, as this API's problems. */
const FRAMEWORK: Readonly<Record<number, ProblemCode>> = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'UNSUPPORTED_MEDIA_TYPE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/**
 * Every error as the problem a client may see. Expected refusals keep their detail; an incomplete
 * query index says how incomplete; anything unexpected, an archive integrity failure included,
 * is a bare 500 whose detail is logged here and never sent.
 */
function asProblem(error: FastifyError | Error, request: FastifyRequest): Problem {
  if (error instanceof Problem) return error;
  if (error instanceof QueryIndexIncompleteError) {
    return new Problem(
      'QUERY_INDEX_INCOMPLETE',
      'the project’s query index does not cover every archived run; an operator must rebuild it',
      {
        totalRuns: error.status.totalRuns,
        missingRuns: error.status.missingRuns,
        staleRuns: error.status.staleRuns,
      },
    );
  }
  const fastify = error as FastifyError;
  if (fastify.validation !== undefined) {
    return new Problem('BAD_REQUEST', `the request does not match its schema: ${fastify.message}`);
  }
  const code =
    typeof fastify.statusCode === 'number' && fastify.code?.startsWith('FST_')
      ? FRAMEWORK[fastify.statusCode]
      : undefined;
  if (code !== undefined) {
    return new Problem(code, PROBLEM_DETAIL[code] ?? 'the request was refused');
  }
  request.log.error(
    { requestId: request.id, error: { name: error.name, message: error.message } },
    'request failed',
  );
  return new Problem('INTERNAL_ERROR', 'the server could not complete the request');
}

const PROBLEM_DETAIL: Readonly<Partial<Record<ProblemCode, string>>> = {
  BAD_REQUEST: 'the request is malformed',
  NOT_FOUND: 'no such resource',
  METHOD_NOT_ALLOWED: 'the method is not allowed here',
  UNSUPPORTED_MEDIA_TYPE: 'the request body has a media type this operation does not take',
  PAYLOAD_TOO_LARGE: 'the request body is larger than this server accepts',
};

async function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  problem: Problem,
): Promise<FastifyReply> {
  if (problem.status === 401) reply.header('www-authenticate', REALM);
  // An upload refused before its body was read is not read after it either.
  if (request.method === 'POST' && request.routeOptions.url === '/v1/runs') {
    reply.header('connection', 'close');
  }
  return reply
    .code(problem.status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send(JSON.stringify(problemBody(problem, request.id)));
}

/** Anything shaped like an API key, whole or in part, wherever it appears in a log line. */
const TOKEN_TEXT = /qer_k1_[A-Za-z0-9_]*/gu;
/** The value of any header or member called authorization or cookie, quoted in JSON. */
const SECRET_MEMBER = /("(?:authorization|cookie|set-cookie)"\s*:\s*)"(?:[^"\\]|\\.)*"/giu;

/**
 * The logger, with requests reduced to their method and route: no URL with a cursor or a run
 * reference, no header, no body. Header paths are redacted where they are known, and every line
 * is scrubbed once more as it is written, because a dependency may log headers under a path
 * nobody listed: no token, authorization value, cookie, or staging path leaves the process at
 * any level. A caller's object options are kept otherwise.
 */
function loggerOptions(
  logger: FastifyServerOptions['logger'] | undefined,
  stagingRoot: string,
): Exclude<FastifyServerOptions['logger'], boolean | undefined> | undefined {
  if (logger === undefined || logger === false) return undefined;
  const base = logger === true ? {} : (logger as Record<string, unknown>);
  const staging = JSON.stringify(stagingRoot).slice(1, -1);
  return {
    ...base,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        '*.headers.authorization',
        '*.headers.cookie',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req: (req: FastifyRequest) => ({ method: req.method, route: req.routeOptions?.url }),
      res: (res: FastifyReply) => ({ statusCode: res.statusCode }),
    },
    hooks: {
      streamWrite: (line: string): string =>
        line
          .replace(TOKEN_TEXT, '[redacted]')
          .replace(SECRET_MEMBER, '$1"[redacted]"')
          .replaceAll(staging, '[staging]'),
    },
  } as Exclude<FastifyServerOptions['logger'], boolean | undefined>;
}
