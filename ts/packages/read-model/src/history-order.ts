import type { ExecutionOccurrence } from './model.js';

/**
 * Where a producer timestamp stands in history order. It is presentation order, not a claim
 * about global chronology: the timestamps come from different producers' clocks.
 *
 * An ordinary timestamp is its instant, to the millisecond, exactly as `Date.parse` reads it, and
 * `leap` is 0. A leap second (`23:59:60` in UTC) is an instant `Date.parse` cannot read and a
 * millisecond count cannot hold apart from its neighbours, so it keeps the last millisecond of
 * the second before it as `epochMs` and says where inside the leap second it falls with `leap`:
 * 1 plus its own millisecond, 1 to 1000. It therefore sorts after every ordinary instant of
 * `23:59:59` and before the `00:00:00` that follows it, and leap-second timestamps sort among
 * themselves by their own fraction.
 */
export interface HistoryInstant {
  /** Milliseconds since the epoch; for a leap second, the last millisecond of the second before it. */
  readonly epochMs: number;
  /** 0 for an ordinary timestamp; for a leap second, 1 plus its millisecond within it. */
  readonly leap: number;
}

/** The protocol's timestamp shape; the calendar and clock ranges are checked beside it. */
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The history position of a timestamp the validator accepts: the protocol's shape read as an
 * RFC 3339 `date-time`, where a second of 60 is valid only as the last second of a UTC day.
 * Anything else was never a valid producer time, has no position in any history, and is
 * refused rather than given one.
 *
 * The single ordering primitive: the in-memory history, the durable query index, and the order
 * PostgreSQL pages a history in all come from it.
 */
export function historyInstant(occurredAt: string): HistoryInstant {
  const m = TIMESTAMP.exec(occurredAt);
  if (m === null) throw invalid(occurredAt);
  const [, y, mo, d, h, mi, s, fraction, sign, oh, om] = m as unknown as (string | undefined)[];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const offsetHour = Number(oh ?? 0);
  const offsetMinute = Number(om ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leapYear ? 29 : (DAYS_IN_MONTH[month] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > days) throw invalid(occurredAt);
  if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) {
    throw invalid(occurredAt);
  }
  if (second < 60) {
    const epochMs = Date.parse(occurredAt);
    if (!Number.isFinite(epochMs)) throw invalid(occurredAt);
    return { epochMs, leap: 0 };
  }
  // A leap second is the second after 23:59:59 UTC and nowhere else.
  const offset = (sign === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  const utcMinuteOfDay = (((hour * 60 + minute - offset) % 1440) + 1440) % 1440;
  if (utcMinuteOfDay !== 1439) throw invalid(occurredAt);
  const zone = sign === undefined ? 'Z' : `${sign}${oh}:${om}`;
  const epochMs = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:59.999${zone}`);
  if (!Number.isFinite(epochMs)) throw invalid(occurredAt);
  // Milliseconds, truncated, exactly as Date.parse reads the fraction of an ordinary second.
  const millisecond = Number((fraction ?? '').padEnd(3, '0').slice(0, 3));
  return { epochMs, leap: 1 + millisecond };
}

function invalid(occurredAt: string): RangeError {
  return new RangeError(`not a protocol timestamp: ${JSON.stringify(occurredAt.slice(0, 64))}`);
}

/** History order of two positions: the instant, then the place inside a leap second. */
export function compareHistoryInstants(a: HistoryInstant, b: HistoryInstant): number {
  return a.epochMs - b.epochMs || a.leap - b.leap;
}

/**
 * History order: the producer timestamp's position, then run id, then execution id, both
 * compared by code unit. Exported because a durable index has to reproduce exactly this order
 * and nothing else.
 */
export function compareHistoryOccurrences(a: ExecutionOccurrence, b: ExecutionOccurrence): number {
  return (
    compareHistoryInstants(historyInstant(a.occurredAt), historyInstant(b.occurredAt)) ||
    compare(a.runId, b.runId) ||
    compare(a.executionId, b.executionId)
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
