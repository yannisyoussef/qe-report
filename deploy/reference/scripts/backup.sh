#!/bin/sh
# A quiesced backup of the reference deployment: the database and the attachment store, taken
# together, with the API stopped.
#
#   ./scripts/backup.sh [name]
#
# Why the API is stopped. An ingestion publishes attachment bytes before it commits the database
# rows that reference them, and destructive maintenance is something an operator starts, never a
# timer. With no writer running, a dump and a copy of the store describe the same moment. This is
# not a zero-downtime backup and is not claimed to be one.
#
# The operator must also not run retention, a rebuild, or staging cleanup while this runs. Nothing
# here can detect that; it is a procedure, not a lock.
#
# Anything that fails leaves the backup directory behind, marked incomplete by the absence of
# manifest.json, and exits non-zero. A partial backup is never reported as a backup.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"

name=${1:-$(date -u +%Y%m%dT%H%M%SZ)}
backups=${QE_REPORT_BACKUP_DIR:-./backups}
target="$backups/$name"
compose="docker compose"

if [ -e "$target" ]; then
  echo "backup $name already exists at $target" >&2
  exit 1
fi
mkdir -p "$target"

fail() {
  echo "backup failed: $1" >&2
  echo "the incomplete backup is at $target; it has no manifest.json and must not be restored" >&2
  exit 1
}

echo "stopping the API so the database and the store describe one moment" >&2
$compose stop api || fail 'the API could not be stopped'

# The schema version and the server's major, recorded from the database itself.
schema=$($compose --profile tools run --rm -T operator \
  psql --no-password --no-psqlrc --quiet --tuples-only --no-align \
  -c 'SELECT coalesce(max(version)::text, 0::text) FROM qe_schema_migrations' 2>/dev/null | tr -d '\r') \
  || fail 'the schema version could not be read'
server=$($compose --profile tools run --rm -T operator \
  psql --no-password --no-psqlrc --quiet --tuples-only --no-align -c 'SHOW server_version' 2>/dev/null | tr -d '\r') \
  || fail 'the PostgreSQL version could not be read'

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

revision=${SOURCE_REVISION:-$(git -C "$here/../.." rev-parse --short HEAD 2>/dev/null || echo unknown)}
image=${QE_REPORT_IMAGE:-qe-report:local}

# The manifest is written last, and its presence is what makes the backup complete. It records no
# password, no API key, and no private key: a backup's own contents are sensitive enough.
cat > "$target/manifest.json" <<MANIFEST
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

echo "starting the API again" >&2
$compose start api || fail 'the API could not be started again'

# Ready, not merely running: the database and both roots have to be usable.
i=0
until $compose exec -T api node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail 'the API did not become ready after the backup'
  sleep 2
done

echo "backup $name complete in $target" >&2
