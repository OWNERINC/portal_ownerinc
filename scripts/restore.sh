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
set -a
source "$root/.image-env"
set +a
(cd "$backup" && sha256sum -c manifest.sha256)

BACKUP_DIR=${PRE_RESTORE_BACKUP_DIR:-"$(dirname "$backup")/pre-restore"} LEAVE_STOPPED=true \
  bash "$(dirname "$0")/backup.sh" "$root"

restart() { docker compose --project-directory "$root" up -d --no-build; }
restore_failed() {
  trap - ERR INT TERM
  docker compose --project-directory "$root" stop nginx api cron >/dev/null 2>&1 || true
  echo "Restore failed; services remain stopped. Inspect the database or restore the pre-restore backup before restarting." >&2
  exit 1
}
trap restore_failed ERR INT TERM
docker compose --project-directory "$root" exec -T postgres sh -c \
  'pg_restore --single-transaction --clean --if-exists --no-owner --no-privileges --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' \
  < "$backup/postgres.dump"
docker compose --project-directory "$root" run --rm --no-deps api \
  sh -c 'find /app/uploads -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
docker compose --project-directory "$root" run --rm -T --no-deps api \
  tar -xzf - -C /app/uploads < "$backup/uploads.tar.gz"
docker compose --project-directory "$root" run --rm migrate node db/provision.js
restart
published=$(docker compose --project-directory "$root" port nginx 80 | tail -n 1)
BASE_URL="http://$published" bash "$(dirname "$0")/smoke.sh"
trap - ERR INT TERM
echo "Restore completed and smoke check passed."
