#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Overrides are for a trusted root environment (or an isolated test fixture),
# never a caller-supplied shell config. Keep the project and backup policy fixed.
root=${PORTAL_ROOT-/opt/ownerinc/apps/portal-ownerinc-real}
environment=${PORTAL_ENV_FILE-/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf}
backup_dir=${PORTAL_BACKUP_DIR-/opt/ownerinc/backups/portal-ownerinc/daily}
lock_wait=${PORTAL_LOCK_WAIT_SECONDS-300}

refuse() { echo "Refusing daily backup: $1" >&2; exit 2; }
canonical_path() {
  [[ $1 == /* && $1 != / && $1 != *[[:cntrl:]]* ]] &&
    [[ $(realpath -e -- "$1" 2>/dev/null) == "$1" ]]
}
require_file() {
  [[ -f $1 && -r $1 ]] && canonical_path "$1" || refuse "missing or unsafe $2."
}

(($# == 0)) || refuse 'no positional arguments are accepted.'
[[ $lock_wait =~ ^[1-9][0-9]{0,2}$ ]] && ((lock_wait <= 900)) || refuse 'lock wait must be 1..900 seconds.'
for command in bash docker flock realpath sha256sum; do
  command -v "$command" >/dev/null || refuse "missing required command $command."
done
for directory in "$root" "$root/runtime" "$root/releases" "$backup_dir"; do
  [[ -d $directory ]] && canonical_path "$directory" || refuse 'directories must exist at absolute canonical paths, without symlinks.'
done
[[ $backup_dir != "$root" && $backup_dir != "$root/"* && $root != "$backup_dir/"* ]] || refuse 'backup directory must be separate from the application root.'
require_file "$environment" 'runtime environment file'

# Use exactly the receiver's lock inode; never remove/replace this file. Read
# current-release only AFTER acquiring it, since a deploy may complete while waiting.
lock="$root/runtime/deploy.lock"
[[ ! -L $lock && ( ! -e $lock || -f $lock ) ]] || refuse 'unsafe deploy lock.'
exec 9>>"$lock"
if ! flock -w "$lock_wait" 9; then
  echo "Unable to acquire deploy lock within ${lock_wait}s; no daily backup started." >&2
  exit 75
fi

require_file "$root/current-release" 'current-release file'
mapfile -t current_lines < "$root/current-release"
((${#current_lines[@]} == 1)) || refuse 'current-release must contain exactly one path.'
release=${current_lines[0]}
commit=${release#"$root/releases/"}
[[ $commit =~ ^[0-9a-f]{40}$ && $release == "$root/releases/$commit" ]] || refuse 'current release must be releases/<sha40> under the application root.'
[[ -d $release ]] && canonical_path "$release" || refuse 'missing or unsafe release directory.'
require_file "$release/docker-compose.yml" 'release Compose file'
require_file "$release/scripts/backup.sh" 'release backup helper'
require_file "$release/.image-env" 'immutable image manifest'

override="$root/runtime/compose.production.yaml"
if [[ -e $release/compose.ownerinc-vps.yaml || -L $release/compose.ownerinc-vps.yaml ]]; then
  override="$release/compose.ownerinc-vps.yaml"
fi
require_file "$override" 'Compose override'
chmod 700 "$backup_dir"

# backup.sh validates/parses the digest manifest without sourcing it. Capture its
# stdout so "Backup created" is not reported as success before local hash checks.
if output=$(COMPOSE_PROJECT_NAME=ownerinc-portal-prod \
  COMPOSE_ENV_FILE="$environment" COMPOSE_OVERRIDE="$override" \
  BACKUP_DIR="$backup_dir" RETENTION_DAYS=14 BACKUP_UPLOAD_S3=false LEAVE_STOPPED=false \
  bash "$release/scripts/backup.sh" "$release"); then
  destination=${output#'Backup created: '}
else
  status=$?
  echo "Daily backup helper failed (status $status); inspect journal and Portal services." >&2
  exit "$status"
fi

name=${destination#"$backup_dir/"}
if [[ ! $name =~ ^[0-9]{8}T[0-9]{6}Z$ || $output != "Backup created: $backup_dir/$name" ]] ||
  ! canonical_path "$destination"; then
  echo 'Daily backup returned an invalid destination; no verified success recorded.' >&2
  exit 1
fi
for file in postgres.dump uploads.tar.gz manifest.sha256; do
  if [[ ! -f $destination/$file || ! -s $destination/$file ]] || ! canonical_path "$destination/$file"; then
    echo 'Daily backup is incomplete; no verified success recorded.' >&2
    exit 1
  fi
done
mapfile -t hashes < "$destination/manifest.sha256"
if ((${#hashes[@]} != 2)) ||
  [[ ! ${hashes[0]} =~ ^[0-9a-f]{64}\ [\ \*]postgres\.dump$ || ! ${hashes[1]} =~ ^[0-9a-f]{64}\ [\ \*]uploads\.tar\.gz$ ]] ||
  ! (cd "$destination" && sha256sum --check --strict manifest.sha256 >/dev/null); then
  echo 'Daily backup manifest verification failed; preserve the files for inspection.' >&2
  exit 1
fi
printf 'Local backup verified: %s (S3 disabled; retention 14 days)\n' "$destination"
