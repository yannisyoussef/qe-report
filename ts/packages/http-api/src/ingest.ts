import type { Multipart } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { PersistResult, PostgresRunStore } from 'qe-report-postgres';
import { diagnosticDto, ingestionDto } from './dto.js';
import { OPERATIONAL_INSTANT_GRAMMAR, parseOperationalInstant } from './instants.js';
import type { TransportLimits } from './limits.js';
import { Problem } from './problems.js';
import { encodeRunRef } from './run-ref.js';
import { LimitExceeded, PartAborted, StagedUpload } from './staging.js';

/** The store operation an upload ends in; the only one it may call. */
export type RunWriter = Pick<PostgresRunStore, 'persistRunDirectory'>;

export interface IngestionResponse {
  readonly status: 200 | 201;
  readonly body: Record<string, unknown>;
  readonly location?: string;
}

/** The most diagnostics one refusal carries; the rest are counted in its detail. */
const MAX_DIAGNOSTICS = 200;

/**
 * Receives one run as `multipart/form-data`, streams it into a fresh server-named run directory,
 * and hands that directory to the run store, which validates and archives it exactly as it would
 * any other. The project is the caller's key's. Whatever happens, the request directory is
 * removed before this returns: after a refusal, a limit, a malformed or abandoned body, a
 * validation failure, a store error, or success.
 */
export async function ingestUpload(
  request: FastifyRequest,
  projectId: string,
  store: RunWriter,
  stagingRoot: string,
  limits: TransportLimits,
): Promise<IngestionResponse> {
  if (!request.isMultipart()) {
    throw new Problem('UNSUPPORTED_MEDIA_TYPE', 'a run is uploaded as multipart/form-data');
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number(declared) > limits.maxRequestBytes) {
    throw tooLarge(`the request is larger than ${limits.maxRequestBytes} bytes`);
  }
  const staged = await StagedUpload.create(stagingRoot, request.id);
  try {
    const expiresAt = await receive(request, staged, limits);
    const result = await store.persistRunDirectory({
      projectId,
      runDirectory: staged.directory,
      expiresAt,
      sourceLocator: `http:${request.id}`,
    });
    return respond(result);
  } finally {
    await staged.remove();
  }
}

function tooLarge(detail: string): Problem {
  return new Problem('PAYLOAD_TOO_LARGE', detail);
}

/**
 * Reads every part into the staged directory and returns the declared expiry. The body is
 * counted as it arrives, so a request without a length, or lying about it, is stopped at the
 * limit rather than read to its end; a part being written when that happens is abandoned.
 */
async function receive(
  request: FastifyRequest,
  staged: StagedUpload,
  limits: TransportLimits,
): Promise<Date> {
  let parts: AsyncIterator<Multipart>;
  try {
    parts = request
      .parts({
        // The parser's own limits sit just above the ones counted below, which trip first and
        // refuse at once: the parser's stop reading the body instead, and would leave a part
        // that arrives afterwards waiting for bytes that never come.
        limits: {
          fieldNameSize: 64,
          fieldSize: 128,
          fields: 4,
          files: limits.maxEventParts + limits.maxAttachmentParts + 2,
          parts: limits.maxEventParts + limits.maxAttachmentParts + 8,
          fileSize: Math.max(limits.maxEventBytes, limits.maxAttachmentBytes) + 1,
          headerPairs: 16,
        },
      })
      [Symbol.asyncIterator]();
  } catch (e) {
    throw multipartProblem(e);
  }

  let received = 0;
  let current: Readable | undefined;
  let trip: ((problem: Problem) => void) | undefined;
  const tripped = new Promise<never>((_, reject) => {
    trip = reject;
  });
  tripped.catch(() => undefined);
  let exceeded: Problem | undefined;
  const raw = request.raw;
  let counting = false;
  const onData = (chunk: Buffer): void => {
    received += chunk.length;
    if (received > limits.maxRequestBytes && exceeded === undefined) {
      exceeded = tooLarge(`the request is larger than ${limits.maxRequestBytes} bytes`);
      raw.unpipe();
      current?.destroy(exceeded);
      trip?.(exceeded);
    }
  };

  let expiresAt: Date | undefined;
  let eventParts = 0;
  let eventBytes = 0;
  let attachmentParts = 0;
  let attachmentBytes = 0;
  try {
    for (;;) {
      const pending = parts.next();
      pending.catch(() => undefined);
      // The parser pipes the body on the first call; counting starts once it does, so that no
      // listener here ever puts the body into flowing mode before the parser reads it.
      if (!counting) {
        raw.on('data', onData);
        counting = true;
      }
      let next;
      try {
        next = await Promise.race([pending, tripped]);
      } catch (e) {
        throw exceeded ?? multipartProblem(e);
      }
      if (next.done === true) break;
      const part = next.value as unknown as Part;
      if (part.fieldname === 'expiresAt' && part.type === 'field') {
        if (expiresAt !== undefined) {
          throw new Problem('BAD_REQUEST', 'expiresAt is sent once');
        }
        expiresAt = parseExpiry(part);
        continue;
      }
      if (
        part.type !== 'file' ||
        (part.fieldname !== 'events' && part.fieldname !== 'attachment')
      ) {
        throw new Problem(
          'BAD_REQUEST',
          `unexpected part ${JSON.stringify(part.fieldname.slice(0, 32))} as ${part.type === 'file' ? 'a file' : 'text'}; the parts are expiresAt (text), events (files), and attachment (files)`,
        );
      }
      current = part.file;
      try {
        if (part.fieldname === 'events') {
          eventParts += 1;
          if (eventParts > limits.maxEventParts) {
            throw tooLarge(`more than ${limits.maxEventParts} events parts`);
          }
          await staged.writeEvents(part.file, (bytes) => {
            eventBytes += bytes;
            if (eventBytes > limits.maxEventBytes) {
              throw new LimitExceeded(`the events parts exceed ${limits.maxEventBytes} bytes`);
            }
          });
        } else {
          attachmentParts += 1;
          if (attachmentParts > limits.maxAttachmentParts) {
            throw tooLarge(`more than ${limits.maxAttachmentParts} attachment parts`);
          }
          let bytesOfThisPart = 0;
          await staged.writeAttachment(part.file, (bytes) => {
            bytesOfThisPart += bytes;
            attachmentBytes += bytes;
            if (bytesOfThisPart > limits.maxAttachmentBytes) {
              throw new LimitExceeded(`an attachment exceeds ${limits.maxAttachmentBytes} bytes`);
            }
            if (attachmentBytes > limits.maxTotalAttachmentBytes) {
              throw new LimitExceeded(
                `the attachment parts exceed ${limits.maxTotalAttachmentBytes} bytes`,
              );
            }
          });
        }
      } catch (e) {
        if (exceeded !== undefined) throw exceeded;
        if (e instanceof LimitExceeded) throw tooLarge(e.message);
        if (e instanceof PartAborted) throw new Problem('BAD_REQUEST', e.message);
        if (e instanceof Problem) throw e;
        throw multipartProblem(e);
      } finally {
        current = undefined;
      }
    }
  } finally {
    raw.off('data', onData);
  }
  if (exceeded !== undefined) throw exceeded;
  if (expiresAt === undefined) {
    throw new Problem('BAD_REQUEST', 'expiresAt is required, once, as a text part');
  }
  if (eventParts === 0) {
    throw new Problem('BAD_REQUEST', 'at least one events part is required');
  }
  return expiresAt;
}

/** What the multipart parser hands over, narrowed to what is read here. */
type Part =
  | {
      readonly type: 'file';
      readonly fieldname: string;
      readonly file: Readable;
    }
  | {
      readonly type: 'field';
      readonly fieldname: string;
      readonly value: unknown;
      readonly valueTruncated: boolean;
    };

/**
 * The expiry the caller states, to the millisecond it states. It is an operational instant, not
 * a protocol timestamp: a leap second or a finer fraction is refused rather than read as some
 * earlier instant, because retention must never delete a run before the time it was given.
 * Nothing else decides retention: not the time now, the key, or the run.
 */
function parseExpiry(part: Extract<Part, { type: 'field' }>): Date {
  const refused = new Problem('BAD_REQUEST', `expiresAt must be ${OPERATIONAL_INSTANT_GRAMMAR}`);
  if (part.valueTruncated || typeof part.value !== 'string') throw refused;
  try {
    return parseOperationalInstant(part.value, 'expiresAt');
  } catch {
    throw refused;
  }
}

/** The multipart parser's refusals, as the problems a client sees; anything else is ours. */
function multipartProblem(e: unknown): Error {
  if (e instanceof Problem) return e;
  const code = (e as { code?: unknown }).code;
  switch (code) {
    case 'FST_PARTS_LIMIT':
    case 'FST_FILES_LIMIT':
      return tooLarge('the upload has more parts than this server accepts');
    case 'FST_REQ_FILE_TOO_LARGE':
      return tooLarge('a part is larger than this server accepts');
    case 'FST_FIELDS_LIMIT':
      return new Problem('BAD_REQUEST', 'the only text part is expiresAt, sent once');
    case 'FST_INVALID_MULTIPART_CONTENT_TYPE':
      return new Problem('UNSUPPORTED_MEDIA_TYPE', 'a run is uploaded as multipart/form-data');
    case 'FST_MP_PREMATURE_CLOSE':
      return new Problem('BAD_REQUEST', 'the request ended before its multipart body did');
    case 'FST_PROTO_VIOLATION':
    case 'FST_INVALID_JSON_FIELD_ERROR':
      return new Problem('BAD_REQUEST', 'the multipart body has a part this server refuses');
    default:
      break;
  }
  // The parser's own complaints about framing: a missing boundary, a truncated part, a bad header.
  const message = e instanceof Error ? e.message : '';
  if (/multipart|boundary|part|form|header/iu.test(message) && !('errno' in (e as object))) {
    return new Problem('BAD_REQUEST', 'the multipart body is malformed');
  }
  return e instanceof Error ? e : new Error(String(e));
}

function respond(result: PersistResult): IngestionResponse {
  switch (result.kind) {
    case 'inserted':
      return {
        status: 201,
        body: ingestionDto(result),
        location: `/v1/runs/${encodeRunRef(result.runId)}`,
      };
    case 'already_present':
      return { status: 200, body: ingestionDto(result) };
    case 'conflict':
      throw new Problem(
        'RUN_CONFLICT',
        'another run with different content is already archived under this run id in this project',
        { runId: result.runId },
      );
    case 'rejected': {
      const shown = result.diagnostics.slice(0, MAX_DIAGNOSTICS).map(diagnosticDto);
      const more = result.diagnostics.length - shown.length;
      const detail = {
        RUN_INVALID: 'the protocol source is not valid',
        RUN_INCOMPLETE: 'the run is valid but not complete; only complete runs are archived',
        RUN_EMPTY: 'the upload holds no protocol events',
      }[result.reason];
      throw new Problem(
        result.reason,
        more > 0 ? `${detail}; ${more} further diagnostics are not listed` : detail,
        {
          ...(result.runId === undefined ? {} : { runId: result.runId }),
          diagnostics: shown,
        },
      );
    }
  }
}
