# Changelog

This file records what changed for someone consuming qe-report, not what happened in the
repository. Versions follow [SemVer](https://semver.org) for the public packages and the container
image; `COMPATIBILITY.md` explains why the protocol, HTTP API and database schema have version
numbers of their own.

## 1.0.0

The first stable release. Product version `1.0.0`; protocol compatibility line `0.3`; HTTP API
`v1`; database schema `5`.

### A runner-agnostic protocol

Test results are recorded as newline-delimited events under a published JSON Schema, with one run
directory per run. The protocol is deliberately not a report format: it describes what happened,
including retries, forks, shards and scope failures, and leaves interpretation to a consumer. A
single instant, `historyInstant`, orders history across producers.

### Producers

Java and TypeScript SDKs write run directories, with redaction and attachment publication built in.
Two adapters use them: a JUnit Platform `TestExecutionListener` discovered through `ServiceLoader`,
and a Playwright Test reporter. Both handle several JVMs or workers writing one run, and both
identify themselves and their runner in the events they write.

### Validation

`qe-report-validator` decides whether a directory is a run, as a library and as the
`qe-report-validate` command. It enforces run-wide execution invariants, not only schema shape, and
contains attachment reading inside the directory it was given.

### Service

An authenticated HTTP API v1 on Fastify: streamed multipart upload of a completed run directory,
run listing, one run, exact history, flakiness, and run-scoped attachment download. Project-scoped
API keys are machine credentials; only their SHA-256 is stored, and no operator action has a route.

Behind it: a durable PostgreSQL archive of the original protocol lines, which are the only truth;
attachment bytes in an immutable content-addressed store keyed by SHA-256, shared across runs and
projects; explicit bounded retention that deletes expired runs and reclaims unreferenced bytes; and
rebuildable query indexes that refuse to answer for a project they do not fully cover rather than
serving part of it.

### Producer upload

`qe-report-http-client`, as a library and as the `qe-report-upload` command, delivers a finished run
directory over HTTPS. The local directory is the spool; one immutable upload plan is verified before
and during every attempt; retries are safe because whole-run ingestion is idempotent; and the API
key comes from the environment, never an argument.

### Reference deployment

`deploy/reference` is one API instance, PostgreSQL 16, a POSIX attachment store and an NGINX TLS
edge, described by a Compose stack and a Dockerfile. The application runs as a non-root user on a
read-only root filesystem and publishes no port of its own. Migrations, retention, index rebuilds
and staging cleanup are operator commands; nothing is scheduled.

Backups are quiesced and hold both halves of the state together, taken under the same exclusive
lock that destructive maintenance uses, so a concurrent retention pass cannot produce a backup that
passes every check and restores an archive missing bytes. Restore is destructive, requires saying
so, and is rehearsed in CI against genuinely destroyed volumes.

### Known limitations in 1.0.0

These are scope boundaries, not defects. None has a promised date.

- The reference deployment is a single API instance. It is not highly available, not replicated and
  not horizontally scaled; a restart is a short outage and a backup is a planned one.
- There is no user model: no accounts, no sessions, no OIDC. Credentials are machine API keys, and
  the project a key belongs to is the authorisation boundary.
- There is no web UI or dashboard. The API and the operator command are the interfaces.
- Attachment bytes live on a POSIX filesystem behind a storage boundary. There is no object-store
  backend yet.
- There is no Java HTTP uploader. Java producers write run directories; uploading them is the
  TypeScript command's job.
- Attachment download has no `Range` support, so a client cannot resume a partial download.
- Maintenance is explicit. Nothing expires, collects or cleans up on a timer.
- The reference backup is quiesced, which means a short planned outage. No consistent snapshot while
  writers run has been demonstrated, and none is claimed.
- The release image is built and rehearsed for `linux/amd64`. No other architecture is claimed.
