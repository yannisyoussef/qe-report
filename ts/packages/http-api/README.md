# qe-report-http-api

The first network boundary of qe-report: an authenticated HTTP API, version 1, on
[Fastify](https://fastify.dev), over the durable run store and the query indexes of
[`qe-report-postgres`](../postgres/README.md). It is a transport. Every answer comes from the
existing store and query layer, and nothing here decides a verdict, a history, or what flakiness
means. Private; nothing is published.

```
CI or producer  ->  HTTPS (at the edge)  ->  API v1  ->  run store, query indexes, blob store
```

API version 1 is the transport's own version. It is independent of the protocol (0.3), the
database schema version, the query-index version, and the package version. The contract is
[`openapi/qe-report-api-v1.json`](../../../openapi/qe-report-api-v1.json), OpenAPI 3.1,
generated from the same route table the server registers and checked in CI to match it.

## Running it

The database must already be migrated: the server checks the schema at start and refuses to
serve one that is absent or not the one it was built for. Migrating is an explicit operator
action and never a side effect of a process starting.

```bash
export DATABASE_URL=postgres://qe:secret@db.internal:5432/qe
qe-report-admin migrate
qe-report-admin schema      # reports whether the schema is current, changing nothing

export QE_REPORT_BLOB_ROOT=/var/lib/qe-report/blobs
export QE_REPORT_STAGING_ROOT=/var/lib/qe-report/staging
qe-report-server
```

| Variable                 | Default     | Meaning                                                                                                                |
| ------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | required    | The PostgreSQL 16 database.                                                                                            |
| `QE_REPORT_BLOB_ROOT`    | required    | The durable attachment store.                                                                                          |
| `QE_REPORT_STAGING_ROOT` | required    | Where uploads are staged. A real directory, not a link, and apart from the blob root: neither may be inside the other. |
| `QE_REPORT_HOST`         | `127.0.0.1` | The address to bind. The server never binds a public interface unless told to.                                         |
| `QE_REPORT_PORT`         | `8080`      | The port.                                                                                                              |
| `QE_REPORT_LOG_LEVEL`    | `info`      | The log level.                                                                                                         |
| `QE_REPORT_MAX_*`        | see below   | The upload and body limits.                                                                                            |

**Bearer API keys must only travel over HTTPS. TLS is expected at the deployment or
reverse-proxy boundary**; the server itself speaks plain HTTP. It trusts no forwarded header,
installs no CORS handling, and sets no cookie. Connection and rate limiting belong at the same
edge: the server bounds every request itself, but it does not count requests.

`createQeReportApi({ runStore, queries, apiKeys, stagingRoot, blobRoot, checkDatabase, limits })`
builds the same server from injected parts, with no global state, for embedding and tests.

## API keys

A key belongs to exactly one project and carries `runs:read`, `runs:write`, or both. **The
project of every request is the key's**: no path, query parameter, header, multipart part,
body member, or protocol event names a project, and a `projectId` sent anywhere is refused or
ignored, never obeyed. A key is presented as `Authorization: Bearer <token>` and nowhere else.

Keys are managed by the operator command, never over HTTP:

```bash
qe-report-admin key create --project web --scope runs:write --scope runs:read --label "ci main"
# prints qer_k1_<publicId>_<secret> once, on standard output; it cannot be recovered
qe-report-admin key create --project web --scope runs:read --expires-at 2027-01-01T00:00:00Z
# --expires-at takes the same operational instant a run's expiresAt does
qe-report-admin key revoke --public-id <publicId>
```

Only the SHA-256 of a key's secret is stored. Revocation takes effect at once, and expiry is
judged by the database's clock. A key's project and scopes never change; rotation is issuing a
new key, deploying it, and revoking the old one.

A project id is opaque, well-formed Unicode without U+0000, 1 to 512 bytes of UTF-8, never
trimmed or normalised: the one contract the whole system shares.

| Operation                                                                                                                                   | Scope        |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `POST /v1/runs`                                                                                                                             | `runs:write` |
| `GET /v1/runs`, `GET /v1/runs/{runRef}`, `GET /v1/runs/{runRef}/attachments/{sha256}`, `POST /v1/history/query`, `POST /v1/flakiness/query` | `runs:read`  |
| `GET /healthz`, `GET /readyz`                                                                                                               | none         |

No key: `401` with `WWW-Authenticate: Bearer realm="qe-report"`, the same whether the key was
missing, malformed, unknown, wrong, expired, or revoked. A valid key without the scope: `403`.

## Uploading a run

A run is uploaded as `multipart/form-data`, streamed, never as an archive and never by naming a
server path:

| Part         | Kind                                                         | Count       |
| ------------ | ------------------------------------------------------------ | ----------- |
| `expiresAt`  | text: an operational instant (below)                         | exactly one |
| `events`     | file: one NDJSON protocol event stream, one session per part | one or more |
| `attachment` | file: attachment bytes                                       | any         |

```bash
curl --fail-with-body -H "Authorization: Bearer $QE_REPORT_TOKEN" \
  -F expiresAt=2026-12-31T00:00:00Z \
  -F events=@qe-report/runs/run-42/events/s-1-6a840baf5d8c.ndjson \
  -F events=@qe-report/runs/run-42/events/s-2-450222bcc347.ndjson \
  -F attachment=@qe-report/runs/run-42/attachments/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 \
  https://qe-report.example/v1/runs
```

### Operational instants

A lifecycle time a caller states, a run's `expiresAt` and a key's `--expires-at`, is an
**operational instant**: RFC 3339, an explicit `Z` or numeric offset, seconds `00` to `59`, and
at most three fractional digits.

```
2027-01-01T00:00:00Z   2027-01-01T00:00:00.123Z   2027-01-01T01:00:00+01:00
```

It is deliberately narrower than a protocol timestamp, and one parser applies it to both fields.
A protocol `occurredAt` may carry nanoseconds, which a millisecond deadline would truncate, and
a leap second, which the read model orders as an instant plus a place inside that second. Read
either as a deadline and the deadline moves earlier, so retention would delete a run before the
time its owner asked for. Both are refused with `400` instead, and nothing is archived. Protocol
timestamps are untouched: `occurredAt` keeps every form protocol 0.3 accepts, and history keeps
its leap-second order.

The server writes each part, byte for byte and in arrival order, into a fresh directory it
names itself, `<staging root>/<request id>/events/000001.ndjson` and so on. It never uses a
client filename, event id, run id, or attachment name as a path. Attachment bytes are hashed as
they stream and stored under the SHA-256 they have, whatever the part claims; whether an event
references them is the validator's question, and bytes nothing references never reach the
durable store. The directory then goes to the run store exactly as any run directory would,
under the logical locator `http:<request id>`, and is removed however the request ends. No
temporary path is stored, returned, or logged. Each `events` part is one session file, as a run
directory holds them; a part that mixes sessions is refused by the validator
(`SESSION_FILE_MIXED`).

| Result                                                                                             | Status                                                                             |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| archived now                                                                                       | `201`, `Location: /v1/runs/{runRef}`                                               |
| the same run was already archived (its index may have been repaired from the archive's own source) | `200`                                                                              |
| another run is archived under this run id in this project                                          | `409 RUN_CONFLICT`                                                                 |
| invalid, incomplete, or empty protocol source                                                      | `422 RUN_INVALID`, `RUN_INCOMPLETE`, `RUN_EMPTY`, with the validator's diagnostics |
| malformed multipart, a missing or repeated `expiresAt`, an unknown part                            | `400`                                                                              |
| a limit exceeded                                                                                   | `413`, and nothing written                                                         |
| not multipart                                                                                      | `415`                                                                              |

```json
{ "outcome": "inserted", "runId": "run-42", "runRef": "cnVuLTQy", "ingestionSequence": "1807" }
```

`ingestionSequence` is a decimal string: it is a PostgreSQL `bigint`. The expiry is taken from
the part and nothing else; a past instant is valid and makes the run eligible for retention at
once. A refused upload writes no run, no source line, no index row, no retention fact, and no
durable byte.

### Limits

| Limit                       | Variable                               | Default                                            |
| --------------------------- | -------------------------------------- | -------------------------------------------------- |
| request body                | `QE_REPORT_MAX_REQUEST_BYTES`          | 1 GiB                                              |
| `events` parts              | `QE_REPORT_MAX_EVENT_PARTS`            | 64                                                 |
| bytes across `events` parts | `QE_REPORT_MAX_EVENT_BYTES`            | 256 MiB                                            |
| `attachment` parts          | `QE_REPORT_MAX_ATTACHMENT_PARTS`       | 256                                                |
| bytes of one attachment     | `QE_REPORT_MAX_ATTACHMENT_BYTES`       | 64 MiB, and never more than the blob store accepts |
| bytes across attachments    | `QE_REPORT_MAX_TOTAL_ATTACHMENT_BYTES` | 512 MiB                                            |
| a JSON body                 | `QE_REPORT_MAX_JSON_BODY_BYTES`        | 64 KiB                                             |

Nothing is buffered whole: parts stream to disk with backpressure, and the body is counted as
it arrives, so a request without a length is stopped at the limit too. A client that abandons
an upload leaves no staging directory behind; a server killed outright can, and the staging
root is then for the operator to clear.

## Reading

### Run references

A run id may hold `/`, `?`, `#`, `%`, and other characters a path segment cannot carry, so a
run is addressed by its `runRef`: the unpadded base64url of its UTF-8 run id. `run-42` is
`cnVuLTQy`. It is a locator, not an identity or a secret; every response carries the run id
itself beside it, so no client needs to encode one. Padding, the standard alphabet, and any other
spelling are refused with `400`.

```bash
curl -H "Authorization: Bearer $QE_REPORT_TOKEN" 'https://qe-report.example/v1/runs?limit=50'
curl -H "Authorization: Bearer $QE_REPORT_TOKEN" https://qe-report.example/v1/runs/cnVuLTQy
```

`GET /v1/runs` lists the project's runs, newest archived first, from the query index, with an
opaque `nextCursor` while more remain. The order is the archive's, not producer time.
`GET /v1/runs/{runRef}` replays that one run from its archived source and returns its sessions,
executions, attempts, steps, scope failures, and attachment references. It works whether or
not the project's index is complete, and it carries no locator, fingerprint, archived line,
database identifier, or storage key.

### History and flakiness

Runner names and historical ids can be long, so both queries are read-only `POST`s with a JSON
body:

```bash
curl -H "Authorization: Bearer $QE_REPORT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"runnerName":"playwright","historicalId":"login.spec.ts::signs in","limit":100}' \
  https://qe-report.example/v1/history/query

curl -H "Authorization: Bearer $QE_REPORT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"runnerName":"playwright","historicalId":"login.spec.ts::signs in"}' \
  https://qe-report.example/v1/flakiness/query
```

A history page is in history order (producer timestamp position, then run id, then execution
id, exactly as the read model orders it) and ends with a `nextCursor` while more remain. The
flakiness answer is the durable summary: `totalOccurrences`, `flakyOccurrences`, `everFlaky`.
There is no score, rate, trend, or ranking.

Cursors are opaque base64url tokens. Each is bound to what it pages, the project and, for a
history, its runner name and historical id; a cursor handed to another listing, another
history, or another project's key is refused with `400`. There is no offset.

While the project's query index does not cover every archived run, the listing, history, and
flakiness answer `503 QUERY_INDEX_INCOMPLETE` with `totalRuns`, `missingRuns`, and `staleRuns`,
rather than part of an answer. Rebuilding is an operator action; no request triggers it. Reading
one run still works.

### Attachments

```bash
curl -H "Authorization: Bearer $QE_REPORT_TOKEN" -o report.bin \
  https://qe-report.example/v1/runs/cnVuLTQy/attachments/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

Bytes are only reachable through a run of the key's project that references them; there is no
download by hash alone. They stream as `application/octet-stream` with
`X-Content-Type-Options: nosniff` and a `Content-Disposition` naming the hash, whatever media
type the producer declared: a declared `text/html` or `image/svg+xml` is never served as active
content. The declared type is in the run's attachment references.

A run that is not in the key's project and a run that does not exist are the same `404`, and so
are a hash the run does not reference and a hash nothing references.

## Problems

Every error is `application/problem+json`:

```json
{
  "type": "urn:qe-report:problem:run-conflict",
  "title": "Run conflict",
  "status": 409,
  "code": "RUN_CONFLICT",
  "detail": "another run with different content is already archived under this run id in this project",
  "requestId": "4c0b3c8e-2e8e-4f4b-9d2c-7a61e3f0b5a1",
  "runId": "run-42"
}
```

| Code                                         | Status |
| -------------------------------------------- | ------ |
| `AUTHENTICATION_REQUIRED`                    | 401    |
| `FORBIDDEN`                                  | 403    |
| `BAD_REQUEST`                                | 400    |
| `NOT_FOUND`                                  | 404    |
| `RUN_CONFLICT`                               | 409    |
| `PAYLOAD_TOO_LARGE`                          | 413    |
| `UNSUPPORTED_MEDIA_TYPE`                     | 415    |
| `RUN_INVALID`, `RUN_INCOMPLETE`, `RUN_EMPTY` | 422    |
| `INTERNAL_ERROR`                             | 500    |
| `QUERY_INDEX_INCOMPLETE`, `NOT_READY`        | 503    |

An archive that fails its own integrity checks, such as a stored source that no longer replays or
bytes that no longer match their hash, is a server failure: the client sees a bare `500` with
its `requestId`, and the detail goes to the log.

Every response carries `X-Request-Id`, generated by the server; a request id a client sends is
not used. Every response is `Cache-Control: no-store`.

## Health

`GET /healthz` is liveness only. `GET /readyz` is `200` when PostgreSQL answers, the schema is
current, and both the blob and staging roots are usable, and `503 NOT_READY` with the reasons
otherwise, without paths or credentials. A project whose query index is incomplete does not make
the service unready.

## Logging

One structured line per request: request id, method, route pattern, status, duration, and the
public id of the key. No URL with a cursor or run reference, no header, no body, no event, no
byte of an attachment. Authorization and cookie headers are redacted wherever a dependency
logs them, and every line is scrubbed of anything shaped like a key and of staging paths before
it is written, at every level.

## What is not here

No users, organisations, sessions, cookies, OAuth, OIDC, or JWT; project-scoped keys are the
only principal, and a later identity layer can map onto the same project boundary. No route
deletes, sweeps, migrates, rebuilds or verifies an index, or manages keys; those are operator
actions. No archive (ZIP or TAR) upload, no upload by server path, no search, no Range requests,
no Swagger UI, and no rate limiting of its own.
