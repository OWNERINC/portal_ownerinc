import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureFailure } from './payload-preauthority-command.mjs';
export { postRestoreFixtureHoldScript } from './payload-preauthority-snapshot-hold.mjs';

export const snapshotComponents = Object.freeze([
  'portalDatabase', 'cmsDatabase', 'portalSchema', 'cmsSchema', 'portalUploads', 'cmsUploads',
]);
const labels = new Set(['first_target_before', 'first_target_after', 'first_source_after',
  'second_target_before', 'second_target_after', 'second_source_after']);
const digest = /^[0-9a-f]{64}$/u;
const codes = new Set(['restored_authority_mismatch', 'source_announcement_invalid',
  'restored_source_document_mismatch', 'restored_target_document_present', 'restored_worker_hold_failed']);

export function assertRecoveryCondition(code, condition) {
  if (!codes.has(code)) throw new Error('unsupported_recovery_assertion');
  if (!condition) throw new FixtureFailure(code, { substep: code });
}

function validSnapshot(snapshot) {
  return snapshot && typeof snapshot === 'object'
    && Object.keys(snapshot).length === snapshotComponents.length
    && snapshotComponents.every(component => typeof snapshot[component] === 'string' && digest.test(snapshot[component]));
}

export function sanitizeSnapshotMismatch(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > snapshotComponents.length) return null;
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (!item || !snapshotComponents.includes(item.component) || seen.has(item.component)
        || typeof item.expectedHash !== 'string' || !digest.test(item.expectedHash)
        || typeof item.actualHash !== 'string' || !digest.test(item.actualHash)
        || item.expectedHash === item.actualHash) return null;
    seen.add(item.component);
    result.push({ component: item.component, expectedHash: item.expectedHash, actualHash: item.actualHash });
  }
  return result;
}

export function assertRecoverySnapshots(expected, actual, { changed = false } = {}) {
  if (!validSnapshot(expected) || !validSnapshot(actual)) {
    throw new FixtureFailure('recovery_snapshot_shape_invalid', { substep: 'compare_restored_stores' });
  }
  const mismatch = snapshotComponents.filter(component => expected[component] !== actual[component])
    .map(component => ({ component, expectedHash: expected[component], actualHash: actual[component] }));
  if (changed) {
    if (!mismatch.length) throw new FixtureFailure('restore_target_unchanged', { substep: 'compare_target_before_after' });
  } else if (mismatch.length) {
    const error = new FixtureFailure('restored_snapshot_mismatch', { substep: 'compare_restored_stores' });
    error.snapshotMismatch = mismatch;
    throw error;
  }
}

/** Fixture-only post-operation hold. This is NOT a production pre-open gate.
 * Try both operations for every fixture even if the first one fails. Never
 * replace the acceptance failure with a hold failure or reopen admission. */
export async function holdFailedRecoveryFixtures(fixtures, hold) {
  const roles = ['source', 'target', 'leaseTarget'];
  const result = [];
  for (const [index, fixture] of fixtures.entries()) {
    const entry = { fixture: roles[index] || 'unknown', attempted: true, admissionClosed: false, writersStopped: false };
    try {
      const outcome = await hold(fixture);
      entry.admissionClosed = outcome?.admissionClosed === true;
      entry.writersStopped = outcome?.writersStopped === true;
    } catch (error) {
      // Only the command wrapper attaches this bounded typed result after
      // validating stdout AND process status in the explicit hold context.
      const outcome = error instanceof FixtureFailure ? error.fixtureFailureHold : null;
      entry.admissionClosed = outcome?.admissionClosed === true;
      entry.writersStopped = outcome?.writersStopped === true;
    }
    result.push(entry);
  }
  return result;
}

// Both operations are run under ONE inherited lease by the caller. The installed
// guard closes the signed admission state/sentinel. Even a guard rejection must
// not leave fixture writers running. Success is checked, never inferred.
/** Private diagnostic copies only: truncation NEVER affects an acceptance hash.
 * Six fixed capture labels x six components x 1 MiB maximum retained bytes. */
export function createPrivateSnapshotEvidence() {
  const records = new Map();
  return {
    capture(label, component, bytes) {
      if (!labels.has(label) || !snapshotComponents.includes(component)) throw new Error('invalid_snapshot_evidence_label');
      const buffer = Buffer.from(bytes);
      records.set(`${label}-${component}`, { label, component, originalBytes: buffer.length,
        format: component === 'portalUploads' || component === 'cmsUploads' ? 'tar' : 'normalized-pg-dump-sql',
        truncated: buffer.length > 1024 * 1024, bytes: Buffer.from(buffer.subarray(0, 1024 * 1024)) });
    },
    async persist(root) {
      if (!root || !records.size) return false;
      const directory = path.join(root, 'private-snapshots');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const manifest = [];
      for (const [name, { bytes, ...metadata }] of records) {
        const file = `${name}.bin`;
        await writeFile(path.join(directory, file), bytes, { mode: 0o600 });
        await chmod(path.join(directory, file), 0o600);
        manifest.push({ file, ...metadata });
      }
      const manifestPath = path.join(directory, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await chmod(manifestPath, 0o600);
      return true;
    },
  };
}
