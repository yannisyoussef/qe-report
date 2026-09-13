# qe-report-postgres

The first durable store for qe-report runs: a complete, validator-valid
run is archived in PostgreSQL as its original protocol source, its
attachment bytes are made durable in a content-addressed blob store
first, and everything a reader sees is rebuilt from that source through
the existing validator and projector. The package is a library over the
`pg` driver with explicit SQL and a small versioned schema. It is not
published.

```
validated protocol source (PostgreSQL)  ->  validator replay  ->  projectRun  ->  ReadModel.assemble
attachment bytes (blob store, by SHA-256)                                    ->  openBlob / verify
```

```ts
import pg from 'pg';
import { FileBlobStore } from 'qe-report-blob-fs';
import { PostgresRunStore, migrate } from 'qe-report-postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool);
const store = new PostgresRunStore(pool, new FileBlobStore('/var/lib/qe-report/blobs'));
const result = await store.persistRunDirectory({
  projectId: 'web',
  runDirectory: 'build/qe-report/runs/run-42-1f2e3d4c5b6a',
});
// { kind: 'inserted', runId, ingestionSequence }
// | { kind: 'already_present', runId, ingestionSequence, blobRelationsAdded }
// | { kind: 'rejected', reason: 'RUN_INVALID' | 'RUN_INCOMPLETE' | 'RUN_EMPTY', diagnostics }
// | { kind: 'conflict', reason: 'RUN_CONFLICT', storedFingerprint, offeredFingerprint }
const run = await store.projectStoredRun('web', 'run-42'); // a ProjectedRun, or undefined
await store.verifyStoredRunBlobs('web', 'run-42'); // every required blob re-read in full
const blob = await store.openBlob('web', 'run-42', sha256); // { sha256, sizeBytes, stream }, or undefined
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

Durable beside the lines: the attachment bytes, in the blob store under
their SHA-256, with a catalog row per blob and a relation per run in
PostgreSQL (see Attachments below).

Derived, and never written: projected runs, test histories, flakiness,
and the blob catalog of the read model. A stored run is replayed through the current
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
same fingerprint returns `already_present`, whatever directory it came
from, and neither the archive, its provenance, nor its physical duplicate
lines change; a run whose blob relations are complete costs no blob work
either, because the identity is looked up before any byte is copied
(the transaction still settles a race). A different fingerprint under
the same identity is `conflict` (`RUN_CONFLICT`): nothing is overwritten
or merged.

## Ingestion order and one transaction

```
validate the run directory  ->  retain the source lines and events
  ->  derive the distinct attachment hashes and sizes
  ->  look the identity up: same content with every relation is already_present,
      different content is conflict, either without blob work
  ->  copy, hash, verify, and publish each blob (bounded concurrency)
  ->  BEGIN  ->  claim (projectId, runId)  ->  record blob metadata
  ->  record the lines  ->  record the run-to-blob relations  ->  COMMIT
```

Every required blob is durable before the transaction starts, so the
database references only blobs the store already holds. The archive is
built in memory from the validation pass; the filesystem is not read
inside the transaction. Two concurrent ingestions of one run leave one
archive and give the other callers `already_present`; two different
contents racing for one identity leave exactly one archive and give the
loser `conflict`; a failure while inserting rolls the run back entirely,
blob metadata included. Operational database errors are thrown, not
turned into validation problems.

The blob store and PostgreSQL cannot share one transaction. The invariant
is one-directional: a committed run never references a blob that was not
materialised, while a transaction that rolls back after publication may
leave an unreferenced blob. Such an orphan is immutable content under its
own hash; it is not deleted in the failure path, because another
ingestion may already reference or be about to reference it, and a later
ingestion that needs the hash verifies and reuses it. Collecting orphans
belongs to a retention milestone.

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
`source_attachments_verified`. On load, the lines are replayed through
the validator without an attachments directory, one group per session,
and the result is checked three ways: the replayed summary must match the
stored one on every semantic fact (the file count is not one of them, it
describes the directory layout), the number of lines read must match the
archived count, and the fingerprint of the lines read must match the
archived fingerprint. A disagreement is a `ReplayMismatchError`, not a
silently different model. The stored summary is an audit record, never
the source of outcomes. This structural replay reads no bytes and is what
`projectStoredRun` uses; the projector is not blob-aware and
`ProjectedRun` carries no storage paths.

## Attachments

Three facts about attachments are kept apart, and none is a single
`verified` flag:

1. `source_attachments_verified` on the run row: the validation pass at
   ingestion checked the source files against the events. An audit claim
   about the source at that moment. `persistRunDirectory` is the only
   writer and always validates the bytes, so the column reads `true` for
   runs it archived; a caller cannot assert it, and no boolean creates a
   blob record.
2. Blob metadata recorded: `qe_blobs` holds one row per distinct hash
   (size, provider storage key, first stored time) and `qe_run_blobs`
   relates each archived run to the distinct blobs its attachment events
   require. Both are storage-integrity metadata, rebuildable from the
   source lines; names, media types, attempts, steps, and multiplicity
   are read from the lines only. A hash is global: the same bytes in two
   runs or two projects are one `qe_blobs` row and one object.
3. Bytes re-verified now: `verifyStoredRunBlobs(projectId, runId)`, or
   `replayRun(projectId, runId, { verifyAttachments: true })`, derives the
   required hashes from the replayed source, requires a catalog relation
   with the declared size for each, opens the object from the blob store,
   and recomputes its size and full SHA-256. A missing relation, a size
   the catalog disagrees on, a missing object, or a corrupt one is an
   `AttachmentIntegrityError` (`BLOB_RECORD_MISSING`,
   `BLOB_RECORD_SIZE_MISMATCH`, `BLOB_MISSING`, `BLOB_CORRUPT`). Nothing
   is repaired and nothing falls back to the run's `source_locator`.

A hash has one size: a catalog row or a declaration disagreeing about it
is a `BlobSizeConflictError` and writes nothing.
`openBlob(projectId, runId, sha256)` streams the opaque bytes of a blob
that run relates to, from the store's own location; the caller supplies
the hash and the run, never a path, and a hash the run does not relate
to is nothing, because whether a hash exists is a global fact a caller
learns only through a run it may see.

Runs archived before durable blobs existed (migration 1) have source
lines and no relations. A run with attachment events and no relations
is such a legacy archive (`(validation_summary->>'attachments')::int > 0
AND NOT EXISTS (SELECT 1 FROM qe_run_blobs ...)`); `loadRun` shows an
empty `blobs` list and verification reports `BLOB_RECORD_MISSING`.
Re-ingesting such a run from a still available directory is the storage
upgrade: the same content is recognised, its bytes are materialised, and
the relations are recorded in one transaction, answered as
`already_present` with `blobRelationsAdded` counting the relations this
call created; the run's source and provenance are not touched. The
upgrade is automatic on re-ingestion, not a separate operation.

Projected runs, test histories, and flakiness never depend on blob
storage; they are rebuilt from the source lines alone.

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
container: migrations (fresh through both versions, a database at
migration 1 upgraded with a legacy run, repeated, concurrent, a waiter
blocked on the lock, changed checksum of either version, deterministic
schema, blob catalog constraints), every valid complete protocol fixture
archived, replayed, and projected equal to its directory, the incomplete,
invalid, and empty ones refused, idempotency across property order,
whitespace, extra duplicate lines, extra empty or blank files, a
duplicate copy of a session file, and another directory, a forward-field
conflict, project isolation, a forward-compatible run with an attachment
loaded, projected, opened, and verified after its directory was deleted,
a commit failing after publication,
rollback of a failed insert in a later chunk of a 1 400-line run,
concurrent same and different contents including a claimant blocked
behind an open transaction, an older fingerprint rule, tampered lines and
a tampered audit summary, and read-model equality with the local
snapshot. For bytes: runs with no, one, two references to one, and four
distinct blobs, one blob shared between projects and between runs, a
source changed between validation and materialisation (hash, size, gone,
directory, link), a database failure after publication leaving an orphan
that a later ingestion reuses, idempotent re-ingestion and conflict, six
concurrent runs sharing one new blob, a catalog size conflict, a legacy
run completed without touching its source (staged under migration 1 and
by deletion, with five concurrent upgraders counting one relation), an
empty attachment, and missing, corrupted, truncated, and link-replaced
objects detected on verification and not repaired. Real JUnit consumer runs (with a `TestReporter` entry as the
attachment) and fresh Playwright runs round-trip without their run
directories in the CI jobs that produce them.

## Limitations

- No update, delete, retention, or incremental ingestion; a run is
  archived once, complete. Orphaned blobs are not collected.
- No relational tables for sessions, executions, attempts, history, or
  flakiness; the archive plus the projector is the model. Rebuildable
  indexes may be added later if queries need them.
- One blob provider, the local filesystem store; one database provider,
  exercised against PostgreSQL 16; no generic persistence layer.
- A hash is global across projects: whether a blob exists is not a
  per-project fact, which a future transport must keep in mind before
  exposing blob lookups.
