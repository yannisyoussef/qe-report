import { createHash } from 'node:crypto';

/**
 * The one naming rule behind session files and run directories: a readable stem that no path can
 * use, plus a short digest that keeps colliding stems apart. The name is a locator only; the
 * identifier inside the events stays authoritative.
 */
export const MAX_STEM = 48;
export const HASH_LENGTH = 12;
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

/**
 * The identifier reduced to `[A-Za-z0-9._-]`, at most 48 characters, starting with a letter,
 * digit, or underscore: a leading dot or dash is replaced, so the name is never hidden and never
 * read as an option, and an empty stem becomes an underscore. A stem that is a reserved device
 * basename (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, in any case, alone or
 * followed by an extension) has its first character replaced as well, so the name is portable
 * across filesystems.
 */
export function safeStem(id: string): string {
  let safe = id.replace(/[^A-Za-z0-9._-]/gu, '_');
  if (safe === '') return '_';
  if (!/^[A-Za-z0-9_]/u.test(safe)) safe = `_${safe.slice(1)}`;
  safe = safe.slice(0, MAX_STEM);
  if (RESERVED_DEVICE.test(safe)) safe = `_${safe.slice(1)}`;
  return safe;
}

/** The first 12 lowercase hex digits of the SHA-256 of the original identifier. */
export function shortHash(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}
