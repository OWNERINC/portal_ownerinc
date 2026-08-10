#!/usr/bin/env bash
set -euo pipefail

base_url=${BASE_URL:-http://127.0.0.1:${HTTP_PORT:-80}}
attempts=${SMOKE_ATTEMPTS:-30}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  liveness=$(curl --fail --silent --show-error --max-time 5 "$base_url/api/health" 2>/dev/null || true)
  readiness=$(curl --fail --silent --show-error --max-time 5 "$base_url/api/ready" 2>/dev/null || true)
  canonical=$(curl --fail --silent --show-error --max-time 5 "$base_url/autocard.html" 2>/dev/null || true)
  legacy=$(curl --fail --silent --show-error --max-time 5 "$base_url/autocard/" 2>/dev/null || true)
  if [[ $liveness == *'"status":"ok"'* ]] && [[ $readiness == *'"status":"ready"'* ]] \
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
