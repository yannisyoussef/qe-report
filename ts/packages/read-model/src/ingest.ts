import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunDirectorySnapshot } from 'qe-report-validator';
import type { IngestionProblem, ProjectedRun } from './model.js';
import { checkProjectId } from './project-id.js';
import { AmbiguousRunError, projectRun } from './projector.js';

export interface ProjectionRequest {
  /** Opaque, non-empty partition key chosen by the caller. Never derived from the run. */
  readonly projectId: string;
  readonly runDirectory: string;
}

export type ProjectionResult =
  | { readonly kind: 'projected'; readonly run: ProjectedRun }
  | { readonly kind: 'rejected'; readonly problem: IngestionProblem };

/**
 * Validates one run directory with the protocol validator and, only when it is valid as a
 * whole, projects its accepted events. An invalid run is rejected entirely with the validator's
 * own diagnostics, which is where a broken execution invariant (a reused attempt number, a
 * changed history identity, a changed runner) surfaces as LIFECYCLE_INVALID; an incomplete but
 * valid run is projected with the verdict `incomplete`; a directory without events has no run
 * id and is rejected as empty. The projector's own defensive checks cannot fire for a snapshot
 * the validator accepted, so PROJECTION_AMBIGUOUS is unreachable on this path. Before the
 * validator opens anything, every entry of `events/` and `attachments/` must be a regular file:
 * a symbolic link, a directory, a pipe, or a device there is rejected, so the validator never
 * reads or hashes bytes outside the run directory and never blocks on a special file. What is
 * found on disk never throws; a validator failure on hostile input becomes a problem too.
 */
export async function projectRunDirectory(request: ProjectionRequest): Promise<ProjectionResult> {
  checkProjectId(request.projectId);
  const { projectId, runDirectory } = request;
  if (!existsSync(join(runDirectory, 'events'))) {
    return rejected({
      code: 'NOT_A_RUN_DIRECTORY',
      projectId,
      runDirectory,
      runId: undefined,
      detail: undefined,
      message: 'no events directory',
      diagnostics: [],
    });
  }
  const irregular = irregularEntry(runDirectory);
  if (irregular !== undefined) {
    return rejected({
      code: irregular.symlink ? 'SYMLINK_SKIPPED' : 'NOT_A_REGULAR_FILE',
      projectId,
      runDirectory,
      runId: undefined,
      detail: undefined,
      message: `${irregular.path} is not a regular file`,
      diagnostics: [],
    });
  }
  let snapshot;
  try {
    snapshot = await validateRunDirectorySnapshot(runDirectory);
  } catch (e) {
    return rejected({
      code: 'VALIDATION_ERROR',
      projectId,
      runDirectory,
      runId: undefined,
      detail: undefined,
      message: `the validator failed: ${(e as Error).message}`,
      diagnostics: [],
    });
  }
  if (!snapshot.report.valid) {
    return rejected({
      code: 'RUN_INVALID',
      projectId,
      runDirectory,
      runId: snapshot.events[0]?.runId,
      detail: undefined,
      message: 'the validator rejected the run',
      diagnostics: snapshot.report.diagnostics.filter((d) => d.severity === 'error'),
    });
  }
  if (snapshot.events.length === 0) {
    return rejected({
      code: 'EMPTY_RUN',
      projectId,
      runDirectory,
      runId: undefined,
      detail: undefined,
      message: 'no event was accepted, so the directory names no run',
      diagnostics: [],
    });
  }
  try {
    return { kind: 'projected', run: projectRun(projectId, runDirectory, snapshot) };
  } catch (e) {
    if (e instanceof AmbiguousRunError) {
      return rejected({
        code: 'PROJECTION_AMBIGUOUS',
        projectId,
        runDirectory,
        runId: snapshot.events[0]?.runId,
        detail: e.detail,
        message: e.message,
        diagnostics: [],
      });
    }
    throw e;
  }
}

function rejected(problem: IngestionProblem): ProjectionResult {
  return { kind: 'rejected', problem };
}

/** The first entry of `events/` or `attachments/` that is not a regular file, if any. */
function irregularEntry(
  runDirectory: string,
): { readonly path: string; readonly symlink: boolean } | undefined {
  for (const collection of ['events', 'attachments']) {
    const dir = join(runDirectory, collection);
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return { path, symlink: true };
      if (!stat.isFile()) return { path, symlink: false };
    }
  }
  return undefined;
}
