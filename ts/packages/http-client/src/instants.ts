/**
 * An operational instant: a lifecycle time a producer states, such as when a run may be deleted.
 * It is deliberately narrower than a protocol timestamp, and exactly the grammar API v1 accepts.
 *
 * ```
 * 2027-01-01T00:00:00Z        2027-01-01T00:00:00.5Z
 * 2027-01-01T00:00:00.123Z    2027-01-01T01:00:00+01:00
 * ```
 *
 * RFC 3339, an explicit `Z` or numeric offset, seconds 00 to 59, and at most three fractional
 * digits, so the value is exactly a millisecond and a `Date` carries it without losing anything.
 * A protocol timestamp admits more: nanoseconds, which would be truncated, and a leap second,
 * which names an instant a millisecond count cannot hold apart from its neighbours. Read as a
 * deadline either would move earlier, and retention would then delete a run before the time its
 * owner asked for, so both are refused instead of rounded.
 */
const OPERATIONAL =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

/** What an operational instant must look like, worded for someone who has to fix a value. */
export const OPERATIONAL_INSTANT_GRAMMAR =
  'an RFC 3339 instant with an explicit offset, seconds 00 to 59, and at most millisecond precision, such as 2027-01-01T00:00:00Z or 2027-01-01T00:00:00.123Z';

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A value that is not an operational instant; each producer answers it in its own way. */
export class NotAnInstant extends Error {
  constructor(what: string) {
    super(`${what} must be ${OPERATIONAL_INSTANT_GRAMMAR}`);
    this.name = 'NotAnInstant';
  }
}

/**
 * The instant a producer's lifecycle timestamp names, exactly. The one parser behind every way a
 * producer states an expiry: the `qe-report-upload` command, the Playwright reporter's
 * configuration, and any library caller that wants to check a value before sending it.
 *
 * The grammar is checked first, then the calendar and the offset, and the instant is built from
 * the stated components rather than handed to `new Date(text)`. That matters: `Date.parse` reads
 * `2027-02-30T00:00:00Z` as the second of March and `...00.1234Z` as `.123`, so a value the
 * service would refuse, or one whose meaning it would have to guess at, would otherwise be sent.
 *
 * `what` names the field, for the message: `expiresAt`, `--expires-at`.
 */
export function parseOperationalInstant(text: unknown, what: string): Date {
  if (typeof text !== 'string') throw new NotAnInstant(what);
  const m = OPERATIONAL.exec(text);
  if (m === null) throw new NotAnInstant(what);
  const [, y, mo, d, , , , , , oh, om] = m as unknown as (string | undefined)[];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  // The calendar, by the Gregorian rules, because the grammar only says how many digits each
  // field has: a thirty-first of February is a shape it admits and a date that never existed.
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leapYear ? 29 : (DAYS_IN_MONTH[month] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > days) throw new NotAnInstant(what);
  if (Number(oh ?? 0) > 23 || Number(om ?? 0) > 59) throw new NotAnInstant(what);
  // Only now, and only to turn an approved timestamp into an instant. The text is read as
  // written, four-digit year included: the numeric `Date.UTC(year, ...)` would read years 0 to
  // 99 as 1900 to 1999 and make the producer refuse four-digit years the service accepts.
  const epochMs = Date.parse(text);
  if (!Number.isFinite(epochMs)) throw new NotAnInstant(what);
  return new Date(epochMs);
}

/**
 * When retention may delete a run. The service takes an operational instant: RFC 3339, an
 * explicit offset, seconds 00 to 59, and at most a millisecond of precision. A `Date` is exactly
 * that, and `toISOString` writes it in exactly that form, so a caller states a deadline and the
 * service stores the instant the caller meant.
 */
export function checkExpiresAt(expiresAt: unknown): Date {
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) {
    throw new TypeError(
      'expiresAt must be a valid Date: the instant after which the run may be deleted',
    );
  }
  return expiresAt;
}

/**
 * The absolute instant a relative retention comes to. A producer that thinks in "thirty days"
 * calls this once, before the first attempt, and passes the result: every retry then offers the
 * same deadline, rather than a slightly later one each time it asks.
 *
 * There is no default retention. How long a run is kept is the caller's decision.
 */
export function expiryAfter(retentionMs: number, now: Date = new Date()): Date {
  if (!Number.isInteger(retentionMs) || retentionMs < 1) {
    throw new TypeError('retentionMs must be a whole number of milliseconds of at least one');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const at = new Date(now.getTime() + retentionMs);
  if (!Number.isFinite(at.getTime())) {
    throw new TypeError('retentionMs is so large that it names no instant');
  }
  return at;
}
