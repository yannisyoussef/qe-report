# qe-report protocol

A language-neutral description of a test run as a sequence of events, for
reporting from any runner. Compatibility line 0.1; the schema in
[`schema/event.schema.json`](schema/event.schema.json) is the source of
truth, and the fixtures in [`fixtures/`](fixtures/) are its executable
specification. Both the Java and TypeScript bindings in this repository are
checked against them.

The design was derived from the observed behaviour of three runners: JUnit
Platform 6 (`TestExecutionListener`), Playwright 1.63 (`Reporter`), and
Karate 1.5 (`RuntimeHook`). Where a concept exists because of what those
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

A run is a newline-delimited sequence of JSON events. A file of events and
a live stream are the same format. Several sessions can contribute to one
run: Playwright shards, forked JVMs, and parallel CI jobs each open a
session against a shared `runId`.

## Envelope

Every event carries:

| Field | Meaning |
|---|---|
| `protocolVersion` | Full Semantic Version written by the producer, for example `0.1.0`. |
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
| `session.finished` | The process will emit nothing further. | empty |
| `run.finished` | Only from a producer that knows every session has finished. Nothing for the run is valid after it. | empty |
| `attempt.started` | A test case execution begins. | `attemptId`, `attemptNumber` (1 for the first execution, 2 for the first retry), `test`. |
| `attempt.finished` | It ends. | `attemptId`, `status`, `rawStatus`, `expectedStatus`, `durationMs`, `failures`. |
| `step.started` | A named unit inside an attempt begins. | `stepId`, `attemptId`, `parentStepId`, `name`, `kind`, `location`. |
| `step.finished` | It ends. | `stepId`, `attemptId`, `status`, `rawStatus`, `durationMs`, `failures`. |
| `attachment.added` | Bytes were stored for an attempt or step. | `attemptId`, `stepId`, `name`, `mediaType`, `sizeBytes`, `sha256`. |

There is no `run.started`: run-level facts (environment, CI context, source
revision) live on `session.started`, because a forked JVM or a shard knows
them and no coordinator has to. Failures are embedded in the finishing
events rather than emitted separately, because every runner observed
delivers the error together with the end of the test or step.

### Ordering and completeness

- Within a session, `session.started` comes first and `sequence` increases
  by exactly one per event. Across sessions there is no order.
- An attempt's `attempt.started` precedes its steps, attachments, and
  `attempt.finished`. A step finishes before its attempt does. Attachments
  precede `attempt.finished`: all three runners have every attachment
  available when they report the end of a test, so nothing arrives late.
- `session.finished` requires every attempt of the session to be finished.
  `run.finished` requires every session in the same stream to be finished.
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
- `historicalId` links the same logical test across runs. The adapter
  derives it and says how far to trust it in `historicalIdStability`:
  `stable` (survives unrelated edits), `uncertain` (built from indexes or
  line numbers, as Karate outline examples and JUnit parameterized
  invocations are), or `unavailable` (no identity can be given, as for
  JUnit dynamic tests, whose ids are `#1`, `#2` in registration order).
  When unavailable, `historicalId` is absent. Derivation rules belong to
  each adapter and are not part of the protocol.

`path` is the runner's own container hierarchy, outermost first, as typed
segments. `file` and `group` are the well-known kinds. A runner-specific
kind such as Playwright's `project` is allowed; a consumer that does not
know a kind treats it like a group. `displayName` is the leaf. `location`
is a display string; a consumer never resolves it on disk.

## Status

`status` is one of four values. The runner's own word is kept in
`rawStatus` so a lossy mapping loses nothing for display.

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
attributed to every test in the file; JUnit reports a failed `@BeforeAll`
only on the class container and never starts the tests, so an adapter
synthesises a failed attempt with `phase: "setup"` for each planned test.
Karate background failures are step failures with `phase: "setup"`.

## Attachments

Bytes never travel inside events. `attachment.added` carries the display
name, media type, size, and lower-case hex SHA-256 of the bytes as stored,
after any producer-side redaction. The hash is integrity and deduplication
metadata: a file sink names the sidecar file by it, and a consumer verifies
it. Deduplication is per run in the file layout and per project on any
server; the hash is never a global lookup key.

The file layout of a run is:

```
<run directory>/
  events.ndjson
  attachments/<sha256>
```

No archives are accepted as attachments in this compatibility line.

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

The compatibility unit before 1.0 is `0.minor`: a consumer of line 0.1
reads any `0.1.x` and rejects everything else as an unsupported protocol
version. From 1.0 the unit is the major.

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
`https://yannisyoussef.github.io/qe-report/schema/0.1/event.schema.json`.
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
| Attachment bytes (file sink default) | 64 MiB |

Producers drop an oversized event and report the problem; they never
truncate silently.

## Validating a file

The validator is the TypeScript package
[`../ts/packages/validator`](../ts/packages/validator): Node starts fast,
`npx` distributes it without a JVM, and it uses the same mature JSON Schema
implementation as the TypeScript binding's tests. The Java binding is
checked against the same corpus with an independent validator.

```
qe-report-validate events.ndjson [--attachments <dir>] [--require-complete] [--json]
```

Attachment bytes are looked up next to the file in `attachments/` unless
`--attachments` names another directory; a declared attachment that is not
there is reported as missing. Diagnostics name the line, the event id when known, a code, and for
schema problems a JSON pointer. Codes: `MALFORMED_JSON`, `SCHEMA_INVALID`,
`UNSUPPORTED_PROTOCOL_VERSION`, `UNSUPPORTED_EVENT_TYPE`, `EVENT_TOO_LARGE`,
`LIFECYCLE_INVALID` (with a detail such as `DUPLICATE_ATTEMPT_FINISHED` or
`SEQUENCE_GAP`), `ATTACHMENT_MISSING`, `ATTACHMENT_SIZE_MISMATCH`,
`ATTACHMENT_HASH_MISMATCH`; and the informational `IGNORED_EVENT_TYPE`,
`DUPLICATE_EVENT`, and `INCOMPLETE_RUN`. Exit status is 0 for a valid
file, 1 for an invalid one, 2 for usage or I/O errors.

## Fixture corpus

[`fixtures/manifest.json`](fixtures/manifest.json) lists every fixture and
what a conforming implementation must do with it: valid events that must
round-trip, invalid events with the expected reason and pointer, and whole
runs with their expected outcome, completeness, and counts. Three runs are
derived from the JUnit, Playwright, and Karate probes, with values
sanitised and timestamps fixed. Others cover a crashed producer, an
identical duplicate, an ignorable unknown event, a newer patch version, and
each lifecycle and attachment violation.

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
with `expectedStatus: "failed"`. A fixture error in setup is
`failures[].phase: "setup"`; a teardown error is `"teardown"` on an
attempt that may otherwise have passed, which is how pytest reports it.
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
`phase: "setup"`. Command log entries could be steps with `kind`
`"command"`; that is a choice for an adapter, not a protocol change.

Neither mapping needed a new event, status, or field, which is the check
the exercise was for.
