import type { ApiKeyScope } from 'qe-report-postgres';
import { MAX_PAGE_SIZE } from 'qe-report-postgres';

/**
 * The route table of API v1: one entry per operation, carrying the JSON Schemas Fastify
 * validates requests with and the response shapes the OpenAPI contract is generated from. The
 * route registration and the contract both read this table, so neither can describe an
 * operation the other does not have.
 */

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/** Protocol text bounds: runner names and historical ids are at most 512 characters. */
const shortText = { type: 'string', minLength: 1, maxLength: 512 } as const;
const identifier = { type: 'string', pattern: '^[\\x21-\\x7E]{1,128}$' } as const;
const runRef = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{2,172}$',
  description:
    'Unpadded base64url of the UTF-8 run id: a transport locator only, never an identity.',
} as const;
const sha256 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const decimal = {
  type: 'string',
  pattern: '^(0|[1-9][0-9]*)$',
  description: 'A decimal integer, as text: it may exceed what a JSON number holds exactly.',
} as const;
const instant = { type: 'string', format: 'date-time' } as const;
const cursor = {
  type: 'string',
  minLength: 1,
  maxLength: 2048,
  description: 'Opaque. Pass back exactly as received, to the same listing, with the same key.',
} as const;
const pageLimit = { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE } as const;
const verdict = { type: 'string', enum: ['passed', 'failed', 'inconclusive', 'incomplete'] };
const status = { type: 'string', enum: ['passed', 'failed', 'skipped', 'inconclusive'] };
const expectedStatus = { type: 'string', enum: ['passed', 'failed', 'skipped'] };
const sessionStatus = { type: 'string', enum: ['passed', 'failed', 'inconclusive'] };
const stability = { type: 'string', enum: ['stable', 'uncertain', 'unavailable'] };
const strings = { type: 'array', items: { type: 'string' } } as const;

const object = (properties: Record<string, Schema>, required: readonly string[]): Schema => ({
  type: 'object',
  properties,
  required: [...required],
  additionalProperties: false,
});

const HISTORY_QUERY = object(
  { runnerName: shortText, historicalId: shortText, limit: pageLimit, cursor },
  ['runnerName', 'historicalId'],
);
const FLAKINESS_QUERY = object({ runnerName: shortText, historicalId: shortText }, [
  'runnerName',
  'historicalId',
]);

/** The shapes the contract names, beside the protocol's own, which are added when it is generated. */
export const COMPONENT_SCHEMAS: Record<string, Schema> = {
  Problem: {
    type: 'object',
    description:
      'RFC 9457 problem details. Further members depend on the code: `diagnostics` and `runId` for a refused run, `totalRuns`, `missingRuns`, and `staleRuns` for an incomplete query index.',
    properties: {
      type: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'integer' },
      code: {
        type: 'string',
        enum: [
          'AUTHENTICATION_REQUIRED',
          'FORBIDDEN',
          'BAD_REQUEST',
          'NOT_FOUND',
          'METHOD_NOT_ALLOWED',
          'RUN_CONFLICT',
          'PAYLOAD_TOO_LARGE',
          'UNSUPPORTED_MEDIA_TYPE',
          'RUN_INVALID',
          'RUN_INCOMPLETE',
          'RUN_EMPTY',
          'INTERNAL_ERROR',
          'QUERY_INDEX_INCOMPLETE',
          'NOT_READY',
        ],
      },
      detail: { type: 'string' },
      requestId: { type: 'string' },
      runId: { type: 'string' },
      diagnostics: { type: 'array', items: ref('Diagnostic') },
      totalRuns: { type: 'integer' },
      missingRuns: { type: 'integer' },
      staleRuns: { type: 'integer' },
      problems: strings,
    },
    required: ['type', 'title', 'status', 'code', 'detail', 'requestId'],
    additionalProperties: false,
  },
  Diagnostic: object(
    {
      severity: { type: 'string', enum: ['error', 'info'] },
      code: { type: 'string' },
      detail: { type: 'string' },
      message: { type: 'string' },
      file: {
        type: 'string',
        description: 'The uploaded stream it concerns, as `events/000001.ndjson` in arrival order.',
      },
      line: { type: 'integer', minimum: 1 },
      eventId: { type: 'string' },
      pointer: { type: 'string' },
    },
    ['severity', 'code', 'message'],
  ),
  IngestionResult: object(
    {
      outcome: { type: 'string', enum: ['inserted', 'already_present'] },
      runId: identifier,
      runRef,
      ingestionSequence: decimal,
      blobRelationsAdded: { type: 'integer', minimum: 0 },
      retentionAdded: { type: 'boolean' },
      queryIndexRebuilt: { type: 'boolean' },
    },
    ['outcome', 'runId', 'runRef', 'ingestionSequence'],
  ),
  RunSummary: object(
    {
      runId: identifier,
      runRef,
      ingestionSequence: decimal,
      ingestedAt: instant,
      expiresAt: instant,
      verdict,
      complete: { type: 'boolean' },
      closed: { type: 'boolean' },
      ignoredEvents: { type: 'integer', minimum: 0 },
      duplicateEvents: { type: 'integer', minimum: 0 },
      sessionCount: { type: 'integer', minimum: 0 },
      executionCount: { type: 'integer', minimum: 0 },
      scopeFailureCount: { type: 'integer', minimum: 0 },
      attachmentCount: { type: 'integer', minimum: 0 },
    },
    [
      'runId',
      'runRef',
      'ingestionSequence',
      'ingestedAt',
      'verdict',
      'complete',
      'closed',
      'ignoredEvents',
      'duplicateEvents',
      'sessionCount',
      'executionCount',
      'scopeFailureCount',
      'attachmentCount',
    ],
  ),
  RunPage: object({ runs: { type: 'array', items: ref('RunSummary') }, nextCursor: cursor }, [
    'runs',
  ]),
  AttachmentReference: object(
    {
      sessionId: identifier,
      attemptId: identifier,
      stepId: identifier,
      name: { type: 'string' },
      mediaType: {
        type: 'string',
        description:
          'As the producer declared it. Downloads are always served as application/octet-stream.',
      },
      sizeBytes: { type: 'integer', minimum: 0 },
      sha256,
      href: { type: 'string' },
    },
    ['sessionId', 'attemptId', 'name', 'mediaType', 'sizeBytes', 'sha256', 'href'],
  ),
  Session: object(
    {
      sessionId: identifier,
      startedAt: { type: 'string' },
      producer: ref('ProtocolComponent'),
      runner: ref('ProtocolComponent'),
      environment: ref('ProtocolStringMap'),
      executor: ref('ProtocolExecutor'),
      source: ref('ProtocolSource'),
      labels: ref('ProtocolStringMap'),
      finished: { type: 'boolean' },
      finishedAt: { type: 'string' },
      status: sessionStatus,
      rawStatus: { type: 'string' },
      failures: { type: 'array', items: ref('ProtocolFailure') },
      executionIds: strings,
    },
    ['sessionId', 'startedAt', 'producer', 'finished', 'failures', 'executionIds'],
  ),
  Step: object(
    {
      stepId: identifier,
      parentStepId: identifier,
      name: { type: 'string' },
      kind: { type: 'string' },
      location: ref('ProtocolLocation'),
      startedAt: { type: 'string' },
      finished: { type: 'boolean' },
      finishedAt: { type: 'string' },
      status,
      rawStatus: { type: 'string' },
      durationMs: { type: 'integer', minimum: 0 },
      failures: { type: 'array', items: ref('ProtocolFailure') },
    },
    ['stepId', 'name', 'startedAt', 'finished', 'failures'],
  ),
  Attempt: object(
    {
      attemptId: identifier,
      attemptNumber: { type: 'integer', minimum: 1 },
      sessionId: identifier,
      startedAt: { type: 'string' },
      test: ref('ProtocolTestCase'),
      finished: { type: 'boolean' },
      finishedAt: { type: 'string' },
      status,
      rawStatus: { type: 'string' },
      expectedStatus,
      durationMs: { type: 'integer', minimum: 0 },
      failures: { type: 'array', items: ref('ProtocolFailure') },
      steps: { type: 'array', items: ref('Step') },
      attachments: { type: 'array', items: ref('AttachmentReference') },
    },
    [
      'attemptId',
      'attemptNumber',
      'sessionId',
      'startedAt',
      'test',
      'finished',
      'failures',
      'steps',
      'attachments',
    ],
  ),
  Execution: object(
    {
      executionId: identifier,
      runnerName: { type: 'string' },
      test: ref('ProtocolTestCase'),
      attempts: { type: 'array', items: ref('Attempt'), minItems: 1 },
      finalAttemptId: identifier,
      complete: { type: 'boolean' },
      finalStatus: status,
      flaky: { type: 'boolean' },
    },
    ['executionId', 'test', 'attempts', 'finalAttemptId', 'complete', 'flaky'],
  ),
  ScopeFailure: object(
    {
      sessionId: identifier,
      occurredAt: { type: 'string' },
      path: { type: 'array', items: ref('ProtocolPathSegment') },
      displayName: { type: 'string' },
      rawStatus: { type: 'string' },
      location: ref('ProtocolLocation'),
      failures: { type: 'array', items: ref('ProtocolFailure') },
    },
    ['sessionId', 'occurredAt', 'path', 'failures'],
  ),
  Run: object(
    {
      runId: identifier,
      runRef,
      validator: object(
        {
          verdict,
          complete: { type: 'boolean' },
          closed: { type: 'boolean' },
          ignoredEvents: { type: 'integer', minimum: 0 },
          duplicateEvents: { type: 'integer', minimum: 0 },
        },
        ['verdict', 'complete', 'closed', 'ignoredEvents', 'duplicateEvents'],
      ),
      sessions: { type: 'array', items: ref('Session') },
      executions: { type: 'array', items: ref('Execution') },
      scopeFailures: { type: 'array', items: ref('ScopeFailure') },
      attachments: { type: 'array', items: ref('AttachmentReference') },
    },
    ['runId', 'runRef', 'validator', 'sessions', 'executions', 'scopeFailures', 'attachments'],
  ),
  HistoryQuery: HISTORY_QUERY,
  Occurrence: object(
    {
      runId: identifier,
      runRef,
      executionId: identifier,
      sessionIds: strings,
      historicalIdStability: stability,
      occurredAt: { type: 'string' },
      attemptCount: { type: 'integer', minimum: 1 },
      complete: { type: 'boolean' },
      finalStatus: status,
      expectedStatus,
      flaky: { type: 'boolean' },
      runVerdict: verdict,
      runComplete: { type: 'boolean' },
      sessionStatus,
    },
    [
      'runId',
      'runRef',
      'executionId',
      'sessionIds',
      'historicalIdStability',
      'occurredAt',
      'attemptCount',
      'complete',
      'flaky',
      'runVerdict',
      'runComplete',
    ],
  ),
  HistoryPage: object(
    {
      runnerName: shortText,
      historicalId: shortText,
      occurrences: { type: 'array', items: ref('Occurrence') },
      nextCursor: cursor,
    },
    ['runnerName', 'historicalId', 'occurrences'],
  ),
  FlakinessQuery: FLAKINESS_QUERY,
  Flakiness: object(
    {
      runnerName: shortText,
      historicalId: shortText,
      totalOccurrences: { type: 'integer', minimum: 0 },
      flakyOccurrences: { type: 'integer', minimum: 0 },
      everFlaky: { type: 'boolean' },
    },
    ['runnerName', 'historicalId', 'totalOccurrences', 'flakyOccurrences', 'everFlaky'],
  ),
  Health: object({ status: { type: 'string', enum: ['ok'] } }, ['status']),
};

/** One response of an operation, by status. */
export interface ResponseSpec {
  readonly description: string;
  /** The media type and schema of the body; absent for a body-less response. */
  readonly content?: { readonly mediaType: string; readonly schema: Schema };
  readonly headers?: Readonly<Record<string, { description: string; schema: Schema }>>;
}

export interface RouteSpec {
  readonly method: 'GET' | 'POST';
  /** Fastify's form, `:name` parameters. */
  readonly url: string;
  readonly operationId: string;
  readonly summary: string;
  /** The scope a key needs; absent for the unauthenticated operational routes. */
  readonly scope?: ApiKeyScope;
  readonly params?: Schema;
  readonly querystring?: Schema;
  /** A JSON body Fastify validates. */
  readonly body?: Schema;
  /** A body Fastify does not validate (the multipart upload), described for the contract only. */
  readonly requestBody?: { readonly mediaType: string; readonly schema: Schema };
  readonly responses: Readonly<Record<number, ResponseSpec>>;
}

const json = (schema: Schema): { mediaType: string; schema: Schema } => ({
  mediaType: 'application/json',
  schema,
});
const problem = (description: string): ResponseSpec => ({
  description,
  content: { mediaType: 'application/problem+json', schema: ref('Problem') },
});
const requestIdHeader = {
  'X-Request-Id': {
    description: 'The id this server gave the request; quote it when reporting a problem.',
    schema: { type: 'string', format: 'uuid' },
  },
};
const authProblems: Record<number, ResponseSpec> = {
  401: problem(
    'No valid API key. Unknown, malformed, expired, and revoked keys are not told apart.',
  ),
  403: problem('The key is valid but lacks the scope this operation needs.'),
};
const runRefParams: Schema = object({ runRef }, ['runRef']);

export const ROUTES: readonly RouteSpec[] = [
  {
    method: 'GET',
    url: '/healthz',
    operationId: 'getHealth',
    summary: 'Process liveness only.',
    responses: { 200: { description: 'The process is up.', content: json(ref('Health')) } },
  },
  {
    method: 'GET',
    url: '/readyz',
    operationId: 'getReadiness',
    summary: 'Whether every dependency needed to serve requests is usable.',
    responses: {
      200: { description: 'Ready.', content: json(ref('Health')) },
      503: problem('Not ready: the database, its schema, or a storage root is not usable.'),
    },
  },
  {
    method: 'POST',
    url: '/v1/runs',
    operationId: 'ingestRun',
    summary: 'Upload one complete run as multipart protocol source and attachment bytes.',
    scope: 'runs:write',
    requestBody: {
      mediaType: 'multipart/form-data',
      schema: {
        type: 'object',
        description:
          'The project is the API key’s; no part names one. Event streams are stored exactly as sent. Unknown part names are refused.',
        properties: {
          expiresAt: {
            type: 'string',
            format: 'date-time',
            description:
              'Required, exactly once, as text: an RFC 3339 instant with an explicit offset after which retention may delete the run. A past instant is valid.',
          },
          events: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', format: 'binary' },
            description: 'One or more NDJSON protocol event streams, as file parts.',
          },
          attachment: {
            type: 'array',
            items: { type: 'string', format: 'binary' },
            description:
              'Zero or more attachment byte streams, as file parts, identified by the SHA-256 of their bytes; filenames and media types are ignored.',
          },
        },
        required: ['expiresAt', 'events'],
      },
    },
    responses: {
      201: {
        description: 'Archived now.',
        content: json(ref('IngestionResult')),
        headers: {
          Location: { description: 'The run, by its runRef.', schema: { type: 'string' } },
        },
      },
      200: {
        description: 'The same run was already archived; derived state may have been repaired.',
        content: json(ref('IngestionResult')),
      },
      400: problem('The request itself is malformed: its multipart framing or parts.'),
      ...authProblems,
      409: problem('Another run is archived under this run id in this project.'),
      413: problem('A transport limit was exceeded; nothing was written.'),
      415: problem('The body is not multipart/form-data.'),
      422: problem('The protocol source is invalid, incomplete, or empty; nothing was written.'),
    },
  },
  {
    method: 'GET',
    url: '/v1/runs',
    operationId: 'listRuns',
    summary: 'The project’s runs, newest archived first, in keyset pages.',
    scope: 'runs:read',
    querystring: object({ limit: pageLimit, cursor }, []),
    responses: {
      200: { description: 'One page.', content: json(ref('RunPage')) },
      400: problem('A malformed cursor or limit.'),
      ...authProblems,
      503: problem('The project’s query index is incomplete; nothing partial is answered.'),
    },
  },
  {
    method: 'GET',
    url: '/v1/runs/:runRef',
    operationId: 'getRun',
    summary: 'One whole run, replayed from its archived source.',
    scope: 'runs:read',
    params: runRefParams,
    responses: {
      200: { description: 'The run.', content: json(ref('Run')) },
      ...authProblems,
      404: problem('No such run in this project.'),
    },
  },
  {
    method: 'GET',
    url: '/v1/runs/:runRef/attachments/:sha256',
    operationId: 'getAttachment',
    summary: 'The bytes of an attachment the run references, streamed.',
    scope: 'runs:read',
    params: object({ runRef, sha256 }, ['runRef', 'sha256']),
    responses: {
      200: {
        description: 'The bytes, always as application/octet-stream.',
        content: {
          mediaType: 'application/octet-stream',
          schema: { type: 'string', format: 'binary' },
        },
        headers: {
          'X-Content-Type-Options': {
            description: 'Always nosniff.',
            schema: { type: 'string', enum: ['nosniff'] },
          },
        },
      },
      ...authProblems,
      404: problem('No such run in this project, or the run references no such attachment.'),
    },
  },
  {
    method: 'POST',
    url: '/v1/history/query',
    operationId: 'queryHistory',
    summary:
      'One historical test’s occurrences across the project’s runs, in keyset pages. Read-only.',
    scope: 'runs:read',
    body: HISTORY_QUERY,
    responses: {
      200: { description: 'One page, in history order.', content: json(ref('HistoryPage')) },
      400: problem('A malformed body or cursor.'),
      ...authProblems,
      415: problem('The body is not application/json.'),
      503: problem('The project’s query index is incomplete; nothing partial is answered.'),
    },
  },
  {
    method: 'POST',
    url: '/v1/flakiness/query',
    operationId: 'queryFlakiness',
    summary: 'How often one historical test’s executions were flaky. Read-only.',
    scope: 'runs:read',
    body: FLAKINESS_QUERY,
    responses: {
      200: { description: 'The counts.', content: json(ref('Flakiness')) },
      400: problem('A malformed body.'),
      ...authProblems,
      415: problem('The body is not application/json.'),
      503: problem('The project’s query index is incomplete; nothing partial is answered.'),
    },
  },
];

export const REQUEST_ID_HEADER = requestIdHeader;
