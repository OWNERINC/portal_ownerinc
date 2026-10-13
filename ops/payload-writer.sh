#!/usr/bin/env bash
# Operator-side import/maintenance launcher. Every out-of-band writer MUST use
# this before creating a DB connection; ordinary web/jobs are Compose-managed.
set -Eeuo pipefail
umask 077
: "${PORTAL_OPERATION_LOCK:?Set the same lock as deploy/backup/restore}"
[[ $# -gt 0 && $PORTAL_OPERATION_LOCK == /* && ! -L $PORTAL_OPERATION_LOCK ]] || exit 2
if [[ -n ${PORTAL_OPERATION_LOCK_HELD:-} ]]; then
  [[ $PORTAL_OPERATION_LOCK_HELD == "$PORTAL_OPERATION_LOCK" && /proc/$$/fd/9 -ef $PORTAL_OPERATION_LOCK ]] || exit 2
else
  exec 9>>"$PORTAL_OPERATION_LOCK"
  flock -w "${PORTAL_LOCK_WAIT_SECONDS:-300}" 9 || exit 75
  export PORTAL_OPERATION_LOCK_HELD=$PORTAL_OPERATION_LOCK
fi
runtime=$(dirname -- "$PORTAL_OPERATION_LOCK")
state_helper="$runtime/payload-control-state.py"
[[ -f $state_helper && ! -L $state_helper ]] || { echo 'Payload writer admission state is unavailable' >&2; exit 75; }
python3 "$state_helper" verify-admission "$runtime" open >/dev/null || exit 75
[[ ! -e $PORTAL_OPERATION_LOCK.admission-closed && ! -L $PORTAL_OPERATION_LOCK.admission-closed ]] || { echo 'Payload writer admission is closed' >&2; exit 75; }
# Foreground exec keeps fd9 alive until the writer and its inherited children exit.
# The caller must not daemonize or close fd9 before all DB/filesystem work ends.
exec "$@"
