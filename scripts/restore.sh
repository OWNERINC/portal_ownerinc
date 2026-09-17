#!/usr/bin/env bash
set -euo pipefail

backup=${1:-}
[[ ${2:-} == --confirm && ${3:-} == RESTORE ]] || {
  echo "Usage: $0 BACKUP_DIRECTORY --confirm RESTORE" >&2
  exit 2
}
[[ -d $backup && -f $backup/manifest.sha256 ]] || { echo "Invalid backup directory" >&2; exit 2; }

root=${PROJECT_ROOT:-$(pwd)}
[[ -f $root/.image-env ]] || { echo "Missing immutable image manifest: $root/.image-env" >&2; exit 2; }
API_IMAGE=$(sed -n 's/^API_IMAGE=//p' "$root/.image-env" | tail -n 1)
CRON_IMAGE=$(sed -n 's/^CRON_IMAGE=//p' "$root/.image-env" | tail -n 1)
[[ $API_IMAGE =~ @sha256:[0-9a-f]{64}$ && $API_IMAGE == */ownerinc-portal-api@sha256:* ]] || { echo "Invalid API image digest" >&2; exit 2; }
[[ $CRON_IMAGE =~ @sha256:[0-9a-f]{64}$ && $CRON_IMAGE == */ownerinc-portal-cron@sha256:* ]] || { echo "Invalid cron image digest" >&2; exit 2; }
export API_IMAGE CRON_IMAGE
(cd "$backup" && sha256sum -c manifest.sha256)

compose() {
  local args=(--profile notifications)
  if [[ -n ${COMPOSE_ENV_FILE:-} ]]; then
    [[ -f $COMPOSE_ENV_FILE ]] || { echo "Missing Compose environment file: $COMPOSE_ENV_FILE" >&2; return 2; }
    args+=(--env-file "$COMPOSE_ENV_FILE")
  fi
  local override=${COMPOSE_OVERRIDE:-}
  if [[ -n $override ]]; then
    args=(--profile notifications --file "$root/docker-compose.yml" --file "$override"
      --project-name "${COMPOSE_PROJECT_NAME:-ownerinc-portal-prod}" --project-directory "$root")
    if [[ -n ${COMPOSE_ENV_FILE:-} ]]; then
      args=(--profile notifications --env-file "$COMPOSE_ENV_FILE" --file "$root/docker-compose.yml" --file "$override"
        --project-name "${COMPOSE_PROJECT_NAME:-ownerinc-portal-prod}" --project-directory "$root")
    fi
  else
    args+=(--project-directory "$root")
  fi
  docker compose "${args[@]}" "$@"
}

BACKUP_DIR=${PRE_RESTORE_BACKUP_DIR:-"$(dirname "$backup")/pre-restore"} LEAVE_STOPPED=true \
  bash "$(dirname "$0")/backup.sh" "$root"

restart() { compose up -d --no-build; }
restore_failed() {
  trap - ERR INT TERM
  set +e
  stop_status=0
  compose stop nginx api cron >/dev/null 2>&1 || stop_status=$?
  running=$(compose ps --status running --services 2>/dev/null || true)
  if (( stop_status != 0 )) || grep -Eq '^(nginx|api|cron)$' <<<"$running"; then
    echo "Restore failed and a required service is still running; stop it before retrying." >&2
  else
    echo "Restore failed; services remain stopped. Inspect the database or restore the pre-restore backup before restarting." >&2
  fi
  exit 1
}
trap restore_failed ERR INT TERM
compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -c "DROP TABLE IF EXISTS public.firebase_cleanup_queue CASCADE; DROP TABLE IF EXISTS public.pending_registrations CASCADE"'
compose exec -T postgres sh -c \
  'pg_restore --single-transaction --clean --if-exists --no-owner --no-privileges --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' \
  < "$backup/postgres.dump"
compose run --rm --no-deps api \
  sh -c 'find /app/uploads -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
compose run --rm -T --no-deps api \
  tar -xzf - -C /app/uploads < "$backup/uploads.tar.gz"
compose run --rm --no-deps \
  -e RUN_MIGRATIONS=true -e MIGRATION_ONLY=true \
  migrate
compose run --rm --no-deps \
  -e RUN_MIGRATIONS=false -e MIGRATION_ONLY=false \
  migrate node db/verify-migrations.js
restart
if [[ -n ${RESTORE_BASE_URL:-} ]]; then
  BASE_URL=$RESTORE_BASE_URL bash "$(dirname "$0")/smoke.sh"
else
  published=$(compose port nginx 80 | tail -n 1)
  [[ -n $published ]] || { echo "Restore smoke requires RESTORE_BASE_URL when the proxy has no published port." >&2; exit 1; }
  BASE_URL="http://$published" bash "$(dirname "$0")/smoke.sh"
fi
trap - ERR INT TERM
echo "Restore completed and smoke check passed."
