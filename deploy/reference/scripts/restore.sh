#!/bin/sh
# Restores a backup into this deployment, destroying what is there now.
#
#   ./scripts/restore.sh <name>
#
# It replaces the database and the attachment store wholesale. It does not merge: a backup and a
# live archive are two different histories, and combining them would produce a third that neither
# describes. Restore into an empty or replaced deployment.
#
# Every step is checked, and the API is not started if any of them failed. A bad checksum, a
# manifest this code does not understand, a different PostgreSQL major, a failed database or store
# restore, or a schema the current binary does not recognise all stop the procedure.
set -eu

name=${1:-}
[ -n "$name" ] || { echo "usage: restore.sh <backup name>" >&2; exit 2; }

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"
backups=${QE_REPORT_BACKUP_DIR:-./backups}
source="$backups/$name"
compose="docker compose"

fail() {
  echo "restore failed: $1" >&2
  echo "the API has not been started; the deployment is in an incomplete state" >&2
  exit 1
}

[ -d "$source" ] || fail "no backup named $name in $backups"
[ -f "$source/manifest.json" ] || fail 'the backup has no manifest.json, so it is incomplete'
[ -f "$source/database.dump" ] || fail 'the backup has no database.dump'
[ -f "$source/blobs.tar" ] || fail 'the backup has no blobs.tar'

echo "verifying checksums" >&2
# Verified with the same tool that wrote them, for the same reason.
$compose --profile tools run --rm -T \
  --volume "$(cd "$source" && pwd):/in:ro" \
  operator bash -c 'cd /in && sha256sum --check --status checksums.sha256' \
  || fail 'a checksum does not match'

# The dump format is tied to the server major that wrote it.
backed_up_major=$(sed -n 's/.*"postgresVersion": *"\([0-9]*\).*/\1/p' "$source/manifest.json")
[ -n "$backed_up_major" ] || fail 'the manifest does not say which PostgreSQL version wrote it'

echo "stopping the API; a restore never runs underneath a writer" >&2
$compose stop api || fail 'the API could not be stopped'
$compose up -d postgres || fail 'PostgreSQL could not be started'
i=0
until $compose exec -T postgres pg_isready --quiet 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail 'PostgreSQL did not become ready'
  sleep 2
done

running_major=$($compose exec -T postgres sh -c 'postgres --version' 2>/dev/null | sed -n 's/.* \([0-9]*\)\..*/\1/p')
[ "$running_major" = "$backed_up_major" ] || \
  fail "the backup came from PostgreSQL $backed_up_major and this deployment runs $running_major"

db=${POSTGRES_DB:-qe_report}
user=${POSTGRES_USER:-qe_report}

echo "replacing the database" >&2
# Dropped and recreated rather than restored over: whatever is there now is not this backup.
$compose --profile tools run --rm -T operator \
  psql --dbname=postgres --quiet --no-psqlrc \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid()" \
  -c "DROP DATABASE IF EXISTS \"$db\"" \
  -c "CREATE DATABASE \"$db\" OWNER \"$user\"" >/dev/null 2>&1 \
  || fail 'the database could not be replaced'

$compose --profile tools run --rm -T \
  --volume "$(cd "$source" && pwd):/in:ro" \
  operator pg_restore --no-password --dbname="$db" --no-owner --no-privileges --exit-on-error /in/database.dump \
  || fail 'pg_restore did not succeed'

echo "replacing the attachment store" >&2
# Emptied first: a store that still held objects from another history would be a third archive.
$compose --profile tools run --rm -T \
  --volume "$(cd "$source" && pwd):/in:ro" \
  operator sh -c 'rm -rf /var/lib/qe-report/blobs/* /var/lib/qe-report/blobs/.[!.]* 2>/dev/null; tar --extract --file=/in/blobs.tar --directory=/var/lib/qe-report' \
  || fail 'the attachment store could not be replaced'

echo "verifying the schema this binary expects" >&2
$compose run --rm -T --entrypoint qe-report-admin api schema || \
  fail 'the restored schema is not the one this build expects; restore a backup that matches it, or upgrade'

echo "starting the API" >&2
$compose up -d api || fail 'the API could not be started'
i=0
until $compose exec -T api node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail 'the API did not become ready after the restore'
  sleep 2
done

# The deployment is not restored until it serves again: the edge is the only way in.
echo "starting the edge" >&2
$compose up -d edge || fail 'the edge could not be started'
i=0
until $compose exec -T edge curl --fail --silent --insecure https://127.0.0.1:8443/readyz > /dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail 'the deployment did not answer through the edge after the restore'
  sleep 2
done

echo "restore of $name complete; verify it with ./scripts/smoke.sh before trusting it" >&2
