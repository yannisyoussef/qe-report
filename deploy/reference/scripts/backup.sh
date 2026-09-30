#!/bin/sh
# A quiesced backup of the reference deployment: the database and the attachment store, taken
# together, with the API stopped and destructive maintenance locked out.
#
#   ./scripts/backup.sh [name]
#
# Why the API is stopped. An ingestion publishes attachment bytes before it commits the database
# rows that reference them, so with no writer running a dump and a copy of the store describe the
# same moment. This is not a zero-downtime backup and is not claimed to be one.
#
# Why the lock. Stopping the API does not stop an operator, and a retention pass running between
# the dump and the copy could delete bytes the dump still references, producing a backup that
# passes every check and restores an archive pointing at objects that are not there. So this takes
# the same exclusive maintenance lock retention takes, in one session held across both halves, and
# proves afterwards that it was the same session holding it the whole time. A maintenance command
# started meanwhile waits for the lock and fails on its own timeout rather than corrupting this.
#
# Anything that fails leaves the backup directory behind, marked incomplete by the absence of
# manifest.json, exits non-zero, and starts the API again.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"

name=${1:-$(date -u +%Y%m%dT%H%M%SZ)}
# A path component, not a path: this name is used to make a directory and to bind-mount it into a
# container that writes as root.
case $name in
  '' | .* | */* | *[!A-Za-z0-9._-]*)
    echo "a backup name may hold letters, digits, dot, dash and underscore, and may not begin with a dot" >&2
    exit 2
    ;;
esac

backups=${QE_REPORT_BACKUP_DIR:-./backups}
target="$backups/$name"
compose="docker compose"
# The lock's key, from qe-report-postgres: the boundary between writing durable state and
# reclaiming it. A ceiling, not a duration; the lock is released as soon as this script is done.
lock_key=7248134620002
lock_seconds=${QE_REPORT_BACKUP_LOCK_SECONDS:-3600}
# A name of this backup's choosing, so the locking container can be removed without parsing it out
# of compose's own progress output, which goes to the same stream as the id.
lock_container="qe-report-backup-lock-$$"
lock_pid=''
# Names this backup's own locking session, so that what is looked for in pg_locks is this session
# holding the lock and not merely somebody holding it. Without it, a retention pass already holding
# the lock would satisfy both checks while this backup's own session sat waiting for it.
lock_name="qe-report-backup-$$-$(date -u +%s)"
restarted=0

# A backup is as sensitive as the database it holds, so nothing in it is readable by anyone else.
umask 077

if [ -e "$target" ]; then
  echo "backup $name already exists at $target" >&2
  exit 1
fi
mkdir -p "$target"
chmod 0700 "$target"

# Released twice over, deliberately. Removing the container ends the session, and terminating the
# backend by name ends it even if the container could not be removed: a locking session left behind
# would hold the exclusive lock for its whole ceiling and block every backup and every retention
# pass until it expired.
release_lock() {
  docker rm --force "$lock_container" >/dev/null 2>&1 || true
  query "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
         WHERE application_name = '$lock_name' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
}

# However this ends, the deployment is left serving and the lock is let go. A backup that fails at
# 03:00 must not also be an outage.
cleanup() {
  status=$?
  release_lock
  if [ "$restarted" -eq 0 ]; then
    echo "starting the API again after a failed backup" >&2
    $compose start api >/dev/null 2>&1 || \
      echo "the API is still stopped; start it with: docker compose start api" >&2
  fi
  exit $status
}
trap cleanup EXIT INT TERM

fail() {
  echo "backup failed: $1" >&2
  echo "the incomplete backup is at $target; it has no manifest.json and must not be restored" >&2
  exit 1
}

# Runs one psql query and prints its single value, without a pipeline: `sh` has no pipefail, so a
# pipeline would report the exit status of the last stage and a failed query would look empty.
query() {
  out=$($compose --profile tools run --rm -T operator \
    psql --no-password --no-psqlrc --quiet --tuples-only --no-align -c "$1") || return 1
  printf '%s' "$out" | tr -d '\r\n'
}

# This backup's own session, if it holds the maintenance lock exclusively; empty otherwise. The key
# is stored as its two halves, and the single-argument form of pg_advisory_lock is the one with
# objsubid 1.
lock_holder() {
  query "SELECT coalesce(max(l.pid)::text, '')
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ExclusiveLock'
           AND l.objsubid = 1 AND l.classid::bigint * 4294967296 + l.objid::bigint = $lock_key
           AND a.application_name = '$lock_name'"
}

echo "stopping the API so the database and the store describe one moment" >&2
$compose stop api || fail 'the API could not be stopped'

echo "taking the maintenance lock" >&2
$compose --profile tools run --detach --name "$lock_container" -T \
  --env "PGAPPNAME=$lock_name" operator \
  psql --no-password --no-psqlrc --quiet \
  -c 'SET statement_timeout = 0' \
  -c "SELECT pg_advisory_lock($lock_key)" \
  -c "SELECT pg_sleep($lock_seconds)" >/dev/null \
  || fail 'the locking session could not be started'

i=0
while [ -z "$lock_pid" ]; do
  lock_pid=$(lock_holder) || fail 'the maintenance lock could not be inspected'
  [ -n "$lock_pid" ] && break
  i=$((i + 1))
  [ "$i" -lt 10 ] || \
    fail 'this backup could not take the maintenance lock; is a retention pass running?'
  sleep 2
done
echo "   held by session $lock_pid" >&2

# The schema version, from the application's own command: a deployment script has no business
# knowing the name of a table. The command exits zero only when the schema is current, so the
# version it reports is the version that is applied.
schema_json=$($compose run --rm -T --entrypoint qe-report-admin api schema --json 2>/dev/null) \
  || fail 'the schema is not current, or could not be read'
schema=$(printf '%s' "$schema_json" | sed -n 's/.*"expectedVersion": *\([0-9]*\).*/\1/p' | head -1)
server=$(query 'SHOW server_version') || fail 'the PostgreSQL version could not be read'
# Empty would still write a manifest, and an empty schemaVersion is not even JSON.
case $schema in ''|*[!0-9]*) fail 'the schema version did not come back as a number' ;; esac
[ -n "$server" ] || fail 'the PostgreSQL version came back empty'

echo "dumping the database" >&2
$compose --profile tools run --rm -T \
  --volume "$(cd "$target" && pwd):/out" \
  operator pg_dump --no-password --format=custom --no-owner --no-privileges --file=/out/database.dump \
  || fail 'pg_dump did not succeed'

echo "copying the attachment store, as opaque files" >&2
# A tar of the store's own layout: content-addressed paths, byte for byte, nothing decoded.
$compose --profile tools run --rm -T \
  --volume "$(cd "$target" && pwd):/out" \
  operator tar --create --file=/out/blobs.tar --directory=/var/lib/qe-report blobs \
  || fail 'the attachment store could not be copied'

# The same session, still holding it. If it is gone, something could have run between the two
# halves above and this pair of files cannot be shown to describe one moment.
still=$(lock_holder) || fail 'the maintenance lock could not be inspected'
[ -n "$still" ] && [ "$still" = "$lock_pid" ] || \
  fail 'the maintenance lock was not held for the whole backup; this backup is not consistent'

echo "checksumming" >&2
# Computed where the files were written, so the backup does not depend on which checksum tool the
# operator's own machine happens to have.
$compose --profile tools run --rm -T \
  --volume "$(cd "$target" && pwd):/out" \
  operator bash -c 'cd /out && sha256sum database.dump blobs.tar > checksums.sha256' \
  || fail 'checksums could not be written'
database_sha=$(awk '/database\.dump$/ {print $1}' "$target/checksums.sha256")
blobs_sha=$(awk '/blobs\.tar$/ {print $1}' "$target/checksums.sha256")
[ -n "$database_sha" ] && [ -n "$blobs_sha" ] || fail 'a checksum is missing'

image=${QE_REPORT_IMAGE:-qe-report:local}
# From the image that was serving, not from whatever this checkout happens to be on: those two
# disagree the moment an operator backs up a deployment they did not just build.
revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$image" 2>/dev/null || echo '')
[ -n "$revision" ] || revision=unknown

# The manifest is written last, and its presence is what makes the backup complete. It records no
# password, no API key, and no private key: a backup's own contents are sensitive enough.
cat > "$target/manifest.json" <<MANIFEST || fail 'the manifest could not be written'
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sourceRevision": "$revision",
  "image": "$image",
  "schemaVersion": $schema,
  "postgresVersion": "$server",
  "database": { "file": "database.dump", "format": "pg_dump custom", "sha256": "$database_sha" },
  "blobs": { "file": "blobs.tar", "layout": "content-addressed, unchanged", "sha256": "$blobs_sha" },
  "contains": ["postgresql", "attachment store"],
  "excludes": ["staging", "edge logs", "tls private keys", "secrets"]
}
MANIFEST

# The manifest is inside the integrity envelope too, so an altered one is caught by the same check
# rather than only where a field happens to be read.
$compose --profile tools run --rm -T \
  --volume "$(cd "$target" && pwd):/out" \
  operator bash -c 'cd /out && sha256sum manifest.json >> checksums.sha256 && chmod 0600 database.dump blobs.tar checksums.sha256' \
  || fail 'the manifest could not be checksummed'

release_lock

echo "starting the API again" >&2
restarted=1
$compose start api || fail 'the API could not be started again'

# Ready, not merely running: the database and both roots have to be usable.
i=0
until $compose exec -T api node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail 'the API did not become ready after the backup'
  sleep 2
done

echo "backup $name complete in $target" >&2
