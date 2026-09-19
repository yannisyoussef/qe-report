import { createHash } from 'node:crypto';
import { createWriteStream, lstatSync, realpathSync } from 'node:fs';
import { constants } from 'node:fs';
import { access, link, mkdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A request directory's name: the server's own request id and nothing a client sent. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Checks the operator's roots before anything is served: the staging root must be a real
 * directory, not a link to one, and the staging and blob roots must be apart, neither inside the
 * other, so that removing a request directory can never reach durable bytes. Returns the staging
 * root, resolved.
 */
export function checkRoots(stagingRoot: string, blobRoot: string): string {
  let stat;
  try {
    stat = lstatSync(stagingRoot);
  } catch (e) {
    throw new Error(`staging root ${stagingRoot} cannot be read: ${(e as Error).message}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`staging root ${stagingRoot} is a symbolic link`);
  if (!stat.isDirectory()) throw new Error(`staging root ${stagingRoot} is not a directory`);
  const staging = realpathSync(stagingRoot);
  const blobs = realpathSync(blobRoot);
  const within = (outer: string, inner: string): boolean => {
    const relative = path.relative(outer, inner);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  if (within(staging, blobs) || within(blobs, staging)) {
    throw new Error(
      'the staging root and the blob root must be separate, neither inside the other',
    );
  }
  return staging;
}

/** Whether a root can be used right now: present, a directory, readable and writable. */
export async function rootUsable(root: string): Promise<boolean> {
  try {
    if (!lstatSync(root).isDirectory()) return false;
    await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A part whose stream was already cut off by the parser, such as one in a truncated body. */
export class PartAborted extends Error {
  constructor() {
    super('the multipart body ended before one of its parts did');
    this.name = 'PartAborted';
  }
}

/**
 * A stream the parser has already destroyed never ends or fails for a new reader, so it is
 * refused before anything waits on it.
 */
function readable(source: Readable): Readable {
  if (source.destroyed || source.errored !== null) throw new PartAborted();
  return source;
}

/** A byte count past a limit; the transport answers it with 413. */
export class LimitExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitExceeded';
  }
}

/**
 * One upload's server-generated run directory, `<staging root>/<request id>/`, with `events/`
 * for the event streams in arrival order and `attachments/` for bytes named by the SHA-256
 * computed here. Every name is the server's; no client filename, event id, run id, or attachment
 * name ever becomes a path. Everything is created exclusively and readable by the owner alone.
 */
export class StagedUpload {
  readonly directory: string;
  private eventFiles = 0;
  private uploads = 0;

  private constructor(directory: string) {
    this.directory = directory;
  }

  static async create(stagingRoot: string, requestId: string): Promise<StagedUpload> {
    if (!REQUEST_ID.test(requestId))
      throw new Error('a request directory is named by a request id');
    const directory = path.join(stagingRoot, requestId);
    // Without `recursive`, an existing entry of that name is an error rather than reused.
    await mkdir(directory, { mode: 0o700 });
    const staged = new StagedUpload(directory);
    await mkdir(path.join(directory, 'events'), { mode: 0o700 });
    await mkdir(path.join(directory, 'attachments'), { mode: 0o700 });
    return staged;
  }

  /**
   * Writes one `events` part as it arrives, byte for byte, to the next `events/NNNNNN.ndjson`.
   * Nothing is parsed or reformatted: the validator reads exactly what was sent.
   */
  async writeEvents(source: Readable, count: (bytes: number) => void): Promise<void> {
    this.eventFiles += 1;
    const name = `${String(this.eventFiles).padStart(6, '0')}.ndjson`;
    await pipeline(
      readable(source),
      counting(count),
      createWriteStream(path.join(this.directory, 'events', name), { flags: 'wx', mode: 0o600 }),
    );
  }

  /**
   * Writes one `attachment` part, hashing it as it streams, and publishes it as
   * `attachments/<sha256>` of what arrived. The same bytes uploaded twice are one file. Whether
   * any event needs them is the validator's question, not this one's.
   */
  async writeAttachment(source: Readable, count: (bytes: number) => void): Promise<string> {
    this.uploads += 1;
    const temporary = path.join(this.directory, 'attachments', `.upload-${this.uploads}`);
    const hash = createHash('sha256');
    await pipeline(
      readable(source),
      counting((bytes, chunk) => {
        count(bytes);
        hash.update(chunk);
      }),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    const sha256 = hash.digest('hex');
    try {
      await link(temporary, path.join(this.directory, 'attachments', sha256));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    await unlink(temporary);
    return sha256;
  }

  /** Removes this request's directory and nothing else. */
  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}

/** Passes bytes through unchanged, reporting each chunk first; the reporter may refuse by throwing. */
function counting(report: (bytes: number, chunk: Buffer) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        report(chunk.length, chunk);
      } catch (e) {
        done(e as Error);
        return;
      }
      done(null, chunk);
    },
  });
}
