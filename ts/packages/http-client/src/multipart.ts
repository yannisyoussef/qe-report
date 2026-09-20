import { randomBytes } from 'node:crypto';
import { closeSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { checkUnchanged, openPlanned, type PlannedFile, type UploadPlan } from './local-run.js';

/**
 * The multipart body of `POST /v1/runs`, exactly as API v1 defines it: one `expiresAt` text
 * part, one `events` part per event file, one `attachment` part per canonical attachment. No
 * project, no run id, no manifest, no archive.
 *
 * It is built from the upload plan each time an attempt needs it, and every attempt sends the
 * same bytes: the files are re-opened, checked against the plan, streamed, and checked again.
 * Nothing is held in memory but one chunk at a time, so a 64 MiB attachment costs no more than a
 * small one, and the length is known in advance because the plan holds every size.
 */
export interface MultipartBody {
  readonly contentType: string;
  readonly contentLength: number;
  /** A fresh stream of the whole body; one per attempt. */
  open(): Readable;
}

const CRLF = '\r\n';

function boundary(): string {
  return `qe-report-${randomBytes(16).toString('hex')}`;
}

function fieldPart(mark: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${mark}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
    'utf8',
  );
}

/**
 * The header of a file part. The filename is the plan's own name for the file, which the service
 * ignores: it names every stored file itself, and never takes one from a client.
 */
function fileHeader(mark: string, name: string, filename: string): Buffer {
  return Buffer.from(
    `--${mark}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`,
    'utf8',
  );
}

/** The parts of one upload, in the order they are sent. */
function layout(
  mark: string,
  plan: UploadPlan,
  expiresAt: string,
): {
  readonly head: Buffer;
  readonly files: readonly { header: Buffer; file: PlannedFile }[];
  readonly tail: Buffer;
} {
  const files = [
    ...plan.events.map((file) => ({
      header: fileHeader(mark, 'events', basename(file.name)),
      file,
    })),
    ...plan.attachments.map((file) => ({
      header: fileHeader(mark, 'attachment', basename(file.name)),
      file,
    })),
  ];
  return {
    head: fieldPart(mark, 'expiresAt', expiresAt),
    files,
    tail: Buffer.from(`--${mark}--${CRLF}`, 'utf8'),
  };
}

function basename(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

export function multipartBody(plan: UploadPlan, expiresAt: string): MultipartBody {
  const mark = boundary();
  const { head, files, tail } = layout(mark, plan, expiresAt);
  const separator = Buffer.from(CRLF, 'utf8');
  const contentLength =
    head.length +
    files.reduce((sum, p) => sum + p.header.length + p.file.facts.sizeBytes + separator.length, 0) +
    tail.length;

  return {
    contentType: `multipart/form-data; boundary=${mark}`,
    contentLength,
    open(): Readable {
      return Readable.from(stream(), { objectMode: false });
    },
  };

  async function* stream(): AsyncGenerator<Buffer> {
    yield head;
    for (const part of files) {
      yield part.header;
      // The file is the one the plan described, or the upload ends here rather than sending
      // bytes of a run that is no longer the run the plan was made from.
      const fd = openPlanned(part.file);
      let sent = 0;
      try {
        for await (const chunk of createReadStream('', { fd, autoClose: false })) {
          const bytes = chunk as Buffer;
          sent += bytes.length;
          if (sent > part.file.facts.sizeBytes) break;
          yield bytes;
        }
        checkUnchanged(fd, part.file, sent);
      } finally {
        closeSync(fd);
      }
      yield separator;
    }
    yield tail;
  }
}
