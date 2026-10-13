#!/usr/bin/env bash
# Manual archive path. CI uses ops/deploy-from-ci.sh; both share manifest/backup
# and mandatory authority guard contracts. This script never changes authority.
set -Eeuo pipefail
umask 077
root=${1:?}; release=${2:?}; release_id=${3:?}
current_file="$root/current-release"
[[ $release == "$root/releases/$release_id" && $release_id =~ ^[0-9a-f]{40}-[0-9]{14}$ ]] || exit 2
[[ -f $current_file && ! -L $current_file ]] || { echo 'Missing canonical current-release pointer' >&2; exit 2; }
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
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ownerinc-portal-prod}"
previous=$(readlink -f "$root/current" 2>/dev/null || true)
[[ -n $previous && -f $previous/.image-env ]] || { echo 'Initial Portal installation must precede CMS installation' >&2; exit 2; }
guard() { "$PAYLOAD_OPERATIONS_GUARD" "$1" "$release" "${2:-}"; }
guard release-preflight "$previous"
for image in "$API_IMAGE" "$CRON_IMAGE" "$CMS_IMAGE"; do docker pull "$image" >/dev/null; done
export COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf}"
[[ -f $COMPOSE_ENV_FILE && ! -L $COMPOSE_ENV_FILE ]] || { echo 'Missing protected production Compose environment' >&2; exit 2; }
COMPOSE_OVERRIDE="$root/runtime/compose.production.yaml"
if [[ -f $previous/compose.ownerinc-vps.yaml ]]; then COMPOSE_OVERRIDE="$previous/compose.ownerinc-vps.yaml"; fi
export COMPOSE_OVERRIDE
compose() {
  local selected=$1; shift
  local extra=() selected_override="$root/runtime/compose.production.yaml"
  local payload_production=()
  if [[ -f $selected/compose.ownerinc-vps.yaml ]]; then selected_override="$selected/compose.ownerinc-vps.yaml"; fi
  if grep -Fxq 'RELEASE_FORMAT=payload-v1' "$selected/.image-env"; then
    extra=(-f "$selected/docker-compose.payload.yml")
    payload_production=(-f "$root/runtime/compose.payload.production.yaml")
  fi
  docker compose --profile notifications --env-file "$COMPOSE_ENV_FILE" --env-file "$selected/.image-env" \
    --project-directory "$selected" --project-name "${COMPOSE_PROJECT_NAME:-ownerinc-portal}" \
    -f "$selected/docker-compose.yml" "${extra[@]}" -f "$selected_override" "${payload_production[@]}" "$@"
}
rollback() {
  local status=$?
  trap - ERR INT TERM
  set +e
  compose "$release" stop --timeout 120 nginx api cron cms cms-worker
  if [[ ! -e $PORTAL_OPERATION_LOCK.admission-closed && ! -L $PORTAL_OPERATION_LOCK.admission-closed ]]; then
    guard close-admission || {
      echo 'Unable to establish Payload admission fence; writers remain stopped.' >&2
      exit 1
    }
  fi
  if guard rollback-check "${backup:-}"; then
    guard open-admission "$previous"
    if grep -Fxq 'RELEASE_FORMAT=payload-v1' "$previous/.image-env"; then
      compose "$previous" up -d --no-build --no-deps api cron cms nginx
    else
      compose "$previous" up -d --no-build --no-deps api cron nginx
    fi
  else
    echo 'Payload recovery blocked; keep writers stopped and restore coordinated backup.' >&2
  fi
  exit "$status"
}
trap rollback ERR INT TERM
backup_dir="$root/shared/backups"
if ! grep -Fxq 'RELEASE_FORMAT=payload-v1' "$previous/.image-env"; then backup_dir+='/legacy-install'; fi
mkdir -p "$backup_dir"
if grep -Fxq 'RELEASE_FORMAT=payload-v1' "$previous/.image-env"; then
  BACKUP_DIR="$backup_dir" LEAVE_STOPPED=true BACKUP_UPLOAD_S3=false bash "$previous/scripts/backup.sh" "$previous"
else
  backup_output=$(BACKUP_DIR="$backup_dir" LEAVE_STOPPED=true RETENTION_DAYS=14 BACKUP_UPLOAD_S3=false \
    bash "$previous/scripts/backup.sh" "$previous")
  backup=${backup_output#'Backup created: '}
  [[ $backup == "$backup_dir/"* && -d $backup && ! -L $backup ]] || { echo 'Legacy source backup result was not verifiable.' >&2; exit 2; }
  guard close-admission
  guard quiescence-proof
  guard backup-metadata "$backup/preauthority-proof.json"
fi
guard quiescence-proof
compose "$release" run --rm migrate
compose "$release" run --rm --no-deps -e RUN_MIGRATIONS=false -e MIGRATION_ONLY=false migrate node db/verify-migrations.js
compose "$release" up -d --no-deps cms-postgres
compose "$release" run --rm cms-provision
if ! compose "$release" --profile cms-control-roles run --rm --no-deps cms-control-roles; then
  compose "$release" --profile cms-control-roles run --rm --no-deps cms-control-roles \
    node --import tsx scripts/provision-db.ts --bootstrap-control
fi
compose "$release" run --rm --no-deps cms-migrate
CRON_BOOTSTRAP_ONLY=true compose "$release" up -d --no-deps api cms cron
guard verify-release
compose "$release" up -d --no-deps nginx
published=$(compose "$release" port nginx 80 | tail -n 1)
BASE_URL="${RELEASE_BASE_URL:-http://$published}" bash "$release/scripts/smoke.sh"
guard verify-release
CRON_BOOTSTRAP_ONLY=false compose "$release" up -d --no-deps --force-recreate cron
guard verify-release
ln -sfn "$release" "$root/current"
current_tmp="$root/runtime/current-release.manual.$$"
printf '%s\n' "$release" >"$current_tmp"
chmod 644 "$current_tmp"
mv -fT "$current_tmp" "$current_file"
guard open-admission
trap - ERR INT TERM
printf '{"release":"%s","status":"ready"}\n' "$release_id"
