# qe-report protocol

A language-neutral description of a test run as a sequence of events, for
reporting from any runner. Compatibility line 0.3; the schema in
[`schema/event.schema.json`](schema/event.schema.json) is the source of
truth, and the fixtures in [`fixtures/`](fixtures/) are its executable
specification. Both the Java and TypeScript bindings in this repository are
checked against them.

The design was derived from the observed behaviour of three runners: JUnit
Platform 6 (`TestExecutionListener`), Playwright 1.63 (`Reporter`), and
Karate 1.5 (`RuntimeHook`); line 0.2 from the first real adapter (the
JUnit Platform adapter), which met a failure that line 0.1 could not
represent; and line 0.3 from the second (the Playwright reporter), which
met invocation-level outcomes that no attempt and no scope could carry.
Where a concept exists because of what those
runners do, this document says so. The ecosystem-level boundary this
protocol implements is in the
[qe-ecosystem architecture](https://github.com/yannisyoussef/qe-ecosystem/blob/develop/docs/architecture.md)
and its
[ADR-0002](https://github.com/yannisyoussef/qe-ecosystem/blob/develop/docs/adr/0002-reporting-protocol-boundary.md).

## Shape of a run

```
run          one logical execution, identified by a producer-generated runId
 └─ session  one producer process (a JVM, a Playwright process, a shard)
     └─ attempt   one execution of a test case; a retry is a new attempt
         ├─ step        optional, nested, timed
         └─ attachment  metadata for bytes stored outside the stream
```

A run is a set of newline-delimited event streams, one per session. A
session file and a live stream are the same format. Several sessions can
contribute to one run: Playwright shards, forked JVMs, and parallel CI jobs
each open a session against a shared `runId`, and each owns its own event
stream. Ordering is defined only inside a session; nothing orders sessions
against each other.

## Envelope

Every event carries:

| Field | Meaning |
|---|---|
| `protocolVersion` | Full Semantic Version written by the producer, for example `0.3.0`. |
| `eventId` | Unique within the run. A second occurrence with identical content is a harmless duplicate; with different content it is invalid. |
| `eventType` | Discriminator for `payload`, dotted lower case. |
| `runId`, `sessionId` | Identity of the run and of the producer process. |
| `sequence` | 1-based, contiguous within the session. A gap means loss. |
| `occurredAt` | Producer clock, ISO-8601 with an explicit offset. |
| `ignorable` | Optional. True when a consumer that does not know `eventType` may skip the event safely. Absent means false. |
| `payload` | Content specific to the event type. |

Identifiers are printable ASCII without spaces, at most 128 characters.
Timestamps come from the producer's clock; runner-reported durations are
carried as `durationMs` on the finishing events.

## Events

| Event | Emitted when | Payload |
|---|---|---|
| `session.started` | A producer process begins. | `producer` (required), `runner`, `environment`, `executor`, `source`, `labels`. |
| `session.finished` | The session emits no further session-scoped event. | `status`, `rawStatus`, `failures` (the runner's aggregate outcome, all optional). |
| `run.finished` | Only from a producer that knows every session has finished. | empty |
| `attempt.started` | A test case execution begins. | `attemptId`, `attemptNumber` (1 for the first execution, 2 for the first retry), `test`. |
| `attempt.finished` | It ends. | `attemptId`, `status`, `rawStatus`, `expectedStatus`, `durationMs`, `failures`. |
| `step.started` | A named unit inside an attempt begins. | `stepId`, `attemptId`, `parentStepId`, `name`, `kind`, `location`. |
| `step.finished` | It ends. | `stepId`, `attemptId`, `status`, `rawStatus`, `durationMs`, `failures`. |
| `attachment.added` | Bytes were stored for an attempt or step. | `attemptId`, `stepId`, `name`, `mediaType`, `sizeBytes`, `sha256`. |
| `scope.failed` | A non-test scope of the hierarchy failed. | `path`, `failures`, `displayName`, `rawStatus`, `location`. |

There is no `run.started`: run-level facts (environment, CI context, source
revision) live on `session.started`, because a forked JVM or a shard knows
them and no coordinator has to. Failures are embedded in the finishing
events rather than emitted separately, because every runner observed
delivers the error together with the end of the test or step.

### Scope failures

A scope is a non-test node of the runner's hierarchy: a class, a suite, a
file, a module, or whatever a runner groups tests in. Runners can fail a
scope on its own, after or before its tests, and the tests keep their own
verdicts: a JUnit class whose `@AfterAll` throws after every test passed, a
pytest module or class whose teardown fixture errors, a Cypress spec whose
`after` hook fails. Attributing such a failure to a child test would be
false, and inventing a test to carry it would distort counts and history.
`scope.failed` records it where it belongs, and it is why line 0.2 exists:
a consumer that ignored it would derive a passed run from a failed one, so
it could not be an ignorable addition to line 0.1.

```json
{
  "protocolVersion": "0.3.0",
  "eventId": "jvm-1-0033",
  "eventType": "scope.failed",
  "runId": "run-junit-0001",
  "sessionId": "jvm-1",
  "sequence": 33,
  "occurredAt": "2026-09-11T10:00:30.000+00:00",
  "payload": {
    "path": [
      { "kind": "engine", "name": "junit-jupiter" },
      { "kind": "class", "name": "com.example.CustomerTest" }
    ],
    "displayName": "CustomerTest",
    "rawStatus": "FAILED",
    "failures": [
      { "message": "cleanup failed", "type": "java.lang.IllegalStateException", "phase": "teardown" }
    ]
  }
}
```

- `path` identifies the failing scope itself, outermost first, in the same
  segments a test path uses; the last segment is the scope that failed. It
  is required and never empty. When the same adapter emits the scope's
  tests, the scope path is a prefix of each of their paths, so a consumer
  can place the failure in the tree by prefix matching; prefix matching is
  for display, never for verdicts. Scopes have no identity of their own
  beyond the event's `eventId`, and no historical identity.
- `failures` reuses the failure definition and is never empty. Several
  failures observed at once belong in one event. `failures[].phase`, when
  present, is `setup` or `teardown`; a consumer treats any other value as
  absent.
- `displayName`, `rawStatus`, and `location` are optional and mean what
  they mean on a test.

The event is session-scoped: valid after `session.started` and before
`session.finished`, before or after the child attempts, without any
attempt association. Each `scope.failed` is a distinct failure: events are
never merged by path, a nested scope and its parent may each fail, and a
session may carry several. A scope failure with no attempt under its path
is valid and means that nothing ran there. There is no `scope.started`,
`scope.finished`, or `scope.passed`: only the observed failure is recorded.

A prevented set of tests has one representation, not two: when the runner
reports per-test setup errors, or the adapter can honestly synthesise them
for planned tests (the JUnit `@BeforeAll` mapping), those are failed
attempts with `phase: setup`; otherwise a single `scope.failed` with
`phase: setup`. Consumers never infer one from the other.

### Session outcome

A runner invocation can end with an aggregate outcome that no attempt and
no hierarchy scope explains: a global setup or teardown exception, a global
timeout, an interruption, a runner policy such as failing the invocation
for a flaky test. The Playwright reporter met all of these. Its `onEnd`
reports `passed`, `failed`, `timedout`, or `interrupted` for the whole
invocation, and under line 0.2 a run whose global setup threw derived as
`passed`. Line 0.3 therefore lets `session.finished` carry the runner's own
aggregate outcome for the completed session, in three optional fields:

- `status`: `passed` (the invocation completed with a successful aggregate
  outcome), `failed` (it completed with a failed aggregate outcome, whether
  or not a test or a scope explains it), or `inconclusive` (it completed
  without a pass or fail verdict: interrupted, cancelled). This is its own
  set, `sessionStatus`, not the attempt status: there is no skipped session
  and no expected status.
- `rawStatus`: the runner's own aggregate word (`timedout`, `interrupted`),
  for display and lossy mappings only. It never enters verdict derivation,
  a consumer needs no runner knowledge to derive one, and it requires
  `status`.
- `failures`: errors of the invocation itself that belong to no attempt and
  no scope, in the ordinary failure shape and limits, with `phase` `setup`
  or `teardown` where truthful. They require `status`, so that the failure
  list never becomes a second, implicit verdict carrier; a `failed` session
  may carry none (a timeout or a policy has no exception to attach), an
  `inconclusive` session may carry the error that stopped it, and a
  `passed` session carries none.

An empty payload remains valid and is what a producer emits when its
runner exposes no authoritative aggregate outcome; the JUnit Platform
adapter does so, because a forked JVM knows nothing of the build's
verdict, and consumers then derive the outcome from attempt and scope
facts alone. A producer whose runner exposes one must emit `status`. Three
layers stay distinct and none replaces another: an attempt's outcome, a
scope failure, and the session outcome. `session.finished` remains the
event that closes the session; only `run.finished` may follow it.

A supplied `status` is never erased. When the terminal event exceeds the
producer's event size limit, both SDKs drop diagnostic detail in a fixed
order, the failures first and then the raw status, and report each step;
the canonical status survives every step. When the status alone cannot be
written, or the sink fails, they emit no terminal event at all rather than
an empty one: the session stays structurally open, the SDK accepts nothing
further for it, and a consumer derives `incomplete` instead of a false
`passed`. A producer without an aggregate outcome still closes its session
with the empty payload whenever that can be written.

```json
{
  "eventType": "session.finished",
  "payload": {
    "status": "failed",
    "rawStatus": "timedout",
    "failures": [{ "message": "global setup broke", "phase": "setup" }]
  }
}
```

A run's verdict is derived, never persisted, and is one of four:
`incomplete` (the event lifecycle is structurally unfinished: a session,
attempt, or step never finished), `failed`, `inconclusive` (the lifecycle
finished correctly but execution ended without a pass or fail verdict),
or `passed`. A test case's outcome is that of its final attempt (the
highest `attemptNumber`), read against `expectedStatus`: failed where
passing was expected, or passed where failure was expected, is an
unexpected outcome. Derivation, in order of precedence:

1. any session, attempt, or step still open: `incomplete`;
2. otherwise any unexpected test outcome, any `scope.failed`, or any
   session with `status: "failed"`: `failed`;
3. otherwise any test whose final attempt is `inconclusive`, or any session
   with `status: "inconclusive"`: `inconclusive`;
4. otherwise `passed`.

Failure evidence outranks inconclusive evidence, and a session's `passed`
never erases an unexpected attempt, a scope failure, or an inconclusive
final attempt: all attempts passed
with a failed session is a failed run, one unexpected failure with an
inconclusive session is a failed run, all attempts passed with an
inconclusive session is an inconclusive run, and a properly closed
interrupted run is inconclusive, not incomplete. A flaky test, one failed
attempt followed by an expected passed final attempt, is not an unexpected
outcome; a runner policy that fails the invocation for it is exactly what
the session status expresses, and the two layers stay separate. A
`scope.failed` never rewrites a completed attempt. For

```
class FooTest
  testA PASSED
  testB PASSED
  @AfterAll FAILED
```

the read model keeps `testA = passed`, `testB = passed`, one teardown scope
failure, and a run verdict of `failed`.

### Session lifecycle

```
ACTIVE ──session.finished──▶ SESSION FINISHED ──run.finished──▶ RUN FINISHED
```

- While active, a session emits any event.
- After `session.finished`, no attempt, step, attachment, or other
  session-scoped event is valid for that session. The only event a
  finished session may still emit is `run.finished`. The outcome carried
  by `session.finished` describes the completed session itself.
- `run.finished` carries no status; the run's verdict is derived.
- `run.finished` is optional and is emitted only by a producer that knows
  every session of the run has finished: a single-process reporter, or a
  coordinator. A forked worker cannot know this and must not emit it. A run
  has at most one `run.finished`; after it, no event for the run is valid.
- Both SDKs hold this state explicitly and drop anything else with a
  reported problem; the validator rejects the same transitions.

### Ordering and completeness

- Within a session, `session.started` comes first and `sequence` increases
  by exactly one per event. Across sessions there is no order.
- An attempt's `attempt.started` precedes its steps, attachments, and
  `attempt.finished`. A step finishes before its attempt does. Attachments
  precede `attempt.finished`: all three runners have every attachment
  available when they report the end of a test, so nothing arrives late.
- `session.finished` requires every attempt of the session to be finished.
  `run.finished` requires every session of the run to be finished.
- A producer that crashes leaves a session, an attempt, or a step without
  its finishing event. Such a run is valid but incomplete. A consumer must
  represent the open items as having no verdict; it must not invent one.
- Two `attempt.finished` for one attempt is invalid (duplicate completion).

## Test case

```json
{
  "executionId": "pw-flaky-desktop",
  "historicalId": "81228c4c8886d566ba11-f5170702659ec7deddf5",
  "historicalIdStability": "stable",
  "displayName": "flaky passes on retry",
  "path": [
    { "kind": "project", "name": "desktop" },
    { "kind": "file", "name": "main.spec.ts" }
  ],
  "location": { "file": "tests/main.spec.ts", "line": 10, "column": 1 },
  "tags": ["@smoke"],
  "labels": { "issue": "QE-1" }
}
```

Two identities, because the runners give two different things:

- `executionId` correlates the attempts of one logical test within a run.
  Every retry carries the same value. JUnit's `UniqueId`, Playwright's
  `test.id`, and Karate's scenario `uniqueId` all serve here.
- `historicalId` links the same logical test across runs. Its collision
  domain is the runner: consumers key history by the pair `(runner.name
  from session.started, historicalId)`, so two runner families that happen
  to emit the same string never merge into one test, and renaming or
  replacing the adapter (`producer`) does not break history. A session
  whose tests carry a `historicalId` must therefore declare `runner`, with
  a lower-case family name such as `junit-platform`, `playwright`, `karate`,
  `pytest`, or `cypress`; the validator rejects a historical id without a
  runner. Adapters do not namespace the id themselves. The adapter
  derives it and says how far to trust it in `historicalIdStability`:
  `stable` (survives unrelated edits), `uncertain` (built from indexes or
  line numbers, as Karate outline examples and JUnit parameterized
  invocations are), or `unavailable` (no identity can be given, as for
  JUnit dynamic tests, whose ids are `#1`, `#2` in registration order).
  When unavailable, `historicalId` is absent. Derivation rules belong to
  each adapter and are not part of the protocol.

Because the attempts of one execution are one test, the validator holds
them to three relational rules, run-wide and across sessions. No two
attempts of an execution share an `attemptNumber`: the final attempt is
the one with the highest number, and two attempts with that number would
leave it undefined; gaps such as 1 then 3 are allowed and nothing is
invented for the missing numbers. Every attempt carries the same history
identity, the same `historicalId` and the same `historicalIdStability`,
an absent id included, so an identity cannot appear, disappear, or change
its stability between retries. Every attempt belongs to a session
declaring the same `runner.name`, an absent runner counting as a family of
its own, so the history key above is defined for the whole execution.
Retries may still differ in presentation (labels, tags, display name,
location, path), may sit in different sessions of the same runner family,
and may come from different producers or runner versions. A repetition of
a test inside one run (Playwright's `repeatEach`) is a separate execution
with its own `executionId`, not a retry.

`path` is the runner's own container hierarchy, outermost first, as typed
segments. `file` and `group` are the well-known kinds. A runner-specific
kind such as Playwright's `project` is allowed; a consumer that does not
know a kind treats it like a group. `displayName` is the leaf. `location`
is a display string; a consumer never resolves it on disk.

## Status

`status` of an attempt or step is one of four values. The runner's own
word is kept in `rawStatus` so a lossy mapping loses nothing for display.
A session's aggregate `status` is a separate, three-valued set described
under session outcome.

| Canonical | Meaning | Observed sources |
|---|---|---|
| `passed` | Verdict: passed. | all |
| `failed` | Verdict: failed, including timeouts. | all; Playwright `timedOut` |
| `skipped` | The body did not run to a verdict by decision. | JUnit disabled and `ABORTED` (assumption), Playwright `skipped`, fixme |
| `inconclusive` | Execution ended without a verdict for reasons outside the test. | Playwright `interrupted` |

`expectedStatus` (default `passed`) records what the author declared. A
consumer derives "expected failure" from `failed`/`failed` and "unexpected
pass" from `passed`/`failed`; this is Playwright's model and it also
represents pytest's `xfail` without new enumeration values.

Documented lossy mappings: JUnit `ABORTED` becomes `skipped` with
`rawStatus: "ABORTED"`; Playwright `timedOut` becomes `failed`; Karate
`karate.abort()` leaves the scenario `passed` with `rawStatus: "aborted"`
because that is Karate's own verdict; a Karate `@ignore` scenario is never
reported because the runner never invokes the hook for it.

`failures[].phase` says where a failure originated when the runner can
tell: `setup`, `test`, or `teardown`. A Playwright `beforeAll` failure is
attributed to every test in the file. JUnit reports a failed `@BeforeAll`
only on the class container and never starts the tests; an adapter may
represent the planned tests it prevented as failed attempts with
`phase: "setup"`, a mapping the JUnit adapter must test and document
before relying on it. Karate background failures are step failures with
`phase: "setup"`.

An attempt represents a test case. A failure that belongs to a non-test
scope of the hierarchy, such as a JUnit `@AfterAll` failure reported on the
class container after its tests have passed, is represented by
`scope.failed` (see Scope failures): it fails the run without altering the
verdict of any child attempt, and no test is invented to carry it.

## Attachments

Bytes never travel inside events. `attachment.added` carries the display
name, media type, size, and lower-case hex SHA-256 of the bytes as stored,
after any producer-side redaction. The hash is integrity and deduplication
metadata: a file sink names the sidecar file by it, and a consumer verifies
it. Deduplication is per run in the file layout and per project on any
server; the hash is never a global lookup key.

### Run directory

```
<output root>/
  runs/
    <run directory>/
      events/<session file>.ndjson    one file per session, created exclusively by its producer
      attachments/<sha256>            bytes, shared by every session of the run
```

One physical run directory holds one logical run. The directory configured
through an adapter (`qe.report.dir`, `QE_REPORT_DIR`, Playwright's `dir`)
is the output root, and every run below it lives in its own run directory
named from the `runId` by the portable naming contract: the id reduced
to `[A-Za-z0-9._-]`, an empty result replaced by an underscore, a leading
character that is not a letter, digit, or underscore replaced by one, the
result cut to 48 characters, and a reserved device basename (`CON`, `PRN`,
`AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, in any case, alone or
followed by an extension) neutralised by replacing its first character
with an underscore; then `-` and the first 12 lowercase hex digits of the
SHA-256 of the original, untransformed id. It is the same contract as
session files without the extension. Every process reporting into one run
resolves the same directory from the same `runId`, two runs never share
one, and the name contains nothing a path or a platform could use: it has
no separator, never starts with a dot or a dash, never ends with a dot or
a space, and is never a device name, so a hostile-looking but valid
identifier still lands below `runs` on every filesystem. The directory is
a locator only: the `runId` inside the events is authoritative and is
never read back from the name. Both SDKs compute the name
(`RunDirectories` in Java, `resolveRunDirectory` in TypeScript) from the
shared corpus under
[`fixtures/naming/`](fixtures/naming/run-directories.json).

A session file is named from its `sessionId` by the same contract, with
`.ndjson` appended. The suffix keeps names unique when sanitisation
collides, the sanitiser leaves nothing a path could use, and the file name
is never authoritative: the events inside it carry the `sessionId`. A file holds
exactly one session. Producers create their file exclusively, so a second
process reusing a sessionId fails at open instead of interleaving; a
restarted producer uses a new sessionId. No process ever appends to a file
it did not create, and no adapter has to merge files afterwards: a
consumer reads the directory as it is.

Attachment bytes are written to a uniquely named temporary file, hashed,
and published under the hash by rename. Two producers, in threads or in
processes, publishing the same bytes at the same time both succeed; a
publication that finds the hash already present with the same size is
complete. A failed publication leaves no file behind.

### Archives

An archive is just bytes to this protocol. Events never inline archive
contents, and no consumer unpacks an archive or treats it as files and
directories: a Playwright trace is stored, hashed, sized, and downloaded
unchanged, exactly like a screenshot, subject to the same media-type
policy an ingestion point applies to any binary attachment. Whether such
an attachment is ever viewed rather than downloaded is a decision for an
isolated viewer that does not exist yet. The prohibition in the ecosystem
security baseline is on archive extraction and on accepting archives as
transport containers, not on storing opaque bytes.

## Redaction

Producers redact before serialising. Both SDKs apply the same built-in
rules, checked against [`fixtures/redaction/cases.json`](fixtures/redaction/cases.json):
sensitive headers (`Authorization`, `Proxy-Authorization`, `Cookie`,
`Set-Cookie`, API-key and auth-token headers), password-style keys in
`key: value` and `key=value` text, bearer tokens, JWTs, private-key
blocks, credentials in URLs, and well-known cloud and platform token
formats. Free-text fields of every event are redacted; identifiers,
statuses, media types, hashes, kinds, and versions are not. Environment
variables are captured by allowlist only.

Only text is redacted. Bytes of a binary attachment (screenshot, video,
trace) are stored as given; a producer capturing such content is
responsible for what it contains.

## Compatibility

The compatibility unit before 1.0 is `0.minor`: a consumer of line 0.3
reads any `0.3.x` and rejects everything else, including the unpublished
lines 0.1 and 0.2, as an unsupported protocol version. From 1.0 the unit
is the major. Lines 0.1 and 0.2 exist in the repository history only;
nothing was ever published from them, so there is no migration path, no
parallel runtime support, and no dual schema to maintain. Line 0.3 is a
new line rather than a 0.2 minor because a 0.2 consumer that ignored the
session outcome would derive a passed run from a failed one.

Within a supported line:

- Unknown properties on any object are ignored. A producer never requires a
  new property; the schema does not forbid additional properties anywhere.
- A new event type may be added in a minor only if an older consumer can
  skip it without misreading existing events or state. Such an event is
  sent with `ignorable: true`. An unknown event type without that flag is
  an error (`UNSUPPORTED_EVENT_TYPE`), never silently skipped.
- An event type whose interpretation is needed to derive run, attempt, or
  test state cannot be added in a minor; adding it is a new line.
- A known event type is validated in full whether or not it is marked
  ignorable.

The schema `$id` is
`https://yannisyoussef.github.io/qe-report/schema/0.3/event.schema.json`.
It identifies the compatibility line; consumers ship the schema and do not
fetch it, and the URL is not yet served.

## Limits

Enforced by the schema unless noted:

| Limit | Value |
|---|---|
| Identifier | 1 to 128 printable ASCII characters, no spaces |
| `displayName`, path segment name, step name | 1024 characters |
| Path depth | 32 segments |
| Tags | 64, each 128 characters |
| Labels and environment | 64 entries, keys 64 and values 1024 characters |
| `failures` | 32 per finishing event |
| `failures[].message` | 65536 characters |
| `failures[].stackTrace` | 262144 characters |
| `attemptNumber` | 1 to 1000 |
| Serialised event (SDK and validator, not schema) | 1 MiB including the newline |
| Attachment bytes (file sink default; a text file is read no further than this before being refused) | 64 MiB |

Producers drop an oversized event and report the problem; they never
truncate silently.

## Validating a run

The validator is the TypeScript package
[`../ts/packages/validator`](../ts/packages/validator): Node starts fast,
`npx` distributes it without a JVM, and it uses the same mature JSON Schema
implementation as the TypeScript binding's tests. The Java binding is
checked against the same corpus with an independent validator.

```
qe-report-validate <run directory | events file> [--attachments <dir>] [--require-complete] [--json]
```

A run directory is validated as a whole: every `events/*.ndjson` file as
one session, then the run-level rules (one `runId`, unique event and
session ids, at most one `run.finished`, every session finished when the
run is closed, one attempt per attempt number and one history identity
and runner family per execution) and the bytes under `attachments/`.
The run directory given is the trusted entry point; below it, `events`
must be a real directory and every event file and declared attachment a
regular file, so a symbolic link or special entry is reported and never
opened. The argument is one run
directory, `<output root>/runs/<run directory>`, not the output root;
discovering the runs below a root is the read model's job, not the
validator's. A single session file
can be validated on its own; attachment bytes are then looked up in the
`attachments` directory of its run unless `--attachments` names another. A
declared attachment that is not there is reported as missing.

Diagnostics name the file and line, the event id when known, a code, and
for schema problems a JSON pointer. Codes: `MALFORMED_JSON`,
`SCHEMA_INVALID`, `UNSUPPORTED_PROTOCOL_VERSION`, `UNSUPPORTED_EVENT_TYPE`,
`EVENT_TOO_LARGE`, `LIFECYCLE_INVALID` (with a detail such as
`DUPLICATE_ATTEMPT_FINISHED`, `SESSION_ALREADY_FINISHED`,
`DUPLICATE_RUN_FINISHED`, `SESSION_FILE_MIXED`, `SEQUENCE_GAP`,
`DUPLICATE_ATTEMPT_NUMBER`, `HISTORICAL_IDENTITY_CHANGED`, or
`EXECUTION_RUNNER_CHANGED`),
`ATTACHMENT_MISSING`, `ATTACHMENT_SIZE_MISMATCH`, `ATTACHMENT_HASH_MISMATCH`,
`UNSAFE_FILESYSTEM_ENTRY`; and the informational `IGNORED_EVENT_TYPE`, `DUPLICATE_EVENT`, and
`INCOMPLETE_RUN`. Exit status is 0 for a valid run, 1 for an invalid one,
2 for usage or I/O errors.

The summary reports the derived run verdict as defined above, together
with the counts it rests on: attempts, attempts that finished `failed`,
scope failures, sessions whose status is `failed` or `inconclusive`, and
session failures. Scope and session failures are counted on their own and
never become failed attempts.

## Fixture corpus

[`fixtures/manifest.json`](fixtures/manifest.json) lists every fixture and
what a conforming implementation must do with it: valid events that must
round-trip, invalid events with the expected reason and pointer, and whole
runs with their expected outcome, completeness, and counts. Three runs are
derived from the JUnit, Playwright, and Karate probes, with values
sanitised and timestamps fixed. Others cover forked producers without a
coordinator, a coordinator that closes the run, scope failures after all
tests passed, after a test failed, and several in one session, a crashed
producer, an identical duplicate, an ignorable unknown event, a newer patch
version, the unpublished 0.1 and 0.2 lines, session outcomes (a failed,
inconclusive, or passed session over attempts that say otherwise, a flaky
test with and without a failing invocation policy, an invocation-level
setup failure with no attempt, an inconclusive final attempt with and
without a passed session), a retry across two sessions of one runner
family from two producers, two run ids in one directory, each execution
rule (a reused attempt number, a changed, appeared, or destabilised
history identity, a changed or missing runner between sessions), and each
lifecycle, session-file, and attachment violation. `naming/` holds the
run-directory naming corpus.

## Conceptual mappings (not executed)

These are thought experiments against documented runner concepts, written
to check that the model does not assume JUnit or Playwright. No adapter
exists for either; nothing here is a compatibility claim.

**pytest.** A session is one `pytest` process (`pytest-xdist` workers are
separate sessions on one `runId`). The test path is `file`, then `group`
for each class; parametrised ids (`test_x[1-a]`) are the `displayName`
with `historicalIdStability: "uncertain"` when ids are auto-generated and
`stable` when the author gave explicit ids. `nodeid` serves as
`executionId`. Outcomes map directly: `passed`, `failed`, `skipped`;
`xfail` is `failed` with `expectedStatus: "failed"`, `xpass` is `passed`
with `expectedStatus: "failed"`. A function-scoped fixture error in setup is
`failures[].phase: "setup"`; a teardown error is `"teardown"` on an
attempt that may otherwise have passed, which is how pytest reports it. A
module- or class-scoped fixture that errors in teardown after its tests
ran is a `scope.failed` with the module or class as its path.
`pytest-rerunfailures` retries are further attempts. Captured stdout and
log records become text attachments.

**Cypress.** A session is one `cypress run` process; parallel runs on
Cypress Cloud are sessions on one `runId`. The path is `file`, then
`group` for each `describe`. `it` titles are the `displayName`; Cypress
has no stable test id, so `historicalId` is the joined title path with
`uncertain` stability. Retries (`retries` config) are attempts, and the
per-attempt screenshots and the spec video are attachments. `it.skip`
and `this.skip()` are `skipped`; a `beforeEach` failure marks the test
and, by Cypress semantics, the remaining tests of the suite, each with
`phase: "setup"`; an `after` hook failure of a suite or spec is a
`scope.failed` for that suite or spec. Command log entries could be steps with `kind`
`"command"`; that is a choice for an adapter, not a protocol change.

Neither mapping needs anything beyond the 0.3 event set, which is the check
the exercise was for.
