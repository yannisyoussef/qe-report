import { discoverRunDirectories } from './discovery.js';
import { projectRunDirectory } from './ingest.js';
import { compareHistoryOccurrences } from './history-order.js';
import { checkProjectId } from './project-id.js';
import type {
  Blob,
  BlobReference,
  BlobSource,
  ExecutionOccurrence,
  Flakiness,
  IngestionProblem,
  ProjectedRun,
  TestHistory,
} from './model.js';

/** A run source: every run directory below an output root, or one run directory. */
export type ReadModelSource =
  | { readonly projectId: string; readonly outputRoot: string }
  | { readonly projectId: string; readonly runDirectory: string };

export interface ReadModelBuild {
  readonly model: ReadModel;
  /** Every run directory that did not become a run, and the conflicts between those that did. */
  readonly problems: readonly IngestionProblem[];
}

/**
 * An immutable in-memory snapshot of projected runs with the three product views over them:
 * what happened in a run, how a test behaved across runs, and whether an execution was flaky.
 * Run and history queries are exact and stay inside the project they are asked about; the blob
 * catalog is deliberately snapshot-wide, because bytes are identified by their hash alone and
 * the catalog exists to show how storage can share them across projects and runs.
 */
export class ReadModel {
  private readonly runsByKey: ReadonlyMap<string, ProjectedRun>;
  private readonly history: ReadonlyMap<string, readonly ExecutionOccurrence[]>;
  private readonly blobsBySha: ReadonlyMap<string, Blob>;

  private constructor(
    runs: ReadonlyMap<string, ProjectedRun>,
    history: ReadonlyMap<string, readonly ExecutionOccurrence[]>,
    blobs: ReadonlyMap<string, Blob>,
  ) {
    this.runsByKey = runs;
    this.history = history;
    this.blobsBySha = blobs;
  }

  /**
   * Assembles a snapshot from projected runs. A run key `(projectId, runId)` seen from more than
   * one run directory is a conflict: none of those directories enters the model and the
   * problem names them all, because neither the directory name nor its age can say which is
   * the run. Bytes reported under one SHA-256 with two sizes are a conflict as well; the run
   * that contradicts the catalog is left out rather than reconciled.
   */
  static assemble(runs: readonly ProjectedRun[]): ReadModelBuild {
    const problems: IngestionProblem[] = [];
    const byKey = new Map<string, ProjectedRun[]>();
    for (const run of runs) {
      const key = runKey(run.projectId, run.runId);
      const known = byKey.get(key);
      if (known === undefined) byKey.set(key, [run]);
      else if (!known.some((r) => r.runDirectory === run.runDirectory)) known.push(run);
    }
    const accepted = new Map<string, ProjectedRun>();
    const blobs = new Map<string, MutableBlob>();
    for (const [key, candidates] of [...byKey.entries()].sort(([a], [b]) => compare(a, b))) {
      if (candidates.length > 1) {
        const directories = candidates.map((r) => r.runDirectory).sort(compare);
        for (const run of candidates) {
          problems.push({
            code: 'DUPLICATE_RUN',
            projectId: run.projectId,
            runDirectory: run.runDirectory,
            runId: run.runId,
            detail: undefined,
            message: `run ${run.runId} of project ${run.projectId} was found in ${directories.length} run directories: ${directories.join(', ')}`,
            diagnostics: [],
          });
        }
        continue;
      }
      const run = candidates[0] as ProjectedRun;
      const conflict = run.attachments.find((a) => {
        const known = blobs.get(a.sha256);
        return known !== undefined && known.sizeBytes !== a.sizeBytes;
      });
      if (conflict) {
        problems.push({
          code: 'BLOB_SIZE_CONFLICT',
          projectId: run.projectId,
          runDirectory: run.runDirectory,
          runId: run.runId,
          detail: undefined,
          message: `attachment ${conflict.sha256} is ${conflict.sizeBytes} bytes here and ${blobs.get(conflict.sha256)?.sizeBytes ?? 0} bytes in an earlier run`,
          diagnostics: [],
        });
        continue;
      }
      accepted.set(key, run);
      for (const reference of run.attachments) {
        const blob = blobs.get(reference.sha256) ?? {
          sha256: reference.sha256,
          sizeBytes: reference.sizeBytes,
          sources: [],
          references: [],
        };
        if (!blob.sources.some((s) => s.projectId === run.projectId && s.runId === run.runId)) {
          blob.sources.push({
            projectId: run.projectId,
            runId: run.runId,
            runDirectory: run.runDirectory,
          });
        }
        blob.references.push({ projectId: run.projectId, runId: run.runId, reference });
        blobs.set(reference.sha256, blob);
      }
    }
    const history = new Map<string, ExecutionOccurrence[]>();
    for (const run of accepted.values()) {
      for (const occurrence of historyOccurrencesOf(run)) {
        const key = historyKey(
          occurrence.projectId,
          occurrence.runnerName,
          occurrence.historicalId,
        );
        const list = history.get(key);
        if (list === undefined) history.set(key, [occurrence]);
        else list.push(occurrence);
      }
    }
    for (const [key, list] of history) history.set(key, list.sort(compareHistoryOccurrences));
    const frozenBlobs = new Map<string, Blob>();
    for (const [sha, blob] of [...blobs.entries()].sort(([a], [b]) => compare(a, b))) {
      frozenBlobs.set(sha, {
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
        sources: [...blob.sources].sort(compareSources),
        references: [...blob.references].sort(compareSources),
      });
    }
    return { model: new ReadModel(accepted, history, frozenBlobs), problems };
  }

  /** What happened in one run, or nothing when the project holds no such run. */
  getRun(projectId: string, runId: string): ProjectedRun | undefined {
    checkProjectId(projectId);
    return this.runsByKey.get(runKey(projectId, runId));
  }

  /** Every run of the snapshot, by project then run id. */
  runs(): readonly ProjectedRun[] {
    return [...this.runsByKey.values()].sort(
      (a, b) => compare(a.projectId, b.projectId) || compare(a.runId, b.runId),
    );
  }

  /**
   * How one historical test behaved across the runs of a project, as exact execution
   * occurrences: one per execution, so a test repeated inside a run appears once per
   * repetition. The order follows the producers' clocks, which no consumer should treat as a
   * global ordering, with the run id and the execution id as tie-breakers.
   */
  getTestHistory(projectId: string, runnerName: string, historicalId: string): TestHistory {
    checkProjectId(projectId);
    return {
      projectId,
      runnerName,
      historicalId,
      occurrences: this.history.get(historyKey(projectId, runnerName, historicalId)) ?? [],
    };
  }

  /** Whether and how often the executions of one historical test were flaky. No score, no window. */
  getFlakiness(projectId: string, runnerName: string, historicalId: string): Flakiness {
    const { occurrences } = this.getTestHistory(projectId, runnerName, historicalId);
    const flaky = occurrences.filter((o) => o.flaky);
    return {
      projectId,
      runnerName,
      historicalId,
      totalOccurrences: occurrences.length,
      flakyOccurrences: flaky.length,
      everFlaky: flaky.length > 0,
      flaky,
    };
  }

  /** Stored bytes by their full SHA-256, across every run of the snapshot. */
  getBlob(sha256: string): Blob | undefined {
    return this.blobsBySha.get(sha256);
  }

  /** Every blob of the snapshot, by hash. */
  blobs(): readonly Blob[] {
    return [...this.blobsBySha.values()];
  }
}

interface MutableBlob {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly sources: BlobSource[];
  readonly references: BlobReference[];
}

/**
 * Discovers, validates, projects, and assembles: the whole snapshot from the given sources.
 * Sources are processed in the order given and their run directories in discovery order, and
 * neither order can change the result, because assembly sorts every collection and resolves
 * conflicts without preferring a position.
 */
export async function buildReadModel(sources: readonly ReadModelSource[]): Promise<ReadModelBuild> {
  const runs: ProjectedRun[] = [];
  const problems: IngestionProblem[] = [];
  for (const source of sources) {
    checkProjectId(source.projectId);
    const directories: string[] = [];
    if ('runDirectory' in source && 'outputRoot' in source) {
      throw new TypeError('a source names either an output root or a run directory, not both');
    }
    if ('runDirectory' in source) directories.push(source.runDirectory);
    else {
      const discovery = discoverRunDirectories(source.outputRoot);
      for (const p of discovery.problems) {
        problems.push({
          code: p.code,
          projectId: source.projectId,
          runDirectory: p.path,
          runId: undefined,
          detail: undefined,
          message: p.message,
          diagnostics: [],
        });
      }
      directories.push(...discovery.runDirectories);
    }
    for (const runDirectory of directories) {
      const result = await projectRunDirectory({ projectId: source.projectId, runDirectory });
      if (result.kind === 'projected') runs.push(result.run);
      else problems.push(result.problem);
    }
  }
  const assembled = ReadModel.assemble(runs);
  return { model: assembled.model, problems: [...problems, ...assembled.problems] };
}

function runKey(projectId: string, runId: string): string {
  return JSON.stringify([projectId, runId]);
}

function historyKey(projectId: string, runnerName: string, historicalId: string): string {
  return JSON.stringify([projectId, runnerName, historicalId]);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSources(a: BlobSource | BlobReference, b: BlobSource | BlobReference): number {
  return compare(a.projectId, b.projectId) || compare(a.runId, b.runId);
}

/**
 * The history occurrences of a run: one per execution that carries a historical id under a
 * declared runner. An execution without either is not history and is never given one. This is
 * the single derivation of history facts from a projected run; the in-memory snapshot and any
 * durable index of them both call it, so neither can drift into its own interpretation.
 */
export function historyOccurrencesOf(run: ProjectedRun): readonly ExecutionOccurrence[] {
  const out: ExecutionOccurrence[] = [];
  const sessions = new Map(run.sessions.map((s) => [s.sessionId, s]));
  for (const e of run.executions) {
    const historicalId = e.test.historicalId;
    if (historicalId === undefined || e.runnerName === undefined) continue;
    const finalSession = sessions.get(e.finalAttempt.sessionId);
    out.push({
      projectId: run.projectId,
      runnerName: e.runnerName,
      historicalId,
      runId: run.runId,
      executionId: e.executionId,
      sessionIds: [...new Set(e.attempts.map((a) => a.sessionId))].sort(compare),
      historicalIdStability: e.test.historicalIdStability,
      occurredAt: (e.attempts[0] as (typeof e.attempts)[number]).startedAt,
      attemptCount: e.attempts.length,
      complete: e.complete,
      finalStatus: e.finalStatus,
      expectedStatus: e.finalAttempt.expectedStatus,
      flaky: e.flaky,
      runVerdict: run.validator.verdict,
      runComplete: run.validator.complete,
      sessionStatus: finalSession?.status,
    });
  }
  return out;
}
