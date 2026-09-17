#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -n ${SSH_ORIGINAL_COMMAND:-} && $SSH_ORIGINAL_COMMAND != staging:* ]]; then
  echo "Refusing deployment: staging receiver accepts only staging targets." >&2
  exit 2
fi

export DEPLOY_TARGET=staging
export DEPLOY_RECEIVER_ROLE=staging
export DEPLOY_CONFIG=${DEPLOY_CONFIG:-/etc/ownerinc/portal-staging-deploy.conf}
exec /usr/local/libexec/ownerinc-portal-deploy "$@"
