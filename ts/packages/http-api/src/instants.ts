import { historyInstant } from 'qe-report-read-model';

/**
 * An operational instant: a deadline or other lifecycle time a caller states, such as a run's
 * expiry or a key's. It is deliberately narrower than a protocol timestamp.
 *
 * ```
 * 2027-01-01T00:00:00Z        2027-01-01T00:00:00.5Z
 * 2027-01-01T00:00:00.123Z    2027-01-01T01:00:00+01:00
 * ```
 *
 * RFC 3339, an explicit `Z` or numeric offset, seconds 00 to 59, and at most three fractional
 * digits, so that the value is exactly a millisecond and a JavaScript `Date` carries it without
 * losing anything. A protocol timestamp admits more: nanosecond precision, which would be
 * truncated here, and a leap second, whose position the read model represents as an instant plus
 * a place inside that second. Reading either as a deadline would move it earlier, and retention
 * would then delete data before the time its owner asked for. Both are refused instead.
 *
 * Protocol timestamps are untouched by this: `occurredAt` keeps every form protocol 0.3 accepts,
 * and history keeps the leap-second order QE-008 defined.
 */
const OPERATIONAL =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u;

/** What an operational instant must look like, for a message a caller can act on. */
export const OPERATIONAL_INSTANT_GRAMMAR =
  'an RFC 3339 instant with an explicit offset, seconds 00 to 59, and at most millisecond precision, such as 2027-01-01T00:00:00Z or 2027-01-01T00:00:00.123Z';

/** A value that is not an operational instant; each caller answers it in its own way. */
export class NotAnInstant extends Error {
  constructor(what: string) {
    super(`${what} must be ${OPERATIONAL_INSTANT_GRAMMAR}`);
    this.name = 'NotAnInstant';
  }
}

/**
 * The instant a lifecycle timestamp names, exactly. The grammar above is checked first, and the
 * calendar, the offset, and the instant itself then come from the read model's one timestamp
 * primitive, so nothing here is a second interpretation of a date. A value outside the grammar,
 * an impossible date, or an offset that is not one is refused rather than rounded.
 *
 * `what` names the field, for the error: `expiresAt`, `--expires-at`.
 */
export function parseOperationalInstant(text: unknown, what: string): Date {
  if (typeof text !== 'string' || !OPERATIONAL.test(text)) throw new NotAnInstant(what);
  let position;
  try {
    position = historyInstant(text);
  } catch {
    // A shape the grammar allows but no calendar has: the 31st of February, an offset of 90
    // minutes past the hour.
    throw new NotAnInstant(what);
  }
  // Unreachable while the grammar stops at second 59, and checked because the whole point of
  // this parser is that no leap second is ever read as an ordinary deadline.
  if (position.leap !== 0) throw new NotAnInstant(what);
  const at = new Date(position.epochMs);
  if (!Number.isFinite(at.getTime())) throw new NotAnInstant(what);
  return at;
}
