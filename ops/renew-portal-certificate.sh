#!/usr/bin/env bash
set -Eeuo pipefail

if (($#)); then
  echo 'Portal certificate renewal accepts no arguments.' >&2
  exit 2
fi

# Certbot runs the deploy hook only after a successful renewal, not when the
# lineage is still valid. Preserve its output/status; do not invent a renewal.
exec docker exec root-app-1 /opt/certbot/bin/certbot renew --non-interactive \
  --cert-name portal.ownerinc.com.br --no-random-sleep-on-renew \
  --no-directory-hooks --deploy-hook '/usr/sbin/nginx -t && /usr/sbin/nginx -s reload'
