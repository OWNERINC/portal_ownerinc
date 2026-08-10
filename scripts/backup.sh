#!/usr/bin/env bash
set -euo pipefail

root=${1:-$(pwd)}
: "${BACKUP_DIR:?Set BACKUP_DIR to persistent storage outside the release}"
if [[ -f $root/.image-env ]]; then
  set -a
  source "$root/.image-env"
  set +a
fi
RETENTION_DAYS=${RETENTION_DAYS:-14}
[[ $RETENTION_DAYS =~ ^[0-9]+$ ]] || { echo "RETENTION_DAYS must be an integer" >&2; exit 2; }

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$BACKUP_DIR/$timestamp"
mkdir -p "$destination"

running=$(docker compose --project-directory "$root" ps --status running --services)
stopped=()
for service in nginx cron api; do
  if grep -qx "$service" <<<"$running"; then stopped+=("$service"); fi
done

restore_services() {
  if ((${#stopped[@]})); then docker compose --project-directory "$root" start "${stopped[@]}" >/dev/null; fi
}
cleanup() { restore_services; rm -rf "$destination"; }
trap cleanup ERR INT TERM

if ((${#stopped[@]})); then docker compose --project-directory "$root" stop "${stopped[@]}" >/dev/null; fi

docker compose --project-directory "$root" exec -T postgres sh -c \
  'pg_dump --format=custom --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' \
  > "$destination/postgres.dump"
docker compose --project-directory "$root" run --rm --no-deps -T --entrypoint tar api \
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
