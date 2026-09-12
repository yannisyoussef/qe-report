# qe-report Playwright reporter

A Playwright Test reporter that writes one qe-report session per `playwright test`
invocation, through the qe-report TypeScript SDK, into a run directory. It observes tests
and never changes what runs, what a test's expected status is, or Playwright's exit code.

## Installation

Package `qe-report-playwright` (not published yet; the consumer fixture under
`../../consumer-fixtures/playwright` resolves it from the workspace and is the reference for
how a project consumes it). `@playwright/test` is a peer dependency: the reporter compiles
against its reporter types and runs with whatever Playwright the consumer installed.

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [['qe-report-playwright', { dir: 'build/qe-report' }], ['list']],
});
```

`printsToStdio()` is false: keep a terminal reporter next to it.

## Configuration

A reporter option wins over its environment variable, which wins over the default.

| Option               | Environment variable   | Default                                             |
| -------------------- | ---------------------- | --------------------------------------------------- |
| `enabled`            | `QE_REPORT_ENABLED`    | `true`                                              |
| `dir`                | `QE_REPORT_DIR`        | output root `qe-report` under the working directory |
| `runId`              | `QE_REPORT_RUN_ID`     | generated; the invocation is a run of its own       |
| `sessionId`          | `QE_REPORT_SESSION_ID` | generated from the process id and random bytes      |
| `maxAttachmentBytes` | option only            | the SDK's 64 MiB                                    |

Run and session ids are protocol identifiers: 1 to 128 printable ASCII characters without
spaces. A malformed value is reported once on standard error and replaced by the default.

## Run, session, and shard model

One `playwright test` process is one session: reporter callbacks run in that process, so
worker processes are not sessions and a worker restart after a failure changes nothing in the
report except the `playwright.workerIndex` label of later attempts. A shard is a separate
process and therefore a separate session; give every shard the same `dir` and `runId` and each
resolves the same run directory below the output root, `<dir>/runs/<run directory>`, named
from the run id by the SDK's contract, and writes its own session file into it
(`events/<session>.ndjson`, `attachments/<sha256>`). An invocation with a generated run id
gets a run directory of its own, so two sequential default invocations never share one, and no
directory ever holds two runs. The start-up line names the resolved run directory. A
configured run id is for processes that run disjoint sets of tests, as shards do: attempt ids
are built from Playwright's test id and the retry, so two invocations of the same tests under
one run id would collide. A job that re-runs failures gets a run id of its own.

`run.finished` is emitted only when the reporter generated the run id itself, because only
then can it know that no other process shares the run. With a configured run id, whether
sharded or not, the run ends with all sessions finished and no `run.finished`, which the
protocol treats as complete and open.

Validate a run with the qe-report validator:

```
qe-report-validate build/qe-report/runs/<run directory> --require-complete
```

## What is reported

| Playwright                 | Protocol                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onBegin`                  | `session.started`: producer `qe-report-playwright`, runner `playwright` with Playwright's version, environment `node.version`, labels `playwright.workers` and `playwright.shard`                                                                                                                                                                             |
| `onTestBegin`              | `attempt.started` with `attemptNumber = retry + 1`                                                                                                                                                                                                                                                                                                            |
| `onStepBegin`, `onStepEnd` | `step.started`, `step.finished`, nested through `parentStepId`, `kind` = Playwright's step category (`hook`, `fixture`, `pw:api`, `expect`, `test.step`, `test.attach`)                                                                                                                                                                                       |
| `onTestEnd`                | the attempt's attachments, then `attempt.finished`                                                                                                                                                                                                                                                                                                            |
| `onError`                  | an error located in a test file outside any of its tests (a spec that fails to load) is a `scope.failed` for that file, with `phase: setup` when nothing ran there; an error located in the configured global setup or teardown module is kept for `session.finished.failures` with `phase: setup` or `teardown`; any other error is printed and not recorded |
| `onEnd`                    | `session.finished` with Playwright's aggregate `FullResult.status` as the session outcome (see below), then `run.finished` for a generated run id, only if the outcome was written                                                                                                                                                                            |

### Identity

`executionId` is Playwright's `test.id`, which is unique within an invocation and shared by
every retry of a test. `historicalId` is the reporter's own digest of the project name, the
`rootDir`-relative test file, the `describe` titles, and the test title, marked `stable`: it
survives edits elsewhere in the file, moving the test within the file, retries, and
`repeatEach`; it changes when the test is renamed, moved to another file, or run under
another project. Line numbers are never part of it.

`repeatEach` executions are separate execution identities with `attemptNumber` 1 (they are
not retries) that share one historical identity. Retries share the execution id and count
`attemptNumber` 1, 2, 3.

### Path and location

`path` is Playwright's hierarchy: a `project` segment when the configuration names one, the
`file` segment as the file relative to Playwright's `rootDir` (the common test directory of the
projects, which Playwright's own reports use) with forward slashes, and one `group` segment
per `describe`. `displayName` is the test title. `location` is the same relative file, line,
and column. The absolute checkout path never appears: `rootDir`, the configuration's
directory, and the working directory are removed from error messages and stack traces.
`tags` are Playwright's tags; annotations become labels `annotation.<type>` (the type reduced
to identifier characters, repeated types joined with `; `).

### Status

| `TestResult.status` | `status`       |
| ------------------- | -------------- |
| `passed`            | `passed`       |
| `failed`            | `failed`       |
| `timedOut`          | `failed`       |
| `skipped`           | `skipped`      |
| `interrupted`       | `inconclusive` |

The native word is kept in `rawStatus`. `expectedStatus` is the author's declaration:
`passed`, `failed` (`test.fail`, also conditional), or `skipped` (`test.skip`, `test.fixme`).
An unexpected pass is `passed` with `expectedStatus: "failed"`; a flaky test is a failed
attempt followed by an expected passed attempt; both are derived from attempts, and
Playwright's aggregate outcome is not stored.

### Session outcome

Playwright's `onEnd` reports an authoritative status for the whole invocation, and the
reporter records it as the session outcome without deriving anything from the attempts:

| `FullResult.status` | `session.finished.status` | `rawStatus`   |
| ------------------- | ------------------------- | ------------- |
| `passed`            | `passed`                  | `passed`      |
| `failed`            | `failed`                  | `failed`      |
| `timedout`          | `failed`                  | `timedout`    |
| `interrupted`       | `inconclusive`            | `interrupted` |

Errors located in the configured `globalSetup` or `globalTeardown` module accompany a failed
or inconclusive outcome as `session.finished.failures` with `phase: setup` or `teardown`, at
most 32 of them; a passed session carries none. A spec that fails to load keeps its
`scope.failed` for the file, and the session outcome records Playwright's verdict beside it.
A flaky test that finally passed under `failOnFlakyTests` is two attempts, failed then
passed, and a failed session with no failure object: the runner's policy is the session
outcome, nothing else. If the SDK cannot write the outcome (it never replaces a status by an
empty terminal event), the reporter emits no `run.finished`, and the run reads as incomplete.

### Failures

Every `TestResult.errors` entry becomes a failure with its message and stack trace (terminal
escape sequences removed, root directory removed, causes appended, bounded), a `type` when
the message starts with an error class name, and a `location` inside the root directory.
`phase` comes from the step tree, not from the error text: Playwright groups every hook and
fixture of an attempt under root steps of category `hook` that it titles "Before Hooks",
"After Hooks", and "Worker Cleanup", and the reporter recognises those groups by their
category and title. An error first seen on a step under "Before Hooks" is `setup`, under
"After Hooks" or "Worker Cleanup" is `teardown`, under any other root step is `test`. An error
with no step, such as a plain
`throw` in the test body or a test timeout, carries no phase. Playwright attributes
`beforeAll` and `afterAll` failures to the tests of the file; the reporter keeps that and
emits no `scope.failed` for them.

### Attachments

Every `TestResult.attachments` entry is stored through the SDK with its content type: an
in-memory body as bytes, a path-backed file read no further than the attachment limit. Text
attachments are redacted; screenshots, videos, and the trace ZIP are opaque bytes, are not
redacted, and are never extracted. Attachments that Playwright associates with a step
(`test.attach` inside `test.step`, screenshots and videos taken during "After Hooks") carry
that `stepId`; every other attachment belongs to the attempt. Nothing is emitted twice. All
attachments are stored synchronously inside `onTestEnd`, which Playwright does not await, so
`attachment.added` always precedes `attempt.finished` and no work is pending at `onEnd`. A
path-backed attachment is therefore read into memory up to the attachment limit; lower
`maxAttachmentBytes` for runs with very large traces or videos.

## Tested versions

| Playwright | Node   |
| ---------- | ------ |
| 1.63.0     | 22, 24 |
| 1.57.0     | 22     |

The peer range `>=1.57.0 <2` states compatibility intent; only the lines above are tested.

The consumer fixture under `../../consumer-fixtures/playwright` runs real Playwright
executions on Chromium: retries, `repeatEach`, two projects, two shards sharing a run,
parallel workers, hook failures, attachments of every kind, a global setup failure, a global
teardown failure, a global timeout, an interruption, `failOnFlakyTests`, and shards that
passed, failed, or were interrupted, and validates every run directory with the protocol
validator, comparing the derived verdict with Playwright's own final status in each case.

## Failure isolation

Reporting never throws into Playwright and never changes a result. If the run directory
cannot be created or the session file already exists, one line is printed and the run is
not reported. A missing or oversized attachment, a sink failure, or an internal mapping
error is printed once and the affected event is dropped while the rest of the run continues.
`onEnd` never returns a status.

## Limitations

- An `onError` without a location, or located outside the root directory and outside the
  configured global modules, is printed and not recorded; Playwright's aggregate status still
  fails the session.
- A test Playwright never finishes (global timeout) is closed as `inconclusive` with
  `rawStatus: "unfinished"` at the end of the run; the failed session outcome outranks it.
- Standard output and error of tests are not captured.
- The reporter is for direct `playwright test` invocations. Under `merge-reports`, which
  replays a blob, step and attempt attachments are distinct objects and a step-scoped
  attachment would be recorded twice.
- More than 32 errors on one attempt are cut to the first 32, and failure text beyond the
  event budget loses stack traces, then failures, with a marker; both are printed once.
- Playwright's own `error-context` attachment (Markdown) is stored like any text attachment.
- `expectedStatus` values Playwright's type admits but no author declares (`timedOut`,
  `interrupted`) are omitted with a diagnostic.
