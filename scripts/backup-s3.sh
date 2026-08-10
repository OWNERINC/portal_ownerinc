#!/usr/bin/env bash
set -euo pipefail

backup_dir=${1:-${BACKUP_DIR:-}}
: "${backup_dir:?Pass a verified backup directory or set BACKUP_DIR}"
: "${S3_BUCKET:?Set S3_BUCKET}"
S3_PREFIX=${S3_PREFIX:-portal-ownerinc}

command -v aws >/dev/null 2>&1 || { echo 'AWS CLI is required for S3 backup upload' >&2; exit 2; }
[[ -d $backup_dir ]] || { echo "Backup directory not found: $backup_dir" >&2; exit 2; }
[[ -f $backup_dir/manifest.sha256 ]] || { echo 'Backup manifest not found' >&2; exit 2; }

(cd "$backup_dir" && sha256sum --check manifest.sha256 >/dev/null)
backup_name=$(basename "$backup_dir")
target="s3://$S3_BUCKET/${S3_PREFIX%/}/$backup_name/"
aws_args=(s3 cp --recursive "$backup_dir/" "$target")
if [[ -n ${AWS_ENDPOINT_URL:-} ]]; then
  aws_args=(--endpoint-url "$AWS_ENDPOINT_URL" "${aws_args[@]}")
fi
"${aws_args[@]}"
printf 'Backup uploaded: %s\n' "$target"
