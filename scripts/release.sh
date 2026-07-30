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

commit=${release_id%%-*}
image_registry=$(sed -n 's/^IMAGE_REGISTRY=//p' "$shared/.env" | tail -n 1)
[[ $image_registry =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)*$ ]] || {
  echo "IMAGE_REGISTRY is missing or invalid" >&2
  exit 2
}
api_tag="$image_registry/ownerinc-portal-api:$commit"
cron_tag="$image_registry/ownerinc-portal-cron:$commit"
docker pull "$api_tag"
docker pull "$cron_tag"
export API_IMAGE=$(docker image inspect --format '{{index .RepoDigests 0}}' "$api_tag")
export CRON_IMAGE=$(docker image inspect --format '{{index .RepoDigests 0}}' "$cron_tag")
[[ $API_IMAGE == *@sha256:* && $CRON_IMAGE == *@sha256:* ]] || {
  echo "Unable to resolve immutable image digests" >&2
  exit 2
}
printf 'API_IMAGE=%s\nCRON_IMAGE=%s\n' "$API_IMAGE" "$CRON_IMAGE" > "$release/.image-env"

if [[ -n $previous && -f $previous/docker-compose.yml ]]; then
  BACKUP_DIR="$shared/backups" bash "$release/scripts/backup.sh" "$previous"
fi

docker compose --project-directory "$release" config --quiet
ln -sfn "$release" "$root/current"

rollback() {
  echo "Release failed; rolling back containers to the previous release." >&2
  if [[ -n $previous && -f $previous/docker-compose.yml ]]; then
    ln -sfn "$previous" "$root/current"
    set -a
    source "$previous/.image-env"
    set +a
    docker compose --project-directory "$previous" up -d --no-build
  else
    rm -f "$root/current"
  fi
}
trap rollback ERR INT TERM

docker compose --project-directory "$release" up -d --remove-orphans
docker compose --project-directory "$release" run --rm --no-deps -e RUN_MIGRATIONS=false migrate node db/verify-migrations.js
published=$(docker compose --project-directory "$release" port nginx 80 | tail -n 1)
BASE_URL="http://$published" bash "$release/scripts/smoke.sh"
trap - ERR INT TERM
printf '{"release":"%s","status":"ready"}\n' "$release_id"
