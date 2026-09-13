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
  expiresAt: new Date('2027-01-01T00:00:00Z'),
});
// { kind: 'inserted', runId, ingestionSequence }
// | { kind: 'already_present', runId, ingestionSequence, blobRelationsAdded, retentionAdded }
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

## Expiry

Every run archived here carries the instant after which retention may
delete it. It is ingestion context, exactly like the project id: the
caller supplies it, and it is never derived from the run's events, its
labels, its runner, its files, or the time it was ingested. An instant
already past is valid and simply makes the run eligible at once; an
absent or unusable one is a caller error and archives nothing.

The first expiry recorded for a run is the one that stands. Re-ingesting
the same run with a different instant answers `already_present` and moves
nothing; a different content under the same identity is `RUN_CONFLICT`
and touches neither the archive nor its expiry. Changing an established
expiry would be a retention-policy operation, and there is none: this
store is append-only apart from the deletion of expired data.

A run archived before retention existed has no expiry at all. It is
retention-unmanaged: it is reported by every maintenance pass, it is
never swept, and no expiry is invented for it. Re-ingesting it from a
still available directory with an expiry records the missing fact and
answers `already_present` with `retentionAdded`, the way missing blob
relations are completed; the archive itself does not change. The
predicate for finding such runs is the absence of a `qe_run_retention`
row. It is independent of the blob-relation predicate from the previous
milestone: a run archived between the two has its bytes and its relations
and no expiry, and one archived before both may lack either, both, or
neither.

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

## Retention and maintenance

Maintenance is explicit, bounded, and invoked by a caller. There is no
scheduler, no background worker, and no timer anywhere in this package;
the operations layer that eventually exists decides when to run them.

```ts
const maintenance = new RetentionMaintenance(pool, blobs);
const plan = await maintenance.preview({ asOf: new Date() }); // mutates nothing
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
const done = await maintenance.run({
  // deletes
  asOf: new Date(),
  tempBefore: yesterday, // sweep abandoned temporary files older than this
  orphanObjectsBefore: yesterday, // collect objects the catalog never knew, older than this
  maxRuns: 100, // DEFAULT_LIMITS.runs
  maxBlobs: 500, // DEFAULT_LIMITS.blobs, catalogued only
  maxUncataloguedBlobs: 500, // DEFAULT_LIMITS.uncataloguedBlobs
  maxBytesExamined: 2 * 1024 ** 3, // DEFAULT_LIMITS.bytesExamined, a soft budget
  lockTimeoutMs: 30_000, // give up rather than wait for the lock; at least 1
});
```

Every bound has a default in `DEFAULT_LIMITS`, and every one of them is
at least one: a pass that could do nothing could never make progress.
`maxBytesExamined` is the one soft bound. Objects are hashed in full
before they are removed, and the first object a pass examines is always
examined however large it is, so that an object bigger than the whole
budget can still be reclaimed rather than blocking every later pass. A
pass can therefore exceed the budget by at most that one object; every
candidate after it that would not fit ends the phase and is reported as
truncation. A caller that wants an oversized candidate processed
alongside others raises the budget.

`lockTimeoutMs` bounds only the wait for the maintenance lock. It must be
at least one millisecond: PostgreSQL reads a `lock_timeout` of zero as no
timeout at all, which is the opposite of asking for one, so zero is a
`TypeError` rather than an unlimited wait. Exceeding it raises
`MaintenanceBusyError`, and nothing of the pass has run. The timeout is
set with `SET LOCAL` inside a transaction that exists only to take the
lock, so it governs the acquisition and disappears when that transaction
commits: the connection goes back to the pool exactly as it was lent out,
and the protected work runs under no transaction of ours.

`asOf` is always the caller's: nothing inside the selection reads the
clock, and nothing compares it with one. A pass asked about an instant in
the future therefore deletes runs that have not reached their expiry, and
deciding who may ask is the job of whatever eventually invokes this. A
pass does at most what its limits allow, in a deterministic order
(expiry, then ingestion sequence), and says in `truncated` where a limit
stopped it, so repeated invocations make progress without any one of them
having to process the whole installation. `afterSha256` continues the
catalogued blob pass past a hash that could not be removed.

Two things are swept only when the caller says how old abandoned means:
temporary files, through `tempBefore`, and objects the catalog never
knew, through `orphanObjectsBefore`. An object published a moment ago by
a writer that did not take the maintenance lock looks exactly like one an
ingestion left behind, and only the caller knows which. One blob root
belongs to one archive for the same reason: two databases sharing a root
would each see the other's objects as unknown.

Six facts are kept apart in the report and in the code, and none is a
synonym for another:

1. **A run expires.** Its `expires_at` is at or before `asOf`. A
   retention-unmanaged run never qualifies and is listed separately.
2. **A run is deleted.** One bounded transaction removes the selected
   runs; their source lines, run-to-blob relations, and retention rows
   cascade with them. If that transaction fails, none of the batch is
   deleted and the report says so.
3. **A run-to-blob relation is released.** Deleting a run removes its
   claim on bytes. It does not remove the bytes.
4. **A blob becomes collectible.** Only when no `qe_run_blobs` row
   anywhere in the database references its hash. The count is global,
   never scoped to a project, a run, or a tenant: the same bytes in two
   projects are one object, and the last reference decides.
5. **Bytes are deleted.** The catalog row goes first, under a final check
   that nothing began referencing the hash, and the object only if that
   check passed. A failure in between leaves an object no row knows,
   which a later pass collects; the opposite order could leave a row, and
   so a run, pointing at bytes that are already gone. An object that
   turns out to be corrupt keeps its bytes and loses only its row, so the
   catalog stops describing it as durable content and it waits for an
   operator.
6. **A temporary file is swept.** Only the store's own names, only
   regular files, and only older than the `tempBefore` the caller gives.
   Without one, nothing is swept.

Two kinds of orphan are collected. A catalogued blob no run references is
the ordinary result of a run expiring. An object with no catalog row at
all is what an ingestion leaves when its bytes were published and its
transaction then rolled back, and no database query can find it: the blob
store is enumerated for those. A corrupt object, an unsafe entry, or a
size that disagrees with the catalog is reported and left exactly where it
is; retention never repairs and never overwrites.

`preview` performs no database mutation and no filesystem deletion. It
inspects and verifies, which is why a corrupt object never counts toward
the bytes it says are reclaimable. It takes no lock, so it describes the
moment it ran and is not a plan a later execution will follow; a
destructive pass decides eligibility again under its own lock. One
consequence of taking no lock: a blob an ingestion is publishing right
now can appear in a preview as an uncatalogued candidate, which the age
cutoff keeps out of a real pass.

## The maintenance lock

Ingestion and destructive retention are serialized by one session-level
advisory lock, separate from the migration lock. A mutating ingestion
takes it **shared** before the first act that could change durable state,
and holds it through the identity check, the blob materialisation, and
the archive transaction. Destructive retention takes it **exclusively**
for its whole window.

```
ingestion   shared ─┐
ingestion   shared ─┼── run beside each other
ingestion   shared ─┘
retention   exclusive ─── waits for them, then excludes them
```

So retention never deletes a blob a concurrent ingestion is about to
reference, and no ingestion publishes bytes while retention is deciding
what is unreferenced. Reading (`loadRun`, `replayRun`,
`projectStoredRun`, `openBlob`) takes no lock at all. The lock lives on
the connection that does the work, so a process that dies releases it
when PostgreSQL ends its session; no process-local mutex is involved in
any of this.

One mutation owns exactly one lease. `withIngestionLock` is the only
place a mutating ingestion takes the lock, and nothing below it acquires
the lock again: PostgreSQL counts session acquisitions, and a lease that
has to be counted is one nobody can reason about. The archive
transaction assumes the boundary is already owned instead of defending
itself with a second acquisition.

A connection goes back to the pool only when its release is proven: the
unlock statement must answer that the lock was held and is now gone. A
thrown error, a false answer, or no answer at all discards the connection
instead, and ending that session releases whatever it still holds. A
connection returned while carrying a lease would let the next borrower
re-enter it and run beside maintenance.

A destructive pass holds that lock while it hashes every object it means
to remove, so its limits are also the bound on how long ingestion can be
kept waiting: `maxBlobs`, `maxUncataloguedBlobs`, and above all
`maxBytesExamined`. Each mutating ingestion and each pass occupies one
pool connection for its whole window, so give maintenance a pool of its
own if ingestion may saturate the main one, and set `lockTimeoutMs` when
waiting indefinitely is worse than being told the store is busy.

## What deletion means to a reader

A deleted run is gone from future reconstruction: `loadRun`,
`replayRun`, and `projectStoredRun` answer `undefined`, and `openBlob`
for one of its hashes answers nothing, because the run no longer
references it. A read model assembled earlier is an immutable snapshot
and is not retroactively changed. There are no history or flakiness
tables to clean, because those have always been rebuilt from the source.
The read model and the protocol know nothing about retention, and
`expiresAt` is an operational instant: it is not a producer clock, not
`ingested_at`, and it orders nothing a reader sees.

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
snapshot, and migration 3 upgrading a database at version 1 or 2. For
retention: a required, finite, possibly past expiry, an inclusive
boundary at `asOf`, independent expiries for one run id in two projects,
an established expiry that neither re-ingestion nor a conflict moves, a
retention-unmanaged run reported and never swept and then completed once
by five racing upgraders, cascade of source lines, relations, and
retention with no cascade into the blob catalog, deterministic bounded
batches, a dry run that changes nothing, a failed batch that deletes
none of itself, bytes shared between two projects and between two runs
of one project kept until the last reference goes, a rollback orphan
found by enumerating the store, corrupt and wrongly sized and linked
objects reported and left, temporary sweeping by name, kind, and age,
the shared and exclusive lock waits observed through PostgreSQL's own
wait state, an expiry batch the server itself refuses part-way leaving
every row in place while the other phases still run, a catalog row that
cannot be deleted leaving the bytes alone, limits reported as truncation
for runs, blobs, and temporary files, the ingestion-sequence tiebreaker
within one expiry, a bounded report of retention-unmanaged runs, and a
preview over a state with work in every phase that changes not one row
or file. For bytes: runs with no, one, two references to one, and four
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
directories in the CI jobs that produce them, and both prove retention on
real output: a run ingested to expire is deleted with its source, its
relations, and its own bytes, while a run that shares those bytes or was
ingested to be kept still replays, projects, and resolves every
attachment.

## Limitations

- No update and no incremental ingestion; a run is archived once,
  complete, and afterwards only deleted. An established expiry cannot be
  changed, and there is no hold, extension, or policy model.
- Maintenance runs only when something invokes it, with no authorisation
  of its own and no audit trail beyond the report it returns.
- The exact number of retention-unmanaged runs is computed on every pass,
  which scans the archive.
- No relational tables for sessions, executions, attempts, history, or
  flakiness; the archive plus the projector is the model. Rebuildable
  indexes may be added later if queries need them.
- One blob provider, the local filesystem store; one database provider,
  exercised against PostgreSQL 16; no generic persistence layer.
- A hash is global across projects: whether a blob exists is not a
  per-project fact, which a future transport must keep in mind before
  exposing blob lookups.
