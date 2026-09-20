# qe-report-http-client

Delivers a completed run directory to a qe-report service over
[API v1](../http-api/README.md). It is a run uploader, not a reporting sink: a producer writes
its events locally through the SDK's file sink, and that finished directory is what is
delivered. Private; nothing is published.

```
runner or adapter  ->  FileSink  ->  completed run directory  ->  uploader  ->  POST /v1/runs
```

The directory it reads may come from anywhere: the Playwright reporter, the JUnit Platform
adapter, either SDK, or an adapter that does not exist yet. There is no runner-specific upload.

## Why a directory and not an event sink

API v1 archives a whole run, once, immutably. A single session cannot tell when a run is
finished: JUnit forks, Playwright shards, and two processes sharing a run id all contribute to
one run, and an event-by-event sink would have to decide, event by event, that nothing more is
coming. So the local directory stays the producer's spool: it is complete before anything is
sent, it can be uploaded again from another process or another day, and it is never deleted
here.

## Using it

```ts
import { QeReportHttpClient, expiryAfter } from 'qe-report-http-client';

const client = new QeReportHttpClient({
  baseUrl: 'https://reports.example.com',
  apiKey: process.env.QE_REPORT_API_KEY ?? '',
});

const result = await client.uploadRunDirectory({
  runDirectory: 'qe-report/runs/run-42-1f2e3d4c5b6a',
  expiresAt: expiryAfter(30 * 24 * 60 * 60 * 1000), // decide the deadline once, here
});
// { outcome: 'inserted' | 'already_present', runId, runRef, ingestionSequence, requestId, attempts }
```

There is no `projectId`: the key was issued for one project, and that is the project the run is
archived into. There is no read API here either; this package uploads.

## The command

```bash
export QE_REPORT_API_KEY=qer_k1_...        # never an argument: arguments are visible to every process
export QE_REPORT_URL=https://reports.example.com

qe-report-upload --run-dir qe-report/runs/run-42-1f2e3d4c5b6a --retention-ms 2592000000
qe-report-upload --run-dir ... --expires-at 2027-01-01T00:00:00Z --json
```

| Option                                   | Meaning                                                             |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `--run-dir`                              | The completed run directory. Required.                              |
| `--url`                                  | The service; `QE_REPORT_URL` otherwise.                             |
| `--expires-at` / `--retention-ms`        | Exactly one. There is no default retention.                         |
| `--max-attempts`, `--attempt-timeout-ms` | Bounds for this upload.                                             |
| `--allow-insecure-http`                  | Plaintext to a host that is not this machine, for development only. |
| `--json`                                 | One JSON line instead of one sentence.                              |

| Exit | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 0    | Archived, or already there. Both are successful uploads.                        |
| 2    | Usage, configuration, or a local run directory that cannot be uploaded.         |
| 3    | The service refused the run: a conflict, an invalid run, a credential, a limit. |
| 4    | Not delivered: the attempts ran out, or the upload was cancelled.               |

## From a JUnit or Gradle build

The JUnit Platform adapter never uploads by itself: it may run in Gradle or Surefire forks, in
several JVMs, and under a configured run id shared by all of them, so no worker can know that
no other session is still to come. The build coordinator uploads the finished directory
instead, once the build is over:

```bash
./gradlew test                      # the adapter writes build/qe-report/runs/<run directory>
export QE_REPORT_API_KEY=qer_k1_...
qe-report-upload \
  --run-dir build/qe-report/runs/run-gradle-consumer-1f2e3d4c5b6a \
  --url https://reports.example.com \
  --retention-ms 2592000000
```

No Java code speaks HTTP: the run directory is the same shape whichever language wrote it.

## What is read, and what is refused

Only `events/` and `attachments/` of the directory given, and only their direct children:

- every `events/*.ndjson`, byte for byte, in code-unit order. Nothing is parsed, split, merged,
  reordered, or re-serialised, and no run id is read out of it. The order is for a stable
  request, not chronology; the service reads the events for that.
- every `attachments/<64 lower-case hex>`, in hash order. Other names, the SDK's `.tmp-` files
  included, are passed over. An attachment whose bytes are not the hash its name claims fails
  the upload: a broken producer directory is not turned into a different, valid remote run.

Nothing is opened through a symbolic link: entries are inspected without following links, opened
with `O_NOFOLLOW` where the platform has it, and the open descriptor is checked again before a
byte is read. A link where a run file belongs stops the upload before anything is sent.

The run directory is expected to be complete and unchanging while it uploads. One plan is made
before the first attempt, and every attempt re-opens exactly those files and checks size, mtime,
device and inode before and after streaming. A directory that changes ends the upload with a
`RUN_DIRECTORY_CHANGED` error rather than sending half of one run and half of another.

Nothing is buffered whole: parts stream, and the request's length is known in advance because
the plan holds every size.

## Retention

Every upload states when retention may delete the run, and there is no default. Pass an absolute
`Date`, or turn a duration into one with `expiryAfter(ms)`. The instant is decided once, before
the first attempt, so a retry never offers a slightly later deadline than the attempt before it.
`Date.toISOString()` is exactly the operational instant the service takes.

## Retries

`POST /v1/runs` is idempotent for the same run, so an upload whose answer was lost can be sent
again: the service answers `already_present` and the run is archived once. That is the only
reason retries exist here.

Retried: a connection that failed or was reset, an attempt that timed out, a response that ended
early or that this client cannot read, and the statuses `408`, `425`, `429`, `500`, `502`,
`503`, `504`.

Never retried, because asking again would only be refused again: `400`, `401`, `403`, `409`,
`413`, `415`, `422`. A `409 RUN_CONFLICT` means another run is already archived under that run id
in that project. A `3xx` is not followed at all: a redirect could carry the key to another host.

Four attempts by default, with a doubling delay and full jitter, bounded. A `Retry-After` is
honoured when it is whole seconds or an HTTP-date, and never beyond the client's own maximum: a
service cannot make a producer wait indefinitely. Each attempt has a finite timeout, ten minutes
by default, because an attachment may be 64 MiB. An `AbortSignal` ends the current attempt, the
wait before the next one, and any attempt after that.

## The key, and where uploads may go

The key is a secret: it is never logged, never put in an error message or a `toString`, never
serialised, and never returned. It travels in the `Authorization` header and nowhere else.

The base URL is checked before anything is sent: no user name or password in the URL, no
fragment, no query string, `http` or `https` only. Plaintext is allowed to this machine
(`localhost`, `127.0.0.0/8`, `[::1]`) for a development service; anywhere else it is refused
unless `allowInsecureHttp` is set deliberately. TLS verification is never disabled, and there is
no option to disable it. A deployment path prefix is kept: `https://example.com/qe-report/`
uploads to `https://example.com/qe-report/v1/runs`.

## Errors

| Error                    | Meaning                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalRunDirectoryError` | The producer's directory cannot be uploaded: an unsafe entry, no events, an attachment that is not its hash, or a directory that changed. Nothing was archived. |
| `UploadRejectedError`    | The service refused the run. Carries the status, the problem code, the request id, the run id, and the validator's diagnostics for a `422`.                     |
| `UploadTransportError`   | Not delivered: the attempts ran out. Carries how many were made and the last status, if there was one.                                                          |
| `UploadAborted`          | The caller cancelled.                                                                                                                                           |

Every error carries the service's `X-Request-Id` where there was one, so an upload can be found
in the service's log.

## What it does not do

It does not delete the producer's output, keep a queue, watch a directory, run in the
background, or validate the protocol: the service is the authority on what a run means, and a
`422` is its answer. It reads no run data beyond the bytes it sends.
