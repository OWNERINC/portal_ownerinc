#!/usr/bin/env bash
set -euo pipefail

root=${1:?root path required}
release=${2:?release path required}
release_id=${3:?release id required}
[[ $release == "$root/releases/$release_id" && $release_id =~ ^[0-9a-f]{40}-[0-9]{14}$ ]] || {
  echo "Invalid release arguments" >&2
  exit 2
}

shared="$root/shared"
previous=$(readlink -f "$root/current" 2>/dev/null || true)
ln -s "$shared/.env" "$release/.env"

image_registry=$(sed -n 's/^IMAGE_REGISTRY=//p' "$shared/.env" | tail -n 1)
[[ $image_registry =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)*$ ]] || {
  echo "IMAGE_REGISTRY is missing or invalid" >&2
  exit 2
}
image_env="$release/.image-env"
[[ -f $image_env ]] || {
  echo "Immutable image manifest is missing" >&2
  exit 2
}
load_images() {
  local manifest=$1
  API_IMAGE=$(sed -n 's/^API_IMAGE=//p' "$manifest" | tail -n 1)
  CRON_IMAGE=$(sed -n 's/^CRON_IMAGE=//p' "$manifest" | tail -n 1)
  [[ $API_IMAGE == "$image_registry/ownerinc-portal-api@sha256:"* && $API_IMAGE =~ @sha256:[0-9a-f]{64}$ ]] || return 1
  [[ $CRON_IMAGE == "$image_registry/ownerinc-portal-cron@sha256:"* && $CRON_IMAGE =~ @sha256:[0-9a-f]{64}$ ]] || return 1
  export API_IMAGE CRON_IMAGE
}
load_images "$image_env" || { echo "Invalid image manifest" >&2; exit 2; }
pull_images() {
  docker pull "$API_IMAGE" >/dev/null
  docker pull "$CRON_IMAGE" >/dev/null
  docker image inspect "$API_IMAGE" >/dev/null
  docker image inspect "$CRON_IMAGE" >/dev/null
}
pull_images

rollback_preflight() {
  local exit_code=$?
  trap - ERR INT TERM
  set +e
  if [[ -n $previous && -f $previous/docker-compose.yml ]]; then
    ln -sfn "$previous" "$root/current"
    load_images "$previous/.image-env"
    pull_images
    docker compose --profile notifications --project-directory "$previous" up -d --no-build
  else
    rm -f "$root/current"
  fi
  exit "$exit_code"
}
trap rollback_preflight ERR INT TERM

if [[ -n $previous && -f $previous/docker-compose.yml ]]; then
  BACKUP_DIR="$shared/backups" LEAVE_STOPPED=true bash "$release/scripts/backup.sh" "$previous"
fi

docker compose --profile notifications --project-directory "$release" config --quiet

rollback() {
  echo "Release failed; rolling back containers to the previous release." >&2
  if [[ -n $previous && -f $previous/docker-compose.yml ]]; then
    ln -sfn "$previous" "$root/current"
    load_images "$previous/.image-env"
    pull_images
    docker compose --profile notifications --project-directory "$previous" up -d --no-build
  else
    rm -f "$root/current"
  fi
}
trap rollback ERR INT TERM

docker compose --profile notifications --project-directory "$release" stop nginx api cron >/dev/null
running=$(docker compose --profile notifications --project-directory "$release" ps --status running --services)
if grep -Eq '^(nginx|api|cron)$' <<<"$running"; then
  echo "Unable to stop the previous public services before migration." >&2
  false
fi
docker compose --profile notifications --project-directory "$release" up -d --no-deps postgres
docker compose --profile notifications --project-directory "$release" run --rm migrate
docker compose --profile notifications --project-directory "$release" run --rm --no-deps -e RUN_MIGRATIONS=false -e MIGRATION_ONLY=false migrate node db/verify-migrations.js
CRON_BOOTSTRAP_ONLY=true docker compose --profile notifications --project-directory "$release" up -d --no-deps api cron
api_container=$(docker compose --profile notifications --project-directory "$release" ps -q api)
cron_container=$(docker compose --profile notifications --project-directory "$release" ps -q cron)
api_healthy=false
for _ in {1..45}; do
  api_health=$(docker inspect --format='{{.State.Health.Status}}' "$api_container" 2>/dev/null || true)
  if [[ $api_health == healthy ]]; then
    api_healthy=true
    break
  fi
  sleep 2
done
[[ $api_healthy == true ]] || { echo "New API did not become healthy before the proxy was started." >&2; false; }
cron_healthy=false
for _ in {1..90}; do
  cron_health=$(docker inspect --format='{{.State.Health.Status}}' "$cron_container" 2>/dev/null || true)
  cron_status=$(docker inspect --format='{{.State.Status}}' "$cron_container" 2>/dev/null || true)
  [[ $cron_status == exited || $cron_status == dead ]] && break
  if [[ $cron_health == healthy ]]; then
    cron_healthy=true
    break
  fi
  sleep 2
done
[[ $cron_healthy == true ]] || { echo "New cron did not become healthy before the proxy was started." >&2; false; }
[[ $(docker inspect --format '{{.Config.Image}}' "$api_container") == "$API_IMAGE" ]] || { echo "New API image digest mismatch." >&2; false; }
[[ $(docker inspect --format '{{.Config.Image}}' "$cron_container") == "$CRON_IMAGE" ]] || { echo "New cron image digest mismatch." >&2; false; }
docker compose --profile notifications --project-directory "$release" up -d --no-deps nginx
published=$(docker compose --profile notifications --project-directory "$release" port nginx 80 | tail -n 1)
BASE_URL="http://$published" bash "$release/scripts/smoke.sh"
if ! CRON_BOOTSTRAP_ONLY=false docker compose --profile notifications --project-directory "$release" up -d --force-recreate --no-deps cron; then
  echo "New cron could not be started after the release became current." >&2
  false
fi
cron_container=$(docker compose --profile notifications --project-directory "$release" ps -q cron)
cron_started=false
for _ in {1..90}; do
  cron_health=$(docker inspect --format='{{.State.Health.Status}}' "$cron_container" 2>/dev/null || true)
  cron_status=$(docker inspect --format='{{.State.Status}}' "$cron_container" 2>/dev/null || true)
  [[ $cron_status == exited || $cron_status == dead ]] && break
  if [[ $cron_health == healthy ]]; then
    cron_started=true
    break
  fi
  sleep 2
done
if [[ $cron_started != true ]]; then
  docker stop "$cron_container" >/dev/null 2>&1 || true
  echo "New cron did not become healthy after the release became current." >&2
  false
fi
ln -sfn "$release" "$root/current"
trap - ERR INT TERM
printf '{"release":"%s","status":"ready"}\n' "$release_id"
