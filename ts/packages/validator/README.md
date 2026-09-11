# qe-report-validator

Validates a qe-report run directory (`events/*.ndjson` plus `attachments/`)
or one event file without a server:

```
qe-report-validate <run directory | events file> [--attachments <dir>] [--require-complete] [--json]
```

Checks JSON, protocol version, event types, the schema, session and run
lifecycle rules, and attachment hashes, and reports the derived run verdict
with the counts it rests on. Exit status 0 valid, 1 invalid, 2 usage or I/O
error. See the repository README.
