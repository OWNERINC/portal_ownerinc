#!/usr/bin/env bash
# Install only after local integration/rehearsal and separate operator approval.
# This host barrier delegates durable authority/ledger decisions to the reviewed
# control adapter. Its absence is an implementation dependency, NEVER a PASS.
set -Eeuo pipefail
umask 077
action=${1:-}; release=${2:-}; evidence=${3:-}
: "${PORTAL_OPERATION_LOCK:?Operational lock required}"
[[ ${PORTAL_OPERATION_LOCK_HELD:-} == "$PORTAL_OPERATION_LOCK" && /proc/$$/fd/9 -ef $PORTAL_OPERATION_LOCK ]] || { echo 'Guard requires inherited exclusive operation lease' >&2; exit 2; }
[[ $release == /* && -d $release && ! -L $release ]] || exit 2
runtime=$(dirname "$PORTAL_OPERATION_LOCK")
control="$runtime/payload-control"
closed="$PORTAL_OPERATION_LOCK.admission-closed"
[[ -x $control && -f $control && ! -L $control ]] || { echo 'Durable Payload control adapter not integrated' >&2; exit 2; }
# No environment/credential files are sourced; control receives only paths/action.
case $action in
  release-preflight|restore-preflight|rollback-check|prepare-restore|verify-restored|verify-release|backup-metadata)
    "$control" "$action" "$release" "$evidence" ;;
  close-admission)
    # External writer launchers cannot pass the held lock; the durable control
    # adapter checks interrupted prior runs before confirming this admission fence.
    [[ ! -L $closed ]] || exit 2
    : > "$closed"
    "$control" close-admission "$release" ;;
  quiescence-proof)
    [[ -f $closed && ! -L $closed ]] || exit 2
    : "${COMPOSE_PROJECT_NAME:?Explicit isolated Compose project required}"
    # Include one-shot import/migrate/maintenance containers, not only five named
    # services. Unknown project members fail closed instead of being killed.
    running=$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Label "com.docker.compose.service"}}')
    while IFS= read -r service; do
      case $service in ''|postgres|cms-postgres|firebase-auth) ;; *) echo 'A project writer is still running; no drain proof' >&2; exit 1;; esac
    done <<< "$running"
    # Durable adapter reconciles job finalization, crash/COMMIT-unknown receipts,
    # complete sequence, epoch, manifest and seal. No DB tx waits for processes.
    "$control" quiescence-proof "$release" ;;
  open-admission)
    [[ -f $closed && ! -L $closed ]] || exit 2
    "$control" open-admission "$release" "$evidence"
    rm -- "$closed" ;;
  *) echo 'Unknown Payload guard action' >&2; exit 2 ;;
esac
