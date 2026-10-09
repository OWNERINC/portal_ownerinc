import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCommandDiagnostic, extractSqlState } from '../../scripts/integration/payload-preauthority-diagnostics.mjs';

const recoveryRunner = await readFile(new URL('../../scripts/test-payload-preauthority-recovery.mjs', import.meta.url), 'utf8');

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
  assert.match(recoveryRunner, /failedSubstep: activeSubstep/u);
  assert.match(recoveryRunner, /commandDiagnostic: error\.diagnostic/u);
  assert.doesNotMatch(recoveryRunner, /commandDiagnostic:\s*\{[^}]*stderr|commandDiagnostic:\s*\{[^}]*stdout/isu);
});
