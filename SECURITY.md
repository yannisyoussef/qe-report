# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository ("Report a
vulnerability" under the Security tab). Do not open a public issue for a
security problem. Reports are acknowledged within a week and fixed
versions are noted in the release notes.

## Which versions get fixes

Security fixes target the latest stable 1.x release. Older 1.x lines are
not maintained in parallel: if a fix lands in 1.4.2, the answer for a
consumer on 1.2.0 is to move to 1.4.2, and `COMPATIBILITY.md` states what
that is allowed to change.

A backport to an older line may be made when there is a specific reason
it is warranted, and it is a deliberate decision each time rather than a
policy. There is no long-term-support programme, and promising one that
does not exist would be worse than saying this.

Because npm and Maven Central versions are immutable, a fix is always a
new version. A bad version is superseded, never replaced; see the
rollback section of `RELEASING.md` for what that means in practice.

## What this code handles

The SDKs run inside test processes and write what test tools observe: HTTP
exchanges, logs, stack traces, screenshots, and environment facts. The
validator reads files produced by any such process. All of it is untrusted
content. The invariants below hold in every release and follow
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
  data roots and a temporary directory, which is mounted `noexec`. The
  other services keep only the capabilities they need to start. The
  deployment's own networks are separate: the edge can reach the
  application and not the database, and the network carrying SQL has no
  route off the host.
- "Unreachable from outside" holds because the host does not route the
  container subnet, not because something refuses the connection. A host
  with forwarding and a route to that subnet exposes the application and
  the database on it, with no published port. That is a property of the
  host, and it is the operator's to check.
- Keys are issued and revoked by the operator command. There is no HTTP
  route for key or maintenance operations, and none should be added
  without deciding the authorisation question first, which this milestone
  deliberately did not.
- A backup contains reporting data and the hashes of API keys. It is
  sensitive, and it is not a place for TLS private keys, the database
  password, or plaintext tokens; the reference backup holds none of them.
- A backup directory is a trust boundary. Its checksums sit beside the
  files they describe, so they detect bit rot and truncation rather than an
  adversary, and `pg_restore` executes whatever the dump contains. Protect
  a backup as you protect the database.
- A restore replaces the whole database, so it brings back every API key as
  it was when the backup was taken. A key revoked since then authenticates
  again from the moment the application starts. Reviewing and re-revoking
  is part of the restore procedure, not an afterthought.
- TLS certificates and private keys are the operator's to manage. Nothing
  in this repository issues, stores, or commits them.
- Staging cleanup is an offline action. Nothing can tell an abandoned
  request from one a live instance is still writing, so the command
  requires the instance that owns the staging root to be stopped.
- Nothing is logged that could be replayed: no `Authorization` header, no
  cookie, no request body, no attachment bytes, no connection string, and
  no secret-file contents, at the edge or in the application. Connection
  strings are taken out of every line as it is written, not only at
  start-up, because a driver error raised while serving a request carries
  its own message.
- The edge's rate and connection limits are not authentication. Every route
  authenticates independently, and the limits count the client address the
  edge can see, which behind NAT or another proxy is one address for many
  clients.
