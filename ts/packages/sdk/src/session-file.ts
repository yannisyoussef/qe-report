import { createHash } from 'node:crypto';

/**
 * The event file name for a session inside a run directory: the sessionId reduced to
 * `[A-Za-z0-9._-]`, at most 48 characters, plus the first 12 hex digits of its SHA-256. The suffix
 * keeps names unique when sanitisation collides; the sanitiser removes anything a path could use.
 * The Java SDK and the fixture generator apply the same contract. The events inside the file, not
 * the name, carry the authoritative sessionId.
 */
export function sessionFileName(sessionId: string): string {
  let safe = sessionId.replace(/[^A-Za-z0-9._-]/gu, '_');
  if (safe.startsWith('.')) safe = `_${safe.slice(1)}`;
  const hash = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 12);
  return `${safe.slice(0, 48)}-${hash}.ndjson`;
}
