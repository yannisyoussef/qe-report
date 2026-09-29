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

## What a deployment must hold up

The reference deployment is described in
[`deploy/reference`](deploy/reference/README.md) and decided in
[ADR-0014](https://github.com/yannisyoussef/qe-ecosystem/blob/develop/docs/adr/0014-reference-deployment.md).
These are the points that are a security matter rather than a preference:

- API keys are bearer credentials, so they require TLS. The reference
  terminates it at the edge and the application speaks HTTP only on the
  private deployment network. Plaintext to anything but this machine is
  refused by the producer, and nothing anywhere disables certificate
  verification.
- Only the edge is published. PostgreSQL and the application are reachable
  on the internal network alone; exposing either is a misconfiguration.
- The application runs as a non-root user with a read-only root
  filesystem, no added capabilities, and writable space only for its two
  data roots and a temporary directory.
- Keys are issued and revoked by the operator command. There is no HTTP
  route for key or maintenance operations, and none should be added
  without deciding the authorisation question first, which this milestone
  deliberately did not.
- A backup contains reporting data and the hashes of API keys. It is
  sensitive, and it is not a place for TLS private keys, the database
  password, or plaintext tokens; the reference backup holds none of them.
- TLS certificates and private keys are the operator's to manage. Nothing
  in this repository issues, stores, or commits them.
- Staging cleanup is an offline action. Nothing can tell an abandoned
  request from one a live instance is still writing, so the command
  requires the instance that owns the staging root to be stopped.
- Nothing is logged that could be replayed: no `Authorization` header, no
  cookie, no request body, no attachment bytes, no connection string, and
  no secret-file contents, at the edge or in the application.
