import { readFileSync } from 'node:fs';

/**
 * Where a deployment may state the database it uses. A container mounts a secret as a file and
 * passes the path; a developer exports the URL directly. Exactly one of the two, because a
 * process that found both would have to guess which one its operator meant.
 */
export const DATABASE_URL = 'DATABASE_URL';
export const DATABASE_URL_FILE = 'DATABASE_URL_FILE';

/**
 * The user information of a URL-shaped string: everything between `scheme://` and the last `@`
 * that precedes the end of the authority. The class stops at `/`, `?` and `#` so a path
 * containing an `@` is not mistaken for a credential, and is greedy up to that point so a
 * password holding an unencoded `@` is removed whole rather than in part. A DSN whose password
 * contains an unencoded `/` is not a URL and is not recognised here either; percent-encode it,
 * as PostgreSQL's own documentation requires.
 */
const URL_USER_INFORMATION = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/?#]*@/gu;

/**
 * A connection string with its password taken out, for a message a person may read: a library
 * that puts the whole DSN into an exception must not turn a log line or an error response into a
 * credential leak. The host survives, because it is the part that makes the message useful, and
 * a URL that carried no user information is returned unchanged rather than made to look as
 * though it had some.
 */
export function scrubConnectionStrings(text: string): string {
  return text.replace(URL_USER_INFORMATION, '$1[redacted]@');
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
  // Present, not merely non-empty. An empty value is a deployment that meant to supply this form
  // and did not, which is a different mistake from not choosing the form at all, and guessing
  // between the two is how a process ends up connecting somewhere nobody intended.
  if (direct !== undefined && file !== undefined) {
    throw new Error(
      `only one of ${DATABASE_URL} and ${DATABASE_URL_FILE} may be set; both are, and this process will not choose between them (an empty value is still set)`,
    );
  }
  if (direct !== undefined && direct !== '') return direct;
  if (file === undefined || file === '') {
    throw new Error(`one of ${DATABASE_URL} and ${DATABASE_URL_FILE} must be set to a value`);
  }
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`the file ${DATABASE_URL_FILE} names cannot be read`);
  }
  // One trailing line ending, in either of the two forms a file may carry it.
  const url = contents.replace(/\r?\n$/u, '');
  if (url === '') throw new Error(`the file ${DATABASE_URL_FILE} names is empty`);
  if (url.includes('\n')) {
    throw new Error(`the file ${DATABASE_URL_FILE} names holds more than one line`);
  }
  return url;
}
