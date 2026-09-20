# qe-report

A runner-agnostic test reporting protocol, with a Java and a TypeScript
binding, producer SDKs, and a validator. Part of the
[QE ecosystem](https://github.com/yannisyoussef/qe-ecosystem); the
ecosystem architecture and decision records apply here.

Status: protocol compatibility line 0.3 is defined and implemented in both
languages; a JUnit Platform adapter produces it from real Gradle and Maven
builds, and a Playwright Test reporter from real Playwright runs; an
in-memory read model projects validated runs into runs, test histories,
and flakiness, a PostgreSQL store archives complete validated runs as
their original protocol source for replay through that read model, and a
content-addressed blob store on the local filesystem keeps their
attachment bytes durable under the SHA-256 the events declare, with
explicit run expiry and bounded maintenance that deletes expired runs and
reclaims bytes no run anywhere still references. Rebuildable PostgreSQL
indexes answer run listings, exact test history, and flakiness without
replaying every archived run, while one run is still reconstructed from
its own stored source. An authenticated HTTP API (version 1) over those
same operations takes runs as streamed multipart uploads and answers
runs, histories, flakiness, and attachment downloads, with the project
decided by a project-scoped API key alone. No user accounts, no UI, and
no reporting server beyond that API exist yet. Nothing is published.

## What is here

| Path | Contents |
|---|---|
| [`protocol/`](protocol/README.md) | The protocol: JSON Schema (source of truth), fixture corpus, redaction cases, documentation. |
| [`java/`](java/) | Gradle build. `protocol` (model and codec), `sdk` (session writer, file sink, redaction), and [`junit-platform`](java/junit-platform/README.md) (a `TestExecutionListener` discovered through ServiceLoader). Library bytecode targets Java 17. |
| [`java/consumer-fixtures/`](java/consumer-fixtures/README.md) | Gradle and Maven Surefire projects that consume the adapter as a published artifact; run by the adapter's tests, not part of the build. |
| [`ts/`](ts/) | pnpm workspace. `protocol` (types and codec), `sdk` (session writer, file sink, redaction), `validator` (library and `qe-report-validate` CLI), [`playwright`](ts/packages/playwright/README.md) (a Playwright Test reporter), [`read-model`](ts/packages/read-model/README.md) (validation-first projection of run directories into runs, histories, and flakiness), [`postgres`](ts/packages/postgres/README.md) (durable archive of complete validated runs in PostgreSQL, replayed through the read model, with retention and rebuildable query indexes; tested with Testcontainers), [`blob-fs`](ts/packages/blob-fs/README.md) (immutable content-addressed attachment bytes on the local filesystem, keyed by SHA-256, with an operator-level maintenance surface), [`http-api`](ts/packages/http-api/README.md) (authenticated HTTP API v1 on Fastify over the store and the query indexes, with project-scoped API keys, an operator CLI, and the [OpenAPI contract](openapi/qe-report-api-v1.json)), and a test-only `equivalence` harness. Node 22 or newer. |
| [`ts/consumer-fixtures/`](ts/consumer-fixtures/playwright/README.md) | A Playwright project that consumes the reporter as a package; run by the reporter's consumer tests, not part of the build. |

Read [`protocol/README.md`](protocol/README.md) first: it explains the
run, session, attempt, step, and attachment model, the status set, the two
test identities, and the compatibility rules.

## Building

Java (JDK 25 is provisioned by the toolchain resolver; the wrapper pins
Gradle):

```bash
cd java && ./gradlew check
```

TypeScript (Node 24 and pnpm 12; `corepack enable` provides pnpm):

```bash
cd ts && pnpm install && pnpm check
```

Cross-language equivalence, after both builds:

```bash
cd java && ./gradlew :sdk:equivalenceOutput && cd ../ts && pnpm test:equivalence
```

The check replays the fixture runs and a scripted session through both
SDKs and compares the results after a test-only canonicalization: same
schema validity, same parsed values in the same order, identical
attachment hashes and bytes. Byte-identical JSON is not a protocol
requirement.

## Using the SDKs

Java:

```java
try (ReportSession session =
    ReportSession.builder("run-42", "jvm-1", FileSink.open(Path.of("build/qe-report"), "jvm-1"))
        .start(SessionStarted.of(new Component("my-adapter", "0.1.0")))) {
  session.emit(new AttemptStarted("a-1", 1, testCase));
  session.attach("a-1", null, "log", "text/plain", logBytes);
  session.emit(AttemptFinished.of("a-1", Status.PASSED));
}
```

TypeScript:

```ts
const session = ReportSession.start(
  { runId: 'run-42', sessionId: 'worker-1', sink: FileSink.open('qe-report', 'worker-1') },
  { producer: { name: 'my-adapter', version: '0.1.0' } },
);
session.emit({ eventType: 'attempt.started', payload: { attemptId: 'a-1', attemptNumber: 1, test } });
session.attach({ attemptId: 'a-1', name: 'log', mediaType: 'text/plain' }, logBytes);
session.emit({ eventType: 'attempt.finished', payload: { attemptId: 'a-1', status: 'passed' } });
session.close();
```

Both fill the envelope, redact free text and textual attachments before
anything is written, drop and report an oversized event, and never throw
into the test being reported. Each session writes its own file under
`events/` in the run directory, so forked or parallel producers share one
run without sharing a file; attachments are stored once under their hash.

Validate what was written:

```bash
node ts/packages/validator/dist/cli.js build/qe-report --require-complete
```

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).
Licensed under [Apache-2.0](LICENSE).
