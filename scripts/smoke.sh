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

# Diagnostics only. Command substitutions cannot update parent variables, so
# record finite outcomes in the already-private temporary directory. Never
# change a command's return value if diagnostic I/O fails; never store bodies,
# URLs, headers, paths or arbitrary tool stderr in these facts.
smoke_result() {
  local check=$1 kind=$2 reason=$3 status=${4:-none}
  case $check in api_liveness|api_readiness|same_origin|root|missing_html|canonical_html|legacy_alias|editorial_redirect|router_bootstrap|asset_path_module|index_page|router_module|route_page|route_module|autocard_entry|module_graph) ;; *) return 0;; esac
  [[ $status =~ ^[1-5][0-9]{2}$ ]] || status=none
  { printf '%s %s %s\n' "$kind" "$reason" "$status" >"$temporary_dir/attempt_${attempt}_$check"; } 2>/dev/null || true
  if [[ $kind == fail && ${smoke_graph_mode:-0} == 1 && ! -s $temporary_dir/attempt_${attempt}_graph_failure ]]; then
    { printf '%s %s %s\n' "$check" "$reason" "$status" >"$temporary_dir/attempt_${attempt}_graph_failure"; } 2>/dev/null || true
  fi
  return 0
}

smoke_transport_failure() {
  local reason=transport
  [[ $1 == 22 ]] && reason=http_status
  smoke_result "${smoke_check:-module_graph}" fail "$reason" "${2:-none}"
}

smoke_choose_failure() {
  local check=$1 fallback=$2 known=${3:-none} kind reason status
  [[ -s $temporary_dir/attempt_${attempt}_$check ]] || return 0
  read -r kind reason status <"$temporary_dir/attempt_${attempt}_$check" || return 0
  if [[ $kind == ok ]]; then reason=$fallback; [[ $known == none ]] || status=$known; fi
  [[ $status =~ ^[1-5][0-9]{2}$ ]] || status=none
  printf '%s %s %s\n' "$check" "$reason" "$status"
}

smoke_select_failure() {
  if [[ $liveness != *'"status":"ok"'* ]]; then smoke_choose_failure api_liveness content
  elif [[ $readiness != *'"status":"ready"'* ]]; then smoke_choose_failure api_readiness readiness
  elif [[ $same_origin != *'"status":"ok"'* ]]; then smoke_choose_failure same_origin content
  elif [[ ! -s $temporary_dir/attempt_${attempt}_root ]]; then return 0
  elif [[ -s $temporary_dir/attempt_${attempt}_root ]] && grep -q '^fail ' "$temporary_dir/attempt_${attempt}_root"; then smoke_choose_failure root transport
  elif [[ $missing_html_status != 404 ]]; then smoke_choose_failure missing_html http_status "$missing_html_status"
  elif ! { [[ $canonical == *'class="portal-wrapper"'* ]] && [[ $canonical == *'class="sidebar"'* ]] \
    && [[ $canonical == *'class="topbar"'* ]] && [[ $canonical == *'id="main-content"'* ]] \
    && [[ $canonical == *'<script type="module" src="./js/router-bootstrap.js"></script>'* ]] \
    && [[ $canonical == *'<script src="./js/sidebar.js"></script>'* ]]; }; then smoke_choose_failure canonical_html content
  elif ! { [[ $legacy == *'url=../autocard.html'* ]] && [[ $legacy == *'href="../autocard.html"'* ]]; }; then smoke_choose_failure legacy_alias content
  elif [[ -s $temporary_dir/attempt_${attempt}_editorial_redirect ]]; then smoke_choose_failure editorial_redirect redirect
  elif [[ -s $temporary_dir/attempt_${attempt}_graph_failure ]]; then cat "$temporary_dir/attempt_${attempt}_graph_failure"
  fi
}

# Do not retain a partial body when curl fails (for example, a truncated
# transfer containing the expected markers before the connection was lost).
fetch_resource() {
  local resource=$1 body
  shift
  body=$(curl --fail --silent --show-error --max-time 5 "$@" "$base_url/$resource" 2>/dev/null) || { local code=$?; smoke_transport_failure "$code"; return 1; }
  smoke_result "${smoke_check:-module_graph}" ok none none
  printf '%s' "$body"
}

fetch_status() {
  local resource=$1 status
  status=$(curl --silent --show-error --max-time 5 --output /dev/null \
    --write-out '%{http_code}' "$base_url/$resource" 2>/dev/null) || { local code=$?; smoke_transport_failure "$code" "$status"; return 1; }
  [[ $status =~ ^[0-9]{3}$ ]] || { smoke_result "${smoke_check:-module_graph}" fail http_status none; return 1; }
  smoke_result "${smoke_check:-module_graph}" ok none "$status"
  printf '%s' "$status"
}

# Validate the response metadata as a browser does, and let curl reject an
# incomplete Content-Length/chunked transfer instead of accepting a prefix.
fetch_javascript() {
  local resource=$1 destination=$2 metadata status content_type
  metadata=$(curl --fail --silent --show-error --max-time 5 \
    --dump-header "$temporary_dir/headers" --output "$destination" \
    --write-out $'%{http_code}\n%{content_type}' "$base_url/$resource" 2>/dev/null) || { local code=$?; smoke_transport_failure "$code" "${metadata%%$'\n'*}"; return 1; }
  status=${metadata%%$'\n'*}
  content_type=${metadata#*$'\n'}
  status=${status%$'\r'}
  [[ $status == 200 ]] || { smoke_result "${smoke_check:-route_module}" fail http_status "$status"; return 1; }
  case ${content_type,,} in
    application/javascript*|text/javascript*|application/ecmascript*|text/ecmascript*) ;;
    *) smoke_result "${smoke_check:-route_module}" fail module "$status"; return 1 ;;
  esac
  [[ -s $destination ]] || { smoke_result "${smoke_check:-route_module}" fail module "$status"; return 1; }
  smoke_result "${smoke_check:-route_module}" ok none "$status"
}

check_relative_editorial_redirect() {
  local status location smoke_check=editorial_redirect
  status=$(curl --silent --show-error --max-time 5 --output /dev/null \
    --dump-header "$temporary_dir/redirect.headers" --write-out '%{http_code}' \
    "$base_url/editorial" 2>/dev/null) || { local code=$?; smoke_transport_failure "$code" "$status"; return 1; }
  location=$(awk 'tolower($1) == "location:" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); value = $0 } END { print value }' \
    "$temporary_dir/redirect.headers")
  [[ $status == 308 && $location == /editorial/admin ]] || {
    local reason=redirect; [[ $status == 308 ]] || reason=http_status
    smoke_result editorial_redirect fail "$reason" "$status"; return 1;
  }
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
  local smoke_graph_mode=1 smoke_check=module_graph

  smoke_check=router_bootstrap fetch_javascript js/router-bootstrap.js "$temporary_dir/bootstrap.js" || return 1
  bootstrap=$(<"$temporary_dir/bootstrap.js")
  [[ $bootstrap == *"import { startRouter } from './router.js';"* ]] \
    && [[ $bootstrap == *'void startRouter();'* ]] || { smoke_result router_bootstrap fail module 200; return 1; }

  # This transitive CMS dependency previously arrived as application/octet-stream.
  smoke_check=asset_path_module fetch_javascript js/owner-news/asset-path.mjs "$temporary_dir/asset-path.mjs" || return 1
  visited[js/owner-news/asset-path.mjs]=1

  index_html=$(smoke_check=index_page fetch_resource index.html) || return 1
  [[ $index_html == *'<script type="module" src="./js/index.js"></script>'* ]] || { smoke_result index_page fail content none; return 1; }

  smoke_check=router_module fetch_javascript js/router.js "$temporary_dir/router.js" || return 1
  router=$(<"$temporary_dir/router.js")
  [[ $router == *'export const routes = Object.freeze({'* ]] \
    && [[ $router == *"'/autocard.html': '../autocard/entry.js'"* ]] \
    && [[ $router == *'export async function startRouter() {'* ]] \
    && [[ $router == *'import(routes[initialURL.pathname])'* ]] \
    && [[ $router == *'mountPage(module, user, activeURL);'* ]] \
    && [[ $router == *$'\n}' ]] || { smoke_result router_module fail module 200; return 1; }

  local route_map
  route_map=$(grep -E "^[[:space:]]*'/[^']+\\.html':[[:space:]]*'[^']+'" "$temporary_dir/router.js" \
    | sed -E "s/^[[:space:]]*'([^']+)':[[:space:]]*'([^']+)'.*/\\1 \\2/")
  [[ -n $route_map ]] || { smoke_result module_graph fail module none; return 1; }
  while read -r route module; do
    [[ -n $route && -n $module ]] || { smoke_result module_graph fail module none; return 1; }
    local page
    page=$(smoke_check=route_page fetch_resource "${route#/}") || return 1
    [[ $page == *'class="portal-wrapper"'* ]] \
      && [[ $page == *'class="sidebar"'* ]] \
      && [[ $page == *'class="topbar"'* ]] \
      && [[ $page == *'id="main-content"'* ]] \
      && [[ $page == *'<script type="module" src="./js/router-bootstrap.js"></script>'* ]] || { smoke_result route_page fail content none; return 1; }
    resource=$(resolve_module js/router.js "$module") || { smoke_result module_graph fail module none; return 1; }
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
    ((module_count <= 160)) || { smoke_result module_graph fail module none; return 1; }
    smoke_check=route_module; [[ $resource != autocard/entry.js ]] || smoke_check=autocard_entry
    fetch_javascript "$resource" "$body_file" || return 1
    if [[ $resource == autocard/entry.js ]]; then
      module_source=$(<"$body_file")
      [[ $module_source == *"import { mount as mountEditor } from './app.js';"* ]] \
        && [[ $module_source == *'export function mount(page) {'* ]] \
        && [[ $module_source == *'mountEditor(page);'* ]] \
        && [[ $module_source == *$'\n}'* ]] || { smoke_result autocard_entry fail module 200; return 1; }
    fi
    imports=$(grep -Eo "from[[:space:]]+['\"][^'\"]+['\"]|import[[:space:]]*\\(['\"][^'\"]+['\"]\\)|import[[:space:]]+['\"][^'\"]+['\"]" "$body_file" \
      | sed -E "s/.*['\"]([^'\"]+)['\"].*/\\1/" || true)
    while read -r specifier; do
      case $specifier in
        ./*|../*|/*)
          dependency=$(resolve_module "$resource" "$specifier") || { smoke_result module_graph fail module none; return 1; }
          [[ -n ${visited[$dependency]+yes} ]] || queue+=("$dependency")
          ;;
      esac
    done <<< "$imports"
  done

  return 0
}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  liveness=$(smoke_check=api_liveness fetch_resource api/health || true)
  readiness=$(smoke_check=api_readiness fetch_resource api/ready || true)
  same_origin=$(smoke_check=same_origin fetch_resource api/health --header "Origin: $origin" || true)
  canonical=$(smoke_check=canonical_html fetch_resource autocard.html || true)
  legacy=$(smoke_check=legacy_alias fetch_resource autocard/ || true)
  missing_html_status=$(smoke_check=missing_html fetch_status __route_recovery_missing__.html || true)
  if [[ $liveness == *'"status":"ok"'* ]] && [[ $readiness == *'"status":"ready"'* ]] \
    && [[ $same_origin == *'"status":"ok"'* ]] \
    && smoke_check=root fetch_resource '' >/dev/null \
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
  diagnostic=$(smoke_select_failure 2>/dev/null || true)
  if (( attempt < attempts )); then sleep 2; fi
done

if [[ -n ${diagnostic:-} ]]; then
  read -r failed_check failed_reason failed_status <<< "$diagnostic"
  [[ $failed_status != none ]] || failed_status=null
  printf '{"check":"smoke","status":"failed","attempts":%d,"diagnostic":{"check":"%s","reason":"%s","httpStatus":%s}}\n' \
    "$attempts" "$failed_check" "$failed_reason" "$failed_status" >&2
else
  printf '{"check":"smoke","status":"failed","attempts":%d}\n' "$attempts" >&2
fi
exit 1
