#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# This coordinator NEVER holds database locks. External import/maintenance
# coordinators must use the SAME lock before opening transactions. Only the outer
# coordinator owns fd9; children inherit it rather than recursively flocking.
action=${1:-}
root=${2:-}
[[ $action == backup || $action == restore ]] || { echo 'Invalid Payload operation' >&2; exit 2; }
[[ $root == /* && -d $root ]] || { echo 'Absolute release root required' >&2; exit 2; }
. "$root/scripts/release-manifest.sh"
load_release_manifest "$root/.image-env"
[[ $RELEASE_FORMAT == payload-v1 && -f $root/docker-compose.payload.yml ]] || { echo 'Incomplete Payload release' >&2; exit 2; }
: "${PORTAL_OPERATION_LOCK:?Set the shared deploy/backup/import lock path}"
: "${PAYLOAD_OPERATIONS_GUARD:?Set the reviewed authority/import operations guard}"
[[ $PORTAL_OPERATION_LOCK == /* && ! -L $PORTAL_OPERATION_LOCK ]] || exit 2
[[ $PAYLOAD_OPERATIONS_GUARD == /* && -f $PAYLOAD_OPERATIONS_GUARD && -x $PAYLOAD_OPERATIONS_GUARD && ! -L $PAYLOAD_OPERATIONS_GUARD ]] || exit 2

if [[ ${PORTAL_OPERATION_LOCK_HELD:-} == "$PORTAL_OPERATION_LOCK" ]]; then
  # Verify the inherited descriptor references this inode. No re-open or lock.
  [[ /proc/$$/fd/9 -ef $PORTAL_OPERATION_LOCK ]] || { echo 'Missing inherited operational lock' >&2; exit 2; }
else
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
  "$PAYLOAD_OPERATIONS_GUARD" "$1" "$root" "${2:-}"
}
stopped=()
resume() { if ((${#stopped[@]})); then compose start "${stopped[@]}" >/dev/null; fi; }
stop_writers() {
  local running service
  running=$(compose ps --status running --services)
  # The worker is never admitted or resumed in preauthority. If it is running,
  # the guard's inventory proof fails instead of silently treating it as held.
  for service in nginx api cron cms; do
    if grep -qx "$service" <<<"$running"; then stopped+=("$service"); fi
  done
  # Admission/drain contract covers extra one-shot import/maintenance containers;
  # it must finish before DB proof. No transaction waits on container exit.
  guard close-admission
  if ((${#stopped[@]})); then compose stop --timeout 120 "${stopped[@]}" >/dev/null; fi
  running=$(compose ps --status running --services)
  if grep -Eq '^(nginx|api|cron|cms|cms-worker)$' <<<"$running"; then return 1; fi
  guard quiescence-proof
}

capture() {
  local destination=$1
  mkdir -m 700 "$destination"
  compose exec -T postgres sh -c 'pg_dump --format=custom --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' > "$destination/postgres.dump"
  compose run --rm --no-deps -T --entrypoint tar api -czf - -C /app/uploads . > "$destination/uploads.tar.gz"
  compose exec -T cms-postgres sh -c 'pg_dump --format=custom --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' > "$destination/cms-postgres.dump"
  # Entire private volume: immutable files + staging + ambiguous promotions.
  compose run --rm --no-deps -T --entrypoint tar cms -czf - -C /var/lib/ownerinc-cms/media . > "$destination/cms-uploads.tar.gz"
  cp "$root/.image-env" "$destination/release.images"
  printf 'payload-v1\n' > "$destination/backup.format"
  guard backup-metadata "$destination/operations-proof.json"
  (cd "$destination" && sha256sum postgres.dump uploads.tar.gz cms-postgres.dump cms-uploads.tar.gz release.images operations-proof.json backup.format > manifest.sha256)
  verify_backup_manifest "$destination"
}

destructive=false
failed() {
  local status=$?
  ((status != 0)) || status=1
  trap - ERR INT TERM
  set +e
  if [[ $destructive == true ]]; then
    compose stop --timeout 120 nginx api cron cms cms-worker >/dev/null
    echo 'Payload restore incomplete; keep admission closed and reconcile the protection backup.' >&2
  else
    # Preserve partial evidence. A failed close/proof is NOT permission to reopen.
    echo 'Payload operation failed; admission remains closed. Inspect writers and retained artifacts.' >&2
  fi
  exit "$status"
}
trap failed ERR INT TERM

if [[ $action == backup ]]; then
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
    bash "$root/scripts/backup-s3.sh" "$destination" || exit 3
  fi
  trap - ERR INT TERM
  printf 'Backup created: %s\n' "$destination"
else
  backup=${3:-}
  [[ ${4:-} == --confirm && ${5:-} == RESTORE ]] || exit 2
  verify_backup_manifest "$backup"
  [[ $BACKUP_FORMAT == payload-v1 ]] || { echo 'Legacy backup cannot restore a Payload release' >&2; exit 2; }
  verify_storage_archive "$backup/uploads.tar.gz"
  verify_storage_archive "$backup/cms-uploads.tar.gz"
  guard restore-preflight "$backup"
  : "${PRE_RESTORE_BACKUP_DIR:?Set PRE_RESTORE_BACKUP_DIR}"
  [[ -d $PRE_RESTORE_BACKUP_DIR && $PRE_RESTORE_BACKUP_DIR == /* ]] || exit 2
  stop_writers
  protection="$PRE_RESTORE_BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
  capture "$protection"
  destructive=true
  # The guard confirms compatible schemas/application floor and safe restore
  # targets, including extra objects pg_restore --clean would otherwise retain.
  guard prepare-restore "$backup"
  compose exec -T postgres sh -c 'pg_restore --single-transaction --clean --if-exists --no-owner --no-privileges --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' < "$backup/postgres.dump"
  # Portal pg_restore --no-privileges may remove runtime grants. Record and
  # verify this explicit intermediate floor, then reapply grants through the
  # normal migration/provision path before the next strict destructive check.
  guard portal-restore-intermediate "$backup"
  compose run --rm --no-deps migrate
  compose run --rm --no-deps -e RUN_MIGRATIONS=false -e MIGRATION_ONLY=false migrate node db/verify-migrations.js
  guard prepare-restore "$backup"
  # CMS ownership must remain cms_migrator so future DDL uses the same owner.
  compose exec -T cms-postgres sh -c 'pg_restore --single-transaction --clean --if-exists --no-owner --no-privileges --role=cms_migrator --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' < "$backup/cms-postgres.dump"
  for service in api cms; do
    guard prepare-restore "$backup"
    artifact=uploads.tar.gz; storage=/app/uploads
    if [[ $service == cms ]]; then artifact=cms-uploads.tar.gz; storage=/var/lib/ownerinc-cms/media; fi
    compose run --rm --no-deps -T --entrypoint sh "$service" -c 'find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +' restore-files "$storage"
    guard prepare-restore "$backup"
    compose run --rm --no-deps -T --entrypoint tar "$service" -xzf - -C "$storage" < "$backup/$artifact"
  done
  guard prepare-restore "$backup"
  guard prepare-restore "$backup"
  compose run --rm --no-deps cms-migrate
  compose run --rm --no-deps --entrypoint node cms --import tsx scripts/provision-db.ts --verify-runtime
  guard verify-restored "$backup"
  # Start API/CMS/Nginx for the readiness smoke with admission still closed.
  # Resume the originally stopped services only after smoke; cms-worker is never
  # included, and release verification runs against the complete resumed floor.
  compose up -d --no-deps api cms nginx
  : "${RESTORE_BASE_URL:?Set RESTORE_BASE_URL for the isolated target}"
  BASE_URL=$RESTORE_BASE_URL bash "$root/scripts/smoke.sh"
  resume
  guard verify-release
  guard open-admission
  trap - ERR INT TERM
  echo 'Restore completed and coordinated Payload verification passed.'
fi
