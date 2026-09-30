# Compatibility

qe-report has several version numbers that answer different questions. They are deliberately
independent: the product reaching 1.0.0 did not renumber the protocol, the HTTP API, or the
database schema, and a future product release will not renumber them either unless that change is
decided on its own terms.

| Domain                      | Version in this release | What it governs                                        | Changes when                                                 |
| --------------------------- | ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Product                     | `1.0.0`                 | The published packages, artifacts, and container image | SemVer, on the public surfaces below                         |
| Protocol compatibility line | `0.3`                   | The events a producer writes and a consumer reads      | An explicit protocol decision, recorded as an ADR            |
| HTTP API                    | `v1`                    | The routes, request and response shapes of the service | An explicit API decision; `v2` is a new contract, not a bump |
| Database schema             | `5`                     | The migrations the server expects                      | Any append-only migration; it is a deployment concern only   |
| API key format              | `qer_k1`                | The shape of a machine credential                      | A new format is a new prefix                                 |

`release/release.json` records all of these, and CI checks each against the code it describes, so
this table cannot drift away from the implementation without a build failing.

## Product SemVer

For the published packages and artifacts:

- **patch** — backwards-compatible fixes, including security fixes;
- **minor** — backwards-compatible additions to a public surface;
- **major** — a breaking change to a public surface.

Two things are explicitly _not_ inferred from product SemVer. A change to the protocol
compatibility line is an architectural decision of its own, and so is a new HTTP API version.
Either may happen in a minor product release, or may not happen across several major ones; the
product version does not encode them, which is why the table above exists.

For the 1.x line every public artifact carries the same product version, released together. That
is a decision recorded in ADR-0015, not a property of the design: nothing in the code requires it,
and it will be revisited if independent release pressure ever appears.

## Public surfaces

The compatibility promise applies to the exported surfaces of these, and to nothing else.

npm:

```
qe-report-protocol
qe-report-sdk
qe-report-validator
qe-report-http-client
qe-report-playwright
```

Maven, under `io.github.yannisyoussef`:

```
qe-report-protocol
qe-report-sdk
qe-report-junit-platform
```

The service is distributed as a container image, `ghcr.io/yannisyoussef/qe-report`.

### Not public

`qe-report-read-model`, `qe-report-blob-fs`, `qe-report-postgres`, `qe-report-http-api` and
`qe-report-equivalence` are internal npm packages. They are not published, they carry no
compatibility promise, and they may change between product releases in ways that would be breaking
if they were public. What must stay compatible is the container and the public packages built from
them. Any Java package under an `internal` segment is the same: excluded from the guarantee.

## Protocol 0.3

qe-report 1.x reads and writes protocol compatibility line 0.3. Within it:

- an event conforming to the supported 0.3 contract keeps being accepted, unless a documented
  correctness or security problem makes that impossible;
- the compatibility unit is `0.minor`: a consumer of line 0.3 reads any `0.3.x` and nothing else;
- unknown fields keep the forward-compatibility semantics the protocol already defines, and
  producers and validators apply the same rules.

No promise is made about protocol versions that do not exist yet. Support for a future line will be
decided when there is one.

## Runtimes

| Runtime                   | Supported                                 | Verified in CI                                          |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| Node                      | `>=22`                                    | 22 and 24                                               |
| Java (published bytecode) | 17                                        | tests on 17, 21 and 25; built on 25                     |
| Playwright (peer)         | `>=1.57.0 <2`                             | 1.57.0 and 1.63.0                                       |
| JUnit Platform            | 1.10.5 and newer in the 1.x and 6.x lines | 1.10.5 (JDK 17), 1.13.4 (JDK 21), 6.0.3 (JDK 25)        |
| PostgreSQL                | 16                                        | 16, through Testcontainers and the reference deployment |

The JUnit Platform range is the one CI actually exercises, listed as three cells rather than as a
single interval, because that is what has been run. The published adapter compiles against the
1.10.5 line, which is its floor.

The Playwright peer range is deliberately wider than the two cells CI runs. Narrowing it to the
newest fixture would break consumers for no evidence-backed reason.

## Producer and server

A producer is wire-compatible with a server when both support the same protocol compatibility line.
That is the whole rule. It does not require matching product versions, and a 1.2.0 reporter may
upload to a 1.0.0 server and the reverse, as long as the line matches and the transport features in
use exist on both sides.

`qe-report-http-client` 1.0.0 targets HTTP API v1. A later 1.x client may add features while still
speaking v1; a client that required something beyond v1 would need the server to offer it, and that
would be an API decision.

## Database schema

A qe-report 1.0.0 server expects schema version 5. This is a deployment concern and is not part of
any producer's compatibility question: a producer never sees it.

The server does not migrate on start-up. It refuses to serve a schema it does not recognise, and
migrations are an explicit operator command. A 1.x upgrade may add append-only migrations without
changing the protocol line or the API version. Because migrations are append-only, starting an
older image against a newer schema is safe only when that older build understands the schema now in
the database; where it does not, it refuses to start, and the recovery is to restore the backup
taken before the upgrade. `deploy/reference/README.md` covers this as a runbook.
