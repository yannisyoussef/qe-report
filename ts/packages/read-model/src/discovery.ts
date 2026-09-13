import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveryProblem } from './model.js';

/** The collection of run directories below an output root, as the SDKs write it. */
export const RUNS_DIR = 'runs';

export interface Discovery {
  readonly outputRoot: string;
  readonly runsDirectory: string;
  /** Candidate run directories, by name in code-unit order. Their run ids come from their events. */
  readonly runDirectories: readonly string[];
  readonly problems: readonly DiscoveryProblem[];
}

/**
 * Lists the run directories below an output root: the direct children of `<outputRoot>/runs`
 * that are real directories holding a real `events` directory. Nothing is read recursively, no
 * symbolic link is followed, and no name is interpreted: the directory name is a locator, and
 * the run id inside the events is the identity. The order is deterministic and independent of
 * the filesystem's enumeration order.
 */
export function discoverRunDirectories(outputRoot: string): Discovery {
  const runsDirectory = join(outputRoot, RUNS_DIR);
  const problems: DiscoveryProblem[] = [];
  const runDirectories: string[] = [];
  const runsStat = statOrUndefined(runsDirectory);
  if (runsStat?.isSymbolicLink()) {
    problems.push({
      code: 'SYMLINK_SKIPPED',
      path: runsDirectory,
      message: `${RUNS_DIR} is a symbolic link, not followed`,
    });
    return { outputRoot, runsDirectory, runDirectories, problems };
  }
  if (runsStat === undefined || !runsStat.isDirectory()) {
    problems.push({
      code: 'RUNS_DIRECTORY_MISSING',
      path: runsDirectory,
      message: `no ${RUNS_DIR} directory below the output root`,
    });
    return { outputRoot, runsDirectory, runDirectories, problems };
  }
  for (const entry of readdirSync(runsDirectory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = join(runsDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      problems.push({ code: 'SYMLINK_SKIPPED', path, message: 'symbolic link not followed' });
      continue;
    }
    if (!entry.isDirectory()) {
      problems.push({ code: 'NOT_A_DIRECTORY', path, message: 'not a directory' });
      continue;
    }
    const events = join(path, 'events');
    const eventsStat = statOrUndefined(events);
    if (eventsStat?.isSymbolicLink()) {
      problems.push({
        code: 'SYMLINK_SKIPPED',
        path: events,
        message: 'events directory is a symbolic link, not followed',
      });
      continue;
    }
    if (eventsStat === undefined || !eventsStat.isDirectory()) {
      problems.push({ code: 'NO_EVENTS_DIRECTORY', path, message: 'no events directory' });
      continue;
    }
    runDirectories.push(path);
  }
  return { outputRoot, runsDirectory, runDirectories, problems };
}

function statOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
