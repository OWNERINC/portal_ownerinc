#!/bin/bash -p
set -Eeuo pipefail

# The sole sudo target. Never interpret SSH text or inherit Python/shell hooks.
if [[ $UID != 0 || $EUID != 0 || $# != 1 ]]; then
  echo 'Receiver denied: root_single_request_required' >&2
  exit 2
fi
# Full grammar validation is performed by parse_request before any receipt I/O.
exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C \
  /usr/bin/python3 -I -S /usr/local/libexec/payload-receiver-admission.py payload "$1"
