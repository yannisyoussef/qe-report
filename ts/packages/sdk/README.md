# qe-report-sdk

Producer SDK for the qe-report protocol: `ReportSession` fills the event
envelope, `FileSink` writes one session file under `events/` plus `attachments/<sha256>`,
and `Redactor` removes secrets from text before it is serialised or stored.
Reporting problems go to a handler and never throw into the test being
reported. See the repository README.
