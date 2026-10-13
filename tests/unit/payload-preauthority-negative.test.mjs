import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureFailure } from '../../scripts/integration/payload-preauthority-command.mjs';
import { negativeAssertionCodes, runCatalogNegative } from '../../scripts/integration/payload-preauthority-negative.mjs';
import { createRecoveryFailureReportFields } from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';

function fixture() {
  const before = { cmsSchema: 'baseline-private', cmsDatabase: 'rows-and-sequences-private', portalDatabase: 'portal-private',
    portalSchema: 'portal-schema-private', portalUploads: 'uploads-private', cmsUploads: 'media-private' };
  const injected = { ...before, cmsSchema: 'injected-private' };
  const rejection = new FixtureFailure('coordinator_restore_failed', {
    substep: 'payload_coordinator_restore', commandExitCode: 2, commandError: null,
    coordinatorStep: 'guard_release_preflight', controlErrorIdentifier: 'native_catalog_verification_failed',
    nativeCatalogVerifier: { stage: 'native_relations', reason: 'preauthority_native_relation_inventory_mismatch', sqlState: null },
  });
  const snapshots = [before, injected, injected, before];
  const calls = [];
  return { before, injected, rejection, snapshots, calls, operations: {
    setSubstep: step => calls.push(step), snapshot: () => snapshots.shift(),
    inject: () => calls.push('inject'), cleanup: () => calls.push('cleanup'),
    restore: () => { calls.push('restore'); throw rejection; }, assertWorkerHeld: () => calls.push('worker'),
  } };
}

test('catalog negative requires exact preflight reason, unchanged stores and exact DDL cleanup', async () => {
  for (const label of ['unexpected_schema', 'materialized_view', 'weak_native_constraint', 'migration_ledger_mismatch']) {
    const f = fixture();
    if (label === 'weak_native_constraint') f.rejection.diagnostic.nativeCatalogVerifier = {
      stage: 'native_constraints', reason: 'preauthority_native_constraint_inventory_mismatch', sqlState: null,
    };
    if (label === 'migration_ledger_mismatch') {
      f.rejection.diagnostic.controlErrorIdentifier = 'cms_migration_floor_mismatch';
      delete f.rejection.diagnostic.nativeCatalogVerifier;
    }
    await runCatalogNegative(label, f.operations);
    assert.equal(f.snapshots.length, 0);
    assert.ok(f.calls.indexOf('restore') < f.calls.indexOf('worker'));
    assert.ok(f.calls.indexOf('worker') < f.calls.indexOf('cleanup'));
  }
});

test('every negative phase has a finite redacted code, never a snapshot diff or stale media substep', async () => {
  const mutations = {
    negative_baseline_snapshot_error: f => { f.operations.snapshot = () => { throw Error('private-baseline'); }; },
    negative_injection_error: f => { f.operations.inject = () => { throw Error('private-DDL'); }; },
    negative_injected_snapshot_error: f => { f.operations.snapshot = () => { if (f.snapshots.length === 3) throw Error('private-injected'); return f.snapshots.shift(); }; },
    negative_fixture_not_visible: f => { f.snapshots[1] = f.before; },
    negative_restore_not_rejected: f => { f.operations.restore = () => {}; },
    negative_rejection_reason_mismatch: f => { f.rejection.diagnostic.controlErrorIdentifier = 'operation_lease_missing'; },
    negative_after_snapshot_error: f => { f.operations.snapshot = () => { if (f.snapshots.length === 2) throw Error('private-after'); return f.snapshots.shift(); }; },
    negative_contents_changed: f => { f.snapshots[2] = f.before; },
    negative_worker_hold_failed: f => { f.operations.assertWorkerHeld = () => { throw Error('private-worker'); }; },
    negative_ddl_cleanup_error: f => { f.operations.cleanup = () => { throw Error('private-cleanup'); }; },
    negative_cleanup_snapshot_error: f => { f.operations.snapshot = () => { if (f.snapshots.length === 1) throw Error('private-cleaned'); return f.snapshots.shift(); }; },
    negative_cleanup_snapshot_mismatch: f => { f.snapshots[3] = f.injected; },
  };
  assert.deepEqual(Object.keys(mutations), negativeAssertionCodes);
  for (const [code, mutate] of Object.entries(mutations)) {
    const f = fixture(); mutate(f);
    await assert.rejects(runCatalogNegative('unexpected_schema', f.operations), error => {
      const report = createRecoveryFailureReportFields({ primaryError: error, primarySubstep: 'snapshot_cms_media' });
      assert.equal(report.failureCode, code);
      assert.equal(report.failedSubstep, code);
      assert.doesNotMatch(JSON.stringify(report), /private|snapshot_cms_media|actual|expected/u);
      if (code === 'negative_contents_changed') {
        assert.equal(report.commandDiagnostic.coordinatorStep, 'guard_release_preflight');
        assert.equal(report.commandDiagnostic.controlErrorIdentifier, 'native_catalog_verification_failed');
      }
      return true;
    });
    if (!code.startsWith('negative_cleanup_') && code !== 'negative_ddl_cleanup_error') assert.ok(!f.calls.includes('cleanup'));
  }
});

test('arbitrary rejection, timeout, wrong native reason, late failure and wrong status cannot pass a negative', async () => {
  for (const mutate of [
    f => { f.operations.restore = () => { throw Error('private-command-error'); }; },
    f => { f.rejection.diagnostic.commandError = 'command_timeout'; },
    f => { f.rejection.diagnostic.commandExitCode = 43; },
    f => { f.rejection.diagnostic.coordinatorStep = 'restore_cms_database'; },
    f => { f.rejection.diagnostic.nativeCatalogVerifier.reason = 'preauthority_native_type_inventory_mismatch'; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(runCatalogNegative('unexpected_schema', f.operations), { code: 'negative_rejection_reason_mismatch' });
    assert.ok(!f.calls.includes('cleanup'));
  }
});
