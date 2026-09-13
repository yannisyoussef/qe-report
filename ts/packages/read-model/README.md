# qe-report-read-model

The first runner-agnostic read model over qe-report protocol line 0.3: it
turns validated run directories into an in-memory snapshot that answers
three questions. What happened in this run? How has this test behaved
across runs? Was this execution flaky? It is a library with no server, no
database, no transport, and no user interface, and it is not published.

```
discovery  ->  validated run snapshot  ->  projector  ->  in-memory read model  ->  queries
```

```ts
import { buildReadModel } from 'qe-report-read-model';

const { model, problems } = await buildReadModel([
  { projectId: 'web', outputRoot: 'build/qe-report' },
  { projectId: 'api', runDirectory: 'other/qe-report/runs/run-42-1f2e3d4c5b6a' },
]);
model.getRun('web', 'run-42');
model.getTestHistory('web', 'playwright', '81228c4c8886d566ba11-f5170702659ec7deddf5');
model.getFlakiness('web', 'playwright', '81228c4c8886d566ba11-f5170702659ec7deddf5');
model.getBlob('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
```

Lower layers are exposed for callers that need one step at a time:
`discoverRunDirectories(outputRoot)` lists candidate run directories,
`projectRunDirectory({ projectId, runDirectory })` validates and projects
one of them into a `ProjectionResult`, `projectRun(projectId,
runDirectory, validatedRun)` projects a snapshot the validator already
produced (raising `AmbiguousRunError` for a fabricated snapshot that
breaks an execution invariant, see below),
`isFlaky(attempts)` is the flakiness rule alone, and
`ReadModel.assemble(runs)` builds the snapshot from projected runs.
`RUNS_DIR` names the `runs` collection.

## Project context

`projectId` is ingestion context, not a protocol field: an opaque,
non-empty partition key supplied by the caller and never derived from
labels, environment, runner metadata, or a directory name. The canonical
run key is `(projectId, runId)`; the same run id may exist in two projects
and yields two independent runs. Run and history queries never cross a
project boundary; the blob catalog is the one deliberately snapshot-wide
index, described below. An empty project id is a caller error, not an
ingestion problem.

## Discovery

`discoverRunDirectories` lists the direct children of `<outputRoot>/runs`
that are real directories holding a real `events` directory, in a
deterministic order that does not depend on the filesystem. It never
scans recursively, never follows a symbolic link (a linked `runs`
collection, a linked run entry, or a linked `events` directory is reported
as `SYMLINK_SKIPPED`), and never interprets a name: unrelated files and
empty directories are reported and skipped, and the run id comes from the
events alone. Before a run directory is validated, every entry of its
`events/` and `attachments/` must be a regular file; a link, a directory,
or a special file there rejects the run, so nothing outside the run
directory is ever read or hashed and nothing can block a read. The
directory name is the locator the SDKs derived from the run id; it is not
the identity, so a hash collision between two run ids lands as the
validator's `RUN_ID_MISMATCH` and a run id found in two directories lands
as a `DUPLICATE_RUN` conflict that keeps neither directory.

## Validation first

Every run passes `validateRunDirectorySnapshot` of the validator before
anything is projected. The validator remains the authority for structure,
lifecycle, attachment bytes, and the run verdict; the snapshot it returns
carries the decoded events it accepted, with identical duplicates already
suppressed and unknown ignorable events already counted, so this package
holds no second parser and no second verdict. An invalid run is rejected
whole, with the validator's own error diagnostics wrapped in a
`RUN_INVALID` problem; nothing of it enters the model. A directory whose
events name no run (no accepted event at all) is rejected as `EMPTY_RUN`,
and a validator failure on hostile input is reported as
`VALIDATION_ERROR` rather than aborting the build. A valid but incomplete
run is projected with the verdict `incomplete`, exactly as the validator
reports it, and a complete run without `run.finished` (a forked JUnit
build) is projected as complete and open.

## The projected run

A `ProjectedRun` is immutable and keeps the protocol's three layers apart:

- `sessions`: every producer process with its own producer, runner,
  environment, executor, source, labels, and, when the runner reported
  one, the aggregate `status`, `rawStatus`, and `failures` of the
  invocation. No run-level environment is synthesised from one session.
- `executions`: the attempts of one logical test grouped by the protocol's
  `executionId`, ordered by attempt number, with the final attempt, its
  status, whether every attempt finished, and whether the execution was
  flaky. Each attempt keeps its status, raw status, expected status,
  duration, failures, steps (with their own failures, never flattened
  into the attempt), and attachment references, plus the test descriptor
  it carried: historical id and stability, display name, the runner's own
  typed path (`engine / class / method` for JUnit, `project / file /
group` for Playwright), location, tags, and labels.
- `scopeFailures`: every `scope.failed` on its own, with session, path,
  display name, raw status, location, and failures. A scope failure fails
  the run without rewriting any child execution.
- `validator`: `valid`, `complete`, `closed`, and `verdict` copied from the
  validator, with the counts of ignored and duplicate events.

Failure text and paths are kept as produced; redaction happened in the
producer. An attempt that never finished has no status, and an execution
whose final attempt never finished has no final status and is not flaky.

## History

Executions that carry a `historicalId` under a session that declares a
runner are indexed by `(projectId, runner.name, historicalId)`: the
protocol's collision domain, `(runner.name, historicalId)`, partitioned by
project. The producer's name is not part of the key, so replacing an
adapter keeps the history; display names, paths, locations, and tags never
merge anything. An `uncertain` identity is
indexed and keeps its stability so callers know how far to trust it; an
execution without a historical id is not indexed.

`getTestHistory` returns one occurrence per execution, so a test repeated
inside one run (Playwright `repeatEach`) appears once per repetition,
each with its run id, execution id, sessions, attempt count, final and
expected status, flakiness, the run's verdict and completeness, and the
aggregate status of the final attempt's session. Occurrences are ordered
by the producer clock of the first attempt, then run id, then execution
id. Producer clocks are not a global ordering across machines; the
tie-breakers make the order deterministic, not authoritative.

## Flakiness

An execution is flaky when it has more than one attempt, its final attempt
passed while expected to pass, and an earlier attempt failed while
expected to pass. An expected failure, an unexpected pass, exhausted
retries, a skipped sequence, an inconclusive-only sequence, and an
unfinished execution are not flaky. The rule is independent of session
policy: under Playwright's `failOnFlakyTests` the execution is flaky, the
session is failed, and the run is failed, and without that policy the
same execution is flaky in a passed session of a passed run.
`getFlakiness` counts occurrences and lists the flaky ones; there is no
score and no time window.

## Attachments

An attachment reference records where bytes were used: session, attempt,
step when present, name, media type, size, and SHA-256; a run lists its
references by session and emission order. The blob catalog indexes bytes
by their full SHA-256 across every run and every project of the snapshot,
with the run directories that hold them and every reference to them:
bytes are identified by their hash alone, and the catalog exists to show
how storage can share them. Bytes are never copied, parsed, or executed
(the validator hashes them to check the declaration and nothing else),
archives are never opened, and one hash reported with two sizes is a
`BLOB_SIZE_CONFLICT` that leaves the contradicting run out rather than
reconciling it.

## Snapshot only

`buildReadModel` rebuilds the whole snapshot from its sources. There is
no watching, polling, tailing, checkpointing, or incremental update; a
caller who wants a newer view builds a new snapshot. Building twice from
the same immutable directories gives the same runs, histories, flakiness,
and catalog, whatever the enumeration order of files or sources.

## Execution invariants

The validator enforces the execution invariants required for deterministic
projection, under protocol line 0.3:

- one attempt per `attemptNumber` per execution;
- one historical identity tuple (`historicalId`, `historicalIdStability`)
  per execution;
- one runner family (`runner.name`) per execution.

A run that breaks one of them is `LIFECYCLE_INVALID` with
`DUPLICATE_ATTEMPT_NUMBER`, `HISTORICAL_IDENTITY_CHANGED`, or
`EXECUTION_RUNNER_CHANGED`, and validation-first ingestion rejects it as
`RUN_INVALID` before projection. Gaps in attempt numbers, retries across
sessions of one runner family, different producers or runner versions,
and differing labels, tags, or display names between retries remain
valid and project as one execution. The lower-level `projectRun` keeps
the same three checks as defensive programming for callers that hand it a
fabricated or cast snapshot, raising `AmbiguousRunError` with the same
detail names, which `projectRunDirectory` would report as
`PROJECTION_AMBIGUOUS`; a snapshot the validator produced as valid never
reaches them.

Protocol 0.3 projects deterministically for every validator-valid run
tested: the whole fixture corpus and the real JUnit and Playwright
evidence project without a remaining ambiguity. That is a statement about
the current corpus and producers, not a proof about every future one.

## Limitations

- The output root itself is trusted as a location; `runs`, its entries,
  and the entries of `events/` and `attachments/` are the link checks.
- Memory is bounded by the validated events of the ingested runs; the
  snapshot is meant for a bounded set of runs, not for a service.
- The validator refuses linked and special entries under `events/` and
  `attachments/` itself and compares duplicates without recursion; this
  package's entry check before validation stays as defence in depth, and
  `VALIDATION_ERROR` remains the report for any unexpected validator
  failure.
- No aggregation across sessions, no run-level environment, no
  time-windowed statistics, and no persistence: those are later
  milestones.
