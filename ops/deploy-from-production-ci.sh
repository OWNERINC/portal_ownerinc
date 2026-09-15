#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -n ${SSH_ORIGINAL_COMMAND:-} && $SSH_ORIGINAL_COMMAND != production:* ]]; then
  echo "Refusing deployment: production receiver accepts only production targets." >&2
  exit 2
fi

export DEPLOY_RECEIVER_ROLE=production
exec /usr/local/libexec/ownerinc-portal-deploy "$@"
