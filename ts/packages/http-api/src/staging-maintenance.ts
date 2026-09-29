import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REQUEST_ID } from './staging.js';

/** How many request directories one pass looks at when the operator does not say. */
export const DEFAULT_MAX_STAGING_ENTRIES = 100;
/** The most any one pass may look at, whatever is asked for. */
export const MAX_STAGING_ENTRIES = 1000;

/** One abandoned request directory: the name the server gave it, and when it was last touched. */
export interface StagingEntry {
  /** The request id, which is the directory's whole name. Never an absolute path. */
  readonly requestId: string;
  readonly modifiedAt: Date;
}

export type StagingProblemCode =
  /** A name the server would not have given a request directory; left alone. */
  | 'NOT_A_REQUEST_ID'
  /** A request id that is a link, a device, a socket, a pipe, or a file. Never followed, never removed. */
  | 'NOT_A_DIRECTORY'
  /** It could not be inspected or removed. */
  | 'UNREADABLE'
  | 'REMOVE_FAILED';

export interface StagingProblem {
  readonly code: StagingProblemCode;
  /** The entry's own name under the staging root; the root itself is never reported. */
  readonly name: string;
  readonly message: string;
}

export interface StagingCleanupOptions {
  /** Only directories last modified strictly before this instant. Required: there is no default cutoff. */
  readonly before: Date;
  readonly max?: number;
}

export interface StagingReport {
  readonly dryRun: boolean;
  readonly before: Date;
  /** Request directories eligible under the cutoff: removed by a run, listed by a preview. */
  readonly entries: readonly StagingEntry[];
  readonly removed: number;
  /** Everything the pass declined to touch, and why. */
  readonly problems: readonly StagingProblem[];
  /** True when the limit stopped the pass before the staging root ran out. */
  readonly truncated: boolean;
}

/**
 * Cleanup of request directories a killed server left behind.
 *
 * It is an offline operator action, and deliberately not something the server does when it
 * starts: a directory that looks abandoned is indistinguishable from one a request in another
 * live instance is still writing into, and nothing here can tell the difference. The caller
 * stops the instance that owns the staging root first, and states how old certainly abandoned is.
 *
 * Only immediate children of the staging root are considered, only names the server itself gives
 * a request directory, and only real directories. A link is never followed, an unfamiliar name is
 * reported rather than removed, and a canonical name that is not a directory is a problem to look
 * at rather than material to delete.
 */
export class StagingMaintenance {
  private readonly root: string;

  constructor(stagingRoot: string) {
    this.root = stagingRoot;
  }

  /** What a cleanup would remove. Touches nothing. */
  preview(options: StagingCleanupOptions): StagingReport {
    return this.pass(options, false);
  }

  /** Removes the eligible request directories, and only those. */
  clean(options: StagingCleanupOptions): StagingReport {
    return this.pass(options, true);
  }

  private pass(options: StagingCleanupOptions, destructive: boolean): StagingReport {
    const before = options.before;
    if (!(before instanceof Date) || !Number.isFinite(before.getTime())) {
      throw new TypeError(
        'before must be a valid Date: the instant a request directory is old enough',
      );
    }
    const max = limitOf(options.max);
    const problems: StagingProblem[] = [];
    const entries: StagingEntry[] = [];
    let removed = 0;
    let truncated = false;

    let names: string[];
    try {
      names = readdirSync(this.root).sort(byName);
    } catch (e) {
      throw new Error(`the staging root cannot be read: ${(e as Error).message}`);
    }

    for (const name of names) {
      if (!REQUEST_ID.test(name)) {
        problems.push({
          code: 'NOT_A_REQUEST_ID',
          name,
          message: 'not a name this server gives a request directory',
        });
        continue;
      }
      const path = join(this.root, name);
      let stat;
      try {
        // Without following: a link named like a request id leads somewhere else entirely.
        stat = lstatSync(path);
      } catch (e) {
        problems.push({ code: 'UNREADABLE', name, message: (e as Error).message });
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        problems.push({
          code: 'NOT_A_DIRECTORY',
          name,
          message: stat.isSymbolicLink()
            ? 'a symbolic link where a request directory belongs; it is not followed'
            : 'not a directory, so not a request directory this server made',
        });
        continue;
      }
      if (stat.mtime.getTime() >= before.getTime()) continue;
      if (entries.length === max) {
        truncated = true;
        break;
      }
      entries.push({ requestId: name, modifiedAt: stat.mtime });
      if (!destructive) continue;
      try {
        // The path is built from the root and a name this server itself would have written.
        rmSync(path, { recursive: true, force: true });
        removed += 1;
      } catch (e) {
        problems.push({ code: 'REMOVE_FAILED', name, message: (e as Error).message });
      }
    }

    return {
      dryRun: !destructive,
      before,
      entries,
      removed,
      problems,
      truncated,
    };
  }
}

function limitOf(max: number | undefined): number {
  if (max === undefined) return DEFAULT_MAX_STAGING_ENTRIES;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new TypeError('max must be a whole number of request directories of at least one');
  }
  return Math.min(max, MAX_STAGING_ENTRIES);
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
