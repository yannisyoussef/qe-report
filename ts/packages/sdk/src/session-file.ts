import { safeStem, shortHash } from './safe-name.js';

/**
 * The event file name for a session: the sessionId reduced to `[A-Za-z0-9._-]` (a leading
 * character that is not a letter, digit, or underscore becomes one), at most 48 characters, plus
 * the first 12 hex digits of its SHA-256. The suffix keeps names unique when
 * sanitisation collides; the sanitiser removes anything a path could use. The Java SDK and the
 * fixture generator apply the same contract. The events inside the file, not the name, carry the
 * authoritative sessionId.
 */
export function sessionFileName(sessionId: string): string {
  return `${safeStem(sessionId)}-${shortHash(sessionId)}.ndjson`;
}
