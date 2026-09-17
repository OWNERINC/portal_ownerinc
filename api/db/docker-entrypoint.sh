#!/bin/sh
set -eu

run_migrations=${RUN_MIGRATIONS:-false}
migration_only=${MIGRATION_ONLY:-false}

if [ "$migration_only" = "true" ] && [ "$run_migrations" != "true" ]; then
  echo '[migrate] MIGRATION_ONLY requires RUN_MIGRATIONS=true' >&2
  exit 1
fi

if [ "$run_migrations" = "true" ]; then
  node db/migrate.js
fi

if [ "$migration_only" = "true" ]; then
  exit 0
fi

exec "$@"
