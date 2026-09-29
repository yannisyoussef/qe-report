/**
 * Where uploads go, and whether the key may travel there. A bearer token is a secret, so the
 * base URL is checked once, before anything is sent: no credentials in the URL, no fragment, no
 * query, an https origin unless the target is this machine, and never a scheme that is not HTTP.
 */
export interface Target {
  /** The absolute URL of `POST /v1/runs` under the configured base. */
  readonly runs: URL;
  readonly origin: string;
  readonly secure: boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True for a host that cannot leave this machine, where plaintext is a development choice. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK.has(host)) return true;
  // 127.0.0.0/8 is all loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

export function resolveTarget(baseUrl: string, allowInsecureHttp = false): Target {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new TypeError('baseUrl must be the absolute URL of a qe-report service');
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl ${JSON.stringify(baseUrl)} is not an absolute URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`baseUrl must be http or https, not ${url.protocol.replace(':', '')}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('baseUrl must not carry a user name or a password');
  }
  if (url.hash !== '') throw new TypeError('baseUrl must not carry a fragment');
  if (url.search !== '') throw new TypeError('baseUrl must not carry a query string');
  const secure = url.protocol === 'https:';
  if (!secure && !isLoopback(url.hostname) && !allowInsecureHttp) {
    throw new TypeError(
      `baseUrl ${url.origin} is plaintext HTTP to another host; an API key is only sent over HTTPS, or to this machine, unless allowInsecureHttp is set for a development service`,
    );
  }
  // A deployment may sit under a path; that prefix is kept, and `v1/runs` joins below it.
  const base = new URL(url.pathname.endsWith('/') ? url.href : `${url.href}/`);
  return { runs: new URL('v1/runs', base), origin: url.origin, secure };
}
