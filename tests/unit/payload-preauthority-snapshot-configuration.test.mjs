import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runFixtureCommand, FixtureFailure } from '../../scripts/integration/payload-preauthority-command.mjs';
import { CONVERSION_PROBE_CONTEXT } from '../../scripts/integration/payload-logical-snapshot-probe-protocol.mjs';
import { createRecoveryFailureReportFields } from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';
import { producedLinuxRecoveryFixture } from './payload-preauthority-snapshot-producer-fixture.mjs';

const probeUrl = pathToFileURL(path.resolve('scripts/integration/payload-logical-snapshot-conversion-probe.mjs')).href;
const protocolUrl = pathToFileURL(path.resolve('scripts/integration/payload-logical-snapshot-probe-protocol.mjs')).href;
const consumer = `import { readFileSync } from 'node:fs';
const {assertConversionFixtureConfiguration,conversionProbeFailure}=await import(${JSON.stringify(probeUrl)});
const {encodeConversionProbeFailure}=await import(${JSON.stringify(protocolUrl)});
try {assertConversionFixtureConfiguration(JSON.parse(readFileSync(0,'utf8')),process.env);process.stdout.write('configuration_accepted\\n')}
catch(error) {process.stderr.write(encodeConversionProbeFailure(conversionProbeFailure(error,'conversion_validate_fixture')));process.exitCode=2}`;
const check = (input, env) => runFixtureCommand(process.execPath, ['--input-type=module', '-e', consumer], {
  input, env, conversionProbeCommandContext: CONVERSION_PROBE_CONTEXT,
});

test('actual inventory/release/Compose/environment/JSON producers round-trip through actual consumer and real command wrapper', () => {
  const produced = producedLinuxRecoveryFixture();
  const configuration = JSON.parse(produced.wire.input);
  assert.equal(produced.payloadRelease.split('/').at(-1), produced.commit);
  assert.equal(configuration.commit, produced.commit);
  assert.equal(produced.environment.PAYLOAD_RECOVERY_COMMIT, produced.commit);
  assert.equal(configuration.composeArgs[17], produced.payloadRelease);
  assert.equal(configuration.composeArgs[5], `${produced.payloadRelease}/.image-env`);
  assert.equal(produced.environment.COMPOSE_PROJECT_NAME, produced.project);
  assert.equal(Object.hasOwn(produced.environment, 'GITHUB_SHA'), false, 'the binding does not rely on ambient GITHUB_SHA');
  // No full conversion context on this successful validation-only command:
  // configuration acceptance is NOT evidence of a conversion/engine PASS.
  const result = runFixtureCommand(process.execPath, ['--input-type=module', '-e', consumer], {
    input: produced.wire.input, env: produced.environment,
  });
  assert.equal(result.toString(), 'configuration_accepted\n');
});

test('reversing the commit-addressed release to the old payload-candidate alias fails specifically without exposing paths', () => {
  const produced = producedLinuxRecoveryFixture();
  const configuration = JSON.parse(produced.wire.input);
  configuration.composeArgs = configuration.composeArgs.map(value => value.replace(produced.commit, 'payload-candidate'));
  assert.throws(() => check(JSON.stringify(configuration), produced.environment), error => {
    assert.ok(error instanceof FixtureFailure);
    assert.equal(error.code, 'linux_conversion_validate_fixture_configuration_compose_release_mismatch');
    assert.equal(error.diagnostic.substep, 'conversion_validate_fixture');
    assert.doesNotMatch(JSON.stringify(createRecoveryFailureReportFields({ primaryError: error })), /private\/disposable|payload-candidate|5538227/u);
    return true;
  });
});

test('the actual probe entrypoint reads the producer JSON and stripped environment, passes fixture validation and refuses the unleased test child before effects', () => {
  const produced = producedLinuxRecoveryFixture();
  assert.throws(() => runFixtureCommand(process.execPath,
    [path.resolve('scripts/integration/payload-logical-snapshot-conversion-probe.mjs')], {
      input: produced.wire.input, env: produced.environment,
      conversionProbeCommandContext: CONVERSION_PROBE_CONTEXT,
    }), error => {
    assert.ok(error instanceof FixtureFailure);
    assert.equal(error.diagnostic.substep, 'conversion_validate_lease', 'the real stdin/config gate must be crossed, not bypassed');
    assert.match(error.code, /^linux_conversion_validate_lease_(platform_or_uid_invalid|lease_unavailable|lease_identity_mismatch)$/u);
    assert.doesNotMatch(error.code, /configuration_/u);
    return true;
  });
});

test('each config field failure has a finite precise reason through the real wrapper, including stripped/mismatched commit and lease exports', () => {
  const produced = producedLinuxRecoveryFixture();
  const original = JSON.parse(produced.wire.input);
  const cases = [
    ['configuration_shape_invalid', value => { delete value.commit; }],
    ['configuration_shape_invalid', value => { value.privateExtra = 'private-data'; }],
    ['configuration_runtime_invalid', value => { value.runtimeDirectory += '/..'; }],
    ['configuration_project_invalid', value => { value.project = 'ownerinc-portal-prod'; }],
    ['configuration_commit_invalid', value => { value.commit = 'not-a-commit'; }],
    ['configuration_commit_mismatch', value => { value.commit = 'b'.repeat(40); }],
    ['configuration_python_invalid', value => { value.python = null; }],
    ['configuration_compose_shape_invalid', value => { value.composeArgs.push('--project-name', 'ownerinc-portal-prod'); }],
    ['configuration_compose_options_mismatch', value => { value.composeArgs[0] = '-p'; }],
    ['configuration_compose_environment_mismatch', value => { value.composeArgs[3] = '/private/foreign.env'; }],
    ['configuration_compose_release_mismatch', value => { value.composeArgs[7] = '/private/foreign-release/docker-compose.yml'; }],
    ['configuration_compose_override_mismatch', value => { value.composeArgs[13] = '/private/foreign-override.yaml'; }],
    ['configuration_compose_project_mismatch', value => { value.composeArgs[15] = 'ownerinc-portal-prod'; }],
  ];
  for (const [reason, mutate] of cases) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => check(JSON.stringify(value), produced.environment), { code: `linux_conversion_validate_fixture_${reason}` });
  }
  for (const [key, reason] of [
    ['PAYLOAD_RECOVERY_COMMIT', 'configuration_commit_mismatch'], ['COMPOSE_PROJECT_NAME', 'configuration_project_mismatch'],
    ['PORTAL_OPERATION_LOCK', 'configuration_lock_mismatch'], ['PORTAL_OPERATION_LOCK_HELD', 'configuration_lease_mismatch'],
  ]) {
    const env = { ...produced.environment }; delete env[key];
    assert.throws(() => check(produced.wire.input, env), { code: `linux_conversion_validate_fixture_${reason}` });
  }
});

test('the runner actually uses the tested producers for release, Compose, environment and serialized probe input', async () => {
  const runner = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  assert.match(runner, /const payloadRelease = recoveryPayloadRelease\(releases, runIdentity\.commit\)/u);
  assert.match(runner, /return recoveryComposeArgs\(project, release, runtime, actionArgs\)/u);
  assert.match(runner, /return recoveryFixtureEnvironment\(project, runtime, hostPath\)/u);
  assert.match(runner, /\.\.\.conversionProbeCommandInput\(runtime, \{ commit: runIdentity\.commit, python \}\)/u);
  assert.match(runner, /env: \{ \.\.\.fixtureEnv\(project, runtime, options\.release \|\| runtime\.payloadRelease\), \.\.\.options\.env \}/u);
  assert.match(runner, /return \{ PATH: hostPath, HOME: '\/root', \.\.\.extra \}/u);
});
