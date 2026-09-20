import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';

/**
 * One HTTP attempt, on Node's own client. Redirects are not followed, because a redirect can
 * point anywhere and the request carries a bearer token: a 3xx is an answer, not a detour. TLS
 * verification is never turned off, and there is no option to.
 */
export interface AttemptRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readable;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** The most response bytes this client reads; more than that is refused unread. */
  readonly maxResponseBytes: number;
}

export interface AttemptResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The body as text, within the bound; empty when the service sent none. */
  readonly text: string;
  /** True when the service sent more than the bound and the rest was not read. */
  readonly truncated: boolean;
}

/** What a caller's `AbortSignal` becomes: nothing further is attempted. */
export class UploadAborted extends Error {
  constructor() {
    super('the upload was cancelled');
    this.name = 'UploadAborted';
  }
}

/** The socket closed before the response was complete; the service may or may not have archived. */
export class IncompleteResponse extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'IncompleteResponse';
    (this as NodeJS.ErrnoException).code = 'ECONNRESET';
  }
}

/** Sends one request and reads a bounded answer; the body streams and is never held whole. */
export function send(attempt: AttemptRequest): Promise<AttemptResponse> {
  const secure = attempt.url.protocol === 'https:';
  const call = secure ? httpsRequest : httpRequest;
  return new Promise<AttemptResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const request: ClientRequest = call(
      {
        protocol: attempt.url.protocol,
        hostname: attempt.url.hostname,
        port: attempt.url.port,
        path: `${attempt.url.pathname}${attempt.url.search}`,
        method: 'POST',
        headers: attempt.headers,
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let read = 0;
        let truncated = false;
        response.on('data', (chunk: Buffer) => {
          read += chunk.length;
          if (read > attempt.maxResponseBytes) {
            // A service that answers with more than this client will read is answered by
            // hanging up; nothing of that body is kept, logged, or parsed.
            truncated = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('aborted', () =>
          finish(() => reject(new IncompleteResponse('the response ended before it was complete'))),
        );
        response.on('error', (e) => finish(() => reject(e)));
        response.on('close', () => {
          if (settled) return;
          if (truncated) {
            finish(() =>
              resolve({
                status: response.statusCode ?? 0,
                headers: headersOf(response),
                text: '',
                truncated: true,
              }),
            );
            return;
          }
          if (!response.complete) {
            finish(() =>
              reject(new IncompleteResponse('the response ended before it was complete')),
            );
            return;
          }
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers: headersOf(response),
              text: Buffer.concat(chunks).toString('utf8'),
              truncated: false,
            }),
          );
        });
      },
    );

    const onAbort = (): void => {
      request.destroy();
      finish(() => reject(new UploadAborted()));
    };
    const timer = setTimeout(() => {
      request.destroy();
      const timedOut: NodeJS.ErrnoException = new Error(
        `the attempt took longer than ${attempt.timeoutMs} ms`,
      );
      timedOut.code = 'ETIMEDOUT';
      finish(() => reject(timedOut));
    }, attempt.timeoutMs);
    timer.unref?.();

    function cleanup(): void {
      clearTimeout(timer);
      attempt.signal?.removeEventListener('abort', onAbort);
    }

    if (attempt.signal?.aborted === true) {
      request.destroy();
      finish(() => reject(new UploadAborted()));
      return;
    }
    attempt.signal?.addEventListener('abort', onAbort, { once: true });

    request.on('error', (e) => finish(() => reject(e)));
    attempt.body.on('error', (e) => {
      request.destroy();
      finish(() => reject(e));
    });
    attempt.body.pipe(request);
  });
}

function headersOf(response: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
