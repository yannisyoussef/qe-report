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
