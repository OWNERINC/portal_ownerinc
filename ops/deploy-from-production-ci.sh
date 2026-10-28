#!/usr/bin/env bash
set -Eeuo pipefail

# Only Payload admission crosses the fixed privilege boundary. No shell text,
# environment assignments or extra SSH arguments are passed through sudo.
if [[ ${SSH_ORIGINAL_COMMAND:-} == 'production:payload-v2 '* ||
      ${SSH_ORIGINAL_COMMAND:-} == 'production:payload-apply-v2 '* ]]; then
  if (($# != 0)); then
    echo 'Refusing deployment: Payload receiver accepts one SSH command only.' >&2
    exit 2
  fi
  exec /usr/bin/sudo -n -- /usr/local/libexec/ownerinc-payload-receive "$SSH_ORIGINAL_COMMAND"
fi
if [[ ${SSH_ORIGINAL_COMMAND:-} == production:payload* ]]; then
  echo 'Refusing deployment: unsupported Payload receiver protocol.' >&2
  exit 2
fi

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
