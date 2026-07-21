#!/usr/bin/env bash
set -euo pipefail

base_url=${BASE_URL:-http://127.0.0.1:${HTTP_PORT:-80}}
attempts=${SMOKE_ATTEMPTS:-30}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  health=$(curl --fail --silent --show-error --max-time 5 "$base_url/api/ready" 2>/dev/null || true)
  if [[ $health == *'"status":"ready"'* ]] && curl --fail --silent --show-error --max-time 5 --output /dev/null "$base_url/"; then
    printf '{"check":"smoke","status":"ok","attempt":%d}\n' "$attempt"
    exit 0
  fi
  sleep 2
done

printf '{"check":"smoke","status":"failed","attempts":%d}\n' "$attempts" >&2
exit 1
