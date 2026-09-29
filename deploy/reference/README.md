# The reference deployment

One qe-report API instance, one PostgreSQL 16, one attachment store, behind one TLS edge. It is
the deployment this project tests and the one its operational procedures are written for.

```
HTTPS  ->  NGINX  ->  http://api:8080  ->  postgres:5432
                          |
                          +->  attachment store (a volume)
                          +->  staging (a volume)
```

What it is: a single instance whose data survives a restart, whose backups are rehearsed rather
than described, and whose maintenance is something a person runs. What it is not: highly
available, horizontally scalable, replicated, or zero-downtime for backups. ADR-0014 in the
architecture hub records why, and what would have to be proven before any of that is claimed.

Everything here runs one API process. Two would need shared-storage and staging semantics that
nothing has established, so nothing here suggests it.

## Prerequisites

- Docker with Compose v2.
- `openssl`, for a rehearsal certificate. A real deployment brings its own.
- A host with room for PostgreSQL, the attachment store, and staging. Watching that space is the
  operator's job: nothing deletes a run because a disk is filling. Retention is the only thing
  that removes data, and only when asked.

## Configuration

```sh
cp env.example .env          # every setting, with safe placeholders
./scripts/secrets.sh         # a random password, and the two credential files
./scripts/dev-tls.sh localhost   # a rehearsal certificate; skip it in production
```

`env.example` documents each setting. Two deserve attention together: the application's
`QE_REPORT_MAX_REQUEST_BYTES` and the edge's `QE_REPORT_EDGE_MAX_BODY`. The edge's limit must be
at least the application's, or the proxy will refuse uploads the service would have accepted.
Raise them together.

`.env`, `secrets/`, `tls/`, and `backups/` are ignored by Git and must stay that way. Nothing in
this directory should ever hold a certificate, a private key, a password, an API key, or a backup.

### TLS

The edge reads `server.crt` and `server.key` from `QE_REPORT_TLS_DIR`, mounted read-only. Supply
them however your organisation issues certificates; automatic issuance is deliberately not part of
this reference. `scripts/dev-tls.sh` creates a temporary authority and a certificate for a
rehearsal, so that tests can use real TLS and verify it normally.

For a permanent HTTPS hostname, consider adding HSTS at the edge. It is not configured here
because it would be wrong for a self-signed rehearsal and dangerous to copy unchanged.

## Starting it the first time

The order matters, and the application enforces the part that counts: it refuses to serve a schema
it does not recognise, so it cannot come up against a database that was never migrated.

```sh
docker compose build api
docker compose up -d postgres
docker compose run --rm --entrypoint qe-report-admin api migrate   # explicit, never automatic
docker compose up -d api
docker compose up -d edge
```

Then check it:

```sh
docker compose ps                       # api and edge healthy
curl --cacert tls/ca.crt https://localhost:8443/healthz   # the process is alive
curl --cacert tls/ca.crt https://localhost:8443/readyz    # its dependencies are usable
```

`/healthz` says the process is running. `/readyz` says the database answers, the schema is the one
this build expects, and both filesystem roots are usable. A container is not healthy merely
because a port is open.

## The first API key

Keys are machine credentials, issued by the operator command, never over HTTP. There is no user,
no login, and no browser session anywhere in this system.

```sh
docker compose run --rm --entrypoint qe-report-admin api \
  key create --project web --scope runs:write --scope runs:read --label 'ci uploads'
```

The token is printed once, on standard output, and cannot be recovered afterwards. The project a
key belongs to is fixed: a different project or different scopes is a different key.

## Producers

A producer uploads a finished run directory over HTTPS:

```sh
QE_REPORT_API_KEY=qer_k1_... \
  qe-report-upload --run-dir build/qe-report/runs/run-42-... \
  --url https://reports.example.com --retention-ms 2592000000
```

The key comes from the environment, never an argument. For a rehearsal certificate, point
`NODE_EXTRA_CA_CERTS` at `tls/ca.crt`; there is no switch anywhere that disables verification.

## Day-to-day operations

Every one of these is a command someone runs. Nothing in this deployment schedules work: there is
no timer, no cron, and no background worker for retention, collection, cleanup, rebuilds, or
backups. An external scheduler may call these commands once an operator has decided it should.

Shorthand used below:

```sh
admin() { docker compose run --rm --entrypoint qe-report-admin api "$@"; }
```

### Key rotation

No downtime is needed, because both keys work until the old one is revoked:

```sh
admin key create --project web --scope runs:write --label 'ci uploads 2027'
# put the new token in the producer's configuration, and let one upload prove it
admin key list --project web
admin key revoke --public-id <the old public id>
```

`key list` returns metadata only: public id, project, scopes, label, and the created, expiry, and
revoked instants. It cannot return a secret; nothing stored could reproduce a token.

### Retention and blob collection

```sh
admin maintenance preview --as-of 2027-01-01T00:00:00Z
admin maintenance run --as-of 2027-01-01T00:00:00Z --temp-before 2026-12-31T00:00:00Z
```

`preview` changes nothing. `run` deletes runs whose expiry has passed and reclaims bytes no run
anywhere still references. The instant is the operator's: `--now` is available and prints the
instant it resolved to before it does anything. Collecting objects the catalog never knew, and
sweeping temporary files, each need their own cutoff (`--orphan-objects-before`, `--temp-before`),
because an object published moments ago looks exactly like one an ingestion abandoned.

### Query-index repair

A cross-run query refuses a project whose derived index does not cover it, with
`QUERY_INDEX_INCOMPLETE`. That is the operator's cue:

```sh
admin index status  --project web
admin index rebuild --project web            # one bounded pass; repeat while it reports more
admin index verify  --project web --run-id run-42
```

The index is rebuilt from the archived protocol source, which is the only truth. There is no HTTP
route for any of this.

### Stale staging cleanup

A server killed outright can leave a request directory behind. Cleaning it up is offline work:
nothing can tell an abandoned request from one a live instance is still writing.

```sh
docker compose stop api                       # required: this owns the staging root
admin staging preview --older-than-ms 3600000
admin staging clean   --older-than-ms 3600000 --execute
docker compose up -d api
```

Only the server's own request-id directories are candidates, only real directories, and only ones
older than the cutoff. A link is never followed; an unfamiliar name is reported, not removed.

## Backup

The reference backup is quiesced: the API stops, the database is dumped, the attachment store is
copied, and the API starts again. An ingestion publishes attachment bytes before it commits the
rows that reference them, and maintenance only runs when started, so with no writer running the
two halves describe the same moment. This is not a zero-downtime backup.

```sh
./scripts/backup.sh              # names it after the current instant
./scripts/backup.sh before-upgrade
```

A backup holds the database dump, the attachment store as opaque files in its own layout,
checksums, and a manifest. It does not hold staging, edge logs, TLS keys, or secrets; those have
their own lifecycle. The manifest is written last, so a directory without one is incomplete and
must not be restored. Any failure exits non-zero and says what failed.

A backup does contain reporting data and the hashes of API keys. Treat it as sensitive.

## Restore

Destructive and explicit. It replaces the database and the attachment store; it never merges a
backup into a live archive.

```sh
./scripts/restore.sh before-upgrade
./scripts/smoke.sh <a completed run directory>   # prove it before trusting it
```

It stops on a bad checksum, a missing or unreadable manifest, a different PostgreSQL major, a
failed database or store restore, or a schema this build does not recognise, and it does not start
the API when any step has failed.

## Upgrade

```sh
./scripts/backup.sh before-upgrade
docker compose build api                # or pull the candidate image
docker compose stop api
docker compose run --rm --entrypoint qe-report-admin api migrate
docker compose up -d api
curl --cacert tls/ca.crt https://localhost:8443/readyz
./scripts/smoke.sh <a completed run directory>
```

## Rollback

Be honest about what rolling back can do. Migrations are append-only and are not reversible, so
starting an older image is safe only when that older binary understands the schema now in the
database. It refuses to start otherwise, which is the desired outcome rather than a failure.

When a migration has moved the schema beyond what the older build understands, the recovery is to
restore the backup taken before the upgrade. That is why the upgrade sequence begins with one.

## Reading logs, and what is never in them

```sh
docker compose logs api            # structured, one JSON object per line
docker compose logs edge           # one JSON object per request
docker compose logs postgres
```

The API logs a request's method, route, status, duration, and the public id of the key that made
it. The edge logs the client address, method, path, status, sizes, and duration. Neither logs an
`Authorization` header, a cookie, a request body, attachment bytes, a connection string, or the
contents of a secret file. A failed start says what was wrong with a credential without printing
it, and never names the file it came from.

## Shutdown

```sh
docker compose stop api      # SIGTERM; requests already running are allowed to finish
```

The first signal drains: the listener closes, in-flight requests finish, the pool closes, and the
process exits 0. A drain that outlasts `QE_REPORT_SHUTDOWN_GRACE_MS` gives up, logs one line, and
exits non-zero rather than hanging. A second signal stops it at once. The api service's
`stop_grace_period` in compose.yaml is deliberately longer than the application's own grace, so
the application decides, not Docker.

## When it will not start

A deterministic configuration error should be read, not restarted around. `restart: unless-stopped`
will retry, so look before you loop:

```sh
docker compose logs api | tail -40
docker compose run --rm --entrypoint qe-report-admin api schema
```

Common causes, all deliberate refusals: the schema is not the one this build expects (run
`migrate`), both `DATABASE_URL` and `DATABASE_URL_FILE` are set, the secret file is empty or
missing, or a filesystem root is unusable or is nested inside the other.

## Resource bounds

`env.example` sets memory and CPU for each service, and compose.yaml sets process and file-descriptor
limits. They are a starting point for a modest host, not a contract: whatever you choose must still
support the upload size you configured, since a request of that size streams through the edge and
the application without either of them holding it whole.
