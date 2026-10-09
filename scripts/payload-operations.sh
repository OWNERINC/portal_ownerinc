#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# Fixed progress markers contain no paths, commands, arguments or server output.
# EXIT covers explicit validation exits and nounset errors as well as command
# failures. Emit the primary failure before cleanup so cleanup cannot replace it.
coordinator_step=initialize
destructive=false
step() { coordinator_step=$1; printf 'PAYLOAD_COORDINATOR_STEP step=%s\n' "$coordinator_step" >&2; }
failed() {
  local status=$?
  trap - EXIT INT TERM
  ((status != 0)) || return 0
  set +e
  printf 'PAYLOAD_COORDINATOR_FAILURE step=%s status=%s\n' "$coordinator_step" "$status" >&2
  if [[ $destructive == true ]]; then
    compose stop --timeout 120 nginx api cron cms cms-worker >/dev/null
    echo 'Payload restore incomplete; keep admission closed and reconcile the protection backup.' >&2
  else
    echo 'Payload operation failed; admission remains closed. Inspect writers and retained artifacts.' >&2
  fi
  exit "$status"
}
trap failed EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
step initialize

# This coordinator NEVER holds database locks. External import/maintenance
# coordinators must use the SAME lock before opening transactions. Only the outer
# coordinator owns fd9; children inherit it rather than recursively flocking.
action=${1:-}
root=${2:-}
step validate_invocation
[[ $action == backup || $action == restore ]] || { echo 'Invalid Payload operation' >&2; exit 2; }
[[ $root == /* && -d $root ]] || { echo 'Absolute release root required' >&2; exit 2; }
step release_manifest
. "$root/scripts/release-manifest.sh"
load_release_manifest "$root/.image-env"
[[ $RELEASE_FORMAT == payload-v1 && -f $root/docker-compose.payload.yml ]] || { echo 'Incomplete Payload release' >&2; exit 2; }
step lock_configuration
: "${PORTAL_OPERATION_LOCK:?Set the shared deploy/backup/import lock path}"
[[ $PORTAL_OPERATION_LOCK == /* && ! -L $PORTAL_OPERATION_LOCK ]] || exit 2
step guard_configuration
: "${PAYLOAD_OPERATIONS_GUARD:?Set the reviewed authority/import operations guard}"
[[ $PAYLOAD_OPERATIONS_GUARD == /* && -f $PAYLOAD_OPERATIONS_GUARD && -x $PAYLOAD_OPERATIONS_GUARD && ! -L $PAYLOAD_OPERATIONS_GUARD ]] || exit 2

if [[ ${PORTAL_OPERATION_LOCK_HELD:-} == "$PORTAL_OPERATION_LOCK" ]]; then
  step lock_inherited
  # Verify the inherited descriptor references this inode. No re-open or lock.
  [[ /proc/$$/fd/9 -ef $PORTAL_OPERATION_LOCK ]] || { echo 'Missing inherited operational lock' >&2; exit 2; }
else
  step lock_acquire
  [[ -z ${PORTAL_OPERATION_LOCK_HELD:-} ]] || exit 2
  exec 9>>"$PORTAL_OPERATION_LOCK"
  flock -w "${PORTAL_LOCK_WAIT_SECONDS:-300}" 9 || exit 75
  export PORTAL_OPERATION_LOCK_HELD=$PORTAL_OPERATION_LOCK
fi
export PORTAL_OPERATION_LOCK

compose() {
  local args=(--profile notifications --project-directory "$root" --project-name "${COMPOSE_PROJECT_NAME:-ownerinc-portal-prod}")
  if [[ -n ${COMPOSE_ENV_FILE:-} ]]; then args+=(--env-file "$COMPOSE_ENV_FILE"); fi
  args+=(--env-file "$root/.image-env" -f "$root/docker-compose.yml" -f "$root/docker-compose.payload.yml")
  if [[ -n ${COMPOSE_OVERRIDE:-} ]]; then args+=(-f "$COMPOSE_OVERRIDE"); fi
  payload_override="$(dirname -- "$PORTAL_OPERATION_LOCK")/compose.payload.production.yaml"
  [[ -f $payload_override && ! -L $payload_override ]] || { echo 'Missing protected Payload production Compose overlay' >&2; return 2; }
  args+=(-f "$payload_override")
  # Compose interpolation must come only from the protected runtime env file and
  # immutable release manifest; ambient API_IMAGE, database or Docker endpoint
  # variables must not silently redirect this coordinated operation.
  env -i PATH="$PATH" HOME="${HOME:-/root}" docker compose "${args[@]}" "$@"
}
guard() {
  # The reviewed integration guard must check all authority/epoch/seal/ledger
  # contracts. No fallback, guessed ledger SQL or operator boolean bypass.
  step "${3:-guard_${1//-/_}}"
  "$PAYLOAD_OPERATIONS_GUARD" "$1" "$root" "${2:-}"
}
stopped=()
resume() { step resume_writers; if ((${#stopped[@]})); then compose start "${stopped[@]}" >/dev/null; fi; }
stop_writers() {
  local running service
  step writers_inventory_before
  running=$(compose ps --status running --services)
  # The worker is never admitted or resumed in preauthority. If it is running,
  # the guard's inventory proof fails instead of silently treating it as held.
  for service in nginx api cron cms; do
    if grep -qx "$service" <<<"$running"; then stopped+=("$service"); fi
  done
  # Admission/drain contract covers extra one-shot import/maintenance containers;
  # it must finish before DB proof. No transaction waits on container exit.
  guard close-admission
  step stop_writers
  if ((${#stopped[@]})); then compose stop --timeout 120 "${stopped[@]}" >/dev/null; fi
  step writers_inventory_after
  running=$(compose ps --status running --services)
  step writers_stopped_check
  if grep -Eq '^(nginx|api|cron|cms|cms-worker)$' <<<"$running"; then return 1; fi
  guard quiescence-proof
}

capture() {
  local destination=$1
  step capture_directory
  mkdir -m 700 "$destination"
  step capture_portal_database
  compose exec -T postgres sh -c 'pg_dump --format=custom --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' > "$destination/postgres.dump"
  step capture_portal_storage
  compose run --rm --no-deps -T --entrypoint tar api -czf - -C /app/uploads . > "$destination/uploads.tar.gz"
  step capture_cms_database
  compose exec -T cms-postgres sh -c 'pg_dump --format=custom --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' > "$destination/cms-postgres.dump"
  # Entire private volume: immutable files + staging + ambiguous promotions.
  step capture_cms_storage
  compose run --rm --no-deps -T --entrypoint tar cms -czf - -C /var/lib/ownerinc-cms/media . > "$destination/cms-uploads.tar.gz"
  step capture_release_metadata
  cp "$root/.image-env" "$destination/release.images"
  printf 'payload-v1\n' > "$destination/backup.format"
  guard backup-metadata "$destination/operations-proof.json"
  step capture_manifest
  (cd "$destination" && sha256sum postgres.dump uploads.tar.gz cms-postgres.dump cms-uploads.tar.gz release.images operations-proof.json backup.format > manifest.sha256)
  step capture_verify_manifest
  verify_backup_manifest "$destination"
}

if [[ $action == backup ]]; then
  step backup_destination
  : "${BACKUP_DIR:?Set BACKUP_DIR}"
  [[ -d $BACKUP_DIR && $BACKUP_DIR == /* && ! -L $BACKUP_DIR ]] || exit 2
  destination="$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
  guard release-preflight
  stop_writers
  capture "$destination"
  if [[ ${LEAVE_STOPPED:-false} != true ]]; then resume; guard verify-release; guard open-admission; fi
  # Retention must not delete a mixed/partial set. Retain failed evidence; pruning
  # requires a separate reviewed policy for versioned coordinated backup sets.
  if [[ ${BACKUP_UPLOAD_S3:-false} == true ]]; then
    step backup_upload
    bash "$root/scripts/backup-s3.sh" "$destination" || exit 3
  fi
  trap - EXIT INT TERM
  printf 'Backup created: %s\n' "$destination"
else
  step restore_confirmation
  backup=${3:-}
  [[ ${4:-} == --confirm && ${5:-} == RESTORE ]] || exit 2
  step restore_manifest
  verify_backup_manifest "$backup"
  [[ $BACKUP_FORMAT == payload-v1 ]] || { echo 'Legacy backup cannot restore a Payload release' >&2; exit 2; }
  step restore_portal_archive
  verify_storage_archive "$backup/uploads.tar.gz"
  step restore_cms_archive
  verify_storage_archive "$backup/cms-uploads.tar.gz"
  guard restore-preflight "$backup"
  step restore_protection_destination
  : "${PRE_RESTORE_BACKUP_DIR:?Set PRE_RESTORE_BACKUP_DIR}"
  [[ -d $PRE_RESTORE_BACKUP_DIR && $PRE_RESTORE_BACKUP_DIR == /* ]] || exit 2
  stop_writers
  protection="$PRE_RESTORE_BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
  capture "$protection"
  destructive=true
  # The guard confirms compatible schemas/application floor and safe restore
  # targets, including extra objects pg_restore --clean would otherwise retain.
  guard prepare-restore "$backup" guard_prepare_restore_portal
  step restore_portal_database
  compose exec -T postgres sh -c 'pg_restore --single-transaction --clean --if-exists --no-owner --no-privileges --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' < "$backup/postgres.dump"
  # Portal pg_restore --no-privileges may remove runtime grants. Record and
  # verify this explicit intermediate floor, then reapply grants through the
  # normal migration/provision path before the next strict destructive check.
  guard portal-restore-intermediate "$backup"
  step restore_portal_migrate
  compose run --rm --no-deps migrate
  step restore_portal_verify_migrations
  compose run --rm --no-deps -e RUN_MIGRATIONS=false -e MIGRATION_ONLY=false migrate node db/verify-migrations.js
  guard prepare-restore "$backup" guard_prepare_restore_cms
  # CMS ownership must remain cms_migrator so future DDL uses the same owner.
  step restore_cms_database
  compose exec -T cms-postgres sh -c 'pg_restore --single-transaction --clean --if-exists --no-owner --no-privileges --role=cms_migrator --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' < "$backup/cms-postgres.dump"
  for service in api cms; do
    guard prepare-restore "$backup" "guard_prepare_restore_${service}_clear"
    artifact=uploads.tar.gz; storage=/app/uploads
    if [[ $service == cms ]]; then artifact=cms-uploads.tar.gz; storage=/var/lib/ownerinc-cms/media; fi
    step "restore_${service}_storage_clear"
    compose run --rm --no-deps -T --entrypoint sh "$service" -c 'find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +' restore-files "$storage"
    guard prepare-restore "$backup" "guard_prepare_restore_${service}_extract"
    step "restore_${service}_storage_extract"
    compose run --rm --no-deps -T --entrypoint tar "$service" -xzf - -C "$storage" < "$backup/$artifact"
  done
  guard prepare-restore "$backup" guard_prepare_restore_cms_migrate
  guard prepare-restore "$backup" guard_prepare_restore_cms_migrate
  step restore_cms_migrate
  compose run --rm --no-deps cms-migrate
  step restore_cms_verify_runtime
  compose run --rm --no-deps --entrypoint node cms --import tsx scripts/provision-db.ts --verify-runtime
  guard verify-restored "$backup"
  # Start API/CMS/Nginx for the readiness smoke with admission still closed.
  # Resume the originally stopped services only after smoke; cms-worker is never
  # included, and release verification runs against the complete resumed floor.
  step restore_start_readiness
  compose up -d --no-deps api cms nginx
  step restore_smoke
  : "${RESTORE_BASE_URL:?Set RESTORE_BASE_URL for the isolated target}"
  BASE_URL=$RESTORE_BASE_URL bash "$root/scripts/smoke.sh"
  resume
  guard verify-release
  guard open-admission
  trap - EXIT INT TERM
  echo 'Restore completed and coordinated Payload verification passed.'
fi
