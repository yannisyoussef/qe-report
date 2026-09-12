import { join, relative, resolve, sep } from 'node:path';
import { safeStem, shortHash } from './safe-name.js';

/** The collection of run directories under an output root. */
export const RUNS_DIR = 'runs';

/**
 * The directory name for a run: the runId reduced to `[A-Za-z0-9._-]`, a leading character that
 * is not a letter, digit, or underscore replaced by one, cut to 48 characters, a reserved device
 * basename such as `CON` or `NUL.txt` then neutralised the same way, and `-` plus the first 12 hex
 * digits of the SHA-256 of the original id appended. The same contract as session file names,
 * without the extension; the Java SDK computes the same name. The directory is a locator only:
 * the runId inside the events stays authoritative and is never read back from the name.
 */
export function runDirectoryName(runId: string): string {
  return `${safeStem(runId)}-${shortHash(runId)}`;
}

/**
 * The run directory for a run under an output root: `<outputRoot>/runs/<runDirectoryName>`.
 * One physical run directory holds one logical run, so every process reporting into the same run
 * resolves the same directory from the same runId, and two runs never share one. The name
 * contains no separator, so the result always lies below `runs`; that is checked after
 * normalisation rather than assumed.
 */
export function resolveRunDirectory(outputRoot: string, runId: string): string {
  const runs = join(outputRoot, RUNS_DIR);
  const dir = join(runs, runDirectoryName(runId));
  const rel = relative(resolve(runs), resolve(dir));
  if (rel === '' || rel.startsWith('..') || rel.includes(sep))
    throw new Error(`run directory escapes the output root: ${runId}`);
  return dir;
}
