import { createHash } from 'node:crypto';
import type { Summary, ValidatedRun, ValidatedSourceLine } from 'qe-report-validator';

/** Bumped only if the fingerprint rule changes; stored beside every fingerprint. */
export const FINGERPRINT_VERSION = 1;

/** One source line in storage order. */
export interface ArchivedLine extends ValidatedSourceLine {
  readonly storageOrdinal: number;
}

/** What one transaction writes: built in memory from a successful validation pass, never re-read from disk. */
export interface RunArchive {
  readonly runId: string;
  readonly lines: readonly ArchivedLine[];
  readonly contentFingerprint: string;
  readonly fingerprintVersion: number;
  readonly protocolVersions: readonly string[];
  readonly summary: Summary;
  /** Whether the validation pass behind this archive checked the attachment bytes. */
  readonly attachmentsVerified: boolean;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Storage order: session id by code unit, then session sequence, then event id, then the order
 * the lines were read in, which keeps an identical duplicate right after its original. This is
 * replay order only; the protocol defines no order across sessions.
 */
export function orderLines(lines: readonly ValidatedSourceLine[]): ArchivedLine[] {
  return lines
    .map((line, occurrence) => ({ line, occurrence }))
    .sort(
      (a, b) =>
        compare(a.line.sessionId, b.line.sessionId) ||
        a.line.sequence - b.line.sequence ||
        compare(a.line.eventId, b.line.eventId) ||
        a.occurrence - b.occurrence,
    )
    .map(({ line }, storageOrdinal) => ({ ...line, storageOrdinal }));
}

/**
 * The semantic fingerprint of a run: SHA-256 over the sorted, de-duplicated canonical digests of
 * every accepted and ignored line, as fixed-size bytes behind a version tag. Property order,
 * whitespace, file enumeration, and identical duplicate lines cannot change it; an unknown
 * optional field or an unknown ignorable event does, because their canonical digests include
 * them.
 */
export function contentFingerprint(
  lines: readonly Pick<ValidatedSourceLine, 'canonicalSha256' | 'disposition'>[],
): string {
  const digests = [
    ...new Set(lines.filter((l) => l.disposition !== 'duplicate').map((l) => l.canonicalSha256)),
  ].sort(compare);
  const hash = createHash('sha256');
  hash.update(`qe-report-run-fingerprint/${FINGERPRINT_VERSION}\n`, 'utf8');
  for (const digest of digests) hash.update(Buffer.from(digest, 'hex'));
  return hash.digest('hex');
}

/**
 * Builds the immutable archive of a validated run. The caller has checked validity and
 * completeness, and says whether that validation checked the attachment bytes: the store cannot
 * tell from the report, and a replayed run was validated without them.
 */
export function buildArchive(validated: ValidatedRun, attachmentsVerified: boolean): RunArchive {
  const lines = orderLines(validated.sourceLines);
  const first = lines[0];
  if (first === undefined) throw new Error('a valid run has at least one source line');
  return {
    runId: first.runId,
    lines,
    contentFingerprint: contentFingerprint(validated.sourceLines),
    fingerprintVersion: FINGERPRINT_VERSION,
    protocolVersions: [...new Set(lines.map((l) => l.protocolVersion))].sort(compare),
    summary: validated.report.summary,
    attachmentsVerified,
  };
}
