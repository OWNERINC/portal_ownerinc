import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const stages = new Set(`validate_inputs fixture_root_owner_guard_regression pull_published_candidate_images
prepare verify_release seed quiescent_snapshot restart_writers
negative_tampered_dump negative_tampered_proof negative_tampered_manifest negative_unsafe_archive
negative_wrong_image_digest negative_migration_mismatch negative_unexpected_schema negative_weak_native_constraint
negative_materialized_view negative_migration_ledger_mismatch
negative_target_changed_after_preflight capture_actual_coordinated_backup offline_rejection_matrix
first_actual_restore second_capture_after_synthetic_live_edit second_actual_restore successful_fixture_cleanup`.split(/\s+/u));
const substeps = new Set(`none fixture_root_owner_lease_probe fixture_root_owner_evidence_cleanup
readiness_container_inspect readiness_http_probe snapshot_observe_writer_identities
fixture_nginx_http_availability fixture_nginx_inspect fixture_nginx_prepare fixture_full_smoke
payload_initialize_isolated payload_install_floor_commit payload_control_release_preflight
payload_control_verify_release payload_control_unknown_action payload_coordinator_backup payload_coordinator_restore
seed_portal_user seed_portal_poll seed_portal_legacy_document seed_portal_legacy_revision
seed_portal_publish_legacy_revision seed_cms_portal_editor seed_cms_payload_preference seed_portal_upload seed_cms_media
snapshot_portal_logical_database snapshot_cms_logical_database snapshot_private_dump_evidence
snapshot_portal_uploads snapshot_cms_media snapshot_list_writers snapshot_stop_writers
snapshot_verify_writers_stopped snapshot_compare_quiescent linux_conversion_prerequisite snapshot_restart_writers
verify_restored_authority verify_source_announcement verify_restored_source_document
verify_restored_target_document_absent verify_restored_worker_hold compare_restored_stores compare_target_before_after
post_restore_fixture_failure_hold`.split(/\s+/u));
for (const service of ['api', 'cron', 'cms']) {
  for (const phase of ['container', 'health', 'container_state']) substeps.add(`wait_${service}_${phase}`);
}
const roles = new Set(['source', 'target', 'leaseTarget', 'global']);
const categories = new Set(['none', 'docker', 'compose', 'shell', 'python', 'node', 'git', 'control',
  'coordinator_backup', 'coordinator_restore', 'sql', 'snapshot', 'smoke', 'writer_restart',
  'failure_holds', 'cleanup', 'private_command_evidence', 'private_snapshot_evidence', 'terminal_report', 'lease_race']);
const events = new Set(['stage_begin', 'stage_end', 'substep_begin', 'substep_end', 'command_begin',
  'command_end', 'boundary_begin', 'boundary_end', 'failure_captured']);
const outcomes = new Set(['none', 'completed', 'failed']);
const label = (allowlist, value) => allowlist.has(value) ? value : 'unknown';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// One bounded latest record, no append history. Exclusive temporary file and
// atomic rename mean an interrupted writer leaves either the old or new JSON.
function writeCheckpoint(checkpoint, line) {
  mkdirSync(path.dirname(checkpoint), { recursive: true });
  const temporary = `${checkpoint}.${process.pid}.tmp`;
  let descriptor;
  let owned = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o644);
    owned = true;
    writeFileSync(descriptor, line);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, checkpoint);
    owned = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (owned) unlinkSync(temporary);
  }
}

/** Diagnostics only: no arguments, child output, errors or runtime names enter
 * serialization. I/O failure must never throw into recovery or its failure holds. */
export function createRecoveryProgress({ checkpoint, reportPath,
  writeConsole = line => writeSync(1, line), alert = line => writeSync(2, line),
  clock = () => performance.now(),
} = {}) {
  const started = clock();
  let sequence = 0;
  let elapsedMs = 0;
  let warned = false;
  let stageOpen = false;
  let firstFailure = null;
  let context = { stage: 'unknown', substep: 'none', fixtureRole: 'global' };
  function unavailable() {
    if (warned) return;
    warned = true;
    try { alert('Payload recovery diagnostic progress unavailable.\n'); } catch { /* Never mask recovery. */ }
  }
  function emit(event, selected = {}) {
    try {
      elapsedMs = Math.max(elapsedMs, integer(Math.floor(clock() - started)));
      const record = {
        schemaVersion: 1, artifactKind: 'diagnostic-progress', qualifiesAcceptance: false,
        sequence: ++sequence, elapsedMs,
        stage: label(stages, selected.stage ?? context.stage),
        substep: label(substeps, selected.substep ?? context.substep),
        fixtureRole: label(roles, selected.fixtureRole ?? context.fixtureRole),
        event: label(events, event), commandCategory: label(categories, selected.category ?? 'none'),
        timeoutMs: integer(selected.timeoutMs ?? 0), outcome: label(outcomes, selected.outcome ?? 'none'),
        firstFailure,
      };
      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > 1024) { unavailable(); return; }
      try {
        if (!checkpoint || (reportPath && path.resolve(checkpoint) === path.resolve(reportPath))) throw new Error();
        writeCheckpoint(checkpoint, line);
      } catch { unavailable(); }
      try { writeConsole(line); } catch { unavailable(); }
    } catch { unavailable(); }
  }
  function selectedCommand(selected) {
    return { ...context, category: selected.category, timeoutMs: selected.timeoutMs,
      substep: selected.substep ?? context.substep, fixtureRole: selected.role ?? context.fixtureRole };
  }
  return {
    transition(stage, role = 'global') {
      const next = { stage: label(stages, stage), substep: 'none', fixtureRole: label(roles, role) };
      if (stageOpen && next.stage === context.stage && next.fixtureRole === context.fixtureRole) return;
      if (context.substep !== 'none') emit('substep_end');
      if (stageOpen) emit('stage_end');
      context = next;
      stageOpen = true;
      emit('stage_begin');
    },
    substep(value) {
      const next = value === null ? 'none' : label(substeps, value);
      if (context.substep === next) return;
      if (context.substep !== 'none') emit('substep_end');
      context = { ...context, substep: next };
      if (next !== 'none') emit('substep_begin');
    },
    failure(selected = {}) {
      // Latch before I/O; even a failed checkpoint write must not let subsequent
      // holds/restart/diagnostic failures replace the original normalized context.
      if (firstFailure === null) firstFailure = Object.freeze({
        stage: label(stages, selected.stage ?? context.stage),
        substep: label(substeps, selected.substep ?? context.substep),
        fixtureRole: label(roles, selected.role ?? context.fixtureRole),
      });
      emit('failure_captured', { outcome: 'failed' });
    },
    finish(outcome) {
      if (context.substep !== 'none') emit('substep_end', { outcome });
      if (stageOpen) emit('stage_end', { outcome });
      stageOpen = false;
      context = { stage: 'unknown', substep: 'none', fixtureRole: 'global' };
    },
    command(selected, operation) {
      const metadata = selectedCommand(selected);
      emit('command_begin', metadata);
      let outcome = 'failed';
      try { const result = operation(); outcome = 'completed'; return result; }
      finally { emit('command_end', { ...metadata, outcome }); }
    },
    async boundary(category, operation) {
      const metadata = { ...context, category };
      emit('boundary_begin', metadata);
      let outcome = 'failed';
      try { const result = await operation(); outcome = 'completed'; return result; }
      finally { emit('boundary_end', { ...metadata, outcome }); }
    },
  };
}
