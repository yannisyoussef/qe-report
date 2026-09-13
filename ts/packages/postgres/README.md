# qe-report-postgres

The first durable store for qe-report runs: a complete, validator-valid
run is archived in PostgreSQL as its original protocol source, and
everything a reader sees is rebuilt from that source through the existing
validator and projector. The package is a library over the `pg` driver
with explicit SQL and a small versioned schema. It is not published.

```
validated protocol source (PostgreSQL)  ->  validator replay  ->  projectRun  ->  ReadModel.assemble
```

```ts
import pg from 'pg';
import { PostgresRunStore, migrate } from 'qe-report-postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool);
const store = new PostgresRunStore(pool);
const result = await store.persistRunDirectory({
  projectId: 'web',
  runDirectory: 'build/qe-report/runs/run-42-1f2e3d4c5b6a',
});
// { kind: 'inserted' | 'already_present', runId, ingestionSequence }
// | { kind: 'rejected', reason: 'RUN_INVALID' | 'RUN_INCOMPLETE' | 'RUN_EMPTY', diagnostics }
// | { kind: 'conflict', reason: 'RUN_CONFLICT', storedFingerprint, offeredFingerprint }
const run = await store.projectStoredRun('web', 'run-42'); // a ProjectedRun, or undefined
```

## What is durable and what is derived

Durable: the original JSON lines the validator accepted, one row each,
exactly as read minus the line terminator, with their `runId`,
`sessionId`, `sequence`, `eventId`, event type, protocol version, a
digest of their canonical form, and their disposition (`accepted`,
`ignored` for an unknown event the producer marked ignorable, `duplicate`
for an identical repetition). Unknown optional properties on known events,
unknown ignorable events, prototype-named map keys, and identical
duplicate lines all survive, because the text survives. Beside the lines,
a run row carries provenance and ingestion metadata.

Derived, and never written: projected runs, test histories, flakiness,
and the blob catalog. A stored run is replayed through the current
validator, session by session in storage order, into the same
`ValidatedRun` the local file path produces, then projected with the
read model's `projectRun`; several stored runs are assembled with
`ReadModel.assemble`. Today's decoder drops what it does not understand
when it decodes; the archive does not, so a future decoder can replay the
same run and understand more.

## Complete runs only

A run is archived only when the validator reports it valid and complete:
every session, attempt, and step that started also finished. `closed` is
not required, so a forked JUnit run with no `run.finished` is archived. An
incomplete run is `rejected` with `RUN_INCOMPLETE`, an invalid run with
`RUN_INVALID` and the validator's diagnostics, and a directory whose
events name no run with `RUN_EMPTY`; none writes a row. A run that
completes later would be a different content under the same identity,
and this store does not update runs.

## Identity, idempotency, conflict

The run identity is `(projectId, runId)`, a primary key; the project is
caller-supplied ingestion context (ADR-0007), there is no projects table,
and the same run id in two projects is two runs. The run directory is
stored as `source_locator`, provenance only.

Each run has a content fingerprint: SHA-256 over the sorted, de-duplicated
canonical digests of its accepted and ignored lines, behind a version tag.
JSON property order, whitespace, file enumeration, and identical duplicate
lines do not change it; an unknown optional field or an unknown ignorable
event does. Persisting a run whose identity is already stored with the
same fingerprint returns `already_present` and writes nothing, whatever
directory it came from; the first archive, its provenance, and its
physical duplicate lines stay as they were. A different fingerprint under
the same identity is `conflict` (`RUN_CONFLICT`): nothing is overwritten
or merged.

## One transaction

The archive is built in memory from one validation pass and written in
one transaction: claim the identity (`INSERT ... ON CONFLICT DO NOTHING`),
insert every line in storage order, commit. The filesystem is not read
inside the transaction. Two concurrent ingestions of one run leave one
archive and give the other callers `already_present`; two different
contents racing for one identity leave exactly one archive and give the
loser `conflict`; a failure while inserting lines rolls the run back
entirely. Operational database errors are thrown, not turned into
validation problems.

## Storage order and ingestion sequence

`storage_ordinal` orders a run's lines for storage and replay: session id
by code unit, then session sequence, then event id, then source
occurrence, which keeps an identical duplicate right after its original.
It is not a cross-session event order; the protocol defines none.
`ingestion_sequence` is a database identity that gives runs a stable
out-of-band ingestion order for future queries; it is not protocol
chronology, gaps after rollbacks are normal, and it does not change the
read model's producer-clock history order.

## Replay and audit

The run row keeps the validator summary from ingestion (complete, closed,
verdict, and the semantic counts), the archived line count, and
`attachments_verified`, which the caller states: `persistRunDirectory`
validated the bytes, a caller archiving an already validated run says
whether its validation did. On load, the lines are replayed through the
validator without an attachments directory, one group per session, and
the result is checked three ways: the replayed summary must match the
stored one on every semantic fact (the file count is not one of them, it
describes the directory layout), the number of lines read must match the
archived count, and the fingerprint of the lines read must match the
archived fingerprint. A disagreement is a `ReplayMismatchError`, not a
silently different model. The stored summary is an audit record, never
the source of outcomes.

## Attachments

Attachment bytes are not stored: no `bytea`, no object store. Their
events are, with `sha256`, `sizeBytes`, name, media type, and attempt or
step, so the blob catalog is rebuilt from the archive and the bytes were
hash-verified at ingestion. Replay from the database cannot re-verify the
bytes; durable blob storage is a later milestone.

## Migrations

The schema is an append-only list of versioned SQL migrations embedded in
the package. `migrate(pool)` applies the pending ones in order, each in
its own transaction, under a session advisory lock so concurrent starts
apply each once; it records version, name, and a checksum over the
version, name, and SQL, is a no-op when run again, and refuses to
continue when a recorded migration's checksum no longer matches the
code.

## Evidence

Integration tests run against PostgreSQL 16 in a Testcontainers
container: migrations (fresh, repeated, concurrent, a waiter blocked on
the lock, changed checksum, deterministic schema), every valid complete
protocol fixture archived, replayed, and projected equal to its
directory, the incomplete, invalid, and empty ones refused, idempotency
across property order, whitespace, extra duplicate lines, extra empty or
blank files, a duplicate copy of a session file, and another directory,
a forward-field conflict, project isolation, a forward-compatible run
loaded after its directory was deleted, rollback of a failed insert in a
later chunk of a 1 400-line run, concurrent same and different contents
including a claimant blocked behind an open transaction, an older
fingerprint rule, tampered lines and a tampered audit summary, and
read-model equality with the local snapshot. Real JUnit consumer runs and fresh
Playwright runs round-trip in the CI jobs that produce them.

## Limitations

- No update, delete, retention, or incremental ingestion; a run is
  archived once, complete.
- No relational tables for sessions, executions, attempts, history, or
  flakiness; the archive plus the projector is the model. Rebuildable
  indexes may be added later if queries need them.
- Attachment bytes stay outside the store.
- One provider, exercised against PostgreSQL 16; no generic persistence
  layer.
