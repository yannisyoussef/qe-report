#!/bin/sh
# Restores a backup into this deployment, destroying what is there now.
#
#   ./scripts/restore.sh <name> --yes
#
# It replaces the database and the attachment store wholesale. It does not merge: a backup and a
# live archive are two different histories, and combining them would produce a third that neither
# describes. Restore into an empty or replaced deployment. `--yes` is required, because everything
# now in this deployment is about to be destroyed and no copy of it is taken first.
#
# Every step is checked, and the API is not started if any of them failed. A bad checksum, a
# manifest whose digests disagree with the files, a different PostgreSQL major, a failed database
# or store restore, or a schema the current binary does not recognise all stop the procedure.
#
# A backup directory is a trust boundary. pg_restore executes whatever the dump contains, as the
# reporting role, and checksums.sha256 lives beside the files it describes, so anyone who can
# rewrite one can rewrite the other. Protect a backup exactly as you protect the database.
set -eu

name=''
confirmed=0
for argument in "$@"; do
  case $argument in
    --yes) confirmed=1 ;;
    -*) echo "unknown option $argument" >&2; exit 2 ;;
    *) [ -z "$name" ] || { echo "only one backup name may be given" >&2; exit 2; }; name=$argument ;;
  esac
done
[ -n "$name" ] || { echo "usage: restore.sh <backup name> --yes" >&2; exit 2; }
case $name in
  .* | */* | *[!A-Za-z0-9._-]*)
    echo "a backup name may hold letters, digits, dot, dash and underscore, and may not begin with a dot" >&2
    exit 2
    ;;
esac
if [ "$confirmed" -eq 0 ]; then
  echo "restore.sh destroys the database and the attachment store in this deployment and replaces" >&2
  echo "them with $name. Nothing is copied first. Pass --yes to proceed." >&2
  exit 2
fi

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
# Verified with the same tool that wrote them, for the same reason. The manifest is one of the
# checked files, so an altered manifest fails here rather than at whichever field happens to be
# read later.
$compose --profile tools run --rm -T \
  --volume "$(cd "$source" && pwd):/in:ro" \
  operator bash -c 'cd /in && sha256sum --check --status checksums.sha256' \
  || fail 'a checksum does not match'

# And the digests the manifest itself records agree with the ones just verified: the two are
# written by separate steps, and a backup whose own two accounts of its contents disagree is not
# one to restore.
for file in database blobs; do
  case $file in
    database) recorded_file=database.dump ;;
    blobs) recorded_file=blobs.tar ;;
  esac
  recorded=$(sed -n "s/.*\"$file\": .*\"sha256\": \"\([0-9a-f]\{64\}\)\".*/\1/p" "$source/manifest.json")
  verified=$(awk -v f="$recorded_file" '$2 == f || $2 == "*" f {print $1}' "$source/checksums.sha256")
  [ -n "$recorded" ] || fail "the manifest records no digest for $recorded_file"
  [ "$recorded" = "$verified" ] || \
    fail "the manifest's digest for $recorded_file is not the one in checksums.sha256"
done

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
# These two are interpolated into SQL identifiers below. They come from the operator's own
# environment rather than from anywhere hostile, which is a reason to check them cheaply, not a
# reason to skip it.
for identifier in "$db" "$user"; do
  case $identifier in
    '' | *[!A-Za-z0-9_]* | [0-9]*)
      fail "POSTGRES_DB and POSTGRES_USER must be plain SQL identifiers; got $identifier"
      ;;
  esac
done

echo "replacing the database" >&2
# Dropped and recreated rather than restored over: whatever is there now is not this backup.
# Standard error is kept: when this fails, its reason is the only useful thing there is.
$compose --profile tools run --rm -T operator \
  psql --dbname=postgres --quiet --no-psqlrc \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid()" \
  -c "DROP DATABASE IF EXISTS \"$db\"" \
  -c "CREATE DATABASE \"$db\" OWNER \"$user\"" >/dev/null \
  || fail 'the database could not be replaced'

$compose --profile tools run --rm -T \
  --volume "$(cd "$source" && pwd):/in:ro" \
  operator pg_restore --no-password --dbname="$db" --no-owner --no-privileges --exit-on-error /in/database.dump \
  || fail 'pg_restore did not succeed'

echo "replacing the attachment store" >&2
# Emptied first: a store that still held objects from another history would be a third archive.
# Extracted without the archive's own owners and modes: this runs as root, and GNU tar would
# otherwise restore whatever uid and mode the tar claims. An object the API cannot read, or cannot
# let retention delete, would wedge the attachment store permanently. The store's owner is set
# afterwards, once, to the user the application runs as.
$compose --profile tools run --rm -T \
  --volume "$(cd "$source" && pwd):/in:ro" \
  operator sh -c 'set -e
    rm -rf /var/lib/qe-report/blobs/* /var/lib/qe-report/blobs/.[!.]* 2>/dev/null || true
    tar --extract --no-same-owner --no-same-permissions --numeric-owner \
      --file=/in/blobs.tar --directory=/var/lib/qe-report
    chown -R 10001:10001 /var/lib/qe-report/blobs
    chmod 0700 /var/lib/qe-report/blobs' \
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
# The keys came back with the database, including any that were revoked after the backup was taken.
echo "note: this restored the API keys as they were when the backup was taken. A key revoked since" >&2
echo "      then authenticates again now. Review them with:" >&2
echo "        docker compose run --rm --entrypoint qe-report-admin api key list --all" >&2
echo "      and revoke anything that should not be live." >&2
