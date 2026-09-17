#!/usr/bin/env bash
set -euo pipefail

root=${1:-$(pwd)}
: "${BACKUP_DIR:?Set BACKUP_DIR to persistent storage outside the release}"
if [[ -f $root/.image-env ]]; then
  API_IMAGE=$(sed -n 's/^API_IMAGE=//p' "$root/.image-env" | tail -n 1)
  CRON_IMAGE=$(sed -n 's/^CRON_IMAGE=//p' "$root/.image-env" | tail -n 1)
  [[ $API_IMAGE =~ @sha256:[0-9a-f]{64}$ && $API_IMAGE == */ownerinc-portal-api@sha256:* ]] || { echo "Invalid API image digest" >&2; exit 2; }
  [[ $CRON_IMAGE =~ @sha256:[0-9a-f]{64}$ && $CRON_IMAGE == */ownerinc-portal-cron@sha256:* ]] || { echo "Invalid cron image digest" >&2; exit 2; }
  export API_IMAGE CRON_IMAGE
fi
RETENTION_DAYS=${RETENTION_DAYS:-14}
[[ $RETENTION_DAYS =~ ^[0-9]+$ ]] || { echo "RETENTION_DAYS must be an integer" >&2; exit 2; }

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

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$BACKUP_DIR/$timestamp"
mkdir -p "$destination"

running=$(compose ps --status running --services)
stopped=()
for service in nginx cron api; do
  if grep -qx "$service" <<<"$running"; then stopped+=("$service"); fi
done

restore_services() {
  if ((${#stopped[@]})); then compose start "${stopped[@]}" >/dev/null; fi
}
cleanup() { restore_services; rm -rf "$destination"; }
trap cleanup ERR INT TERM

if ((${#stopped[@]})); then compose stop "${stopped[@]}" >/dev/null; fi

compose exec -T postgres sh -c \
  'pg_dump --format=custom --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' \
  > "$destination/postgres.dump"
compose run --rm --no-deps -T --entrypoint tar api \
  -czf - -C /app/uploads . > "$destination/uploads.tar.gz"

(cd "$destination" && sha256sum postgres.dump uploads.tar.gz > manifest.sha256)
if [[ ${LEAVE_STOPPED:-false} != true ]]; then restore_services; fi
trap - ERR INT TERM
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -exec rm -rf -- {} +
remote_status=0
if [[ ${BACKUP_UPLOAD_S3:-false} == true ]]; then
  if ! "$root/scripts/backup-s3.sh" "$destination"; then
    echo "Local backup preserved; S3 upload failed: $destination" >&2
    remote_status=3
  fi
fi
trap - ERR INT TERM
if ((remote_status)); then exit "$remote_status"; fi
printf 'Backup created: %s\n' "$destination"
