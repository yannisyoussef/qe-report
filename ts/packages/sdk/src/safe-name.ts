import { createHash } from 'node:crypto';

/**
 * The one naming rule behind session files and run directories: a readable stem that no path can
 * use, plus a short digest that keeps colliding stems apart. The name is a locator only; the
 * identifier inside the events stays authoritative.
 */
export const MAX_STEM = 48;
export const HASH_LENGTH = 12;

/**
 * The identifier reduced to `[A-Za-z0-9._-]`, at most 48 characters, starting with a letter,
 * digit, or underscore: a leading dot or dash is replaced, so the name is never hidden and never
 * read as an option, and an empty stem becomes an underscore.
 */
export function safeStem(id: string): string {
  let safe = id.replace(/[^A-Za-z0-9._-]/gu, '_');
  if (safe === '') return '_';
  if (!/^[A-Za-z0-9_]/u.test(safe)) safe = `_${safe.slice(1)}`;
  return safe.slice(0, MAX_STEM);
}

/** The first 12 lowercase hex digits of the SHA-256 of the original identifier. */
export function shortHash(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}
