# qe-report-blob-fs

Durable attachment bytes for qe-report: an immutable content-addressed
blob store on a local filesystem, keyed by the protocol's full lower-case
SHA-256. It is the first concrete byte store behind the storage boundary
the architecture hub describes (local filesystem under server-generated
keys, with the hash retained as identity); an S3-compatible store is
deferred until a non-local deployment needs one. The package is not
published.

```ts
import { FileBlobStore } from 'qe-report-blob-fs';

const store = new FileBlobStore('/var/lib/qe-report/blobs'); // an existing directory
// { maxBlobBytes } caps what the store materialises or verifies; default 64 MiB, the sinks' limit.
const put = await store.put({ path: 'run/attachments/<sha256>', sha256, sizeBytes });
// { sha256, sizeBytes, storageKey: 'sha256/ab/cd/<sha256>', outcome: 'stored' | 'existing' }
await store.stat(sha256); // presence and size by inspection, or undefined
const { stream } = await store.open(sha256, sizeBytes); // opaque bytes
await store.verify(sha256, sizeBytes); // regular file, exact size, full SHA-256
```

## Identity and layout

The identity of a blob is its SHA-256, and nothing else reaches the
filesystem: not an attachment name, media type, run id, project id,
session id, or source path. The object path is derived from the validated
hash alone, `<root>/sha256/ab/cd/<sha256>`, and the store rejects a hash
that is not 64 lower-case hex characters before touching anything. Two
runs, or two projects, that reference the same bytes share one object;
deduplication is global, and the protocol's attachment events remain the
only record of who referenced what, how often, and under which name.

## Materialisation

`put` never trusts an earlier check of the source. A declaration above
the size limit is refused before anything is opened. The source is
inspected without following links, opened with `O_NOFOLLOW` and
`O_NONBLOCK` where the platform has them, and re-checked on the
descriptor (regular files only); it is streamed into a temporary file
under `<root>/tmp` (mode `0700`) that is created exclusively under a
random name with mode `0600`, hashed and counted as it is copied, and
stopped as soon as it exceeds the declared size. Only when the size and
the hash match the declaration is the temporary file synced, made
read-only, and published with an exclusive hard link to its final path
while its descriptor is still open; the published entry is then
re-opened and required to be that very file (same device and inode,
same size), and the object directory is synced. A link that fails with
`EEXIST` means another writer published first; the temporary file is
removed and the existing object is verified like any other. The
temporary file is removed on success and on every failure the process
lives through. No partial or unverified content ever appears at a final
path, and an ordinary rename that would replace an existing object is
never used.

Blobs are streamed in bounded chunks; a 64 MiB attachment is never held
in one buffer.

On Windows, where `O_NOFOLLOW` does not exist, a source that is a link
is refused by the inspection before the open but not by the open itself;
the store is exercised on POSIX platforms.

## Immutability and existing objects

An existing object is never overwritten. When the final path exists, it
is opened with the same posture as a source, its size is compared, and
its full SHA-256 is recomputed: a correct object is reused (`existing`),
a wrong one is a `BlobStoreError` (`BLOB_SIZE_MISMATCH`,
`BLOB_HASH_MISMATCH`, `BLOB_NOT_REGULAR`) that no ingestion repairs
automatically. A link or a file planted at an object path, or at one of
the store's own directories, is refused, not followed, by reads and
writes alike. On POSIX platforms a published object has mode `0444`. The
flip side of never repairing is that wrong content planted under a hash
before the store publishes it blocks that hash until an operator removes
it; the root is an application storage boundary, not a defence against
whoever can write under it.

Concurrent writers, in one process or several, may each copy and hash
the same bytes; the filesystem's exclusive link decides who publishes,
every caller ends with the same verified content, and no process-local
lock is needed for correctness.

## What the store does not do

- It does not delete. Unreferenced objects (from an ingestion whose
  database transaction rolled back after publication) stay until a later
  retention milestone decides how to collect them; they are immutable
  and safe. Temporary files left by a process killed mid-copy stay under
  `<root>/tmp` for the same milestone to sweep; they are never published.
- It does not inspect bytes. Archives, images, videos, and traces are
  opaque: nothing is extracted, parsed, transcoded, or rendered.
- It does not scope bytes by project or run; those facts live in the run
  archive.
- It protects an application storage boundary: the root is trusted to
  the operator, its contents are re-verified when read, and mutation of
  the root by a hostile operator is out of scope.
- It relies on hard links within one filesystem; a filesystem without
  them cannot host the root.

## Evidence

Real-filesystem tests cover the first write, the identical second write,
malformed hashes and sizes, a declaration above the limit, size and hash
disagreement, the copy stopping once a source exceeds its declaration, a
source that disappeared, became a link, a directory, or a pipe, an empty
blob, existing objects that are correct, the wrong size, the wrong hash,
or a link, a link or a file planted in the store's own directories for
reads and writes, eight concurrent writers in one process and six
concurrent writer processes, temporary-file cleanup after success and
failure, streaming of multi-megabyte sources, missing, corrupted, and
truncated objects on verification, and an object that outlives the run
directory it came from.
