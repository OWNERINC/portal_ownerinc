#!/usr/bin/env bash
set -euo pipefail

: "${VPS_USER:?Set VPS_USER}"
: "${VPS_HOST:?Set VPS_HOST}"
VPS_PATH=${VPS_PATH:-/opt/ownerinc-portal}
SSH_PORT=${SSH_PORT:-22}

[[ $VPS_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "Invalid VPS_USER" >&2; exit 2; }
[[ $VPS_HOST =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid VPS_HOST" >&2; exit 2; }
[[ $VPS_PATH =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "Invalid VPS_PATH" >&2; exit 2; }
[[ $SSH_PORT =~ ^[0-9]+$ ]] || { echo "Invalid SSH_PORT" >&2; exit 2; }

git diff --quiet --exit-code HEAD -- || {
  echo "Refusing deploy: tracked changes are not committed." >&2
  exit 2
}

revision=$(git rev-parse --verify HEAD)
release_id="${revision}-$(date -u +%Y%m%d%H%M%S)"
target="${VPS_USER}@${VPS_HOST}"
archive=$(mktemp "${TMPDIR:-/tmp}/ownerinc-portal.XXXXXX.tar.gz")
trap 'rm -f "$archive"' EXIT

git archive --format=tar HEAD -- . ':(exclude)ownerinc-novo-agente/**' | gzip -9 > "$archive"

ssh -p "$SSH_PORT" "$target" "test -f '$VPS_PATH/shared/.env' && mkdir -p '$VPS_PATH/incoming' '$VPS_PATH/releases'"
scp -P "$SSH_PORT" "$archive" "$target:$VPS_PATH/incoming/$release_id.tar.gz"
ssh -p "$SSH_PORT" "$target" "set -eu; release='$VPS_PATH/releases/$release_id'; test ! -e \"\$release\"; mkdir \"\$release\"; tar -xzf '$VPS_PATH/incoming/$release_id.tar.gz' -C \"\$release\"; rm '$VPS_PATH/incoming/$release_id.tar.gz'; bash \"\$release/scripts/release.sh\" '$VPS_PATH' \"\$release\" '$release_id'"

printf 'Deployed revision %s as %s\n' "$revision" "$release_id"
