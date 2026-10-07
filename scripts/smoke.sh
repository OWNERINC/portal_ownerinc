#!/usr/bin/env bash
set -euo pipefail

base_url=${BASE_URL:-http://127.0.0.1:${HTTP_PORT:-80}}
base_url=${base_url%/}
# Exercise the same Origin browsers send on writes. A plain health GET misses
# proxy/CORS failures even when the application is otherwise ready.
authority=${base_url#*://}
origin=${base_url%%://*}://${authority%%/*}
attempts=${SMOKE_ATTEMPTS:-30}
temporary_dir=$(mktemp -d)
trap 'rm -rf "$temporary_dir"' EXIT

# Do not retain a partial body when curl fails (for example, a truncated
# transfer containing the expected markers before the connection was lost).
fetch_resource() {
  local resource=$1 body
  shift
  body=$(curl --fail --silent --show-error --max-time 5 "$@" "$base_url/$resource" 2>/dev/null) || return 1
  printf '%s' "$body"
}

fetch_status() {
  local resource=$1 status
  status=$(curl --silent --show-error --max-time 5 --output /dev/null \
    --write-out '%{http_code}' "$base_url/$resource" 2>/dev/null) || return 1
  [[ $status =~ ^[0-9]{3}$ ]] || return 1
  printf '%s' "$status"
}

# Validate the response metadata as a browser does, and let curl reject an
# incomplete Content-Length/chunked transfer instead of accepting a prefix.
fetch_javascript() {
  local resource=$1 destination=$2 metadata status content_type
  metadata=$(curl --fail --silent --show-error --max-time 5 \
    --dump-header "$temporary_dir/headers" --output "$destination" \
    --write-out $'%{http_code}\n%{content_type}' "$base_url/$resource" 2>/dev/null) || return 1
  status=${metadata%%$'\n'*}
  content_type=${metadata#*$'\n'}
  status=${status%$'\r'}
  [[ $status == 200 ]] || return 1
  case ${content_type,,} in
    application/javascript*|text/javascript*|application/ecmascript*|text/ecmascript*) ;;
    *) return 1 ;;
  esac
  [[ -s $destination ]]
}

check_relative_editorial_redirect() {
  local status location
  status=$(curl --silent --show-error --max-time 5 --output /dev/null \
    --dump-header "$temporary_dir/redirect.headers" --write-out '%{http_code}' \
    "$base_url/editorial" 2>/dev/null) || return 1
  location=$(awk 'tolower($1) == "location:" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); value = $0 } END { print value }' \
    "$temporary_dir/redirect.headers")
  [[ $status == 308 && $location == /editorial/admin ]]
}

resolve_module() {
  local importer=$1 specifier=$2 path part
  local -a segments=() pieces=()
  if [[ $specifier == /* ]]; then
    path=$specifier
  else
    path="${importer%/*}/$specifier"
  fi
  IFS=/ read -r -a pieces <<< "$path"
  for part in "${pieces[@]}"; do
    case $part in
      ''|.) ;;
      ..)
        ((${#segments[@]})) || return 1
        segments=("${segments[@]:0:${#segments[@]}-1}")
        ;;
      *) segments+=("$part") ;;
    esac
  done
  (IFS=/; printf '%s' "${segments[*]}")
}

check_route_module_graph() {
  local router bootstrap index_html route module resource imports specifier dependency module_source
  local body_file="$temporary_dir/module.js" module_count=0
  local -a queue=()
  local -A visited=()

  fetch_javascript js/router-bootstrap.js "$temporary_dir/bootstrap.js" || return 1
  bootstrap=$(<"$temporary_dir/bootstrap.js")
  [[ $bootstrap == *"import { startRouter } from './router.js';"* ]] \
    && [[ $bootstrap == *'void startRouter();'* ]] || return 1

  # This transitive CMS dependency previously arrived as application/octet-stream.
  fetch_javascript js/owner-news/asset-path.mjs "$temporary_dir/asset-path.mjs" || return 1
  visited[js/owner-news/asset-path.mjs]=1

  index_html=$(fetch_resource index.html) || return 1
  [[ $index_html == *'<script type="module" src="./js/index.js"></script>'* ]] || return 1

  fetch_javascript js/router.js "$temporary_dir/router.js" || return 1
  router=$(<"$temporary_dir/router.js")
  [[ $router == *'export const routes = Object.freeze({'* ]] \
    && [[ $router == *"'/autocard.html': '../autocard/entry.js'"* ]] \
    && [[ $router == *'export async function startRouter() {'* ]] \
    && [[ $router == *'import(routes[initialURL.pathname])'* ]] \
    && [[ $router == *'mountPage(module, user, activeURL);'* ]] \
    && [[ $router == *$'\n}' ]] || return 1

  local route_map
  route_map=$(grep -E "^[[:space:]]*'/[^']+\\.html':[[:space:]]*'[^']+'" "$temporary_dir/router.js" \
    | sed -E "s/^[[:space:]]*'([^']+)':[[:space:]]*'([^']+)'.*/\\1 \\2/")
  [[ -n $route_map ]] || return 1
  while read -r route module; do
    [[ -n $route && -n $module ]] || return 1
    local page
    page=$(fetch_resource "${route#/}") || return 1
    [[ $page == *'class="portal-wrapper"'* ]] \
      && [[ $page == *'class="sidebar"'* ]] \
      && [[ $page == *'class="topbar"'* ]] \
      && [[ $page == *'id="main-content"'* ]] \
      && [[ $page == *'<script type="module" src="./js/router-bootstrap.js"></script>'* ]] || return 1
    resource=$(resolve_module js/router.js "$module") || return 1
    queue+=("$resource")
  done <<< "$route_map"
  queue+=(js/router.js js/index.js js/auth-shell.js js/sidebar-state.js js/sidebar.js)

  local index=0
  while ((index < ${#queue[@]})); do
    resource=${queue[index]}
    index=$((index + 1))
    [[ -n ${visited[$resource]+yes} ]] && continue
    visited[$resource]=1
    module_count=$((module_count + 1))
    ((module_count <= 160)) || return 1
    fetch_javascript "$resource" "$body_file" || return 1
    if [[ $resource == autocard/entry.js ]]; then
      module_source=$(<"$body_file")
      [[ $module_source == *"import { mount as mountEditor } from './app.js';"* ]] \
        && [[ $module_source == *'export function mount(page) {'* ]] \
        && [[ $module_source == *'mountEditor(page);'* ]] \
        && [[ $module_source == *$'\n}'* ]] || return 1
    fi
    imports=$(grep -Eo "from[[:space:]]+['\"][^'\"]+['\"]|import[[:space:]]*\\(['\"][^'\"]+['\"]\\)|import[[:space:]]+['\"][^'\"]+['\"]" "$body_file" \
      | sed -E "s/.*['\"]([^'\"]+)['\"].*/\\1/" || true)
    while read -r specifier; do
      case $specifier in
        ./*|../*|/*)
          dependency=$(resolve_module "$resource" "$specifier") || return 1
          [[ -n ${visited[$dependency]+yes} ]] || queue+=("$dependency")
          ;;
      esac
    done <<< "$imports"
  done

  return 0
}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  liveness=$(fetch_resource api/health || true)
  readiness=$(fetch_resource api/ready || true)
  same_origin=$(fetch_resource api/health --header "Origin: $origin" || true)
  canonical=$(fetch_resource autocard.html || true)
  legacy=$(fetch_resource autocard/ || true)
  missing_html_status=$(fetch_status __route_recovery_missing__.html || true)
  if [[ $liveness == *'"status":"ok"'* ]] && [[ $readiness == *'"status":"ready"'* ]] \
    && [[ $same_origin == *'"status":"ok"'* ]] \
    && fetch_resource '' >/dev/null \
    && [[ $missing_html_status == 404 ]] \
    && [[ $canonical == *'class="portal-wrapper"'* ]] \
    && [[ $canonical == *'class="sidebar"'* ]] \
    && [[ $canonical == *'class="topbar"'* ]] \
    && [[ $canonical == *'id="main-content"'* ]] \
    && [[ $canonical == *'<script type="module" src="./js/router-bootstrap.js"></script>'* ]] \
    && [[ $canonical == *'<script src="./js/sidebar.js"></script>'* ]] \
    && [[ $legacy == *'url=../autocard.html'* ]] \
    && [[ $legacy == *'href="../autocard.html"'* ]] \
    && check_relative_editorial_redirect \
    && check_route_module_graph; then
    printf '{"check":"smoke","status":"ok","attempt":%d}\n' "$attempt"
    exit 0
  fi
  if (( attempt < attempts )); then sleep 2; fi
done

printf '{"check":"smoke","status":"failed","attempts":%d}\n' "$attempts" >&2
exit 1
