#!/usr/bin/env bash
set -Eeuo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

if [[ -n ${SSH_ORIGINAL_COMMAND:-} ]]; then
  case $SSH_ORIGINAL_COMMAND in
    production:*) target=production; requested_commit=${SSH_ORIGINAL_COMMAND#production:} ;;
    staging:*) target=staging; requested_commit=${SSH_ORIGINAL_COMMAND#staging:} ;;
    *) echo "Refusing deployment: SSH target must be production or staging." >&2; exit 2 ;;
  esac
  if [[ -n ${DEPLOY_RECEIVER_ROLE:-} && $target != "$DEPLOY_RECEIVER_ROLE" ]]; then
    echo "Refusing deployment: receiver role does not match the SSH target." >&2
    exit 2
  fi
else
  target=${DEPLOY_TARGET:-production}
  requested_commit=${1:-}
  if [[ -n ${DEPLOY_RECEIVER_ROLE:-} && $target != "$DEPLOY_RECEIVER_ROLE" ]]; then
    echo "Refusing deployment: receiver role does not match the target." >&2
    exit 2
  fi
fi
[[ $requested_commit =~ ^[0-9a-f]{40}$ ]] || {
  echo "Refusing deployment: expected a target and one 40-character commit SHA." >&2
  exit 2
}
[[ $target == production || $target == staging ]] || {
  echo "Refusing deployment: target must be production or staging." >&2
  exit 2
}

if [[ $target == production ]]; then
  root=/opt/ownerinc/apps/portal-ownerinc-real
  runtime="$root/runtime"
  releases="$root/releases"
  current_file="$root/current-release"
  environment=/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf
  backup_root=/opt/ownerinc/backups/portal-ownerinc/production
  production_override="$runtime/compose.production.yaml"
  project=ownerinc-portal-prod
  api_container="$project-api-1"
  cron_container="$project-cron-1"
  postgres_container="$project-postgres-1"
  web_container=portal-ownerinc-web
  uploads_volume="${project}_uploads_data"
  public_url=https://portal.ownerinc.com.br
else
  deploy_config=${DEPLOY_CONFIG:-/etc/ownerinc/portal-staging-deploy.conf}
  [[ -r $deploy_config ]] || { echo "Refusing staging deployment: missing $deploy_config." >&2; exit 2; }
  set -a
  . "$deploy_config"
  set +a
  : "${DEPLOY_ROOT:?Set DEPLOY_ROOT in the staging deploy config}"
  : "${DEPLOY_RUNTIME:?Set DEPLOY_RUNTIME in the staging deploy config}"
  : "${DEPLOY_RELEASES:?Set DEPLOY_RELEASES in the staging deploy config}"
  : "${DEPLOY_CURRENT_FILE:?Set DEPLOY_CURRENT_FILE in the staging deploy config}"
  : "${DEPLOY_ENVIRONMENT:?Set DEPLOY_ENVIRONMENT in the staging deploy config}"
  : "${DEPLOY_BACKUP_ROOT:?Set DEPLOY_BACKUP_ROOT in the staging deploy config}"
  : "${DEPLOY_COMPOSE_OVERRIDE:?Set DEPLOY_COMPOSE_OVERRIDE in the staging deploy config}"
  : "${DEPLOY_PROJECT:?Set DEPLOY_PROJECT in the staging deploy config}"
  : "${DEPLOY_PUBLIC_URL:?Set DEPLOY_PUBLIC_URL in the staging deploy config}"
  root=$DEPLOY_ROOT
  runtime=$DEPLOY_RUNTIME
  releases=$DEPLOY_RELEASES
  current_file=$DEPLOY_CURRENT_FILE
  environment=$DEPLOY_ENVIRONMENT
  backup_root=$DEPLOY_BACKUP_ROOT
  production_override=$DEPLOY_COMPOSE_OVERRIDE
  project=$DEPLOY_PROJECT
  api_container=${DEPLOY_API_CONTAINER:-$project-api-1}
  cron_container=${DEPLOY_CRON_CONTAINER:-$project-cron-1}
  postgres_container=${DEPLOY_POSTGRES_CONTAINER:-$project-postgres-1}
  web_container=${DEPLOY_WEB_CONTAINER:-$project-nginx-1}
  uploads_volume=${DEPLOY_UPLOADS_VOLUME:-${project}_uploads_data}
  public_url=$DEPLOY_PUBLIC_URL
  public_authority=${public_url#*://}
  public_authority=${public_authority%%/*}
  public_authority=${public_authority%%\?*}
  public_authority=${public_authority%%\#*}
  public_authority=${public_authority##*@}
  public_authority=${public_authority,,}
  case $public_authority in
    portal.ownerinc.com.br|portal.ownerinc.com.br.|portal.ownerinc.com.br:*|portal.ownerinc.com.br.:*)
      echo "Refusing staging deployment: staging URL points to production." >&2
      exit 2
      ;;
  esac
  for path in "$root" "$runtime" "$releases" "$current_file" "$environment" "$backup_root" "$production_override"; do
    [[ $path == /* ]] || { echo "Refusing staging deployment: paths must be absolute." >&2; exit 2; }
    canonical_path=$(realpath -e "$path" 2>/dev/null || realpath -m -- "$path")
    case $canonical_path in
      /opt/ownerinc/apps/portal-ownerinc-real|/opt/ownerinc/apps/portal-ownerinc-real/*|/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf|/opt/ownerinc/backups/portal-ownerinc/production|/opt/ownerinc/backups/portal-ownerinc/production/*)
        echo "Refusing staging deployment: staging configuration overlaps production." >&2
        exit 2
        ;;
    esac
  done
  [[ $project != ownerinc-portal-prod && $uploads_volume != ownerinc-portal-prod_uploads_data && \
     $api_container != ownerinc-portal-prod-api-1 && $cron_container != ownerinc-portal-prod-cron-1 && \
     $postgres_container != ownerinc-portal-prod-postgres-1 && $web_container != portal-ownerinc-web && \
     $public_url != https://portal.ownerinc.com.br && $public_url != https://portal.ownerinc.com.br/* ]] || {
    echo "Refusing staging deployment: staging names or URL overlap production." >&2
    exit 2
  }
fi
nginx_image='nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752'
[[ $public_url =~ ^https?://[^[:space:]]+$ ]] || {
  echo "Refusing deployment: $target public URL is invalid." >&2
  exit 2
}
if [[ $target == staging && ( $public_url == *\?* || $public_url == *\#* || $public_url == *@* ) ]]; then
  echo "Refusing staging deployment: public URL cannot contain query, fragment, or credentials." >&2
  exit 2
fi

for command in docker flock tar gzip sha256sum curl stat mktemp find realpath; do
  command -v "$command" >/dev/null || {
    echo "Refusing deployment: missing required command $command." >&2
    exit 2
  }
done

[[ -d $root && -d $runtime && -f $environment && -f $production_override && -d $releases && -d $backup_root ]] || {
  echo "Refusing deployment: $target runtime is incomplete." >&2
  exit 2
}
if [[ $target == staging ]]; then
  runtime_public_url=$(sed -n 's/^PORTAL_PUBLIC_URL=//p' "$environment" | tail -n 1)
  runtime_public_url=${runtime_public_url#\"}
  runtime_public_url=${runtime_public_url%\"}
  runtime_public_url=${runtime_public_url%/}
  expected_public_url=${public_url%/}
  [[ -n $runtime_public_url && $runtime_public_url == "$expected_public_url" ]] || {
    echo "Refusing staging deployment: runtime PORTAL_PUBLIC_URL does not match the staging target." >&2
    exit 2
  }
fi
mkdir -p "$root/incoming"
chmod 700 "$root/incoming"

exec 9>"$runtime/deploy.lock"
flock -n 9 || {
  echo "Another $target deployment is already running." >&2
  exit 3
}

current=
if [[ -s $current_file ]]; then
  current=$(<"$current_file")
fi

compose_for() {
  local selected_release=$1
  shift
  local selected_override=$production_override
  local image_environment=()
  if [[ $target == production && -f $selected_release/compose.ownerinc-vps.yaml ]]; then
    selected_override="$selected_release/compose.ownerinc-vps.yaml"
  fi
  if [[ -f $selected_release/.image-env ]]; then
    image_environment=(--env-file "$selected_release/.image-env")
  fi
  docker compose \
    --env-file "$environment" \
    "${image_environment[@]}" \
    --file "$selected_release/docker-compose.yml" \
    --file "$selected_override" \
    --project-name "$project" \
    --project-directory "$selected_release" \
    --profile notifications \
    "$@"
}

wait_for_healthy_cron() {
  for _ in {1..90}; do
    local cron_health cron_status
    cron_health=$(docker inspect --format='{{.State.Health.Status}}' "$cron_container" 2>/dev/null || true)
    cron_status=$(docker inspect --format='{{.State.Status}}' "$cron_container" 2>/dev/null || true)
    if [[ $cron_status == exited || $cron_status == dead ]]; then return 1; fi
    if [[ $cron_health == healthy ]]; then return 0; fi
    sleep 2
  done
  return 1
}

if [[ $current == "$releases/$requested_commit" ]]; then
  curl --fail --silent --show-error --max-time 10 \
    "$public_url/api/ready" >/dev/null
  cron_environment=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cron_container" 2>/dev/null || true)
  cron_running=$(docker inspect --format '{{.State.Running}}' "$cron_container" 2>/dev/null || true)
  cron_health=$(docker inspect --format '{{.State.Health.Status}}' "$cron_container" 2>/dev/null || true)
  if ! grep -Fxq 'CRON_BOOTSTRAP_ONLY=false' <<<"$cron_environment" || [[ $cron_running != true || $cron_health != healthy ]]; then
    CRON_BOOTSTRAP_ONLY=false compose_for "$current" up -d --force-recreate --no-deps cron
  fi
  if wait_for_healthy_cron; then
    printf '{"deployment":"already_current","commit":"%s"}\n' "$requested_commit"
    exit 0
  fi
  echo "Current release is not healthy; cron recovery requires operator intervention." >&2
  exit 1
fi
[[ -z $current || $current =~ ^${releases}/[0-9a-f]{40}$ ]] || {
  echo "Refusing deployment: current release path is outside the release root." >&2
  exit 2
}
if [[ -n $current ]]; then
  [[ -f $current/docker-compose.yml ]] || {
    echo "Refusing deployment: current release is incomplete." >&2
    exit 2
  }
fi

archive=$(mktemp "$root/incoming/ci-${requested_commit}.XXXXXX.tar.gz")
staging="$releases/.staging-${requested_commit}-$$"
release="$releases/$requested_commit"
backup=
backup_complete=false
migration_started=false
services_stopped=false
public_started=false

cleanup_files() {
  [[ ! -e $archive ]] || unlink "$archive"
  if [[ -d $staging ]]; then
    rm -rf -- "$staging"
  fi
}
trap cleanup_files EXIT

stop_container() {
  local container=$1
  local required=${2:-true}
  if ! docker inspect "$container" >/dev/null 2>&1; then
    if [[ $required == true ]]; then
      echo "Required container is missing: $container" >&2
      return 1
    fi
    return 0
  fi
  if [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]]; then
    docker stop "$container" >/dev/null
  fi
  [[ $(docker inspect --format '{{.State.Running}}' "$container") == false ]] || {
    echo "Container is still running: $container" >&2
    return 1
  }
}

stop_services() {
  local status=0
  stop_container "$web_container" false || status=1
  stop_container "$api_container" false || status=1
  stop_container "$cron_container" false || status=1
  return "$status"
}

cat >"$archive"
archive_size=$(stat -c '%s' "$archive")
((archive_size > 0 && archive_size <= 10485760)) || {
  echo "Refusing deployment: archive size is outside the allowed range." >&2
  exit 2
}
gzip -t "$archive"
while IFS= read -r member; do
  case "$member" in
    ''|/*|..|../*|*/..|*/../*)
      echo "Refusing deployment: unsafe archive member." >&2
      exit 2
      ;;
  esac
done < <(tar -tzf "$archive")

mkdir "$staging"
tar --extract --gzip --file "$archive" --directory "$staging" \
  --no-same-owner --no-same-permissions
find "$staging" -type d -exec chmod 0755 {} +
find "$staging" -type f -exec chmod 0644 {} +
[[ -f $staging/.ci-commit && $(<"$staging/.ci-commit") == "$requested_commit" ]] || {
  echo "Refusing deployment: archive commit does not match requested commit." >&2
  exit 2
}
unlink "$staging/.ci-commit"
for required in docker-compose.yml public/index.html nginx/nginx.conf api/db/migrate.js .ci-images; do
  [[ -f $staging/$required ]] || {
    echo "Refusing deployment: archive is missing $required." >&2
    exit 2
  }
done
api_image=$(sed -n '1p' "$staging/.ci-images")
cron_image=$(sed -n '2p' "$staging/.ci-images")
[[ $api_image == ghcr.io/ownerinc/ownerinc-portal-api@sha256:* ]] || {
  echo "Refusing deployment: CI API image digest is invalid." >&2
  exit 2
}
[[ $cron_image == ghcr.io/ownerinc/ownerinc-portal-cron@sha256:* ]] || {
  echo "Refusing deployment: CI cron image digest is invalid." >&2
  exit 2
}
unlink "$staging/.ci-images"
printf '%s\n' "$requested_commit" >"$staging/.deployed-commit"

docker pull "$api_image" >/dev/null
docker pull "$cron_image" >/dev/null
docker image inspect "$api_image" >/dev/null
docker image inspect "$cron_image" >/dev/null
printf 'API_IMAGE=%s\nCRON_IMAGE=%s\n' "$api_image" "$cron_image" \
  >"$staging/.image-env"

if [[ -d $release ]]; then
  rm -rf -- "$release"
fi
mv "$staging" "$release"

rollback() {
  local exit_code=$?
  trap - ERR INT TERM
  set +e
  unset CRON_BOOTSTRAP_ONLY
  echo "Deployment failed; restoring the previous $target release." >&2
  if ! stop_services; then
    echo "Unable to stop $target services; leaving services stopped." >&2
    exit 1
  fi
  database_restored=true
  if [[ $migration_started == true && $backup_complete == true && $public_started != true ]]; then
    # The backup predates this release's table, so pg_restore --clean cannot drop it first.
    if ! docker exec "$postgres_container" sh -c \
      'psql -v ON_ERROR_STOP=1 --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -c "DROP TABLE IF EXISTS public.firebase_cleanup_queue CASCADE; DROP TABLE IF EXISTS public.pending_registrations CASCADE"'; then
      database_restored=false
    elif ! docker exec -i "$postgres_container" sh -c \
      'pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' \
      <"$backup/postgres.dump"; then
      database_restored=false
    fi
  fi
  if [[ $database_restored != true ]]; then
    echo "Database restore failed; services remain stopped." >&2
    exit 1
  fi
  if [[ $public_started == true ]]; then
    echo "Public traffic reached the new release; database restore is intentionally skipped." >&2
  fi
  if [[ -n $current ]]; then
    current_tmp="$runtime/current-release.rollback.$$"
    printf '%s\n' "$current" >"$current_tmp"
    chmod 644 "$current_tmp"
    mv "$current_tmp" "$current_file"
    compose_for "$current" up -d --remove-orphans
    restored=false
    for _ in {1..30}; do
      if curl --fail --silent --show-error --max-time 5 \
        "$public_url/api/ready" >/dev/null 2>&1; then
        restored=true
        break
      fi
      sleep 2
    done
    if [[ $restored == true ]] && ! wait_for_healthy_cron; then
      echo "Previous release cron did not recover before the rollback deadline." >&2
      restored=false
    fi
    if [[ $restored != true ]]; then
      echo "Previous release did not recover before the rollback deadline." >&2
      if ! stop_services; then
        echo "Unable to stop failed rollback services; leaving services stopped." >&2
        exit 1
      fi
    fi
  else
    rm -f "$current_file"
    if [[ $services_stopped == true ]]; then
      docker start "$postgres_container" >/dev/null 2>&1 || true
    fi
  fi
  if [[ -d $release && $release != "$current" ]]; then
    rm -rf -- "$release"
  fi
  printf '{"deployment":"rolled_back","failed_commit":"%s"}\n' \
    "$requested_commit" >&2
  exit "$exit_code"
}
trap rollback ERR INT TERM

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$backup_root/${stamp}-autodeploy-${requested_commit:0:12}"
mkdir "$backup"
chmod 700 "$backup"

stop_services
services_stopped=true
docker exec "$postgres_container" sh -c \
  'pg_dump --format=custom --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' \
  >"$backup/postgres.dump"
docker run --rm --read-only \
  --volume "$uploads_volume:/data:ro" \
  "$nginx_image" tar -czf - -C /data . >"$backup/uploads.tar.gz"
(cd "$backup" && sha256sum postgres.dump uploads.tar.gz >manifest.sha256)
(cd "$backup" && sha256sum --check manifest.sha256 >/dev/null)
chmod 600 "$backup/postgres.dump" "$backup/uploads.tar.gz" "$backup/manifest.sha256"
backup_complete=true

migration_started=true
compose_for "$release" run --rm migrate
compose_for "$release" run --rm --no-deps \
  -e RUN_MIGRATIONS=false -e MIGRATION_ONLY=false \
  migrate node db/verify-migrations.js

# Keep the public proxy stopped while the new API and a side-effect-free cron container are validated.
export CRON_BOOTSTRAP_ONLY=true
compose_for "$release" up -d --no-deps api cron
unset CRON_BOOTSTRAP_ONLY
api_healthy=false
for _ in {1..45}; do
  api_health=$(docker inspect --format='{{.State.Health.Status}}' "$api_container" 2>/dev/null || true)
  if [[ $api_health == healthy ]]; then
    api_healthy=true
    break
  fi
  sleep 2
done
if [[ $api_healthy != true ]]; then
  echo "New API did not become healthy before the public proxy was started." >&2
  false
fi

cron_healthy=false
for _ in {1..90}; do
  cron_health=$(docker inspect --format='{{.State.Health.Status}}' "$cron_container" 2>/dev/null || true)
  cron_status=$(docker inspect --format='{{.State.Status}}' "$cron_container" 2>/dev/null || true)
  if [[ $cron_status == exited || $cron_status == dead ]]; then
    break
  fi
  if [[ $cron_health == healthy ]]; then
    cron_healthy=true
    break
  fi
  sleep 2
done
if [[ $cron_healthy != true ]]; then
  echo "New cron did not become healthy before the public proxy was started." >&2
  false
fi

if [[ $(docker inspect --format '{{.Config.Image}}' "$api_container") != "$api_image" ]]; then
  echo "New API container is not using the resolved immutable digest." >&2
  false
fi
if [[ $(docker inspect --format '{{.Config.Image}}' "$cron_container") != "$cron_image" ]]; then
  echo "New cron container is not using the resolved immutable digest." >&2
  false
fi

compose_for "$release" up -d --no-deps nginx
public_started=true

ready=false
for _ in {1..45}; do
  if curl --fail --silent --show-error --max-time 5 \
      "$public_url/api/ready" >/dev/null 2>&1 \
    && curl --fail --silent --show-error --max-time 5 \
      "$public_url/login.html" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [[ $ready != true ]]; then
  echo "$target readiness did not recover before the deadline." >&2
  false
fi

BASE_URL=$public_url bash "$release/scripts/smoke.sh"

expected_public_hash=$(sha256sum "$release/public/index.html" | awk '{print $1}')
mounted_public_hash=$(docker exec "$web_container" \
  sha256sum /usr/share/nginx/html/index.html | awk '{print $1}')
if [[ $mounted_public_hash != "$expected_public_hash" ]]; then
  echo "Deployed web container does not contain the requested release." >&2
  false
fi

find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +

export CRON_BOOTSTRAP_ONLY=false
if ! compose_for "$release" up -d --force-recreate --no-deps cron; then
  echo "New cron could not be started after the release became current." >&2
  false
fi
cron_started=false
for _ in {1..90}; do
  cron_health=$(docker inspect --format='{{.State.Health.Status}}' "$cron_container" 2>/dev/null || true)
  cron_status=$(docker inspect --format='{{.State.Status}}' "$cron_container" 2>/dev/null || true)
  if [[ $cron_status == exited || $cron_status == dead ]]; then
    break
  fi
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
current_tmp="$runtime/current-release.$$"
printf '%s\n' "$release" >"$current_tmp"
chmod 644 "$current_tmp"
mv "$current_tmp" "$current_file"
trap - ERR INT TERM
printf '{"deployment":"ready","commit":"%s","backup":"%s"}\n' \
  "$requested_commit" "$(basename "$backup")"
