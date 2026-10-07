#!/usr/bin/env bash
# Manual archive path. CI uses ops/deploy-from-ci.sh; both share manifest/backup
# and mandatory authority guard contracts. This script never changes authority.
set -Eeuo pipefail
umask 077
root=${1:?}; release=${2:?}; release_id=${3:?}
[[ $release == "$root/releases/$release_id" && $release_id =~ ^[0-9a-f]{40}-[0-9]{14}$ ]] || exit 2
. "$release/scripts/release-manifest.sh"
load_release_manifest "$release/.image-env"
[[ $RELEASE_FORMAT == payload-v1 ]] || exit 2
# Guard is installed only by an explicitly authorized operator, not this archive.
export PAYLOAD_OPERATIONS_GUARD="$root/runtime/payload-operations-guard"
export PORTAL_OPERATION_LOCK="$root/runtime/deploy.lock"
[[ -d $root/runtime && -x $PAYLOAD_OPERATIONS_GUARD && ! -L $PAYLOAD_OPERATIONS_GUARD && ! -L $PORTAL_OPERATION_LOCK ]] || { echo 'Missing reviewed Payload operational installation' >&2; exit 2; }
exec 9>>"$PORTAL_OPERATION_LOCK"
flock -n 9 || exit 75
export PORTAL_OPERATION_LOCK_HELD=$PORTAL_OPERATION_LOCK
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ownerinc-portal}"
previous=$(readlink -f "$root/current" 2>/dev/null || true)
[[ -n $previous && -f $previous/.image-env ]] || { echo 'Initial Portal installation must precede CMS installation' >&2; exit 2; }
guard() { "$PAYLOAD_OPERATIONS_GUARD" "$1" "$release" "${2:-}"; }
guard release-preflight "$previous"
for image in "$API_IMAGE" "$CRON_IMAGE" "$CMS_IMAGE"; do docker pull "$image" >/dev/null; done
export COMPOSE_ENV_FILE="$root/shared/.env"
compose() {
  local selected=$1; shift
  local extra=()
  if grep -Fxq 'RELEASE_FORMAT=payload-v1' "$selected/.image-env"; then extra=(-f "$selected/docker-compose.payload.yml"); fi
  docker compose --profile notifications --env-file "$COMPOSE_ENV_FILE" --env-file "$selected/.image-env" \
    --project-directory "$selected" --project-name "${COMPOSE_PROJECT_NAME:-ownerinc-portal}" \
    -f "$selected/docker-compose.yml" "${extra[@]}" "$@"
}
rollback() {
  local status=$?
  trap - ERR INT TERM
  set +e
  compose "$release" stop --timeout 120 nginx api cron cms cms-worker
  if guard rollback-check "$previous"; then
    guard open-admission "$previous"
    compose "$previous" up -d --no-build
  else
    echo 'Payload recovery blocked; keep writers stopped and restore coordinated backup.' >&2
  fi
  exit "$status"
}
trap rollback ERR INT TERM
guard close-admission
backup_dir="$root/shared/backups"
if ! grep -Fxq 'RELEASE_FORMAT=payload-v1' "$previous/.image-env"; then backup_dir+='/legacy-install'; fi
mkdir -p "$backup_dir"
BACKUP_DIR="$backup_dir" LEAVE_STOPPED=true BACKUP_UPLOAD_S3=false bash "$release/scripts/backup.sh" "$previous"
guard quiescence-proof
compose "$release" run --rm migrate
compose "$release" run --rm --no-deps -e RUN_MIGRATIONS=false -e MIGRATION_ONLY=false migrate node db/verify-migrations.js
compose "$release" up -d --no-deps cms-postgres
compose "$release" run --rm cms-provision
compose "$release" run --rm --no-deps cms-migrate
CRON_BOOTSTRAP_ONLY=true compose "$release" up -d --no-deps api cms cron
guard verify-release
compose "$release" up -d --no-deps nginx
published=$(compose "$release" port nginx 80 | tail -n 1)
BASE_URL="${RELEASE_BASE_URL:-http://$published}" bash "$release/scripts/smoke.sh"
guard verify-release
CRON_BOOTSTRAP_ONLY=false compose "$release" up -d --no-deps --force-recreate cron cms-worker
guard verify-release
guard open-admission
ln -sfn "$release" "$root/current"
trap - ERR INT TERM
printf '{"release":"%s","status":"ready"}\n' "$release_id"
