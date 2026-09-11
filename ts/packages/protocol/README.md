# qe-report-protocol

Types and JSON codec for the qe-report protocol, compatibility line 0.2.
`parseEvent` checks structure and protocol compatibility and throws a
`ProtocolError` with a code; `stringifyEvent` writes one event per line.
The schema in the repository's `protocol/` directory is the source of
truth. See the repository README for the model and compatibility rules.
