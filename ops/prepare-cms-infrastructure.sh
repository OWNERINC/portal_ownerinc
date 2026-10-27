#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

usage() {
  echo 'Usage: prepare-cms-infrastructure.sh [--check|--apply]' >&2
  exit 2
}

mode=check
authenticated=false
approval_digest=''
case ${1:-} in
  '') ;;
  --check) shift; (($# == 0)) || usage ;;
  --apply) mode=apply; shift; (($# == 0)) || usage ;;
  --authenticated-check|--authenticated-apply)
    (($# == 2)) && [[ $2 =~ ^[0-9a-f]{64}$ ]] || usage
    mode=${1#--authenticated-}; approval_digest=$2; authenticated=true; shift 2 ;;
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
daily_backup_root=/opt/ownerinc/backups/portal-ownerinc/daily
pre_restore_backup_root="$backup_root/restore-protection"
libexec_dir=/usr/local/libexec
receiver_target=/usr/local/libexec/ownerinc-portal-deploy
receiver_helper_target=/usr/local/libexec/payload-receiver-admission.py
receiver_root_target=/usr/local/libexec/ownerinc-payload-receive
production_receiver_target=/usr/local/libexec/ownerinc-portal-deploy-production
receiver_sudoers_target=/etc/sudoers.d/ownerinc-payload-receive
receiver_incoming=/var/lib/ownerinc/payload-candidate/incoming
receiver_sudoers='deploy ALL=(root) NOPASSWD: NOSETENV: /usr/local/libexec/ownerinc-payload-receive'
guard_target="$runtime/payload-operations-guard"
control_target="$runtime/payload-control"
control_runtime_target="$runtime/payload-control-runtime.py"
control_state_helper_target="$runtime/payload-control-state.py"
control_inventory_helper_target="$runtime/payload-control-inventory.py"
control_inventory_target="$runtime/payload-control-inventory.json"
control_key_target="$runtime/payload-control.key"
control_state_dir="$runtime/payload-control-state"
production_override="$runtime/compose.production.yaml"
payload_production_target="$runtime/compose.payload.production.yaml"
candidate_target="$runtime/cms-image-candidate.env"
lock="$runtime/deploy.lock"
cms_image='ghcr.io/ownerinc/ownerinc-portal-cms@sha256:6eaddc9a333ba682508a09a4ae8a6409d9e571abab9ec4a62829c2e9828730b0'
source_receiver="$script_dir/deploy-from-ci.sh"
source_receiver_helper="$script_dir/payload-receiver-admission.py"
source_receiver_root="$script_dir/payload-receiver-root.sh"
source_production_receiver="$script_dir/deploy-from-production-ci.sh"
source_guard="$script_dir/payload-operations-guard.sh"
source_control="$script_dir/payload-control"
source_control_runtime="$script_dir/payload-control-runtime.py"
source_control_state="$script_dir/payload-control-state.py"
source_control_inventory="$script_dir/payload-control-inventory.py"
source_private_helper="$script_dir/prepare-cms-infrastructure-private.py"
source_payload_overlay="$script_dir/compose.payload.production.yaml"
payload_compose="$repo_root/docker-compose.payload.yml"

# A flag/digest is not authority. Only the fixed installed verifier can supply
# context, after independently authenticating source/admission/host under FD9.
# Direct legacy invocation retains its original source layout and pinned floor.
authenticated_context=''
authenticated_refresh() {
  [[ $authenticated == true ]] || return 0
  local observed
  observed=$(/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    /usr/bin/python3 -I -S -B /usr/local/libexec/ownerinc-payload-prepare.py \
    --verify-context "$approval_digest") || return 1
  [[ -n $authenticated_context && $observed == "$authenticated_context" ]]
}
approved_predecessor() {
  local filename=$1 expected=$2
  [[ $expected =~ ^[0-9a-f]{64}$ && -f $filename && ! -L $filename ]] && \
    [[ $(sha256sum -- "$filename" | cut -d ' ' -f 1) == "$expected" ]]
}
if [[ $authenticated == true ]]; then
  [[ $script_dir == /opt/ownerinc/lib/payload-preparation/ops && \
     ${BASH_SOURCE[0]} == /opt/ownerinc/lib/payload-preparation/ops/prepare-cms-infrastructure.sh ]] || usage
  authenticated_context=$(/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    /usr/bin/python3 -I -S -B /usr/local/libexec/ownerinc-payload-prepare.py \
    --verify-context "$approval_digest") || exit 2
  mapfile -t approved_fields <<< "$authenticated_context"
  [[ ${#approved_fields[@]} == 8 && ${approved_fields[0]} == "$approval_digest" && \
     ${approved_fields[1]} =~ ^[0-9a-f]{40}$ && \
     ${approved_fields[2]} =~ ^ghcr\.io/ownerinc/ownerinc-portal-cms@sha256:[0-9a-f]{64}$ ]] || usage
  for approved_hash in "${approved_fields[@]:3}"; do
    [[ $approved_hash == - || $approved_hash =~ ^[0-9a-f]{64}$ ]] || usage
  done
  cms_image=${approved_fields[2]}
  # Helpers use the same fixed isolated interpreter authenticated by admission,
  # not a PATH-selected Python or caller-provided Python environment.
  python3() { /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/python3 -I -S -B "$@"; }
fi

for command in python3 docker flock install cmp stat mktemp mkdir mv rm date env chown chmod sha256sum cut; do
  command -v "$command" >/dev/null || {
    echo "Refusing preparation: required command is unavailable ($command)." >&2
    exit 2
  }
done

for source in "$source_receiver" "$source_receiver_helper" "$source_receiver_root" "$source_production_receiver" "$source_guard" "$source_control" "$source_control_runtime" "$source_control_state" "$source_control_inventory" "$source_private_helper" \
  "$source_payload_overlay" "$payload_compose"; do
  [[ -f $source && ! -L $source ]] || {
    echo 'Refusing preparation: reviewed source bundle is incomplete or linked.' >&2
    exit 2
  }
done

# The receiver uses this exact interpreter for legacy as well as Payload. Check
# its isolated stdlib and reviewed helper syntax without executing helper code.
if ! env -i PATH="$PATH" /usr/bin/python3 -I -S -c \
  'import gzip, io, os, re, stat, subprocess, sys, tarfile, tempfile; assert sys.version_info >= (3, 9); compile(open(sys.argv[1], "rb").read(), sys.argv[1], "exec")' \
  "$source_receiver_helper" >/dev/null 2>&1; then
  echo 'Refusing preparation: fixed receiver Python or helper source is unavailable or invalid.' >&2
  exit 2
fi

# Fixed executable paths only; validate the exact rule even in --check, without
# publishing it. No wildcard, env, shell, Python or general sudo grant.
[[ -x /usr/bin/sudo && -x /usr/sbin/visudo ]] && \
  printf '%s\n' "$receiver_sudoers" | /usr/sbin/visudo -cf - >/dev/null || {
  echo 'Refusing preparation: fixed sudo tools or narrow receiver policy invalid.' >&2
  exit 2
}
/bin/bash -n "$source_receiver_root"
/bin/bash -n "$source_production_receiver"

receiver_privilege_paths() {
  /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/python3 -I -S - "$1" "$receiver_incoming" \
    "$receiver_root_target" "$production_receiver_target" "$receiver_sudoers_target" \
    "$source_receiver_root" "$source_production_receiver" <<'PY'
import os, stat, sys
mode, incoming, *files = sys.argv[1:]
def reject():
    raise SystemExit('Refusing preparation: unsafe receiver privilege path.')
def directory(path, create=False):
    current = '/'
    for part in [''] + path.strip('/').split('/'):
        current = os.path.join(current, part) if part else current
        try:
            value = os.lstat(current)
        except FileNotFoundError:
            if not create:
                reject()
            if mode != 'create':
                continue
            os.mkdir(current, 0o700)
            os.chown(current, 0, 0)  # Only newly created segments, never repairs.
            value = os.lstat(current)
        if not stat.S_ISDIR(value.st_mode) or (value.st_uid, value.st_gid) != (0, 0) or stat.S_IMODE(value.st_mode) & 0o7022:
            reject()
        if current == incoming and stat.S_IMODE(value.st_mode) != 0o700:
            reject()
directory(incoming, create=True)
for filename in files:
    directory(os.path.dirname(filename))
    try:
        value = os.lstat(filename)
    except FileNotFoundError:
        if filename in files[:3]:
            continue
        reject()
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or (value.st_uid, value.st_gid) != (0, 0) or stat.S_IMODE(value.st_mode) & 0o7022:
        reject()
PY
}
receiver_privilege_paths check

[[ -d $root && -d $runtime && -d $releases && -d $backup_root && -d $libexec_dir && -d $secrets_dir ]] || {
  echo 'Refusing preparation: expected production directories are incomplete.' >&2
  exit 2
}
[[ -d $daily_backup_root && ! -L $daily_backup_root ]] || {
  echo 'Refusing preparation: the protected daily backup directory is missing or linked.' >&2
  exit 2
}
[[ -f $current_file && ! -L $current_file && -f $environment && ! -L $environment && \
   -f $production_override && ! -L $production_override && -f $lock && ! -L $lock ]] || {
  echo 'Refusing preparation: an expected production file is missing or linked.' >&2
  exit 2
}

# Inspect every existing path component without resolving through symlinks.
# Operator-owned (uid 1000) parents are valid; group/world-writable parents are not.
if ! python3 - "$root" "$runtime" "$releases" "$backup_root" "$daily_backup_root" "$libexec_dir" "$secrets_dir" \
    "$current_file" "$environment" "$production_override" "$lock" "$receiver_target" \
    "$guard_target" "$control_target" "$control_runtime_target" "$control_state_helper_target" \
    "$control_key_target" "$payload_production_target" "$candidate_target" "$control_inventory_target" "$source_receiver" \
    "$source_guard" "$source_control" "$source_control_runtime" "$source_control_state" "$source_control_inventory" \
    "$source_payload_overlay" "$payload_compose" "$source_private_helper" "$receiver_helper_target" "$source_receiver_helper" <<'PY'
import os
import stat
import sys

directories = sys.argv[1:8]
files = sys.argv[8:]
optional = {files[5], files[6], files[7], files[8], files[9], files[10], files[11], files[12]}
optional.add(files[-2])  # Receiver dependency may be absent on an eligible legacy host.

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

# Unlike operator-owned runtime paths, executable receiver dependencies require
# a root:root protected chain. Do not silently repair or traverse an unsafe one.
parent = os.path.dirname(files[-2])
while True:
    value = os.lstat(parent)
    if not stat.S_ISDIR(value.st_mode) or (value.st_uid, value.st_gid) != (0, 0) or stat.S_IMODE(value.st_mode) & 0o7022:
        reject()
    if parent == '/':
        break
    parent = os.path.dirname(parent)

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
    if path == files[-2] and ((value.st_uid, value.st_gid) != (0, 0) or mode != 0o755):
        reject()
    if path == files[1] and ((value.st_uid, value.st_gid) != (1000, 1000) or mode != 0o600):
        reject()
PY
then
  exit 2
fi

# The receiver and daily backup share this lease. Acquire it before reading
# state that will govern writes, then retain the same non-truncated inode.
lock_identity=$(stat -Lc '%d:%i' -- "$lock")
if [[ $authenticated == true ]]; then
  # FD9 is inherited from the still-running parent. Never reopen, truncate,
  # reacquire on a separate open description, or unlock the parent's lease.
  authenticated_refresh || exit 2
else
  exec 9<>"$lock"
fi
if [[ -L $lock || ! /proc/$$/fd/9 -ef $lock || $(stat -Lc '%d:%i' /proc/$$/fd/9) != "$lock_identity" ]]; then
  echo 'Refusing preparation: shared lock identity changed during open.' >&2
  exit 2
fi
if [[ $authenticated != true ]]; then
flock -n 9 || {
  echo 'Refusing preparation: another deployment or coordinated operation holds the shared lock.' >&2
  exit 3
}
fi
if [[ -L $lock || ! /proc/$$/fd/9 -ef $lock ]]; then
  echo 'Refusing preparation: shared lock path changed while leased.' >&2
  exit 2
fi

control_state_presence=$(python3 - "$control_key_target" "$control_state_dir" <<'PY'
import os, stat, sys
key, directory = sys.argv[1:]
key_exists, dir_exists = os.path.lexists(key), os.path.lexists(directory)
if key_exists != dir_exists:
    raise SystemExit(2)
if not key_exists:
    print('empty')
else:
    key_info, dir_info = os.lstat(key), os.lstat(directory)
    if stat.S_ISLNK(key_info.st_mode) or not stat.S_ISREG(key_info.st_mode) or key_info.st_nlink != 1 \
       or (os.name != 'nt' and (key_info.st_uid, stat.S_IMODE(key_info.st_mode)) != (0, 0o600)) \
       or stat.S_ISLNK(dir_info.st_mode) or not stat.S_ISDIR(dir_info.st_mode) \
       or (os.name != 'nt' and (dir_info.st_uid, stat.S_IMODE(dir_info.st_mode)) != (0, 0o700)):
        raise SystemExit(2)
    print('complete')
PY
) || {
  echo 'Refusing preparation: private Payload control state is partial or unsafe.' >&2
  exit 2
}
if [[ $control_state_presence == complete ]]; then
  python3 "$source_control_state" verify-state "$runtime" >/dev/null || {
    echo 'Refusing preparation: existing private Payload control journal failed integrity checks.' >&2
    exit 2
  }
fi

inventory_args=("$root" "$runtime" "$releases" "$current_file" "$lock" "$daily_backup_root" "$backup_root" \
  "$pre_restore_backup_root" "$environment" "$production_override" "$payload_production_target")
if [[ -e $pre_restore_backup_root || -L $pre_restore_backup_root ]]; then
  [[ -d $pre_restore_backup_root && ! -L $pre_restore_backup_root ]] || {
    echo 'Refusing preparation: restore-protection inventory path is unsafe.' >&2
    exit 2
  }
  [[ $(stat -c '%u:%a' -- "$pre_restore_backup_root") == '0:700' ]] || {
    echo 'Refusing preparation: restore-protection inventory path has unsafe owner or mode.' >&2
    exit 2
  }
fi
if [[ -e $control_inventory_target || -L $control_inventory_target ]]; then
  # v1/mismatched inventories are deliberately refused. Inventory identity is
  # signed host state; never rewrite it or reset the journal to learn an owner.
  python3 "$source_control_inventory" verify-production "$control_inventory_target" "${inventory_args[@]}" >/dev/null || {
    echo 'Refusing preparation: protected Payload inventory differs from the reviewed production project or paths.' >&2
    exit 2
  }
fi

current=$(<"$current_file")
current_sha=${current#"$releases/"}
[[ $current == "$releases/$current_sha" && $current_sha =~ ^[0-9a-f]{40}$ && \
   -d $current && ! -L $current ]] || {
  echo 'Refusing preparation: current release pointer is invalid.' >&2
  exit 2
}
expected_current=d285029970c82d48cd50cc393a054af4cbfdf1e8
if [[ $authenticated == true ]]; then expected_current=${approved_fields[1]}; fi
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
if [[ $authenticated == true ]]; then expected_installed_receiver=${approved_fields[3]}; fi
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
    CMS_CONTROLLER_PASSWORD=check \
    CMS_MIGRATOR_PASSWORD=check \
    CMS_RUNTIME_PASSWORD=check \
    CMS_OWNER_DATABASE_URL=postgresql://cms_admin:check@postgres:5432/ownerinc_cms \
    CMS_MIGRATION_DATABASE_URL=postgresql://cms_migrator:check@postgres:5432/ownerinc_cms \
    CMS_RUNTIME_DATABASE_URL=postgresql://cms_runtime:check@postgres:5432/ownerinc_cms \
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
control_files_known() {
  for pair in \
    "$control_target:$source_control" \
    "$control_runtime_target:$source_control_runtime" \
    "$control_state_helper_target:$source_control_state" \
    "$control_inventory_helper_target:$source_control_inventory"; do
    IFS=: read -r target source <<< "$pair"
    [[ ! -e $target && ! -L $target ]] || file_matches "$target" "$source" || return 1
  done
}
control_files_installed() {
  file_installed "$control_target" "$source_control" 755 && \
    file_installed "$control_runtime_target" "$source_control_runtime" 644 && \
    file_installed "$control_state_helper_target" "$source_control_state" 644 && \
    file_installed "$control_inventory_helper_target" "$source_control_inventory" 644
}
payload_inventory_matches() {
  [[ -f $control_inventory_target && ! -L $control_inventory_target ]] && \
    python3 "$source_control_inventory" verify-production "$control_inventory_target" "${inventory_args[@]}" >/dev/null 2>&1 && \
    root_owned_mode "$control_inventory_target" 600
}
payload_overlay_is_known() {
  [[ ! -e $payload_production_target && ! -L $payload_production_target ]] || \
    file_matches "$payload_production_target" "$source_payload_overlay"
}
candidate_is_known() {
  [[ ! -e $candidate_target && ! -L $candidate_target ]] || candidate_matches || \
    { [[ $authenticated == true ]] && approved_predecessor "$candidate_target" "${approved_fields[7]}"; }
}

payload_overlay_is_known && candidate_is_known && control_files_known && \
  { [[ ! -e $control_inventory_target && ! -L $control_inventory_target ]] || payload_inventory_matches; } || {
  echo 'Refusing preparation: an existing runtime CMS control or overlay differs from this reviewed bundle.' >&2
  exit 2
}

expected_helper=ffe1c2ed3fb086e156401063cdeaf9c6575a49e3458b202928df7f6794587bf8
expected_wrapper=b1be89c891468052aea9de917e75214c7331c9ff72a4cb3e790aae9b4007d1b6
if [[ $authenticated == true ]]; then
  expected_helper=${approved_fields[4]}; expected_wrapper=${approved_fields[5]}
  # Includes approved guard/candidate transitions and exact allowed absences.
  authenticated_refresh || exit 2
fi
if [[ -e $receiver_helper_target || -L $receiver_helper_target ]] && \
   ! file_matches "$receiver_helper_target" "$source_receiver_helper" && \
   ! approved_predecessor "$receiver_helper_target" "$expected_helper"; then
  echo 'Refusing preparation: installed receiver helper differs from the reviewed bundle.' >&2
  exit 2
fi

if [[ -e $production_receiver_target ]] && ! file_matches "$production_receiver_target" "$source_production_receiver" && \
   ! approved_predecessor "$production_receiver_target" "$expected_wrapper"; then
  echo 'Refusing preparation: production wrapper differs from reviewed baseline and bundle.' >&2
  exit 2
fi
if { [[ -e $receiver_root_target ]] && ! file_matches "$receiver_root_target" "$source_receiver_root"; } || \
   { [[ -e $receiver_sudoers_target ]] && ! cmp -s -- "$receiver_sudoers_target" <(printf '%s\n' "$receiver_sudoers"); }; then
  echo 'Refusing preparation: existing Payload privilege dependency differs from reviewed bundle.' >&2
  exit 2
fi

needs_change=false
file_installed "$receiver_root_target" "$source_receiver_root" 755 || needs_change=true
file_installed "$production_receiver_target" "$source_production_receiver" 755 || needs_change=true
{ [[ -f $receiver_sudoers_target ]] && root_owned_mode "$receiver_sudoers_target" 440; } || needs_change=true
[[ -d $receiver_incoming ]] || needs_change=true
file_installed "$receiver_helper_target" "$source_receiver_helper" 755 || needs_change=true
file_installed "$receiver_target" "$source_receiver" 755 || needs_change=true
file_installed "$guard_target" "$source_guard" 755 || needs_change=true
control_files_installed || needs_change=true
file_installed "$payload_production_target" "$source_payload_overlay" 644 || needs_change=true
candidate_installed || needs_change=true
[[ $cms_env_state == complete ]] || needs_change=true
[[ $control_state_presence == complete ]] || needs_change=true
payload_inventory_matches || needs_change=true

if [[ $mode == check ]]; then
  authenticated_refresh || exit 2
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
  authenticated_refresh || exit 2
  backup_name="cms-infrastructure-preparation-$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import uuid; print(uuid.uuid4())')"
  backup_dir="$backup_root/$backup_name"
  mkdir -m 0700 -- "$backup_dir" || {
    echo 'Refusing preparation: unique private backup directory could not be created.' >&2
    exit 2
  }
  chmod 0700 "$backup_dir"
  if [[ ! -d $pre_restore_backup_root ]]; then
    mkdir -m 0700 -- "$pre_restore_backup_root"
    chown 0:0 -- "$pre_restore_backup_root"
    chmod 0700 -- "$pre_restore_backup_root"
  fi
  for entry in "receiver:$receiver_target:ownerinc-portal-deploy" \
    "receiver-helper:$receiver_helper_target:payload-receiver-admission.py" \
    "receiver-root:$receiver_root_target:ownerinc-payload-receive" \
    "production-wrapper:$production_receiver_target:ownerinc-portal-deploy-production" \
    "receiver-sudoers:$receiver_sudoers_target:ownerinc-payload-receive.sudoers" \
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
    authenticated_refresh || return 1
    parent=$(dirname -- "$target")
    temporary=$(mktemp "$parent/.cms-preparation.XXXXXX")
    if ! install -o 0 -g 0 -m "$permissions" -- "$source" "$temporary"; then
      rm -f -- "$temporary"
      return 1
    fi
    if ! authenticated_refresh; then rm -f -- "$temporary"; return 1; fi
    if ! mv -fT -- "$temporary" "$target"; then
      rm -f -- "$temporary"
      return 1
    fi
  }
  atomic_text() {
    local target=$1 permissions=$2 text=$3 parent temporary
    authenticated_refresh || return 1
    parent=$(dirname -- "$target")
    temporary=$(mktemp "$parent/.cms-preparation.XXXXXX")
    if ! printf '%s\n' "$text" > "$temporary" || ! chmod "$permissions" "$temporary" || \
      ! chown 0:0 "$temporary" || ! authenticated_refresh || ! mv -fT -- "$temporary" "$target"; then
      rm -f -- "$temporary"
      return 1
    fi
  }

  # Each file is replaced atomically. The previous receiver, guard and full
  # production environment are preserved in the private backup for manual rollback.
  # Publish and recheck the dependency FIRST: any failure leaves the old receiver
  # untouched. An interrupted run may leave an inert helper, never an orphan receiver.
  if ! file_installed "$receiver_helper_target" "$source_receiver_helper" 755; then
    atomic_install "$source_receiver_helper" "$receiver_helper_target" 0755
  fi
  file_installed "$receiver_helper_target" "$source_receiver_helper" 755 || {
    echo 'Refusing preparation: receiver helper installation did not verify; receiver was not replaced.' >&2
    exit 2
  }
  receiver_privilege_paths create
  if ! file_installed "$receiver_root_target" "$source_receiver_root" 755; then
    atomic_install "$source_receiver_root" "$receiver_root_target" 0755
  fi
  file_installed "$receiver_root_target" "$source_receiver_root" 755 || exit 2
  if [[ ! -f $receiver_sudoers_target ]] || ! root_owned_mode "$receiver_sudoers_target" 440; then
    authenticated_refresh || exit 2
    sudoers_temporary=$(mktemp "$(dirname -- "$receiver_sudoers_target")/.payload-receive.XXXXXX")
    if ! { printf '%s\n' "$receiver_sudoers" > "$sudoers_temporary" && \
      chmod 0440 "$sudoers_temporary" && chown 0:0 "$sudoers_temporary" && \
      /usr/sbin/visudo -cf "$sudoers_temporary" >/dev/null && \
      mv -fT -- "$sudoers_temporary" "$receiver_sudoers_target"; }; then
      rm -f -- "$sudoers_temporary"
      exit 2
    fi
  fi
  cmp -s -- "$receiver_sudoers_target" <(printf '%s\n' "$receiver_sudoers") && \
    root_owned_mode "$receiver_sudoers_target" 440 || exit 2
  # Publish the SSH wrapper last; interrupted dependency setup never replaces it.
  if ! file_installed "$production_receiver_target" "$source_production_receiver" 755; then
    atomic_install "$source_production_receiver" "$production_receiver_target" 0755
  fi
  if ! file_installed "$receiver_target" "$source_receiver" 755; then
    atomic_install "$source_receiver" "$receiver_target" 0755
  fi
  if ! file_installed "$guard_target" "$source_guard" 755; then
    atomic_install "$source_guard" "$guard_target" 0755
  fi
  if ! file_installed "$control_target" "$source_control" 755; then
    atomic_install "$source_control" "$control_target" 0755
  fi
  if ! file_installed "$control_runtime_target" "$source_control_runtime" 644; then
    atomic_install "$source_control_runtime" "$control_runtime_target" 0644
  fi
  if ! file_installed "$control_state_helper_target" "$source_control_state" 644; then
    atomic_install "$source_control_state" "$control_state_helper_target" 0644
  fi
  if ! file_installed "$control_inventory_helper_target" "$source_control_inventory" 644; then
    atomic_install "$source_control_inventory" "$control_inventory_helper_target" 0644
  fi
  if ! file_installed "$payload_production_target" "$source_payload_overlay" 644; then
    atomic_install "$source_payload_overlay" "$payload_production_target" 0644
  fi
  if ! candidate_installed; then
    atomic_text "$candidate_target" 0644 "CMS_IMAGE=$cms_image"
  fi
  authenticated_refresh || exit 2
  if [[ $cms_env_state == empty || $cms_env_state == legacy-complete || $cms_env_state == pre-observer-complete ]] && ! python3 "$source_private_helper" update "$environment"; then
    echo 'Refusing preparation: private CMS environment could not be atomically written.' >&2
    echo "The pre-change receiver, guard and environment remain in $backup_dir for manual recovery." >&2
    exit 2
  fi
  if [[ ! -e $control_inventory_target ]]; then
    authenticated_refresh || exit 2
    create_production_inventory() {
      if [[ $authenticated == true ]]; then
        /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/python3 -I -S -B \
          /usr/local/libexec/ownerinc-payload-prepare.py --create-inventory "$approval_digest"
      else
        python3 "$source_control_inventory" create-production "$control_inventory_target" "${inventory_args[@]}"
      fi
    }
    if ! create_production_inventory; then
      echo 'Refusing preparation: protected Payload inventory could not be created.' >&2
      exit 2
    fi
  fi
  if [[ $control_state_presence == empty ]]; then
    authenticated_refresh || exit 2
    if ! python3 "$source_control_state" initialize "$runtime"; then
      echo 'Refusing preparation: private Payload control state could not be initialized; no production database was touched.' >&2
      echo 'If initialization partially wrote its private state, preserve it and investigate; automatic repair is forbidden.' >&2
      exit 2
    fi
  fi

  echo "Prepared (inactive) files and private environment; prior receiver/guard/environment backup: $backup_dir"
fi

echo 'Installed inactive preauthority control with a private host-only signing key and explicit worker hold; no database or service was changed.'
echo 'BLOCKED: deployment needs a fresh complete candidate set containing the preauthority catalog verifier and actual Task 3 recovery acceptance; CMS services and worker were not started.'
echo 'Prepared state is inactive: the production SSH wrapper and restricted Payload privilege transport are installed; no Docker pull/up/run, database migration, systemd/timer, authority, or authorized_keys change was performed.'
