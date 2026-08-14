#!/usr/bin/env bash
set -Eeuo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

root=/opt/ownerinc/apps/portal-ownerinc-real
runtime="$root/runtime"
releases="$root/releases"
current_file="$root/current-release"
environment=/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf
backup_root=/opt/ownerinc/backups/portal-ownerinc/production
production_override="$runtime/compose.production.yaml"
project=ownerinc-portal-prod
api_container="$project-api-1"
postgres_container="$project-postgres-1"
web_container=portal-ownerinc-web
uploads_volume="${project}_uploads_data"
nginx_image='nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752'

requested_commit=${SSH_ORIGINAL_COMMAND:-${1:-}}
[[ $requested_commit =~ ^[0-9a-f]{40}$ ]] || {
  echo "Refusing deployment: expected one 40-character commit SHA." >&2
  exit 2
}

for command in docker flock tar gzip sha256sum curl stat mktemp; do
  command -v "$command" >/dev/null || {
    echo "Refusing deployment: missing required command $command." >&2
    exit 2
  }
done

[[ -f $environment && -f $production_override && -d $releases && -d $backup_root ]] || {
  echo "Refusing deployment: production runtime is incomplete." >&2
  exit 2
}

exec 9>"$runtime/deploy.lock"
flock -n 9 || {
  echo "Another production deployment is already running." >&2
  exit 3
}

current=
if [[ -s $current_file ]]; then
  current=$(<"$current_file")
fi
if [[ $current == "$releases/$requested_commit" ]]; then
  curl --fail --silent --show-error --max-time 10 \
    https://portal.ownerinc.com.br/api/ready >/dev/null
  printf '{"deployment":"already_current","commit":"%s"}\n' "$requested_commit"
  exit 0
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

cleanup_files() {
  [[ ! -e $archive ]] || unlink "$archive"
  if [[ -d $staging ]]; then
    rm -rf -- "$staging"
  fi
}
trap cleanup_files EXIT

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
for required in docker-compose.yml public/index.html nginx/nginx.conf api/db/migrate.js; do
  [[ -f $staging/$required ]] || {
    echo "Refusing deployment: archive is missing $required." >&2
    exit 2
  }
done
printf '%s\n' "$requested_commit" >"$staging/.deployed-commit"

api_tag="ghcr.io/ownerinc/ownerinc-portal-api:$requested_commit"
cron_tag="ghcr.io/ownerinc/ownerinc-portal-cron:$requested_commit"
docker pull "$api_tag" >/dev/null
docker pull "$cron_tag" >/dev/null
api_image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$api_tag")
cron_image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$cron_tag")
[[ $api_image == ghcr.io/ownerinc/ownerinc-portal-api@sha256:* ]] || {
  echo "Refusing deployment: API image did not resolve to an immutable digest." >&2
  exit 2
}
[[ $cron_image == ghcr.io/ownerinc/ownerinc-portal-cron@sha256:* ]] || {
  echo "Refusing deployment: cron image did not resolve to an immutable digest." >&2
  exit 2
}
printf 'API_IMAGE=%s\nCRON_IMAGE=%s\n' "$api_image" "$cron_image" \
  >"$staging/.image-env"

if [[ -d $release ]]; then
  rm -rf -- "$release"
fi
mv "$staging" "$release"

compose_for() {
  local selected_release=$1
  shift
  local selected_override=$production_override
  local image_environment=()
  if [[ -f $selected_release/compose.ownerinc-vps.yaml ]]; then
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
    --project-directory "$selected_release" \
    --profile notifications \
    "$@"
}

rollback() {
  local exit_code=$?
  trap - ERR INT TERM
  set +e
  echo "Deployment failed; restoring the previous production release." >&2
  docker stop "$web_container" "$api_container" >/dev/null 2>&1 || true
  if [[ $migration_started == true && $backup_complete == true ]]; then
    docker exec -i "$postgres_container" sh -c \
      'pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' \
      <"$backup/postgres.dump"
  fi
  if [[ -n $current ]]; then
    compose_for "$current" up -d --remove-orphans
    restored=false
    for _ in {1..30}; do
      if curl --fail --silent --show-error --max-time 5 \
        https://portal.ownerinc.com.br/api/ready >/dev/null 2>&1; then
        restored=true
        break
      fi
      sleep 2
    done
    if [[ $restored != true ]]; then
      echo "Previous release did not recover before the rollback deadline." >&2
    fi
  elif [[ $services_stopped == true ]]; then
    docker start "$postgres_container" >/dev/null 2>&1 || true
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

docker stop "$web_container" "$api_container" >/dev/null
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
compose_for "$release" up -d --remove-orphans

ready=false
for _ in {1..45}; do
  if curl --fail --silent --show-error --max-time 5 \
      https://portal.ownerinc.com.br/api/ready >/dev/null 2>&1 \
    && curl --fail --silent --show-error --max-time 5 \
      https://portal.ownerinc.com.br/login.html >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [[ $ready != true ]]; then
  echo "Production readiness did not recover before the deadline." >&2
  false
fi

expected_public_hash=$(sha256sum "$release/public/index.html" | awk '{print $1}')
mounted_public_hash=$(docker exec "$web_container" \
  sha256sum /usr/share/nginx/html/index.html | awk '{print $1}')
if [[ $mounted_public_hash != "$expected_public_hash" ]]; then
  echo "Deployed web container does not contain the requested release." >&2
  false
fi
if [[ $(docker inspect --format '{{.Config.Image}}' "$api_container") != "$api_image" ]]; then
  echo "Deployed API container is not using the resolved immutable digest." >&2
  false
fi

current_tmp="$runtime/current-release.$$"
printf '%s\n' "$release" >"$current_tmp"
chmod 644 "$current_tmp"
mv "$current_tmp" "$current_file"
trap - ERR INT TERM
printf '{"deployment":"ready","commit":"%s","backup":"%s"}\n' \
  "$requested_commit" "$(basename "$backup")"
