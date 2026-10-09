import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createCommandDiagnostic, extractControlErrorIdentifier, extractSqlState,
} from '../../scripts/integration/payload-preauthority-diagnostics.mjs';

const recoveryRunner = await readFile(new URL('../../scripts/test-payload-preauthority-recovery.mjs', import.meta.url), 'utf8');
const controlRuntime = await readFile(new URL('../../ops/payload-control-runtime.py', import.meta.url), 'utf8');
const controlState = await readFile(new URL('../../ops/payload-control-state.py', import.meta.url), 'utf8');
const controlInventory = await readFile(new URL('../../ops/payload-control-inventory.py', import.meta.url), 'utf8');
const controlEntrypoint = await readFile(new URL('../../ops/payload-control', import.meta.url), 'utf8');
const controlGuard = await readFile(new URL('../../ops/payload-operations-guard.sh', import.meta.url), 'utf8');

test('extracts only a known SQLSTATE-only line from a known psql invocation', () => {
  const psqlContext = { sqlCommandContext: true };
  assert.equal(extractSqlState('ERROR:  23505\n', psqlContext), '23505');
  assert.equal(extractSqlState(Buffer.from('ERROR:  28P01\r\n'), psqlContext), '28P01',
    'letter-bearing PostgreSQL codes remain supported');
  assert.equal(extractSqlState('ERROR: Could not open fixture-private-value', psqlContext), null);
  assert.equal(extractSqlState('ERROR: COULD', psqlContext), null);
  assert.equal(extractSqlState('ERROR: abcde', psqlContext), null,
    'an ordinary lowercase five-letter value is not a SQLSTATE');
  assert.equal(extractSqlState('ERROR: ABCDE', psqlContext), null,
    'an unrecognized uppercase five-character value is not allowlisted');
  assert.equal(extractSqlState('ERROR:  23505 private detail', psqlContext), null,
    'a line with appended prose is not a SQLSTATE-only line');
  assert.equal(extractSqlState('ERROR:  23505\n', { sqlCommandContext: false }), null,
    'stderr from commands outside the known SQL invocation is never parsed');
  assert.equal(extractSqlState('docker compose failed: fixture-private-value', psqlContext), null);
});

test('command diagnostics contain allowlisted metadata only', () => {
  const diagnostic = createCommandDiagnostic({
    substep: 'seed_portal_poll',
    status: 3,
    stderr: 'ERROR:  23514\nprivate detail contains fixture-private-value',
    sqlCommandContext: true,
  });

  assert.deepEqual(diagnostic, {
    substep: 'seed_portal_poll',
    commandExitCode: 3,
    commandError: null,
    sqlState: '23514',
    errorIdentifier: 'check_violation',
    controlErrorIdentifier: null,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-private-value|ERROR|detail|constraint/u);
});

test('unknown SQLSTATEs and process failures remain bounded identifiers', () => {
  assert.deepEqual(createCommandDiagnostic({
    substep: 'seed_cms_media',
    status: null,
    errorCode: 'ETIMEDOUT',
    stderr: 'fixture-private-value',
  }), {
    substep: 'seed_cms_media',
    commandExitCode: null,
    commandError: 'command_timeout',
    sqlState: null,
    errorIdentifier: null,
    controlErrorIdentifier: null,
  });
  assert.equal(createCommandDiagnostic({
    substep: 'bad substep with private value',
    status: 1,
    stderr: 'ERROR:  XX000 private detail',
  }).substep, 'unclassified_command');
  assert.equal(createCommandDiagnostic({
    substep: 'seed_portal_users',
    status: 1,
    stderr: 'ERROR:  XX000 private detail',
    sqlCommandContext: true,
  }).sqlState, null);
  assert.equal(createCommandDiagnostic({
    substep: 'seed_portal_users',
    status: 1,
    stderr: 'ERROR:  23503\n',
  }).sqlState, null, 'an otherwise known SQLSTATE is ignored outside psql context');
});

test('control errors require a known adapter context, one exact line and an emitted finite code', () => {
  const context = { controlCommandContext: 'payload-control:verify-release' };
  assert.match(controlRuntime, /fail\('planned_release_mismatch'\)/u);
  assert.match(controlRuntime, /print\(str\(error\), file=sys\.stderr\)/u,
    'the adapter emits fixed reason identifiers as a single stderr line');
  assert.equal(extractControlErrorIdentifier('planned_release_mismatch\n', context), 'planned_release_mismatch');
  assert.equal(createCommandDiagnostic({
    substep: 'payload_control_verify_release',
    status: 2,
    stderr: Buffer.from('planned_release_mismatch\n'),
    controlCommandContext: context.controlCommandContext,
  }).controlErrorIdentifier, 'planned_release_mismatch');

  for (const text of [
    'secret_adapter_reason\n',
    'planned_release_mismatch\nfixture-private-value=top-secret\n',
    'planned_release_mismatch\nunknown appended detail\n',
  ]) {
    assert.equal(extractControlErrorIdentifier(text, context), null,
      'unknown codes and any appended detail remain private/unclassified');
  }
  assert.equal(extractControlErrorIdentifier('planned_release_mismatch\n'), null,
    'stderr outside a known adapter invocation is never parsed');
  assert.equal(extractControlErrorIdentifier('planned_release_mismatch\n', {
    controlCommandContext: 'payload-control:backup-metadata',
  }), null, 'an action without an explicit adapter context is not parsed');

  assert.equal(extractControlErrorIdentifier('Guard requires inherited exclusive operation lease\n', {
    controlCommandContext: 'payload-operations-guard',
  }), 'guard_operation_lease_required');
  assert.equal(extractControlErrorIdentifier('Guard requires inherited exclusive operation lease\n', context), null,
    'guard prose is recognized only in its own explicit context');
  assert.match(controlEntrypoint, /exec python3 "\$runtime" "\$@"/u);
  assert.match(controlGuard, /echo 'Guard requires inherited exclusive operation lease' >&2/u);
  for (const source of [controlEntrypoint, controlGuard]) {
    for (const match of source.matchAll(/echo '([^'\r\n]+)' >&2/gu)) {
      const contextName = source === controlGuard ? 'payload-operations-guard' : context.controlCommandContext;
      assert.ok(extractControlErrorIdentifier(`${match[1]}\n`, { controlCommandContext: contextName }),
        `fixed wrapper message ${match[1]} must map to a bounded identifier`);
    }
  }

  const sourceCodes = new Set([controlRuntime, controlState, controlInventory]
    .flatMap(source => [...source.matchAll(/fail\('([a-z][a-z0-9_]+)'\)/gu)]
      .map(match => match[1])));
  sourceCodes.add('admission_state_not_open');
  sourceCodes.add('admission_state_not_closed');
  for (const identifier of ['state_head_corrupt', 'proof_not_canonical', 'proof_shape_invalid']) {
    assert.ok(controlState.includes(`'${identifier}'`), `expected state helper to emit ${identifier}`);
    sourceCodes.add(identifier);
  }
  for (const identifier of sourceCodes) {
    assert.equal(extractControlErrorIdentifier(`${identifier}\n`, context), identifier,
      `fixed adapter reason ${identifier} must be in the explicit finite allowlist`);
  }
});

test('recovery seed and report keep failures attributable without serializing command data', () => {
  for (const substep of [
    'seed_portal_user', 'seed_portal_poll', 'seed_portal_legacy_document',
    'seed_portal_legacy_revision', 'seed_portal_publish_legacy_revision',
    'seed_cms_portal_editor', 'seed_cms_payload_preference', 'seed_portal_upload', 'seed_cms_media',
  ]) {
    assert.ok(recoveryRunner.includes(substep), `expected a distinct seed substep for ${substep}`);
  }
  assert.match(recoveryRunner, /'VERBOSITY=sqlstate'/u);
  assert.match(recoveryRunner, /sqlCommandContext: true/u);
  assert.match(recoveryRunner, /failureReportFields = \{\s*\.\.\.createRecoveryFailureReportFields\(outcome\)/u);
  assert.match(recoveryRunner, /failureFields = failureReportFields \|\| createRecoveryFailureReportFields/u);
  assert.doesNotMatch(recoveryRunner, /commandDiagnostic:\s*\{[^}]*stderr|commandDiagnostic:\s*\{[^}]*stdout/isu);
});
