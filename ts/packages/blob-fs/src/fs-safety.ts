import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from 'node:fs';

/**
 * The same posture the validator takes before reading anything: inspect without following, open
 * without following where the platform allows it, re-check the descriptor, read regular files
 * only. Mirrored here rather than shared, so that neither package exports a filesystem API; the
 * behaviour is pinned by this package's tests.
 */
export type EntryKind = 'missing' | 'file' | 'directory' | 'symlink' | 'special';

/** Only a path that does not exist is "missing"; any other failure to inspect it is an I/O error. */
export function entryKind(path: string): EntryKind {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    throw e;
  }
  return kindOf(stat);
}

export function kindOf(stat: Stats): Exclude<EntryKind, 'missing'> {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'special';
}

/**
 * Opens a path for reading, refusing to follow a link (O_NOFOLLOW where the platform has it),
 * never blocking on a pipe (O_NONBLOCK), and re-checking the open descriptor. Returns the
 * descriptor with its size, or the kind that was found instead.
 */
export function openRegular(
  path: string,
): { fd: number; size: number } | { refused: Exclude<EntryKind, 'file'> } {
  const flags = constants as { O_NOFOLLOW?: number; O_NONBLOCK?: number };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return { refused: 'symlink' };
    if (code === 'ENOENT' || code === 'ENOTDIR') return { refused: 'missing' };
    throw e;
  }
  let stat: Stats;
  try {
    stat = fstatSync(fd);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  const kind = kindOf(stat);
  if (kind !== 'file') {
    closeSync(fd);
    return { refused: kind };
  }
  return { fd, size: stat.size };
}
