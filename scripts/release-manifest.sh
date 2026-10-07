#!/usr/bin/env bash
# Source-only helpers. Parse data, never source/eval a release manifest.
load_release_manifest() {
  local file=$1 key value line
  local seen='|'
  API_IMAGE= CRON_IMAGE= CMS_IMAGE= RELEASE_FORMAT=legacy
  [[ -f $file && ! -L $file ]] || { echo 'Missing or unsafe image manifest' >&2; return 2; }
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == *=* ]] || { echo 'Invalid image manifest line' >&2; return 2; }
    key=${line%%=*}; value=${line#*=}
    [[ $seen != *"|$key|"* ]] || { echo 'Duplicate image manifest key' >&2; return 2; }
    seen+="$key|"
    case $key in
      API_IMAGE|CRON_IMAGE|CMS_IMAGE) printf -v "$key" '%s' "$value" ;;
      RELEASE_FORMAT) [[ $value == legacy || $value == payload-v1 ]] || return 2; RELEASE_FORMAT=$value ;;
      *) echo 'Unknown image manifest key' >&2; return 2 ;;
    esac
  done < "$file"
  [[ $API_IMAGE =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)*/ownerinc-portal-api@sha256:[0-9a-f]{64}$ &&
     $CRON_IMAGE =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)*/ownerinc-portal-cron@sha256:[0-9a-f]{64}$ ]] || {
    echo 'Invalid API/cron immutable digest' >&2; return 2;
  }
  if [[ $RELEASE_FORMAT == payload-v1 ]]; then
    [[ $CMS_IMAGE =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)*/ownerinc-portal-cms@sha256:[0-9a-f]{64}$ ]] || { echo 'Missing/invalid CMS digest' >&2; return 2; }
  elif [[ $seen == *'|CMS_IMAGE|'* ]]; then
    echo 'Partial CMS release state' >&2; return 2
  fi
  export API_IMAGE CRON_IMAGE CMS_IMAGE RELEASE_FORMAT
}

verify_backup_manifest() {
  local directory=$1 format=legacy line name
  local expected=(postgres.dump uploads.tar.gz) actual=()
  [[ -d $directory && ! -L $directory ]] || return 2
  if [[ -e $directory/backup.format ]]; then
    [[ -f $directory/backup.format && ! -L $directory/backup.format && $(cat "$directory/backup.format") == payload-v1 ]] || return 2
    format=payload-v1
    expected=(postgres.dump uploads.tar.gz cms-postgres.dump cms-uploads.tar.gz release.images operations-proof.json backup.format)
  elif [[ -e $directory/cms-postgres.dump || -e $directory/cms-uploads.tar.gz || -e $directory/operations-proof.json || -e $directory/release.images ]]; then
    echo 'Partial coordinated backup without format marker' >&2; return 2
  fi
  [[ -f $directory/manifest.sha256 && ! -L $directory/manifest.sha256 ]] || return 2
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[0-9a-f]{64}\ [\ \*]([a-z.-]+)$ ]] || return 2
    name=${BASH_REMATCH[1]}
    [[ -f $directory/$name && -s $directory/$name && ! -L $directory/$name ]] || return 2
    actual+=("$name")
  done < "$directory/manifest.sha256"
  [[ ${actual[*]} == "${expected[*]}" ]] || { echo 'Incomplete or unexpected backup artifacts' >&2; return 2; }
  (cd "$directory" && sha256sum --check --strict manifest.sha256 >/dev/null) || return 2
  BACKUP_FORMAT=$format
}

verify_storage_archive() {
  local archive=$1 members types member
  # Refuse links/devices and traversal BEFORE deleting any target storage. The
  # original capture includes '.' directories, ordinary private files only.
  members=$(tar --quoting-style=escape -tzf "$archive" 2>/dev/null) || return 2
  types=$(tar --quoting-style=escape -tvzf "$archive" 2>/dev/null) || return 2
  while IFS= read -r member; do
    case $member in /*|..|../*|*/..|*/../*|*\\*) echo 'Unsafe storage archive member' >&2; return 2;; esac
  done <<< "$members"
  while IFS= read -r member; do
    [[ $member == d* || $member == -* ]] || { echo 'Storage archive contains a link or special file' >&2; return 2; }
  done <<< "$types"
}
