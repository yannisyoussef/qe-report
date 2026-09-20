import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { ATTACHMENTS_DIR, EVENTS_DIR } from 'qe-report-sdk';
import { LocalRunDirectoryError } from './errors.js';

/** Attachments are named by their full lower-case SHA-256, and nothing else is one. */
const CANONICAL_ATTACHMENT = /^[0-9a-f]{64}$/u;
const EVENT_FILE = /\.ndjson$/u;

/**
 * What a planned file was when the plan was made. Every attempt re-opens the file and checks
 * these again: a run directory is expected to be complete and unchanging while it uploads, and
 * an upload that has already sent bytes of one version must never continue with another.
 */
export interface FileFacts {
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly device: number;
  readonly inode: number;
}

export interface PlannedFile {
  /** `events/000001.ndjson` or `attachments/<sha256>`, as the plan names it. */
  readonly name: string;
  readonly path: string;
  readonly facts: FileFacts;
  /** For an attachment, the SHA-256 its name claims and its bytes were proven to have. */
  readonly sha256?: string;
}

/**
 * One upload, fixed before the first attempt: which files, in which order, and exactly what each
 * one was. Retries send this plan again rather than looking at the directory afresh, so an
 * attempt cannot quietly upload a different run from the one the first attempt began.
 */
export interface UploadPlan {
  readonly runDirectory: string;
  readonly events: readonly PlannedFile[];
  readonly attachments: readonly PlannedFile[];
  readonly totalBytes: number;
}

function facts(stat: Stats): FileFacts {
  return {
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    device: stat.dev,
    inode: stat.ino,
  };
}

/** `O_NOFOLLOW` where the platform has it: the open itself refuses a symbolic link. */
const NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

/**
 * Opens one file of the run directory for reading, refusing anything that is not a regular file
 * and never following a link to one. The descriptor is re-checked after it is open, so what is
 * read is the file that was inspected and not something swapped in between.
 */
export function openRegular(path: string, name: string): { fd: number; stat: Stats } {
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (e) {
    throw new LocalRunDirectoryError('UNREADABLE', `${name} cannot be read`, { cause: e });
  }
  if (entry.isSymbolicLink()) {
    throw new LocalRunDirectoryError('UNSAFE_ENTRY', `${name} is a symbolic link; it is not read`);
  }
  if (!entry.isFile()) {
    throw new LocalRunDirectoryError('UNSAFE_ENTRY', `${name} is not a regular file`);
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new LocalRunDirectoryError(
        'UNSAFE_ENTRY',
        `${name} is a symbolic link; it is not read`,
      );
    }
    throw new LocalRunDirectoryError('UNREADABLE', `${name} cannot be opened`, { cause: e });
  }
  let opened: Stats;
  try {
    opened = fstatSync(fd);
  } catch (e) {
    closeSync(fd);
    throw new LocalRunDirectoryError('UNREADABLE', `${name} cannot be read`, { cause: e });
  }
  if (!opened.isFile()) {
    closeSync(fd);
    throw new LocalRunDirectoryError('UNSAFE_ENTRY', `${name} is not a regular file`);
  }
  return { fd, stat: opened };
}

/** A directory of the run that must be a real directory, never a link to one. */
function realDirectory(path: string, name: string, required: boolean): boolean {
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !required) return false;
    throw new LocalRunDirectoryError('UNREADABLE', `${name} cannot be read`, { cause: e });
  }
  if (entry.isSymbolicLink()) {
    throw new LocalRunDirectoryError('UNSAFE_ENTRY', `${name} is a symbolic link; it is not read`);
  }
  if (!entry.isDirectory()) {
    throw new LocalRunDirectoryError('UNSAFE_ENTRY', `${name} is not a directory`);
  }
  return true;
}

/** The bytes of an open descriptor, hashed without holding them. */
async function sha256Of(fd: number): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream('', { fd, autoClose: true });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Reads one completed run directory into the plan an upload sends: every `events/*.ndjson` in
 * code-unit order, then every `attachments/<sha256>` in hash order. Nothing else below the
 * directory is looked at, nothing is parsed, and no link is followed.
 *
 * The order is for a stable request, never protocol chronology: the server reads the events, and
 * only the events, for that.
 *
 * Each attachment's bytes are hashed here and must be the hash its name claims. A producer
 * directory whose name and bytes disagree is broken, and uploading it under the hash the bytes
 * happen to have would turn a broken local run into a different, valid remote one.
 */
export async function planUpload(runDirectory: string): Promise<UploadPlan> {
  let root: string;
  try {
    root = realpathSync(runDirectory);
  } catch (e) {
    throw new LocalRunDirectoryError('UNREADABLE', 'the run directory cannot be read', {
      cause: e,
    });
  }
  if (!realDirectory(root, 'the run directory', true)) {
    throw new LocalRunDirectoryError('UNREADABLE', 'the run directory cannot be read');
  }
  const eventsDir = join(root, EVENTS_DIR);
  realDirectory(eventsDir, `${EVENTS_DIR}/`, true);

  const events: PlannedFile[] = [];
  for (const entry of readdirSync(eventsDir).sort(byCodeUnit)) {
    if (!EVENT_FILE.test(entry)) continue;
    const name = `${EVENTS_DIR}/${entry}`;
    const { fd, stat } = openRegular(join(eventsDir, entry), name);
    closeSync(fd);
    events.push({ name, path: join(eventsDir, entry), facts: facts(stat) });
  }
  if (events.length === 0) {
    throw new LocalRunDirectoryError(
      'NO_EVENTS',
      `the run directory holds no ${EVENTS_DIR}/*.ndjson file to upload`,
    );
  }

  const attachments: PlannedFile[] = [];
  const attachmentsDir = join(root, ATTACHMENTS_DIR);
  if (realDirectory(attachmentsDir, `${ATTACHMENTS_DIR}/`, false)) {
    for (const entry of readdirSync(attachmentsDir).sort(byCodeUnit)) {
      // A name that is not a canonical hash is not an attachment: the SDK's own temporary files
      // and anything else a workspace leaves behind are passed over rather than refused.
      if (!CANONICAL_ATTACHMENT.test(entry)) continue;
      const name = `${ATTACHMENTS_DIR}/${entry}`;
      const path = join(attachmentsDir, entry);
      const { fd, stat } = openRegular(path, name);
      const sha256 = await sha256Of(fd);
      if (sha256 !== entry) {
        throw new LocalRunDirectoryError(
          'ATTACHMENT_HASH_MISMATCH',
          `${name} does not hold the bytes its name claims; the run directory is not sound`,
        );
      }
      attachments.push({ name, path, facts: facts(stat), sha256 });
    }
  }

  const all = [...events, ...attachments];
  return Object.freeze({
    runDirectory: root,
    events: Object.freeze(events),
    attachments: Object.freeze(attachments),
    totalBytes: all.reduce((sum, f) => sum + f.facts.sizeBytes, 0),
  });
}

/**
 * Opens a planned file for an attempt, refusing it unless it is still the very file the plan
 * describes. A run directory that changes underneath an upload ends it; it is never retried as
 * though nothing had happened.
 */
export function openPlanned(file: PlannedFile): number {
  const { fd, stat } = openRegular(file.path, file.name);
  const now = facts(stat);
  if (
    now.sizeBytes !== file.facts.sizeBytes ||
    now.mtimeMs !== file.facts.mtimeMs ||
    now.device !== file.facts.device ||
    now.inode !== file.facts.inode
  ) {
    closeSync(fd);
    throw new LocalRunDirectoryError(
      'RUN_DIRECTORY_CHANGED',
      `${file.name} changed while the run was being uploaded`,
    );
  }
  return fd;
}

/** Checks a planned file once more after its bytes were sent, from the descriptor that sent them. */
export function checkUnchanged(fd: number, file: PlannedFile, sent: number): void {
  let now: Stats;
  try {
    now = fstatSync(fd);
  } catch (e) {
    throw new LocalRunDirectoryError(
      'RUN_DIRECTORY_CHANGED',
      `${file.name} could not be checked after it was sent`,
      { cause: e },
    );
  }
  if (
    sent !== file.facts.sizeBytes ||
    now.size !== file.facts.sizeBytes ||
    now.mtimeMs !== file.facts.mtimeMs ||
    now.ino !== file.facts.inode
  ) {
    throw new LocalRunDirectoryError(
      'RUN_DIRECTORY_CHANGED',
      `${file.name} changed while it was being uploaded`,
    );
  }
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
