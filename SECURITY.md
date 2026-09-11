# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository ("Report a
vulnerability" under the Security tab). Do not open a public issue for a
security problem. Reports are acknowledged within a week and fixed
versions are noted in the release notes. Before 1.0, only the latest
release of each package receives fixes.

## What this code handles

The SDKs run inside test processes and write what test tools observe: HTTP
exchanges, logs, stack traces, screenshots, and environment facts. The
validator reads files produced by any such process. All of it is untrusted
content. The invariants below hold from the first release and follow
[ADR-0003](https://github.com/yannisyoussef/qe-ecosystem/blob/develop/docs/adr/0003-redaction-and-attachment-handling.md):

- Free text is redacted before serialisation and before a textual
  attachment is stored: sensitive headers, password-style keys, bearer
  tokens, JWTs, private keys, credentials in URLs, and well-known token
  formats. There is no unredact path.
- Binary attachments are stored as given and are not redacted; the
  documentation says so.
- Environment variables are captured only by explicit allowlist.
- Attachment bytes never appear inside events. Sidecar files are named by
  the SHA-256 of their content; a producer-supplied name never influences
  a path.
- Events and attachments have size limits; an oversized event is dropped
  and reported, never truncated silently.
- The validator resolves attachment paths only from hashes, never from
  producer strings, and treats every field as data.
- The SDKs never throw into the test being reported.

A violation of any of these is a security bug.
