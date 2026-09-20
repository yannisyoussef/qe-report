import {
  LocalRunDirectoryError,
  UploadRejectedError,
  UploadTransportError,
  type ServerDiagnostic,
} from './errors.js';
import { checkExpiresAt } from './instants.js';
import { planUpload, type UploadPlan } from './local-run.js';
import { multipartBody } from './multipart.js';
import {
  DEFAULT_RETRY,
  RETRIABLE_STATUSES,
  delayBefore,
  isRetriableError,
  resolveRetry,
  retryAfterMs,
  type RetryPolicy,
} from './retry.js';
import { resolveTarget, type Target } from './target.js';
import { UploadAborted, send, type AttemptResponse } from './transport.js';

/** An attachment can be 64 MiB and a run can hold many; a delivery is not a small REST call. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
/** API v1 answers in a few hundred bytes; anything beyond this is not an answer of its. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface QeReportHttpClientOptions {
  /** The service's base URL; a deployment path prefix is kept. */
  readonly baseUrl: string;
  /** The bearer token. It is never logged, thrown, serialised, or returned. */
  readonly apiKey: string;
  readonly retry?: Partial<RetryPolicy>;
  readonly attemptTimeoutMs?: number;
  /** Allows plaintext HTTP to a host that is not this machine. For development only. */
  readonly allowInsecureHttp?: boolean;
  /** Seams for tests: no upload sleeps for real, and no jitter is guessed at. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export interface UploadRunRequest {
  /** The completed run directory a producer wrote; it is read, never changed or removed. */
  readonly runDirectory: string;
  /** When retention may delete the run. Decided by the caller, exactly once, before attempt one. */
  readonly expiresAt: Date;
  readonly signal?: AbortSignal;
}

export interface UploadResult {
  readonly outcome: 'inserted' | 'already_present';
  readonly runId: string;
  readonly runRef: string;
  /** Decimal text: the archive's sequence is a 64-bit integer. */
  readonly ingestionSequence: string;
  /** The service's own id for the request that archived or recognised the run. */
  readonly requestId: string | undefined;
  /** How many attempts it took, the successful one included. */
  readonly attempts: number;
  /** The service repaired this run's derived index while recognising it. */
  readonly queryIndexRebuilt?: boolean;
}

const JSON_TYPE = /^application\/json\s*(;|$)/iu;
const PROBLEM_TYPE = /^application\/problem\+json\s*(;|$)/iu;

/**
 * Uploads completed run directories to a qe-report service. It is a run uploader, not an event
 * sink: a producer writes its events locally through the SDK's file sink, and that finished
 * directory is what is delivered. The directory is the producer's own durable spool, so a
 * delivery can be retried, from another process or another day, and nothing is deleted here.
 *
 * The project is never named: the API key is issued for one project, and that is the project a
 * run is archived into.
 */
export class QeReportHttpClient {
  private readonly target: Target;
  private readonly apiKey: string;
  private readonly retry: RetryPolicy;
  private readonly attemptTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(options: QeReportHttpClientOptions) {
    this.target = resolveTarget(options.baseUrl, options.allowInsecureHttp ?? false);
    if (typeof options.apiKey !== 'string' || !/^[\x21-\x7e]+$/u.test(options.apiKey)) {
      throw new TypeError('apiKey must be the bearer token of a project-scoped API key');
    }
    this.apiKey = options.apiKey;
    this.retry = resolveRetry(options.retry);
    const timeout = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1) {
      throw new TypeError('attemptTimeoutMs must be a whole number of milliseconds');
    }
    this.attemptTimeoutMs = timeout;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** Where this client uploads; the key is not part of it. */
  get endpoint(): string {
    return this.target.runs.href;
  }

  /** Nothing of this client is worth serialising, and the key must never be. */
  toJSON(): Record<string, unknown> {
    return { endpoint: this.endpoint };
  }

  toString(): string {
    return `QeReportHttpClient(${this.endpoint})`;
  }

  /**
   * Reads the run directory, then delivers it. The plan is made once: retries send the same
   * files, in the same order, with the same expiry, and stop at once if the directory changes.
   */
  async uploadRunDirectory(request: UploadRunRequest): Promise<UploadResult> {
    const expiresAt = checkExpiresAt(request.expiresAt).toISOString();
    const plan = await planUpload(request.runDirectory);
    return this.deliver(plan, expiresAt, request.signal);
  }

  private async deliver(
    plan: UploadPlan,
    expiresAt: string,
    signal: AbortSignal | undefined,
  ): Promise<UploadResult> {
    let lastProblem: {
      message: string;
      status?: number | undefined;
      requestId?: string | undefined;
      cause?: unknown;
    } = {
      message: 'the upload was not delivered',
    };
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      if (signal?.aborted === true) throw new UploadAborted();
      const body = multipartBody(plan, expiresAt);
      let response: AttemptResponse;
      try {
        response = await send({
          url: this.target.runs,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': body.contentType,
            'content-length': String(body.contentLength),
            accept: 'application/json, application/problem+json',
            'user-agent': 'qe-report-http-client',
          },
          body: body.open(),
          timeoutMs: this.attemptTimeoutMs,
          signal,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        });
      } catch (e) {
        // A directory that changed underneath the upload is the producer's problem, not the
        // network's: it is never attempted again.
        if (e instanceof LocalRunDirectoryError || e instanceof UploadAborted) throw e;
        if (!isRetriableError(e)) {
          throw new UploadTransportError(`the upload could not be delivered: ${safely(e)}`, {
            attempts: attempt,
            cause: e,
          });
        }
        lastProblem = { message: safely(e), cause: e };
        await this.waitBefore(attempt, undefined, signal);
        continue;
      }

      const requestId = response.headers['x-request-id'];
      const answer = this.read(response, attempt, requestId);
      if (answer.kind === 'done') return answer.result;
      if (answer.kind === 'rejected') throw answer.error;
      lastProblem = { message: answer.why, status: response.status, requestId };
      await this.waitBefore(attempt, response, signal);
    }
    throw new UploadTransportError(
      `the upload was not delivered after ${this.retry.maxAttempts} attempts: ${lastProblem.message}`,
      {
        attempts: this.retry.maxAttempts,
        ...(lastProblem.requestId === undefined ? {} : { requestId: lastProblem.requestId }),
        ...(lastProblem.status === undefined ? {} : { status: lastProblem.status }),
        ...(lastProblem.cause === undefined ? {} : { cause: lastProblem.cause }),
      },
    );
  }

  /** The wait before the next attempt, unless this was the last one. */
  private async waitBefore(
    attempt: number,
    response: AttemptResponse | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (attempt >= this.retry.maxAttempts) return;
    const after = retryAfterMs(response?.headers['retry-after'], this.now());
    await this.sleep(delayBefore(attempt, this.retry, after, this.random), signal);
    if (signal?.aborted === true) throw new UploadAborted();
  }

  /**
   * What one answer means: a run archived or recognised, a refusal to carry back, or something
   * to try again. A 3xx is never followed: the key would travel to wherever it pointed.
   */
  private read(
    response: AttemptResponse,
    attempt: number,
    requestId: string | undefined,
  ):
    | { kind: 'done'; result: UploadResult }
    | { kind: 'rejected'; error: UploadRejectedError }
    | { kind: 'again'; why: string } {
    const { status } = response;
    const type = response.headers['content-type'] ?? '';
    if (status === 200 || status === 201) {
      if (response.truncated || !JSON_TYPE.test(type)) {
        // The service may have archived the run; the answer is unusable, and the next attempt
        // settles it as `already_present`.
        return { kind: 'again', why: 'the service answered in a form this client cannot read' };
      }
      const result = successOf(response.text, requestId, attempt);
      return result === undefined
        ? { kind: 'again', why: 'the service answered with an incomplete result' }
        : { kind: 'done', result };
    }
    const problem = PROBLEM_TYPE.test(type) && !response.truncated ? problemOf(response.text) : {};
    if (RETRIABLE_STATUSES.has(status)) {
      return { kind: 'again', why: `the service answered ${status}` };
    }
    return {
      kind: 'rejected',
      error: new UploadRejectedError(status, detailOf(status, problem), {
        ...(problem.code === undefined ? {} : { code: problem.code }),
        ...(requestId === undefined ? {} : { requestId }),
        ...(problem.runId === undefined ? {} : { runId: problem.runId }),
        ...(problem.diagnostics === undefined ? {} : { diagnostics: problem.diagnostics }),
      }),
    };
  }
}

interface ProblemFacts {
  code?: string;
  detail?: string;
  runId?: string;
  diagnostics?: readonly ServerDiagnostic[];
}

function problemOf(text: string): ProblemFacts {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof body !== 'object' || body === null) return {};
  const problem = body as Record<string, unknown>;
  return {
    ...(typeof problem.code === 'string' ? { code: problem.code } : {}),
    ...(typeof problem.detail === 'string' ? { detail: problem.detail } : {}),
    ...(typeof problem.runId === 'string' ? { runId: problem.runId } : {}),
    ...(Array.isArray(problem.diagnostics)
      ? { diagnostics: problem.diagnostics as ServerDiagnostic[] }
      : {}),
  };
}

function detailOf(status: number, problem: ProblemFacts): string {
  if (problem.detail !== undefined) {
    return problem.code === undefined
      ? `the service refused the run (${status}): ${problem.detail}`
      : `the service refused the run (${status} ${problem.code}): ${problem.detail}`;
  }
  return `the service refused the run (${status})`;
}

/** A success is only a success when it says which run was archived, and how. */
function successOf(
  text: string,
  requestId: string | undefined,
  attempts: number,
): UploadResult | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const result = body as Record<string, unknown>;
  const outcome = result.outcome;
  if (outcome !== 'inserted' && outcome !== 'already_present') return undefined;
  const { runId, runRef, ingestionSequence } = result;
  if (typeof runId !== 'string' || runId === '') return undefined;
  if (typeof runRef !== 'string' || runRef === '') return undefined;
  if (typeof ingestionSequence !== 'string' || !/^\d+$/u.test(ingestionSequence)) return undefined;
  return {
    outcome,
    runId,
    runRef,
    ingestionSequence,
    requestId,
    attempts,
    ...(typeof result.queryIndexRebuilt === 'boolean'
      ? { queryIndexRebuilt: result.queryIndexRebuilt }
      : {}),
  };
}

/** An error's own words, without a body, a header, or anything a caller sent. */
function safely(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === undefined ? e.message : `${code}`;
  }
  return 'the connection failed';
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new UploadAborted());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new UploadAborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export { DEFAULT_RETRY };
