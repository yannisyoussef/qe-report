#!/bin/sh
# Creates the two credentials the reference deployment needs, in ./secrets, with a random
# password. Nothing here is committed: see .gitignore beside compose.yaml.
#
#   ./scripts/secrets.sh
#
# Run it once. Running it again would issue a new password that the existing database would not
# accept; to rotate, change it in PostgreSQL and rewrite both files together.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
secrets=${QE_REPORT_SECRET_DIR:-"$here/secrets"}
db=${POSTGRES_DB:-qe_report}
user=${POSTGRES_USER:-qe_report}

mkdir -p "$secrets"
chmod 0700 "$secrets"

if [ -e "$secrets/postgres_password" ]; then
  echo "secrets already exist in $secrets; remove them deliberately before writing new ones" >&2
  exit 1
fi

# 32 bytes of randomness, in an alphabet a connection string needs no escaping for.
password=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 43)

umask 077
printf '%s' "$password" > "$secrets/postgres_password"
# The API reads its whole connection string from a file; the host name is the compose service.
printf 'postgres://%s:%s@postgres:5432/%s' "$user" "$password" "$db" > "$secrets/database_url"
# The operator image authenticates the same way, through a password file of PostgreSQL's own form.
# The database field is a wildcard on purpose: a restore connects to `postgres` to replace the
# reporting database, and an entry naming only that database would leave it prompting for a
# password it can never be given.
printf 'postgres:5432:*:%s:%s\n' "$user" "$password" > "$secrets/pgpass"
chmod 0600 "$secrets/postgres_password" "$secrets/database_url" "$secrets/pgpass"

echo "wrote postgres_password, database_url and pgpass to $secrets" >&2
