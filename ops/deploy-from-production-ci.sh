#!/usr/bin/env bash
set -Eeuo pipefail

# The production-only SSH key also supports the SHA-only receiver already deployed on the VPS.
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^[0-9a-f]{40}$ ]]; then
  export SSH_ORIGINAL_COMMAND="production:$SSH_ORIGINAL_COMMAND"
fi

if [[ -n ${SSH_ORIGINAL_COMMAND:-} && $SSH_ORIGINAL_COMMAND != production:* ]]; then
  echo "Refusing deployment: production receiver accepts only production targets." >&2
  exit 2
fi

export DEPLOY_RECEIVER_ROLE=production
exec /usr/local/libexec/ownerinc-portal-deploy "$@"
