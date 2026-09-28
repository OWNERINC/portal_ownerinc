#!/usr/bin/env bash
set -euo pipefail

base_url=${BASE_URL:-http://127.0.0.1:${HTTP_PORT:-80}}
base_url=${base_url%/}
# Exercise the same Origin browsers send on writes. A plain health GET misses
# proxy/CORS failures even when the application is otherwise ready.
authority=${base_url#*://}
origin=${base_url%%://*}://${authority%%/*}
attempts=${SMOKE_ATTEMPTS:-30}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  liveness=$(curl --fail --silent --show-error --max-time 5 "$base_url/api/health" 2>/dev/null || true)
  readiness=$(curl --fail --silent --show-error --max-time 5 "$base_url/api/ready" 2>/dev/null || true)
  same_origin=$(curl --fail --silent --show-error --max-time 5 --header "Origin: $origin" "$base_url/api/health" 2>/dev/null || true)
  canonical=$(curl --fail --silent --show-error --max-time 5 "$base_url/autocard.html" 2>/dev/null || true)
  legacy=$(curl --fail --silent --show-error --max-time 5 "$base_url/autocard/" 2>/dev/null || true)
  if [[ $liveness == *'"status":"ok"'* ]] && [[ $readiness == *'"status":"ready"'* ]] \
    && [[ $same_origin == *'"status":"ok"'* ]] \
    && curl --fail --silent --show-error --max-time 5 --output /dev/null "$base_url/" \
    && [[ $canonical == *'class="portal-wrapper"'* ]] \
    && [[ $canonical == *'class="sidebar"'* ]] \
    && [[ $canonical == *'class="topbar"'* ]] \
    && [[ $canonical == *'id="main-content"'* ]] \
    && [[ $canonical == *'src="./autocard/entry.js"'* ]] \
    && [[ $legacy == *'url=../autocard.html'* ]] \
    && [[ $legacy == *'href="../autocard.html"'* ]]; then
    printf '{"check":"smoke","status":"ok","attempt":%d}\n' "$attempt"
    exit 0
  fi
  sleep 2
done

printf '{"check":"smoke","status":"failed","attempts":%d}\n' "$attempts" >&2
exit 1
