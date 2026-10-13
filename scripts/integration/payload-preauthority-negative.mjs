import { isDeepStrictEqual } from 'node:util';
import { FixtureFailure } from './payload-preauthority-command.mjs';

const expected = Object.freeze({
  unexpected_schema: ['native_relations', 'preauthority_native_relation_inventory_mismatch'],
  weak_native_constraint: ['native_constraints', 'preauthority_native_constraint_inventory_mismatch'],
  materialized_view: ['native_relations', 'preauthority_native_relation_inventory_mismatch'],
  migration_ledger_mismatch: null,
});
export const negativeAssertionCodes = Object.freeze([
  'negative_baseline_snapshot_error', 'negative_injection_error', 'negative_injected_snapshot_error',
  'negative_fixture_not_visible', 'negative_restore_not_rejected', 'negative_rejection_reason_mismatch',
  'negative_after_snapshot_error', 'negative_contents_changed', 'negative_worker_hold_failed',
  'negative_ddl_cleanup_error', 'negative_cleanup_snapshot_error', 'negative_cleanup_snapshot_mismatch',
]);

/** No assertion diff, SQL, hashes or raw exception messages leave this boundary. */
export async function runCatalogNegative(label, operations) {
  if (!Object.hasOwn(expected, label)) throw new Error('unsupported_catalog_negative');
  let rejection = null;
  const fail = (code, cause = rejection) => {
    if (!negativeAssertionCodes.includes(code)) throw new Error('unsupported_negative_assertion');
    operations.setSubstep(code);
    throw new FixtureFailure(code, { ...cause?.diagnostic, substep: code });
  };
  const phase = async (code, operation) => {
    operations.setSubstep(code);
    try { return await operation(); } catch (error) { fail(code, error); }
  };
  const before = await phase('negative_baseline_snapshot_error', operations.snapshot);
  await phase('negative_injection_error', operations.inject);
  const injected = await phase('negative_injected_snapshot_error', operations.snapshot);
  if (isDeepStrictEqual(injected, before)) fail('negative_fixture_not_visible');
  try { await operations.restore(); } catch (error) { rejection = error; }
  if (!rejection) fail('negative_restore_not_rejected');
  const diagnostic = rejection.diagnostic;
  const native = diagnostic?.nativeCatalogVerifier;
  const contract = expected[label];
  const correctReason = contract
    ? diagnostic?.controlErrorIdentifier === 'native_catalog_verification_failed'
      && native?.stage === contract[0] && native?.reason === contract[1]
    : diagnostic?.controlErrorIdentifier === 'cms_migration_floor_mismatch';
  if (!(rejection instanceof FixtureFailure) || rejection.code !== 'coordinator_restore_failed'
      || diagnostic?.commandExitCode !== 2 || diagnostic?.commandError
      || !['guard_release_preflight', 'guard_restore_preflight'].includes(diagnostic?.coordinatorStep)
      || !correctReason) fail('negative_rejection_reason_mismatch');
  const after = await phase('negative_after_snapshot_error', operations.snapshot);
  if (!isDeepStrictEqual(injected, after)) fail('negative_contents_changed');
  await phase('negative_worker_hold_failed', operations.assertWorkerHeld);
  // Never clean up DDL after an unexpected rejection or content mutation.
  await phase('negative_ddl_cleanup_error', operations.cleanup);
  const cleaned = await phase('negative_cleanup_snapshot_error', operations.snapshot);
  if (!isDeepStrictEqual(cleaned, before)) fail('negative_cleanup_snapshot_mismatch');
}
