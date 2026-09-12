# qe-report JUnit Platform adapter

A `TestExecutionListener` that reports a JUnit Platform execution as one qe-report session per
test plan. It observes the platform, not only Jupiter: JUnit 4 tests through the Vintage engine
and any other engine in the same plan are reported too. Nothing in the tests changes: no base
class, no annotation, no registration code.

## Installation

Coordinates: `io.github.yannisyoussef:qe-report-junit-platform` (Maven), package
`io.github.yannisyoussef.qe.report.junitplatform`. The artifact is not published yet; the
consumer fixtures under `../consumer-fixtures` resolve it from a build-local repository and are
the reference for how a build consumes it.

Gradle:

```kotlin
dependencies {
    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("io.github.yannisyoussef:qe-report-junit-platform:0.1.0")
}
```

Maven Surefire: the same artifact in `test` scope. Surefire supplies the launcher.

The adapter depends on the qe-report Java SDK and, at compile time only, on
`junit-platform-launcher`; the launcher on the consumer's test runtime is the one it runs with.
There is no other dependency.

## Discovery

The listener is registered in `META-INF/services/org.junit.platform.launcher.TestExecutionListener`.
Every launcher created with automatic listener registration on, which is what Gradle, Surefire,
and `LauncherFactory.create()` do, instantiates it. A launcher built with
`LauncherConfig.enableTestExecutionListenerAutoRegistration(false)` does not, and a build can
switch it off with JUnit's own configuration parameter
`junit.platform.execution.listeners.deactivate`.

## Configuration

Four settings. A system property wins over an environment variable, which wins over the default.
Properties are set per JVM by the build tool; variables are inherited by every fork.

| System property       | Environment variable   | Default                                             |
| --------------------- | ---------------------- | --------------------------------------------------- |
| `qe.report.enabled`   | `QE_REPORT_ENABLED`    | `true`                                              |
| `qe.report.dir`       | `QE_REPORT_DIR`        | output root `qe-report` under the working directory |
| `qe.report.runId`     | `QE_REPORT_RUN_ID`     | generated; this JVM becomes a run of its own        |
| `qe.report.sessionId` | `QE_REPORT_SESSION_ID` | generated from the process id and random bytes      |

A run id and a session id are identifiers in the protocol sense: printable ASCII, no spaces, at
most 128 characters. An invalid value, or an unrecognised `qe.report.enabled` value, is reported
once on standard error and replaced by the default.

Forked builds (Gradle `maxParallelForks`, Surefire `forkCount`) work without coordination: give
every fork the same `qe.report.dir` and `qe.report.runId`, and each JVM resolves the same run
directory below the output root and writes its own session file into it. Without a run id,
each fork is a separate run in a run directory of its own; no directory ever holds two runs. A
session id should not be configured for forked builds unless each fork gets its own; a reused
session id fails at start, because a session file is created exclusively.

## Output

The output root holds one run directory per run, `<root>/runs/<run directory>`, named from the
run id by the SDK's contract; inside it lies the SDK's file layout, `events/<session
file>.ndjson` per session and `attachments/<sha256>`. The start-up line on standard error
names the resolved run directory. One JUnit test plan is one session. Gradle and Surefire run
one plan per fork, so a fork is a session. No fork emits `run.finished`: a worker cannot know
that every other worker has finished, and a run consisting of finished sessions without
`run.finished` is complete and open by protocol definition. The adapter writes protocol line
0.3 with an empty `session.finished` payload, because a forked JVM knows nothing of the
build's aggregate verdict; a run in which a container failed carries `scope.failed`. Validate
a run with the qe-report validator:

```
qe-report-validate build/qe-report/runs/<run directory> --require-complete
```

## What is reported

| JUnit                                                                                                                               | Protocol                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.started`                                                                                                                   | producer `qe-report-junit-platform` with the adapter version; runner `junit-platform` with the launcher's implementation version; environment `java.version` only                                                                                                                                     |
| Test started and finished                                                                                                           | `attempt.started`, `attempt.finished`; `attemptNumber` 1, or n for the n-th execution of the same unique id in one plan                                                                                                                                                                               |
| `SUCCESSFUL`, `FAILED`                                                                                                              | `passed`, `failed`, with `rawStatus`                                                                                                                                                                                                                                                                  |
| `ABORTED` (assumption)                                                                                                              | `skipped`, `rawStatus: ABORTED`, the assumption message in `failures[0]`                                                                                                                                                                                                                              |
| Skipped test (`@Disabled`, `@Ignore`)                                                                                               | a synthesised `attempt.started` and `attempt.finished` with `skipped`, `rawStatus: SKIPPED`, the reason in `failures[0].message`, no duration                                                                                                                                                         |
| Skipped container                                                                                                                   | every planned test below it reported as skipped with the container's reason, so the count of planned tests stays honest                                                                                                                                                                               |
| Container failed before any test started (`@BeforeAll`)                                                                             | every planned test below it reported as `failed` with the container's failure and `phase: setup`, no duration                                                                                                                                                                                         |
| Container failed after its tests ran or were skipped (`@AfterAll`), or a container with no planned test (a throwing `@TestFactory`) | one `scope.failed` for the container: `path` is its own position in the hierarchy (a prefix of every test path below it), `displayName`, `rawStatus: FAILED`, and the failure with its inferred phase, `teardown` for `@AfterAll`; the tests below keep their own verdicts and no attempt is invented |
| Failure                                                                                                                             | `message`, `type` (exception class), `stackTrace` (JUnit-pruned, bounded to 64 KiB with a visible marker), `phase`                                                                                                                                                                                    |
| `TestReporter` entry on a test                                                                                                      | a `text/plain` attachment named `junit-report-entry`, one `key: value` line per entry plus its timestamp, redacted like every text attachment                                                                                                                                                         |
| `TestReporter` entry on a container                                                                                                 | not recorded; reported once on standard error                                                                                                                                                                                                                                                         |
| Tags                                                                                                                                | `tags`                                                                                                                                                                                                                                                                                                |
| Duration                                                                                                                            | measured by the adapter with a monotonic clock between the start and finish callbacks; JUnit reports none                                                                                                                                                                                             |

`phase` is inferred from the throw site, not from the exception class: JUnit prunes its own
frames, so the top frame is the user's method, and its Jupiter annotation (`@BeforeEach`,
`@AfterEach`, `@BeforeAll`, `@AfterAll`, `@Test` and the template annotations) or the callback
interface of a throwing extension decides `setup`, `teardown`, or `test`. Where nothing decides,
no phase is written, and a scope failure never carries `test`, which means nothing at a scope.

### Path and identity

The test path is the JUnit hierarchy above the test, outermost first, and the path of a
`scope.failed` is the same hierarchy ending with the failed container itself: the engine as an
`engine` segment (`junit-jupiter`, `junit-vintage`), classes and nested classes as `class`
segments with their binary names (`Outer$Inner`), and templates, factories, dynamic containers,
and runners as `group` segments. JUnit provides no file or line for class and method sources, so
`location` is absent for them; file and classpath-resource sources become a location.

`executionId` is a hash of the unique id (unique ids exceed the identifier length). The unique
id itself, the engine, and the last segment type are kept in labels `junit.uniqueId`,
`junit.engine`, and `junit.segmentType`.

`historicalId` is derived by these rules, in order, and always prefixed with the engine id so
that two engines in one plan cannot collide:

1. any `dynamic-test` or `dynamic-container` segment: no identity, `unavailable`;
2. a `test-template-invocation` (parameterized, repeated): `engine:Class#method(types)[#n]`,
   `uncertain`, because the segment is an index;
3. a method source: `engine:Class#method(parameterTypes)`, `stable`;
4. a class source: `engine:Class`, `stable`;
5. a file or classpath resource source: the resource and its line, `uncertain`;
6. otherwise the unique id without its engine segment, `uncertain`.

Consumers key history by `(runner.name, historicalId)`, so a mixed-engine plan keeps one session
runner, `junit-platform`, and still separates engines.

## Tested versions

The adapter compiles against JUnit Platform 1.10.5 and runs its launcher tests on each line
below; a version outside this list is unsupported until CI proves it.

| JUnit Platform | Jupiter | JDK        |
| -------------- | ------- | ---------- |
| 1.10.5         | 5.10.5  | 17         |
| 1.13.4         | 5.13.4  | 21         |
| 6.0.3          | 6.0.3   | 25         |
| 6.1.3          | 6.1.3   | 17, 21, 25 |

The consumer fixtures run Gradle 9.7 with `maxParallelForks` and `forkEvery`, and Maven Surefire
3.6 with `forkCount` and `reuseForks=false`, both on JUnit 6.1.3, and their run directories are
validated with the protocol validator in CI, which derives the run verdict `failed` from their
one failing test and one `@AfterAll` failure.

## Failure isolation

Reporting never changes a test result and never throws into the launcher. If the run directory
cannot be created, the session file already exists, or the session cannot start, one line is
printed and the plan runs unreported. A sink or attachment failure during the run is printed once
per distinct problem and the affected event or attachment is dropped. An internal error in a
callback is contained the same way.

## Limitations

- When `@BeforeAll` and `@AfterAll` both fail, JUnit delivers one container result whose
  throwable is the set-up one, so the set-up rule applies and the teardown failure is only
  visible as a suppressed exception in that stack trace.
- The skip reason of a skipped test travels in `failures[0].message`, as the protocol corpus does.
- Report entries published on a container are not recorded.
- Durations are measured by the adapter, not reported by JUnit.
- Third-party retry extensions are not modelled; a repeated execution of the same unique id in
  one plan is numbered as a further attempt.
