#!/usr/bin/env bash
set -Eeuo pipefail

root=${1:-$(pwd)}
: "${BACKUP_DIR:?Set BACKUP_DIR to persistent storage outside the release}"
# New releases validate the complete manifest; historical legacy releases remain
# callable by the daily wrapper without this helper in their archive.
if [[ -f $root/scripts/release-manifest.sh && -f $root/.image-env ]]; then
  . "$root/scripts/release-manifest.sh"
  load_release_manifest "$root/.image-env"
  if [[ $RELEASE_FORMAT == payload-v1 ]]; then
    exec bash "$root/scripts/payload-operations.sh" backup "$root"
  fi
elif [[ -f $root/.image-env ]] && grep -Eq '^(CMS_IMAGE|RELEASE_FORMAT)=' "$root/.image-env"; then
  echo 'CMS release requires coordinated backup support' >&2; exit 2
fi
if [[ -f $root/.image-env ]]; then
  API_IMAGE=$(sed -n 's/^API_IMAGE=//p' "$root/.image-env" | tail -n 1)
  CRON_IMAGE=$(sed -n 's/^CRON_IMAGE=//p' "$root/.image-env" | tail -n 1)
  [[ $API_IMAGE =~ @sha256:[0-9a-f]{64}$ && $API_IMAGE == */ownerinc-portal-api@sha256:* ]] || { echo "Invalid API image digest" >&2; exit 2; }
  [[ $CRON_IMAGE =~ @sha256:[0-9a-f]{64}$ && $CRON_IMAGE == */ownerinc-portal-cron@sha256:* ]] || { echo "Invalid cron image digest" >&2; exit 2; }
  export API_IMAGE CRON_IMAGE
fi
RETENTION_DAYS=${RETENTION_DAYS:-14}
[[ $RETENTION_DAYS =~ ^[0-9]+$ ]] || { echo "RETENTION_DAYS must be an integer" >&2; exit 2; }

retention_candidates=()
retention_candidate_ids=()

retention_preflight_error() {
  printf 'Backup retention preflight failed: %s\n' "$1" >&2
  return 1
}

prepare_backup_root() {
  local logical component physical
  logical=$(realpath -s -m -- "$BACKUP_DIR") || retention_preflight_error 'backup root path cannot be normalized'
  component=$logical
  while [[ $component != / ]]; do
    [[ ! -L $component ]] || retention_preflight_error 'backup root path contains a symbolic link'
    component=${component%/*}
    [[ -n $component ]] || component=/
  done
  mkdir -p -- "$logical"
  physical=$(realpath -e -- "$logical") || retention_preflight_error 'backup root path cannot be resolved'
  [[ $physical == "$logical" ]] || retention_preflight_error 'backup root path is not canonical'
  BACKUP_DIR=$logical
}

valid_backup_timestamp() {
  local name=$1 parsed
  [[ $name =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  parsed=$(date -u -d \
    "${name:0:4}-${name:4:2}-${name:6:2} ${name:9:2}:${name:11:2}:${name:13:2} UTC" \
    +%Y%m%dT%H%M%SZ 2>/dev/null) || return 1
  [[ $parsed == "$name" ]]
}

validate_legacy_backup() {
  local directory=$1 artifact line file postgres_count=0 uploads_count=0
  local manifest_lines=()

  for artifact in postgres.dump uploads.tar.gz manifest.sha256; do
    [[ -f $directory/$artifact && ! -L $directory/$artifact ]] || return 1
  done
  mapfile -t manifest_lines < "$directory/manifest.sha256" || return 1
  ((${#manifest_lines[@]} == 2)) || return 1
  for line in "${manifest_lines[@]}"; do
    [[ $line =~ ^[0-9a-f]{64}\ [\ \*](postgres\.dump|uploads\.tar\.gz)$ ]] || return 1
    file=${line:66}
    case $file in
      postgres.dump) postgres_count=$((postgres_count + 1)) ;;
      uploads.tar.gz) uploads_count=$((uploads_count + 1)) ;;
      *) return 1 ;;
    esac
  done
  ((postgres_count == 1 && uploads_count == 1)) || return 1
  (cd "$directory" && sha256sum --check --strict manifest.sha256 >/dev/null 2>&1)
}

retention_preflight() {
  local entry name manifest newest_name='' identity unsafe expired listing_pid i
  local valid_names=() valid_paths=() valid_ids=()

  [[ -d $BACKUP_DIR && ! -L $BACKUP_DIR ]] || retention_preflight_error 'backup root is not a regular directory'
  [[ -r $BACKUP_DIR && -w $BACKUP_DIR && -x $BACKUP_DIR ]] || retention_preflight_error 'backup root permissions do not allow safe retention'

  while IFS= read -r -d '' entry; do
    name=${entry##*/}
    [[ ! -L $entry ]] || retention_preflight_error 'unexpected symbolic link in backup root'
    [[ -d $entry ]] || retention_preflight_error 'unexpected non-directory entry in backup root'
    valid_backup_timestamp "$name" || retention_preflight_error 'unexpected directory name in backup root'
    manifest=$entry/manifest.sha256
    [[ -f $manifest && ! -L $manifest ]] || retention_preflight_error 'backup directory has no regular manifest'
    validate_legacy_backup "$entry" || retention_preflight_error 'backup artifacts or manifest are invalid'
    unsafe=$(find -P "$entry" -mindepth 1 ! -type f -print -quit) || retention_preflight_error 'cannot inspect backup contents'
    [[ -z $unsafe ]] || retention_preflight_error 'backup contains a link, directory, or special entry'
    identity=$(stat -c '%d:%i' -- "$entry") || retention_preflight_error 'cannot inspect backup directory identity'
    valid_names+=("$name")
    valid_paths+=("$entry")
    valid_ids+=("$identity")
    if [[ -z $newest_name || $name > $newest_name ]]; then newest_name=$name; fi
  done < <(find -P "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -print0)
  listing_pid=$!
  wait "$listing_pid" || retention_preflight_error 'cannot enumerate backup root'

  for ((i = 0; i < ${#valid_paths[@]}; i++)); do
    entry=${valid_paths[i]}
    name=${valid_names[i]}
    expired=$(find -P "$entry" -maxdepth 0 -mtime "+$RETENTION_DAYS" -print -quit) || retention_preflight_error 'cannot inspect backup age'
    [[ -n $expired && $name != "$newest_name" ]] || continue

    [[ -r $entry && -w $entry && -x $entry ]] || retention_preflight_error 'expired backup permissions do not allow safe removal'
    retention_candidates+=("$entry")
    retention_candidate_ids+=("${valid_ids[i]}")
  done
}

apply_retention() {
  local candidate name identity i
  for ((i = 0; i < ${#retention_candidates[@]}; i++)); do
    candidate=${retention_candidates[i]}
    name=${candidate##*/}
    if [[ -L $candidate || ! -d $candidate || -L $candidate/manifest.sha256 || ! -f $candidate/manifest.sha256 ]]; then
      printf 'Backup retention failed: candidate changed (%s)\n' "$name" >&2
      return 1
    fi
    identity=$(stat -c '%d:%i' -- "$candidate") || {
      printf 'Backup retention failed: candidate cannot be inspected (%s)\n' "$name" >&2
      return 1
    }
    if [[ $identity != "${retention_candidate_ids[i]}" ]]; then
      printf 'Backup retention failed: candidate identity changed (%s)\n' "$name" >&2
      return 1
    fi
    if ! rm -rf --one-file-system -- "$candidate"; then
      printf 'Backup retention failed: candidate could not be removed (%s)\n' "$name" >&2
      return 1
    fi
    if [[ -e $candidate || -L $candidate ]]; then
      printf 'Backup retention failed: candidate remains after removal (%s)\n' "$name" >&2
      return 1
    fi
  done
}

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

prepare_backup_root
retention_preflight

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$BACKUP_DIR/$timestamp"
if ! mkdir -- "$destination"; then
  printf 'Unable to create backup destination: %s\n' "$timestamp" >&2
  exit 1
fi

stopped=()
destination_created=true
running=''

restore_services() {
  if ((${#stopped[@]})); then compose start "${stopped[@]}" >/dev/null; fi
}

preserve_failed_attempt() {
  local status=$?
  trap - ERR INT TERM
  restore_services || true
  if [[ $destination_created == true ]]; then
    printf 'Backup attempt preserved: %s\n' "$timestamp" >&2
  fi
  exit "$status"
}
trap preserve_failed_attempt ERR INT TERM

running=$(compose ps --status running --services)
for service in nginx cron api; do
  if grep -qx "$service" <<<"$running"; then stopped+=("$service"); fi
done

if ((${#stopped[@]})); then compose stop "${stopped[@]}" >/dev/null; fi

compose exec -T postgres sh -c \
  'pg_dump --format=custom --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' \
  > "$destination/postgres.dump"
compose run --rm --no-deps -T --entrypoint tar api \
  -czf - -C /app/uploads . > "$destination/uploads.tar.gz"

(cd "$destination" && sha256sum postgres.dump uploads.tar.gz > manifest.sha256)
if [[ ${LEAVE_STOPPED:-false} != true ]]; then restore_services; fi
apply_retention
trap - ERR INT TERM
remote_status=0
if [[ ${BACKUP_UPLOAD_S3:-false} == true ]]; then
  if ! bash "$root/scripts/backup-s3.sh" "$destination"; then
    echo "Local backup preserved; S3 upload failed: $destination" >&2
    remote_status=3
  fi
fi
trap - ERR INT TERM
if ((remote_status)); then exit "$remote_status"; fi
printf 'Backup created: %s\n' "$destination"
