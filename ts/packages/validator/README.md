# qe-report-validator

Validates a qe-report protocol event file without a server:

```
qe-report-validate events.ndjson [--attachments <dir>] [--require-complete] [--json]
```

Checks JSON, protocol version, event types, the schema, lifecycle rules,
and attachment hashes. Exit status 0 valid, 1 invalid, 2 usage or I/O
error. See the repository README.
