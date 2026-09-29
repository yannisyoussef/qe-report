#!/bin/sh
# A certificate for a rehearsal, issued by a temporary authority this script also creates.
#
#   ./scripts/dev-tls.sh localhost
#
# It exists so that a rehearsal can use real TLS, verified normally: the producer and the smoke
# test trust ./tls/ca.crt, and nothing anywhere turns certificate verification off. It is not for
# production. A real deployment mounts a certificate its own organisation issued; how that is
# issued is deliberately outside this reference.
set -eu

name=${1:-localhost}
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tls=${QE_REPORT_TLS_DIR:-"$here/tls"}

mkdir -p "$tls"
chmod 0700 "$tls"
umask 077

# The authority.
openssl req -x509 -newkey rsa:2048 -sha256 -days 30 -nodes \
  -keyout "$tls/ca.key" -out "$tls/ca.crt" \
  -subj "/CN=qe-report rehearsal authority" \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null

# The server's key and a request for it.
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$tls/server.key" -out "$tls/server.csr" \
  -subj "/CN=$name" 2>/dev/null

cat > "$tls/server.ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$name,DNS:localhost,IP:127.0.0.1,IP:::1
EXT

openssl x509 -req -in "$tls/server.csr" -sha256 -days 30 \
  -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -extfile "$tls/server.ext" -out "$tls/server.crt" 2>/dev/null

rm -f "$tls/server.csr" "$tls/server.ext" "$tls/ca.srl"
# The edge reads these as a user that is not root.
chmod 0644 "$tls/ca.crt" "$tls/server.crt"
chmod 0640 "$tls/server.key"

echo "issued a rehearsal certificate for $name in $tls (trust $tls/ca.crt)" >&2
