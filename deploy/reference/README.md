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
- `curl` and `node`, for `scripts/smoke.sh`. Nothing in the serving path needs either.
- The ability to run `docker compose`. That is root-equivalent on the host, which is why the
  `operator` service running as root adds no privilege anyone did not already have.
- A host with room for PostgreSQL, the attachment store, and staging. Watching that space is the
  operator's job: nothing deletes a run because a disk is filling. Retention is the only thing
  that removes data, and only when asked.

## Configuration

```sh
cp env.example .env          # every setting, with safe placeholders
./scripts/secrets.sh         # a random password, and the two credential files
./scripts/dev-tls.sh localhost   # a rehearsal certificate; skip it in production
```

`env.example` lists every setting the deployment reads, including the ones fixed by the image.
Two deserve attention together: the application's `QE_REPORT_MAX_REQUEST_BYTES` and the edge's
`QE_REPORT_EDGE_MAX_BODY`. The edge's is deliberately the larger of the two, so the protections
stay separable: the edge refuses what is absurd, with its own 413, and a body between the two
limits reaches the application and is refused there as a problem document. Making them equal hides
the second one. Raise them together, keeping the edge's the larger.

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
older than the cutoff. A link is never followed; an unfamiliar name is reported, not removed. An
unfamiliar name does not fail the command either: a stray file in the staging root is something to
know about, not a reason for a cleanup that did its job to exit non-zero.

Both roots have to be set, as they are for the server, because the check that they are separate is
what stops a mistyped staging root from being a directory whose contents this command deletes. The
cutoff has to be greater than zero: `--older-than-ms 0` would mean "everything".

## Backup

The reference backup is quiesced: the API stops, the database is dumped, the attachment store is
copied, and the API starts again. An ingestion publishes attachment bytes before it commits the
rows that reference them, so with no writer running the two halves describe the same moment. This
is not a zero-downtime backup.

Stopping the API does not stop an operator, so the backup also holds the exclusive maintenance
lock, in one session, across both halves, and proves afterwards that the same session held it the
whole time. Without that, a retention pass started between the dump and the copy could delete
bytes the dump still references, and the result would pass every check and restore an archive
pointing at objects that are not there. A maintenance command started while a backup runs waits
for the lock and then fails on its own timeout, which is the outcome to want.

```sh
./scripts/backup.sh              # names it after the current instant
./scripts/backup.sh before-upgrade
```

A backup holds the database dump, the attachment store as opaque files in its own layout,
checksums, and a manifest. It does not hold staging, edge logs, TLS keys, or secrets; those have
their own lifecycle. The manifest is written last, so a directory without one is incomplete and
must not be restored, and the manifest is itself one of the checksummed files. Any failure exits
non-zero, says what failed, and starts the API again: a backup that fails at three in the morning
must not also be an outage.

A backup directory is a trust boundary. It contains reporting data and the hashes of API keys, and
`checksums.sha256` sits beside the files it describes, so anyone who can rewrite one can rewrite
the other; `pg_restore` then executes whatever the dump contains, as the reporting role. The
checksums detect bit rot and truncation, not an adversary. Protect a backup exactly as you protect
the database, and where it goes from here is yours to decide.

The ownership it leaves behind is part of the contract, because a backup an operator cannot read is
not a backup:

```
<backup directory>        0700, owned by whoever ran backup.sh
  database.dump           0600, same owner
  blobs.tar               0600, same owner
  checksums.sha256        0600, same owner
  manifest.json           0600, same owner
```

Three of those are written by a container running as root, which is what has the client tools and
the volume, so on Linux they would otherwise land owned by root and be unreadable to the operator
who asked for them. The script captures the invoking uid and gid and hands the finished artefacts
over inside the container that wrote them, which is the only place that can. Nothing else changes
hands: PostgreSQL's data directory, the attachment store, and the runtime volumes keep the owners
that serve them.

## Restore

Destructive and explicit. It replaces the database and the attachment store; it never merges a
backup into a live archive.

```sh
./scripts/restore.sh before-upgrade --yes
./scripts/smoke.sh <a completed run directory>   # prove it before trusting it
```

`--yes` is required. Everything now in the deployment is destroyed and no copy of it is taken
first, so the confirmation is the only thing between a name typed at a prompt and an archive that
is gone.

It stops on a bad checksum, a manifest whose own recorded digests disagree with the verified ones,
a missing or unreadable manifest, a different PostgreSQL major, a failed database or store
restore, or a schema this build does not recognise, and it does not start the API when any step
has failed. The attachment store is extracted without the archive's own owners and modes, and its
owner is then set to the account the application runs as: a tar that claimed otherwise could
otherwise leave objects the API can neither read nor let retention delete.

A restore brings back the API keys as they were when the backup was taken. **A key revoked since
then authenticates again.** Review them and revoke what should not be live:

```sh
admin key list --all
admin key revoke --public-id <publicId>
```

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

The edge needs no reload. A new image means a new container on a new address, and the edge
re-resolves the application's name per request rather than once at start-up, which is why this
sequence does not include a step to tell it what happened.

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

The first signal drains: the listener closes, the requests already running are given the grace
period to finish, the pool closes, and the process exits 0. Nothing new is served from the moment
the drain begins, on a new connection or on one already open.

A drain that outlasts `QE_REPORT_SHUTDOWN_GRACE_MS` gives up, logs one line, and exits non-zero
rather than hanging. An upload still running at that point is abandoned: the transfer fails, the
producer retries, and nothing is half-written, because a run becomes archived in one transaction.
The default grace is 30 seconds, which is not long enough for an upload near the configured
maximum on a slow link; if that is normal here, raise `QE_REPORT_SHUTDOWN_GRACE_MS` and the api
service's `stop_grace_period` together, keeping `stop_grace_period` the larger, so the application
decides rather than Docker.

A second signal stops it at once, for an operator who has waited long enough.

## When it will not start

A deterministic configuration error should be read, not restarted around. `restart: unless-stopped`
will retry, so look before you loop:

```sh
docker compose logs api | tail -40
docker compose run --rm --entrypoint qe-report-admin api schema
```

Common causes, all deliberate refusals:

- The schema is not the one this build expects. Run `migrate`.
- Both `DATABASE_URL` and `DATABASE_URL_FILE` are set. An empty value still counts as set.
- The secret file is empty, missing, or holds more than one line.
- A filesystem root is unusable, or is nested inside the other.
- `/readyz` says the blob root is not usable, on a deployment using **bind mounts** rather than
  named volumes. A fresh named volume takes its ownership from the image; a bind mount keeps the
  host's. Run `chown 10001:10001` on the host directories, which is the uid and gid the
  application runs as.

The logs say which of these it is, without printing a credential and without naming the file one
came from.

## Rate and connection limits

The edge counts requests and simultaneous connections per client address, and answers 429 with a
`Retry-After` the producer honours. Health and readiness have their own allowance, so a probe never
spends a client's and is never refused because a client spent it.

Two things to know before trusting the defaults:

- `30r/m` is half a request a second sustained, with a burst of 20. That suits a handful of
  producers. A CI fleet needs more.
- Per address means per address *the edge can see*. A fleet behind one NAT address is one client
  here. If something else terminates connections in front of this, its own address is the one being
  counted, and every client shares one bucket; set `set_real_ip_from` and `real_ip_header` in
  `nginx/templates/qe-report.conf.template` for that case.

None of this is authentication. Every route authenticates independently, and a valid key is subject
to these limits like anything else.

## What the network reaches

Two networks. `frontend` carries HTTP between the edge and the application; `backend` carries SQL
and is `internal`, so neither the database nor the application has a route off the host. Only the
edge publishes a port.

"Unreachable from outside" holds because the host does not route the bridge subnet, not because
something refuses the connection. On a Linux host with forwarding enabled and a route to that
subnet, `api:8080` would be reachable from the LAN with no published port at all. If that describes
your host, the container network is not the boundary you are relying on.

## Resource bounds

`env.example` sets memory and CPU for each service, and compose.yaml sets process and file-descriptor
limits. They are a starting point for a modest host, not a contract: whatever you choose must still
support the upload size you configured, since a request of that size streams through the edge and
the application without either of them holding it whole.
