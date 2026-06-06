#!/usr/bin/env bash
set -euo pipefail

live_dir="$(cd "$(dirname "$0")/.." && pwd)"
cert_dir="$live_dir/.certs"
config_path="$cert_dir/openssl-local.cnf"
key_path="$cert_dir/dev-key.pem"
cert_path="$cert_dir/dev-cert.pem"

mkdir -p "$cert_dir"

ip_raw="$(node -e 'const os=require("os");const out=[];for(const arr of Object.values(os.networkInterfaces())){for(const n of (arr||[])){if(n&&n.family==="IPv4"&&!n.internal)out.push(n.address)}};console.log(out.join("\n"));')"

{
  cat <<'EOF'
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[ dn ]
CN = mmlisp-local

[ v3_req ]
subjectAltName = @alt_names

[ alt_names ]
DNS.1 = localhost
IP.1 = 127.0.0.1
EOF

  idx=2
  while IFS= read -r ip; do
    if [[ -n "$ip" ]]; then
      echo "IP.$idx = $ip"
      idx=$((idx + 1))
    fi
  done <<< "$ip_raw"
} > "$config_path"

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "$key_path" \
  -out "$cert_path" \
  -config "$config_path" \
  -extensions v3_req >/dev/null 2>&1

echo "Generated local HTTPS cert: $cert_path"
echo "Generated local HTTPS key:  $key_path"
