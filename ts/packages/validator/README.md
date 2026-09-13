# qe-report-validator

Validates a qe-report run directory (`events/*.ndjson` plus `attachments/`)
or one event file without a server:

```
qe-report-validate <run directory | events file> [--attachments <dir>] [--require-complete] [--json]
```

Checks JSON, protocol version, event types, the schema, session, run, and
execution lifecycle rules, and attachment hashes, and reports the derived
run verdict with the counts it rests on. Exit status 0 valid, 1 invalid, 2
usage or I/O error. See the repository README.

The run directory named on the command line, and an attachments directory
named with `--attachments`, are the trusted entry points; everything below
them is untrusted input. `events` must be a real directory
and every `events/*.ndjson` entry and every declared
`attachments/<sha256>` must be a regular file: a symbolic link, a
directory, or a special file there is reported as
`UNSAFE_FILESYSTEM_ENTRY` and never opened, so the validator does not read
bytes from outside the run directory through a link it found at validation
time. The check is made without following the entry and the file is then
opened without following links and without blocking on a pipe where the
platform allows it. A local filesystem can still change between the two,
a directory component above the entry can be replaced after it was
inspected, and a hard link to a file elsewhere is a regular file by every
check, so a server that ingests runs should validate content it has
materialised inside its own storage.

A repeated `eventId` is an identical duplicate when the two events have the
same canonical form, with object keys sorted and array order kept, so
property order never makes two writes of one event look different. The
comparison walks the event iteratively and cannot be exhausted by a deeply
nested unknown property.
