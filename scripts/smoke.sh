#!/usr/bin/env bash
set -euo pipefail

base_url=${BASE_URL:-http://127.0.0.1:${HTTP_PORT:-80}}
base_url=${base_url%/}
# Exercise the same Origin browsers send on writes. A plain health GET misses
# proxy/CORS failures even when the application is otherwise ready.
authority=${base_url#*://}
origin=${base_url%%://*}://${authority%%/*}
attempts=${SMOKE_ATTEMPTS:-30}

# Do not retain a partial body when curl fails (for example, a truncated
# transfer containing the expected markers before the connection was lost).
fetch_resource() {
  local resource=$1 body
  shift
  body=$(curl --fail --silent --show-error --max-time 5 "$@" "$base_url/$resource" 2>/dev/null) || return 1
  printf '%s' "$body"
}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  liveness=$(fetch_resource api/health || true)
  readiness=$(fetch_resource api/ready || true)
  same_origin=$(fetch_resource api/health --header "Origin: $origin" || true)
  canonical=$(fetch_resource autocard.html || true)
  legacy=$(fetch_resource autocard/ || true)
  bootstrap=$(fetch_resource js/router-bootstrap.js || true)
  router=$(fetch_resource js/router.js || true)
  entry=$(fetch_resource autocard/entry.js || true)
  if [[ $liveness == *'"status":"ok"'* ]] && [[ $readiness == *'"status":"ready"'* ]] \
    && [[ $same_origin == *'"status":"ok"'* ]] \
    && fetch_resource '' >/dev/null \
    && [[ $canonical == *'class="portal-wrapper"'* ]] \
    && [[ $canonical == *'class="sidebar"'* ]] \
    && [[ $canonical == *'class="topbar"'* ]] \
    && [[ $canonical == *'id="main-content"'* ]] \
    && [[ $canonical == *'<script type="module" src="./js/router-bootstrap.js"></script>'* ]] \
    && [[ $bootstrap == *"import { startRouter } from './router.js';"* ]] \
    && [[ $bootstrap == *'void startRouter();'* ]] \
    && [[ $router == *'export const routes = Object.freeze({'* ]] \
    && [[ $router == *"'/autocard.html': '../autocard/entry.js'"* ]] \
    && [[ $router == *'export async function startRouter() {'* ]] \
    && [[ $router == *'import(routes[initialURL.pathname])'* ]] \
    && [[ $router == *'mountPage(module, user, activeURL);'* ]] \
    && [[ $router == *$'\n}' ]] \
    && [[ $entry == *"import { mount as mountEditor } from './app.js';"* ]] \
    && [[ $entry == *'export function mount(page) {'* ]] \
    && [[ $entry == *'mountEditor(page);'* ]] \
    && [[ $entry == *$'\n}' ]] \
    && [[ $legacy == *'url=../autocard.html'* ]] \
    && [[ $legacy == *'href="../autocard.html"'* ]]; then
    printf '{"check":"smoke","status":"ok","attempt":%d}\n' "$attempt"
    exit 0
  fi
  if (( attempt < attempts )); then sleep 2; fi
done

printf '{"check":"smoke","status":"failed","attempts":%d}\n' "$attempts" >&2
exit 1
