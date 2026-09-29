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
# key, and the real producer command to upload. An existing key may be supplied instead:
#
#   QE_REPORT_API_KEY=qer_k1_... ./scripts/smoke.sh <run directory>
set -eu

run_dir=${1:-}
[ -n "$run_dir" ] || { echo "usage: smoke.sh <completed run directory>" >&2; exit 2; }
[ -d "$run_dir/events" ] || { echo "$run_dir is not a completed run directory" >&2; exit 2; }

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

[ -f "$ca" ] || { echo "no certificate authority at $ca to verify the edge with" >&2; exit 2; }
get() { curl --silent --show-error --fail --cacert "$ca" "$@"; }

echo "1. the process is alive" >&2
get "$base/healthz" > /dev/null

echo "2. its dependencies are usable" >&2
get "$base/readyz" > /dev/null

if [ -n "${QE_REPORT_API_KEY:-}" ]; then
  token=$QE_REPORT_API_KEY
  echo "3. using the key from the environment" >&2
else
  echo "3. issuing a key for project $project" >&2
  token=$($compose run --rm -T --entrypoint qe-report-admin api \
    key create --project "$project" --scope runs:read --scope runs:write \
    --label 'deployment smoke' 2>/dev/null | tr -d '\r\n')
  [ -n "$token" ] || { echo "no key was issued" >&2; exit 1; }
fi
auth="Authorization: Bearer $token"

echo "4. uploading a completed run through the edge" >&2
# The real producer command, verifying the edge's certificate the ordinary way. The key reaches it
# through the environment, never an argument.
QE_REPORT_API_KEY=$token NODE_EXTRA_CA_CERTS=$(cd "$(dirname "$ca")" && pwd)/$(basename "$ca") \
  $upload --run-dir "$run_dir" --url "$base" --retention-ms 86400000 --json > /tmp/qe-smoke-upload.json
run_id=$(sed -n 's/.*"runId": *"\([^"]*\)".*/\1/p' /tmp/qe-smoke-upload.json | head -1)
[ -n "$run_id" ] || { echo "the upload did not report a run id" >&2; exit 1; }
echo "   uploaded $run_id" >&2

echo "5. listing runs" >&2
get --header "$auth" "$base/v1/runs?limit=10" > /tmp/qe-smoke-runs.json
grep -q "$run_id" /tmp/qe-smoke-runs.json || { echo "the run is not in the listing" >&2; exit 1; }

echo "6. reading that exact run" >&2
ref=$(sed -n 's/.*"runRef": *"\([^"]*\)".*/\1/p' /tmp/qe-smoke-upload.json | head -1)
[ -n "$ref" ] || { echo "the upload did not report a run reference" >&2; exit 1; }
get --header "$auth" "$base/v1/runs/$ref" > /tmp/qe-smoke-run.json
grep -q '"sessions"' /tmp/qe-smoke-run.json || { echo "the run did not come back projected" >&2; exit 1; }

runner=$(sed -n 's/.*"runnerName": *"\([^"]*\)".*/\1/p' /tmp/qe-smoke-run.json | head -1)
historical=$(sed -n 's/.*"historicalId": *"\([^"]*\)".*/\1/p' /tmp/qe-smoke-run.json | head -1)
if [ -n "$runner" ] && [ -n "$historical" ]; then
  echo "7. the history of one test, and its flakiness" >&2
  query=$(printf '{"runnerName":"%s","historicalId":"%s"}' "$runner" "$historical")
  get --header "$auth" --header 'Content-Type: application/json' \
    --data "$query" "$base/v1/history/query" > /dev/null
  get --header "$auth" --header 'Content-Type: application/json' \
    --data "$query" "$base/v1/flakiness/query" > /dev/null
else
  echo "7. the run carries no historical identity; skipping history and flakiness" >&2
fi

sha=$(sed -n 's/.*"sha256": *"\([0-9a-f]\{64\}\)".*/\1/p' /tmp/qe-smoke-run.json | head -1)
if [ -n "$sha" ]; then
  echo "8. downloading an attachment" >&2
  get --header "$auth" --output /tmp/qe-smoke-attachment "$base/v1/runs/$ref/attachments/$sha"
  actual=$(sha256sum /tmp/qe-smoke-attachment | cut -d' ' -f1)
  [ "$actual" = "$sha" ] || { echo "the attachment came back as different bytes" >&2; exit 1; }
  echo "   $sha verified byte for byte" >&2
else
  echo "8. the run carries no attachment; skipping the download" >&2
fi

rm -f /tmp/qe-smoke-upload.json /tmp/qe-smoke-runs.json /tmp/qe-smoke-run.json /tmp/qe-smoke-attachment
echo "the deployment serves $run_id over HTTPS" >&2
