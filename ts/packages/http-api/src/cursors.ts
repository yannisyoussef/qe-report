import { createHash } from 'node:crypto';
import type { HistoryCursor } from 'qe-report-postgres';
import { Problem } from './problems.js';
import { isProtocolIdentifier } from './run-ref.js';

/**
 * Opaque continuation tokens for keyset pages: unpadded base64url of a small JSON document with a
 * version, a kind, the keyset position, and a binding. The binding is a SHA-256 over what the
 * page is a page of (the project, and for a history its runner name and historical id), so a
 * cursor handed back for another listing, another history, or under another project's key is
 * refused rather than read as a position there. It is not a security token: authorisation is
 * the API key's, and a cursor only says where to continue.
 */

const CURSOR_VERSION = 1;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
/** Long enough for any cursor this API issues, and short enough to refuse at once. */
const MAX_CURSOR_LENGTH = 2048;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

function binding(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('base64url');
}

function encode(document: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(document), 'utf8').toString('base64url');
}

function malformed(): Problem {
  return new Problem('BAD_REQUEST', 'the cursor is not one this listing issued');
}

/** The JSON document inside a cursor with exactly the members expected, or a 400. */
function decode(cursor: string, members: readonly string[]): Record<string, unknown> {
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH || !BASE64URL.test(cursor)) {
    throw malformed();
  }
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(text, 'utf8').toString('base64url') !== cursor) throw malformed();
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw malformed();
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw malformed();
  }
  const keys = Object.keys(document).sort();
  if (keys.join(',') !== [...members].sort().join(',')) throw malformed();
  const record = document as Record<string, unknown>;
  if (record.v !== CURSOR_VERSION) throw malformed();
  return record;
}

/** Where a run listing continues: below this ingestion sequence, in this project. */
export function encodeRunsCursor(projectId: string, beforeIngestionSequence: bigint): string {
  return encode({
    v: CURSOR_VERSION,
    k: 'runs',
    b: binding(['runs', projectId]),
    s: beforeIngestionSequence.toString(),
  });
}

export function decodeRunsCursor(projectId: string, cursor: string): bigint {
  const d = decode(cursor, ['v', 'k', 'b', 's']);
  if (d.k !== 'runs' || d.b !== binding(['runs', projectId])) throw malformed();
  if (typeof d.s !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(d.s)) throw malformed();
  const sequence = BigInt(d.s);
  if (sequence > MAX_BIGINT) throw malformed();
  return sequence;
}

/** Where a history page continues: the order position and tie-breakers, for this one history. */
export function encodeHistoryCursor(
  projectId: string,
  runnerName: string,
  historicalId: string,
  after: HistoryCursor,
): string {
  return encode({
    v: CURSOR_VERSION,
    k: 'history',
    b: binding(['history', projectId, runnerName, historicalId]),
    t: after.occurredAt.toISOString(),
    l: after.leap,
    r: after.runId,
    e: after.executionId,
  });
}

const ISO_INSTANT = /^[+-]?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function decodeHistoryCursor(
  projectId: string,
  runnerName: string,
  historicalId: string,
  cursor: string,
): HistoryCursor {
  const d = decode(cursor, ['v', 'k', 'b', 't', 'l', 'r', 'e']);
  if (d.k !== 'history' || d.b !== binding(['history', projectId, runnerName, historicalId])) {
    throw malformed();
  }
  if (typeof d.t !== 'string' || !ISO_INSTANT.test(d.t)) throw malformed();
  const occurredAt = new Date(d.t);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString() !== d.t) {
    throw malformed();
  }
  if (typeof d.l !== 'number' || !Number.isInteger(d.l) || d.l < 0 || d.l > 1000) {
    throw malformed();
  }
  if (!isProtocolIdentifier(d.r) || !isProtocolIdentifier(d.e)) throw malformed();
  return { occurredAt, leap: d.l, runId: d.r, executionId: d.e };
}
