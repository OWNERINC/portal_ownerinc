#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

usage() {
  echo 'Usage: prepare-cms-infrastructure.sh [--check|--apply]' >&2
  exit 2
}

mode=check
case ${1:-} in
  '') ;;
  --check) shift; (($# == 0)) || usage ;;
  --apply) mode=apply; shift; (($# == 0)) || usage ;;
  *) usage ;;
esac

if [[ $(uname -s) != Linux || $(id -u) != 0 ]]; then
  echo 'Refusing preparation: run from a reviewed Linux checkout as root.' >&2
  exit 2
fi

script_dir=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(dirname -- "$script_dir")
root=/opt/ownerinc/apps/portal-ownerinc-real
runtime="$root/runtime"
releases="$root/releases"
current_file="$root/current-release"
environment=/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf
secrets_dir=$(dirname -- "$environment")
backup_root=/opt/ownerinc/backups/portal-ownerinc/production
libexec_dir=/usr/local/libexec
receiver_target=/usr/local/libexec/ownerinc-portal-deploy
guard_target="$runtime/payload-operations-guard"
production_override="$runtime/compose.production.yaml"
payload_production_target="$runtime/compose.payload.production.yaml"
candidate_target="$runtime/cms-image-candidate.env"
lock="$runtime/deploy.lock"
cms_image='ghcr.io/ownerinc/ownerinc-portal-cms@sha256:6eaddc9a333ba682508a09a4ae8a6409d9e571abab9ec4a62829c2e9828730b0'
source_receiver="$script_dir/deploy-from-ci.sh"
source_guard="$script_dir/payload-operations-guard.sh"
source_private_helper="$script_dir/prepare-cms-infrastructure-private.py"
source_payload_overlay="$script_dir/compose.payload.production.yaml"
payload_compose="$repo_root/docker-compose.payload.yml"

for command in python3 docker flock install cmp stat mktemp mkdir mv rm date env chown chmod sha256sum; do
  command -v "$command" >/dev/null || {
    echo "Refusing preparation: required command is unavailable ($command)." >&2
    exit 2
  }
done

for source in "$source_receiver" "$source_guard" "$source_private_helper" \
  "$source_payload_overlay" "$payload_compose"; do
  [[ -f $source && ! -L $source ]] || {
    echo 'Refusing preparation: reviewed source bundle is incomplete or linked.' >&2
    exit 2
  }
done

[[ -d $root && -d $runtime && -d $releases && -d $backup_root && -d $libexec_dir && -d $secrets_dir ]] || {
  echo 'Refusing preparation: expected production directories are incomplete.' >&2
  exit 2
}
[[ -f $current_file && ! -L $current_file && -f $environment && ! -L $environment && \
   -f $production_override && ! -L $production_override && -f $lock && ! -L $lock ]] || {
  echo 'Refusing preparation: an expected production file is missing or linked.' >&2
  exit 2
}

# Inspect every existing path component without resolving through symlinks.
# Operator-owned (uid 1000) parents are valid; group/world-writable parents are not.
if ! python3 - "$root" "$runtime" "$releases" "$backup_root" "$libexec_dir" "$secrets_dir" \
    "$current_file" "$environment" "$production_override" "$lock" "$receiver_target" \
    "$guard_target" "$payload_production_target" "$candidate_target" "$source_receiver" \
    "$source_guard" "$source_payload_overlay" "$payload_compose" "$source_private_helper" <<'PY'
import os
import stat
import sys

directories = sys.argv[1:7]
files = sys.argv[7:]
optional = {files[5], files[6], files[7]}

def reject():
    print('Refusing preparation: unsafe path, symlink, or file permissions.', file=sys.stderr)
    raise SystemExit(2)

def inspect_directory(path):
    path = os.path.abspath(path)
    current = os.path.abspath(os.sep)
    for part in [part for part in path.split(os.sep) if part]:
        current = os.path.join(current, part)
        try:
            value = os.lstat(current)
        except OSError:
            reject()
        if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
            reject()
        mode = stat.S_IMODE(value.st_mode)
        if mode & 0o022 and not (value.st_uid == 0 and mode & 0o1000):
            reject()

for directory in directories:
    inspect_directory(directory)

for path in files:
    inspect_directory(os.path.dirname(path))
    try:
        value = os.lstat(path)
    except FileNotFoundError:
        if path in optional:
            continue
        reject()
    except OSError:
        reject()
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        reject()
    mode = stat.S_IMODE(value.st_mode)
    if mode & 0o022:
        reject()
    if path == files[4] and (value.st_uid != 0 or mode != 0o755):
        reject()
    if path == files[1] and (mode & 0o077 or not mode & 0o400):
        reject()
PY
then
  exit 2
fi

# The receiver and daily backup share this lease. Acquire it before reading
# state that will govern writes, then retain the same non-truncated inode.
lock_identity=$(stat -Lc '%d:%i' -- "$lock")
exec 9<>"$lock"
if [[ -L $lock || ! /proc/$$/fd/9 -ef $lock || $(stat -Lc '%d:%i' /proc/$$/fd/9) != "$lock_identity" ]]; then
  echo 'Refusing preparation: shared lock identity changed during open.' >&2
  exit 2
fi
flock -n 9 || {
  echo 'Refusing preparation: another deployment or coordinated operation holds the shared lock.' >&2
  exit 3
}
if [[ -L $lock || ! /proc/$$/fd/9 -ef $lock ]]; then
  echo 'Refusing preparation: shared lock path changed while leased.' >&2
  exit 2
fi

current=$(<"$current_file")
current_sha=${current#"$releases/"}
[[ $current == "$releases/$current_sha" && $current_sha =~ ^[0-9a-f]{40}$ && \
   -d $current && ! -L $current ]] || {
  echo 'Refusing preparation: current release pointer is invalid.' >&2
  exit 2
}
expected_current=d285029970c82d48cd50cc393a054af4cbfdf1e8
[[ $current_sha == "$expected_current" ]] || {
  echo 'Refusing preparation: current release changed from the reviewed API/cron-only floor.' >&2
  exit 2
}
[[ -f $current/docker-compose.yml && ! -L $current/docker-compose.yml && \
   -f $current/.image-env && ! -L $current/.image-env ]] || {
  echo 'Refusing preparation: current legacy release is incomplete.' >&2
  exit 2
}

mapfile -t release_images < "$current/.image-env"
[[ ${#release_images[@]} == 2 && \
   ${release_images[0]} =~ ^API_IMAGE=ghcr\.io/ownerinc/ownerinc-portal-api@sha256:[0-9a-f]{64}$ && \
   ${release_images[1]} =~ ^CRON_IMAGE=ghcr\.io/ownerinc/ownerinc-portal-cron@sha256:[0-9a-f]{64}$ ]] || {
  echo 'Refusing preparation: current release is not the expected API/cron-only format.' >&2
  exit 2
}

selected_production_override=$production_override
release_production_override="$current/compose.ownerinc-vps.yaml"
if [[ -e $release_production_override || -L $release_production_override ]]; then
  if ! python3 - "$current" "$release_production_override" <<'PY'
import os
import stat
import sys

release, path = sys.argv[1:]
try:
    parent = os.lstat(release)
    value = os.lstat(path)
    valid = (
        stat.S_ISDIR(parent.st_mode)
        and not stat.S_ISLNK(parent.st_mode)
        and stat.S_ISREG(value.st_mode)
        and not stat.S_ISLNK(value.st_mode)
        and value.st_nlink == 1
        and (os.name == 'nt' or not stat.S_IMODE(value.st_mode) & 0o022)
    )
except OSError:
    valid = False
if not valid:
    print('Unsafe release-local production Compose override.', file=sys.stderr)
    raise SystemExit(2)
PY
  then
    echo 'Refusing preparation: release-local production Compose override is unsafe.' >&2
    exit 2
  fi
  selected_production_override=$release_production_override
fi

expected_installed_receiver=30be4941fe15c1c75e16175625685e2f51acc6ceaa52db146d61684cdacce0f7
receiver_hash_line=$(sha256sum -- "$receiver_target")
receiver_hash=${receiver_hash_line%% *}
if ! cmp -s -- "$receiver_target" "$source_receiver" && [[ $receiver_hash != "$expected_installed_receiver" ]]; then
  echo 'Refusing preparation: installed common receiver differs from both the reviewed baseline and bundle.' >&2
  exit 2
fi

if ! cms_env_state=$(python3 "$source_private_helper" inspect "$environment" 2>&1); then
  case $cms_env_state in
    *partial_cms_credential_set*) echo 'Refusing preparation: partial CMS credential set; no keys were changed.' >&2 ;;
    *canonical_portal_url_missing*) echo 'Refusing preparation: existing CMS configuration lacks PORTAL_PUBLIC_URL; no keys were changed.' >&2 ;;
    *canonical_portal_url_mismatch*) echo 'Refusing preparation: production PORTAL_PUBLIC_URL is not canonical.' >&2 ;;
    *duplicate_environment_key*) echo 'Refusing preparation: duplicate protected environment key.' >&2 ;;
    *unsafe_environment*) echo 'Refusing preparation: production environment file is unsafe.' >&2 ;;
    *) echo 'Refusing preparation: CMS environment validation failed without changing files.' >&2 ;;
  esac
  exit 2
fi

validate_compose() {
  # Synthetic CMS-only values override private CMS values for this parse.
  # --quiet is mandatory; no rendered Compose config or credential is printed.
  if ! env -i PATH="$PATH" HOME=/root \
    CMS_IMAGE="$cms_image" \
    PORTAL_PUBLIC_URL=https://portal.ownerinc.com.br \
    CMS_POSTGRES_PASSWORD=check \
    CMS_MIGRATOR_PASSWORD=check \
    CMS_RUNTIME_PASSWORD=check \
    CMS_ADMIN_DATABASE_URL=postgresql://cms_admin:check@cms-postgres:5432/ownerinc_cms \
    CMS_MIGRATION_DATABASE_URL=postgresql://cms_migrator:check@cms-postgres:5432/ownerinc_cms \
    CMS_RUNTIME_DATABASE_URL=postgresql://cms_runtime:check@cms-postgres:5432/ownerinc_cms \
    PAYLOAD_SECRET=check \
    PAYLOAD_TO_PORTAL_SECRET=check \
    PORTAL_TO_PAYLOAD_SECRET=check \
    docker compose --project-name ownerinc-portal-prod --project-directory "$current" \
      --env-file "$environment" --env-file "$current/.image-env" \
      --file "$current/docker-compose.yml" --file "$payload_compose" \
      --file "$selected_production_override" --file "$source_payload_overlay" \
      config --quiet >/dev/null 2>&1; then
    echo 'Refusing preparation: combined production Compose configuration did not validate.' >&2
    return 1
  fi
}
validate_compose || exit 2

file_matches() {
  [[ -f $1 && ! -L $1 ]] && cmp -s -- "$1" "$2"
}
root_owned_mode() { [[ $(stat -c '%u:%g:%a' -- "$1") == "0:0:$2" ]]; }
file_installed() {
  file_matches "$1" "$2" && root_owned_mode "$1" "$3"
}
candidate_matches() {
  [[ -f $candidate_target && ! -L $candidate_target ]] && \
    printf 'CMS_IMAGE=%s\n' "$cms_image" | cmp -s -- - "$candidate_target"
}
candidate_installed() { candidate_matches && root_owned_mode "$candidate_target" 644; }
payload_overlay_is_known() {
  [[ ! -e $payload_production_target && ! -L $payload_production_target ]] || \
    file_matches "$payload_production_target" "$source_payload_overlay"
}
candidate_is_known() {
  [[ ! -e $candidate_target && ! -L $candidate_target ]] || candidate_matches
}

payload_overlay_is_known && candidate_is_known || {
  echo 'Refusing preparation: an existing runtime CMS overlay or image candidate differs from this reviewed bundle.' >&2
  exit 2
}

needs_change=false
file_installed "$receiver_target" "$source_receiver" 755 || needs_change=true
file_installed "$guard_target" "$source_guard" 755 || needs_change=true
file_installed "$payload_production_target" "$source_payload_overlay" 644 || needs_change=true
candidate_installed || needs_change=true
[[ $cms_env_state == complete ]] || needs_change=true

if [[ $mode == check ]]; then
  if [[ $needs_change == true ]]; then
    echo 'DRY RUN: production host and combined Compose configuration are eligible; no files were written and no services started.'
  else
    echo 'DRY RUN: infrastructure files are already prepared; no files were written and no services started.'
  fi
  exit 0
fi

if [[ $needs_change != true ]]; then
  echo 'CMS infrastructure is already prepared; no credentials were rotated and no backup was created.'
else
  backup_name="cms-infrastructure-preparation-$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import uuid; print(uuid.uuid4())')"
  backup_dir="$backup_root/$backup_name"
  mkdir -m 0700 -- "$backup_dir" || {
    echo 'Refusing preparation: unique private backup directory could not be created.' >&2
    exit 2
  }
  chmod 0700 "$backup_dir"
  for entry in "receiver:$receiver_target:ownerinc-portal-deploy" \
    "guard:$guard_target:payload-operations-guard" "environment:$environment:production.runtime.conf"; do
    IFS=: read -r label source destination <<< "$entry"
    if [[ -f $source && ! -L $source ]]; then
      install -o 0 -g 0 -m 0600 -- "$source" "$backup_dir/$destination"
    fi
  done
  if ! python3 "$source_private_helper" backup-metadata "$backup_dir/metadata.json" \
      "$receiver_target" "$guard_target" "$environment"; then
    echo 'Refusing preparation: private backup metadata could not be written.' >&2
    exit 2
  fi
  echo "Private pre-change snapshot: $backup_dir"

  atomic_install() {
    local source=$1 target=$2 permissions=$3 parent temporary
    parent=$(dirname -- "$target")
    temporary=$(mktemp "$parent/.cms-preparation.XXXXXX")
    if ! install -o 0 -g 0 -m "$permissions" -- "$source" "$temporary"; then
      rm -f -- "$temporary"
      return 1
    fi
    if ! mv -fT -- "$temporary" "$target"; then
      rm -f -- "$temporary"
      return 1
    fi
  }
  atomic_text() {
    local target=$1 permissions=$2 text=$3 parent temporary
    parent=$(dirname -- "$target")
    temporary=$(mktemp "$parent/.cms-preparation.XXXXXX")
    if ! printf '%s\n' "$text" > "$temporary" || ! chmod "$permissions" "$temporary" || \
      ! chown 0:0 "$temporary" || ! mv -fT -- "$temporary" "$target"; then
      rm -f -- "$temporary"
      return 1
    fi
  }

  # Each file is replaced atomically. The previous receiver, guard and full
  # production environment are preserved in the private backup for manual rollback.
  if ! file_installed "$receiver_target" "$source_receiver" 755; then
    atomic_install "$source_receiver" "$receiver_target" 0755
  fi
  if ! file_installed "$guard_target" "$source_guard" 755; then
    atomic_install "$source_guard" "$guard_target" 0755
  fi
  if ! file_installed "$payload_production_target" "$source_payload_overlay" 644; then
    atomic_install "$source_payload_overlay" "$payload_production_target" 0644
  fi
  if ! candidate_installed; then
    atomic_text "$candidate_target" 0644 "CMS_IMAGE=$cms_image"
  fi
  if [[ $cms_env_state == empty ]] && ! python3 "$source_private_helper" update "$environment"; then
    echo 'Refusing preparation: private CMS environment could not be atomically written.' >&2
    echo "The pre-change receiver, guard and environment remain in $backup_dir for manual recovery." >&2
    exit 2
  fi

  echo "Prepared (inactive) files and private environment; prior receiver/guard/environment backup: $backup_dir"
fi

if [[ -e $runtime/payload-control || -L $runtime/payload-control ]]; then
  echo 'BLOCKED: runtime/payload-control exists but was not validated, replaced, or invoked.'
else
  echo 'BLOCKED: runtime/payload-control adapter is missing/not integrated; no placeholder was created.'
fi
echo 'BLOCKED: compatible API v2 and Task15 acceptance evidence remain pending; CMS services and worker were not started.'
echo 'Prepared state is inactive: no Docker pull/up/run, database migration, systemd/timer, authority, wrapper, or authorized_keys change was performed.'
