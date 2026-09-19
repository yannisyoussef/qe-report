/**
 * The most bytes a project id may take in UTF-8. A project id is opaque ingestion context, but
 * every durable table is keyed by it inside compound B-tree keys, and PostgreSQL bounds an index
 * entry at about 2.7 kB; 512 bytes keeps every such key far below that with room for the rest of
 * it. The bound is system-wide: the read model, the archive, the queries, the credentials, and
 * any transport all apply this one.
 */
export const MAX_PROJECT_ID_UTF8_BYTES = 512;

/** A UTF-16 surrogate without its partner: text that is not Unicode, whatever it looks like. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * Rejects a partition key outside the project id contract: a non-empty string of well-formed
 * Unicode without U+0000, at most {@link MAX_PROJECT_ID_UTF8_BYTES} bytes in UTF-8. Nothing is
 * trimmed or normalised: two ids are the same project only when they are the same code points,
 * so canonically equivalent spellings stay different projects. A violation is a caller's error,
 * not an ingestion problem.
 */
export function checkProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || projectId === '') {
    throw new TypeError('projectId must be a non-empty string');
  }
  if (LONE_SURROGATE.test(projectId)) {
    throw new TypeError('projectId must be well-formed Unicode: it holds an unpaired surrogate');
  }
  if (projectId.includes('\u0000')) {
    throw new TypeError('projectId must not contain U+0000');
  }
  if (Buffer.byteLength(projectId, 'utf8') > MAX_PROJECT_ID_UTF8_BYTES) {
    throw new TypeError(`projectId must be at most ${MAX_PROJECT_ID_UTF8_BYTES} bytes in UTF-8`);
  }
}
