#!/bin/sh
# Proves a running deployment works, through the public interfaces only.
#
#   ./scripts/smoke.sh <completed run directory>
#
# Everything goes through the TLS edge, with the certificate verified normally. Nothing here reads
# PostgreSQL or the attachment store directly: a deployment that only passes a database query has
# not been shown to serve anyone.
#
# It uses the operator command for the one thing that is deliberately not an HTTP route, issuing a
# key, and the real producer command to upload. An existing key may be supplied instead, and is
# then left exactly as it was found:
#
#   QE_REPORT_API_KEY=qer_k1_... ./scripts/smoke.sh <run directory>
#
# The edge's certificate is verified against the host's trust store, which is what a deployment
# with a real certificate needs. A rehearsal certificate signed by scripts/dev-tls.sh is trusted
# instead when its authority is present, so the same script covers both cases.
#
# Needs `node` and `curl`. The run directory should be one with attachments and historical
# identities, because those are what steps 7 and 8 prove; set QE_REPORT_SMOKE_ALLOW_PARTIAL=1 to
# accept a run that has neither and a correspondingly weaker result.
set -eu

run_dir=${1:-}
[ -n "$run_dir" ] || { echo "usage: smoke.sh <completed run directory>" >&2; exit 2; }
# Whether it is a run directory is the producer command's question to answer, not this script's.
[ -d "$run_dir" ] || { echo "$run_dir is not a directory" >&2; exit 2; }

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
cd "$here"

port=${QE_REPORT_PUBLIC_PORT:-8443}
host=${QE_REPORT_SERVER_NAME:-localhost}
base=${QE_REPORT_SMOKE_URL:-"https://$host:$port"}
ca=${QE_REPORT_TLS_DIR:-./tls}/ca.crt
project=${QE_REPORT_SMOKE_PROJECT:-smoke}
upload=${QE_REPORT_UPLOAD_CMD:-"node $repo/ts/packages/http-client/dist/bin/upload.js"}
compose="docker compose"

work=$(mktemp -d "${TMPDIR:-/tmp}/qe-smoke.XXXXXX")
issued=''
cleanup() {
  status=$?
  # A key this script issued is this script's to withdraw, however it ends. One that was supplied
  # is left alone: it is not ours, and the caller may still be using it.
  if [ -n "$issued" ]; then
    $compose run --rm -T --entrypoint qe-report-admin api key revoke --public-id "$issued" \
      >/dev/null 2>&1 || echo "could not revoke the smoke key $issued; revoke it by hand" >&2
  fi
  rm -rf "$work"
  exit $status
}
trap cleanup EXIT INT TERM

# Everything that is not a per-request option lives in one curl configuration file: the token,
# because `ps` and the host's process accounting would otherwise hold a live credential, and the
# authority, because a path is not safe to leave unquoted in a variable.
config="$work/curl.conf"
: > "$config"
chmod 0600 "$config"
get() { curl --silent --show-error --fail --config "$config" "$@"; }

if [ -f "$ca" ]; then
  echo "verifying the edge against the authority in $ca" >&2
  node_ca=$(cd "$(dirname "$ca")" && pwd)/$(basename "$ca")
  printf 'cacert = "%s"\n' "$node_ca" >> "$config"
else
  echo "verifying the edge against the host's trust store" >&2
  node_ca=''
fi

echo "1. the process is alive" >&2
get "$base/healthz" > /dev/null

echo "2. its dependencies are usable" >&2
get "$base/readyz" > /dev/null

if [ -n "${QE_REPORT_API_KEY:-}" ]; then
  token=$QE_REPORT_API_KEY
  echo "3. using the key from the environment" >&2
else
  echo "3. issuing a short-lived key for project $project" >&2
  # An hour, and revoked on the way out: a verification run must not leave a credential behind
  # that outlives it and that nobody holds.
  expires=$(node -e 'process.stdout.write(new Date(Date.now()+3600000).toISOString())')
  created=$($compose run --rm -T --entrypoint qe-report-admin api \
    key create --project "$project" --scope runs:read --scope runs:write \
    --expires-at "$expires" --label 'deployment smoke' 2>"$work/key.err") || {
    cat "$work/key.err" >&2; echo "no key was issued" >&2; exit 1; }
  token=$(printf '%s' "$created" | tr -d '\r\n')
  [ -n "$token" ] || { echo "no key was issued" >&2; exit 1; }
  # The public id is the part of the token before the secret, and is what revocation names.
  issued=$(printf '%s' "$token" | cut -d_ -f3)
fi
printf 'header = "Authorization: Bearer %s"\n' "$token" >> "$config"

echo "4. uploading a completed run through the edge" >&2
# The real producer command, verifying the edge's certificate the ordinary way. The key reaches it
# through the environment, never an argument.
# Exported rather than prefixed: a variable assignment produced by an expansion is a command
# name, not an assignment, in every POSIX shell.
(
  export QE_REPORT_API_KEY=$token
  if [ -n "$node_ca" ]; then export NODE_EXTRA_CA_CERTS=$node_ca; fi
  $upload --run-dir "$run_dir" --url "$base" --retention-ms 86400000 --json
) > "$work/upload.json"
run_id=$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.runId??"")' "$work/upload.json")
ref=$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.runRef??"")' "$work/upload.json")
[ -n "$run_id" ] && [ -n "$ref" ] || { echo "the upload did not report a run" >&2; exit 1; }
echo "   uploaded $run_id" >&2

echo "5. listing runs" >&2
get "$base/v1/runs?limit=10" > "$work/runs.json"
grep -q "$run_id" "$work/runs.json" || { echo "the run is not in the listing" >&2; exit 1; }

echo "6. reading that exact run" >&2
get "$base/v1/runs/$ref" > "$work/run.json"
grep -q '"sessions"' "$work/run.json" || { echo "the run did not come back projected" >&2; exit 1; }

# Read from the projection's own shape rather than from whichever line a pattern matched first:
# the attachment digest has to come from the attachments array, not from anywhere a hash appears.
facts=$(node -e '
  const run = require(process.argv[1]);
  const execution = (run.executions ?? []).find((e) => e.runnerName && e.test?.historicalId);
  const attachment = (run.attachments ?? [])[0];
  process.stdout.write(
    [execution?.runnerName ?? "", execution?.test?.historicalId ?? "", attachment?.sha256 ?? ""].join("\n"),
  );
' "$work/run.json")
runner=$(printf '%s' "$facts" | sed -n 1p)
historical=$(printf '%s' "$facts" | sed -n 2p)
sha=$(printf '%s' "$facts" | sed -n 3p)

partial=${QE_REPORT_SMOKE_ALLOW_PARTIAL:-0}
if [ -n "$runner" ] && [ -n "$historical" ]; then
  echo "7. the history of one test, and its flakiness" >&2
  query=$(printf '{"runnerName":"%s","historicalId":"%s"}' "$runner" "$historical")
  get --header 'Content-Type: application/json' --data "$query" "$base/v1/history/query" > /dev/null
  get --header 'Content-Type: application/json' --data "$query" "$base/v1/flakiness/query" > /dev/null
elif [ "$partial" = '1' ]; then
  echo "7. this run carries no historical identity; skipped as permitted" >&2
else
  echo "7. this run carries no historical identity, so history and flakiness were not proven;" >&2
  echo "   use a run that has one, or set QE_REPORT_SMOKE_ALLOW_PARTIAL=1" >&2
  exit 1
fi

if [ -n "$sha" ]; then
  echo "8. downloading an attachment" >&2
  get --output "$work/attachment" "$base/v1/runs/$ref/attachments/$sha"
  # openssl rather than sha256sum, which this machine may not have.
  actual=$(openssl dgst -sha256 "$work/attachment" | sed 's/.*= *//')
  [ "$actual" = "$sha" ] || { echo "the attachment came back as different bytes" >&2; exit 1; }
  echo "   $sha verified byte for byte" >&2
elif [ "$partial" = '1' ]; then
  echo "8. this run carries no attachment; skipped as permitted" >&2
else
  echo "8. this run carries no attachment, so the byte path was not proven;" >&2
  echo "   use a run that has one, or set QE_REPORT_SMOKE_ALLOW_PARTIAL=1" >&2
  exit 1
fi

echo "the deployment serves $run_id over HTTPS" >&2
