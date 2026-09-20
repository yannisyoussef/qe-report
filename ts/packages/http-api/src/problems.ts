/** Every problem this API answers with, and the status each one carries. */
export const PROBLEMS = {
  AUTHENTICATION_REQUIRED: { status: 401, title: 'Authentication required' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  BAD_REQUEST: { status: 400, title: 'Bad request' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  RUN_CONFLICT: { status: 409, title: 'Run conflict' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  RUN_INVALID: { status: 422, title: 'Run invalid' },
  RUN_INCOMPLETE: { status: 422, title: 'Run incomplete' },
  RUN_EMPTY: { status: 422, title: 'Run empty' },
  INTERNAL_ERROR: { status: 500, title: 'Internal error' },
  QUERY_INDEX_INCOMPLETE: { status: 503, title: 'Query index incomplete' },
  NOT_READY: { status: 503, title: 'Not ready' },
} as const;

export type ProblemCode = keyof typeof PROBLEMS;

/** The `type` URI of a problem code: `RUN_CONFLICT` is `urn:qe-report:problem:run-conflict`. */
export function problemType(code: ProblemCode): string {
  return `urn:qe-report:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

/**
 * An expected refusal, raised anywhere in a request and answered as `application/problem+json`.
 * `detail` is written for the client and never carries a path, a statement, or a stack.
 */
export class Problem extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly detail: string;
  /** Further members of the problem document, such as validator diagnostics. */
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(code: ProblemCode, detail: string, extensions: Record<string, unknown> = {}) {
    super(detail);
    this.name = 'Problem';
    this.code = code;
    this.status = PROBLEMS[code].status;
    this.detail = detail;
    this.extensions = extensions;
  }
}

/** The problem document itself. */
export function problemBody(problem: Problem, requestId: string): Record<string, unknown> {
  return {
    type: problemType(problem.code),
    title: PROBLEMS[problem.code].title,
    status: problem.status,
    code: problem.code,
    detail: problem.detail,
    requestId,
    ...problem.extensions,
  };
}
