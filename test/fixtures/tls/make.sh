#!/bin/sh
# Test-only certificates for the HTTPS tests, valid for a hundred years: one
# self-signed, as Signal K makes its own, and two issued by a CA that the
# server sends along, as signalk-ssl sets it up and later renews. None names
# 127.0.0.1, the address the tests use. Run in this folder to make them again.
set -eu
days=36500
ec='-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes'
openssl req -x509 $ec -keyout self-signed-key.pem -out self-signed.pem -days $days -subj /CN=localhost
openssl req -x509 $ec -keyout ca-key.pem -out ca.pem -days $days -subj '/CN=Test Local CA' \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign
printf 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:boat.local\nextendedKeyUsage=serverAuth\n' > leaf.ext
for leaf in leaf renewed; do
  openssl req -new $ec -keyout $leaf-key.pem -subj /CN=boat.local |
    openssl x509 -req -CA ca.pem -CAkey ca-key.pem -days $days -extfile leaf.ext -out $leaf.pem
done
# Nothing is issued later, so the CA's key is not kept.
rm ca-key.pem leaf.ext
