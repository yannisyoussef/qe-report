import { readFileSync } from 'node:fs';

/**
 * Where a deployment may state the database it uses. A container mounts a secret as a file and
 * passes the path; a developer exports the URL directly. Exactly one of the two, because a
 * process that found both would have to guess which one its operator meant.
 */
export const DATABASE_URL = 'DATABASE_URL';
export const DATABASE_URL_FILE = 'DATABASE_URL_FILE';

/**
 * A connection string with its password taken out, for a message a person may read. Anything
 * between the scheme and the host of a URL-shaped string goes: a library that puts the whole DSN
 * into an exception must not turn a log line or an error response into a credential leak.
 */
export function scrubConnectionStrings(text: string): string {
  return text.replace(
    /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:[^\s/@]*@)?([^\s/?#]*)/gu,
    (_whole, scheme: string, host: string) => `${scheme}[redacted]@${host}`,
  );
}

/** The same message, scrubbed, whatever the value arrived as. */
export function safeMessage(e: unknown): string {
  return scrubConnectionStrings(e instanceof Error ? e.message : String(e));
}

/**
 * The database URL this process will use, from whichever form the deployment chose. The file
 * form is read once, here, at startup: one trailing newline is allowed because that is what a
 * secret mount and an editor both leave behind, and an empty file is a configuration error
 * rather than an empty password.
 *
 * Neither the value nor the path it came from appears in any error: the value is a credential,
 * and the path is a fact about the host that a caller of an HTTP API has no business learning.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const direct = env[DATABASE_URL];
  const file = env[DATABASE_URL_FILE];
  const hasDirect = direct !== undefined && direct !== '';
  const hasFile = file !== undefined && file !== '';
  if (hasDirect && hasFile) {
    throw new Error(
      `only one of ${DATABASE_URL} and ${DATABASE_URL_FILE} may be set; both are, and this process will not choose between them`,
    );
  }
  if (hasDirect) return direct;
  if (!hasFile) throw new Error(`one of ${DATABASE_URL} and ${DATABASE_URL_FILE} must be set`);
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`the file ${DATABASE_URL_FILE} names cannot be read`);
  }
  const url = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  if (url === '') throw new Error(`the file ${DATABASE_URL_FILE} names is empty`);
  if (url.includes('\n')) {
    throw new Error(`the file ${DATABASE_URL_FILE} names holds more than one line`);
  }
  return url;
}
