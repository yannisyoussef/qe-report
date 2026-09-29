/**
 * How an upload is retried. A retry is safe because `POST /v1/runs` is idempotent for the same
 * run: a producer that loses the answer to an attempt the service already archived sees
 * `already_present` the next time, never a second run. Only deliveries are retried; a refusal is
 * a refusal, and asking again would only refuse again.
 */
export interface RetryPolicy {
  /** Total attempts, the first included. */
  readonly maxAttempts: number;
  /** The wait before the second attempt; it doubles from there. */
  readonly baseDelayMs: number;
  /** The longest this client waits between attempts, whatever the doubling or the server says. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
};

/** The most attempts a caller may ask for: a bounded number is what makes an upload end. */
const MAX_ATTEMPTS_CEILING = 10;

export function resolveRetry(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  const policy = { ...DEFAULT_RETRY, ...overrides };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a whole number of at least one');
  }
  if (policy.maxAttempts > MAX_ATTEMPTS_CEILING) {
    throw new TypeError(`maxAttempts must be at most ${MAX_ATTEMPTS_CEILING}`);
  }
  for (const name of ['baseDelayMs', 'maxDelayMs'] as const) {
    const value = policy[name];
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a whole number of milliseconds`);
    }
  }
  if (policy.maxDelayMs < policy.baseDelayMs) {
    throw new TypeError('maxDelayMs must not be less than baseDelayMs');
  }
  return policy;
}

/**
 * The statuses worth trying again. A request that was refused on its merits is not among them:
 * 400, 401, 403, 409, 413, 415, and 422 mean the same thing however often they are asked.
 */
export const RETRIABLE_STATUSES: ReadonlySet<number> = new Set([
  408, // the service gave up waiting for the request
  425, // too early
  429, // too many requests
  500, // the service failed; the run may or may not have been archived
  502,
  503,
  504,
]);

/** Node's names for a connection that never worked, or stopped working mid-flight. */
const RETRIABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
]);

export function isRetriableError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RETRIABLE_CODES.has(code);
}

/**
 * The wait before the next attempt: the service's own `Retry-After` when it gave a usable one,
 * otherwise a doubling delay with full jitter. Both are bounded, so no answer from a service can
 * make a producer wait indefinitely.
 */
export function delayBefore(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | undefined,
  random: () => number,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs);
  const window = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  return Math.round(window * random());
}

/**
 * `Retry-After` as milliseconds: whole seconds, or an HTTP date, and nothing else. A value that
 * is not one of those, or is in the past, is simply no answer at all.
 */
export function retryAfterMs(header: string | undefined, now: number): number | undefined {
  if (header === undefined) return undefined;
  const text = header.trim();
  if (/^\d{1,7}$/u.test(text)) return Number(text) * 1000;
  // An HTTP-date, and only that shape: `Date.parse` reads far looser text than a header may be,
  // and a header this client does not understand is no instruction at all.
  if (!HTTP_DATE.test(text)) return undefined;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}

/** RFC 9110's preferred form: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const HTTP_DATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
