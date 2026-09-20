/** What was wrong with the producer's own run directory, before anything was sent. */
export type LocalRunProblem =
  /** An entry that is a link, a directory, or a special file where a regular file belongs. */
  | 'UNSAFE_ENTRY'
  /** The directory or one of its files cannot be read at all. */
  | 'UNREADABLE'
  /** No `events/*.ndjson` to upload. */
  | 'NO_EVENTS'
  /** An attachment's bytes are not the hash its name claims. */
  | 'ATTACHMENT_HASH_MISMATCH'
  /** A planned file changed between or during attempts; the upload stops rather than mixing runs. */
  | 'RUN_DIRECTORY_CHANGED';

/**
 * The local run directory cannot be uploaded as it is. Nothing was sent, or what was being sent
 * was abandoned: the producer's output is the problem, and the server never saw a complete run.
 */
export class LocalRunDirectoryError extends Error {
  readonly problem: LocalRunProblem;

  constructor(problem: LocalRunProblem, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'LocalRunDirectoryError';
    this.problem = problem;
  }
}

/** One validator diagnostic as the service reported it; the shapes are the service's. */
export interface ServerDiagnostic {
  readonly severity?: string;
  readonly code?: string;
  readonly detail?: string;
  readonly message?: string;
  readonly file?: string;
  readonly line?: number;
  readonly eventId?: string;
}

/**
 * The service refused the run, and would refuse it again: a conflict, an invalid or incomplete
 * run, a credential that may not do this, a limit. It carries what the service said and nothing
 * of the request that carried the key.
 */
export class UploadRejectedError extends Error {
  readonly status: number;
  /** The service's problem code, such as `RUN_CONFLICT` or `RUN_INVALID`, when it gave one. */
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly runId: string | undefined;
  readonly diagnostics: readonly ServerDiagnostic[];

  constructor(
    status: number,
    detail: string,
    facts: {
      code?: string | undefined;
      requestId?: string | undefined;
      runId?: string | undefined;
      diagnostics?: readonly ServerDiagnostic[];
    } = {},
  ) {
    super(detail);
    this.name = 'UploadRejectedError';
    this.status = status;
    this.code = facts.code;
    this.requestId = facts.requestId;
    this.runId = facts.runId;
    this.diagnostics = facts.diagnostics ?? [];
  }
}

/**
 * The run could not be delivered: the connection failed, the attempt timed out, the caller
 * cancelled, or the service kept answering in a way worth trying again until the attempts ran
 * out. Whether the last attempt reached the service is unknown, which is why an upload may be
 * repeated: the same run uploaded twice is the same run.
 */
export class UploadTransportError extends Error {
  readonly attempts: number;
  /** The service's request id of the last attempt that got far enough to give one. */
  readonly requestId: string | undefined;
  /** The last status seen, when the last attempt was answered at all. */
  readonly status: number | undefined;

  constructor(
    message: string,
    facts: {
      attempts: number;
      requestId?: string | undefined;
      status?: number | undefined;
      cause?: unknown;
    },
  ) {
    super(message, facts.cause === undefined ? {} : { cause: facts.cause });
    this.name = 'UploadTransportError';
    this.attempts = facts.attempts;
    this.requestId = facts.requestId;
    this.status = facts.status;
  }
}
