#!/usr/bin/env bash
# Install only after local integration/rehearsal and separate operator approval.
# The host barrier fails closed unless the durable controller and private state
# are installed; absence is NEVER a PASS.
set -Eeuo pipefail
umask 077
action=${1:-}; release=${2:-}; evidence=${3:-}
: "${PORTAL_OPERATION_LOCK:?Operational lock required}"
[[ ${PORTAL_OPERATION_LOCK_HELD:-} == "$PORTAL_OPERATION_LOCK" && ! -L $PORTAL_OPERATION_LOCK && /proc/$$/fd/9 -ef $PORTAL_OPERATION_LOCK ]] || { echo 'Guard requires inherited exclusive operation lease' >&2; exit 2; }
[[ $release == /* && -d $release && ! -L $release ]] || exit 2
runtime=$(dirname "$PORTAL_OPERATION_LOCK")
control="$runtime/payload-control"
closed="$PORTAL_OPERATION_LOCK.admission-closed"
[[ -x $control && -f $control && ! -L $control && -f $runtime/payload-control-runtime.py && ! -L $runtime/payload-control-runtime.py && \
   -f $runtime/payload-control-state.py && ! -L $runtime/payload-control-state.py ]] || { echo 'Durable Payload control adapter not integrated' >&2; exit 2; }
# No environment/credential files are sourced; control receives only paths/action.
case $action in
  release-preflight|restore-preflight|rollback-check|prepare-restore|portal-restore-intermediate|verify-restored|verify-release|backup-metadata)
    "$control" "$action" "$release" "$evidence" ;;
  close-admission)
    if [[ -e $closed || -L $closed ]]; then
      [[ -f $closed && ! -L $closed ]] || { echo 'Unsafe Payload admission sentinel' >&2; exit 2; }
    fi
    # Persist the signed denial first. If creating the convenience sentinel
    # fails, the locked writer launcher still rejects the closed journal state.
    if ! "$control" close-admission "$release"; then
      if [[ ! -e $closed && ! -L $closed ]]; then
        ( set -o noclobber; : > "$closed" ) || true
      fi
      exit 2
    fi
    if [[ ! -e $closed && ! -L $closed ]]; then
      ( set -o noclobber; : > "$closed" )
    fi
    [[ -f $closed && ! -L $closed ]] || exit 2
    ;;
  quiescence-proof)
    [[ -f $closed && ! -L $closed ]] || exit 2
    : "${COMPOSE_PROJECT_NAME:?Explicit isolated Compose project required}"
    # The adapter performs a full all-container inventory including exited
    # one-shots. This fast running-process check is an additional barrier.
    running=$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Label "com.docker.compose.service"}}')
    while IFS= read -r service; do
      case $service in ''|postgres|cms-postgres) ;; *) echo 'A project writer is still running; no drain proof' >&2; exit 1;; esac
    done <<< "$running"
    # Preacthority adapter proves the supported writer/container and DB-session
    # quiescence boundary only. It does not run a finalizer or certify a seal.
    "$control" quiescence-proof "$release" ;;
  open-admission)
    [[ -f $closed && ! -L $closed ]] || exit 2
    "$control" open-admission "$release" "$evidence"
    rm -- "$closed" ;;
  *) echo 'Unknown Payload guard action' >&2; exit 2 ;;
esac
