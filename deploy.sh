#!/usr/bin/env bash
set -euo pipefail

: "${VPS_USER:?Set VPS_USER}"
: "${VPS_HOST:?Set VPS_HOST}"
: "${API_IMAGE:?Set API_IMAGE to an immutable API image digest}"
: "${CRON_IMAGE:?Set CRON_IMAGE to an immutable cron image digest}"
VPS_PATH=${VPS_PATH:-/opt/ownerinc-portal}
SSH_PORT=${SSH_PORT:-22}

[[ $VPS_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "Invalid VPS_USER" >&2; exit 2; }
[[ $VPS_HOST =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid VPS_HOST" >&2; exit 2; }
[[ $VPS_PATH =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "Invalid VPS_PATH" >&2; exit 2; }
[[ $SSH_PORT =~ ^[0-9]+$ ]] || { echo "Invalid SSH_PORT" >&2; exit 2; }
[[ $API_IMAGE =~ @sha256:[0-9a-f]{64}$ && $API_IMAGE == */ownerinc-portal-api@sha256:* ]] || { echo "Invalid API_IMAGE digest" >&2; exit 2; }
[[ $CRON_IMAGE =~ @sha256:[0-9a-f]{64}$ && $CRON_IMAGE == */ownerinc-portal-cron@sha256:* ]] || { echo "Invalid CRON_IMAGE digest" >&2; exit 2; }

worktree=$(git status --porcelain=v1 --untracked-files=all)
[[ -z $worktree ]] || {
  echo "Refusing deploy: worktree contains uncommitted or untracked changes." >&2
  exit 2
}

revision=$(git rev-parse --verify HEAD)
release_id="${revision}-$(date -u +%Y%m%d%H%M%S)"
target="${VPS_USER}@${VPS_HOST}"
archive=$(mktemp "${TMPDIR:-/tmp}/ownerinc-portal.XXXXXX.tar.gz")
archive_tar=$(mktemp "${TMPDIR:-/tmp}/ownerinc-portal.XXXXXX.tar")
image_env_dir=$(mktemp -d "${TMPDIR:-/tmp}/ownerinc-portal-images.XXXXXX")
printf 'API_IMAGE=%s\nCRON_IMAGE=%s\n' "$API_IMAGE" "$CRON_IMAGE" >"$image_env_dir/.image-env"
trap 'rm -f "$archive" "$archive_tar"; rm -rf "$image_env_dir"' EXIT

git archive --format=tar --output="$archive_tar" HEAD -- . ':(exclude)ownerinc-novo-agente/**'
tar --append --file="$archive_tar" -C "$image_env_dir" .image-env
gzip -9 -c "$archive_tar" > "$archive"

ssh -p "$SSH_PORT" "$target" "test -f '$VPS_PATH/shared/.env' && mkdir -p '$VPS_PATH/incoming' '$VPS_PATH/releases'"
scp -P "$SSH_PORT" "$archive" "$target:$VPS_PATH/incoming/$release_id.tar.gz"
ssh -p "$SSH_PORT" "$target" "set -eu; release='$VPS_PATH/releases/$release_id'; test ! -e \"\$release\"; mkdir \"\$release\"; tar -xzf '$VPS_PATH/incoming/$release_id.tar.gz' -C \"\$release\"; rm '$VPS_PATH/incoming/$release_id.tar.gz'; bash \"\$release/scripts/release.sh\" '$VPS_PATH' \"\$release\" '$release_id'"

printf 'Deployed revision %s as %s\n' "$revision" "$release_id"
