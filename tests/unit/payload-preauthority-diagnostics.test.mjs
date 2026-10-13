import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  createCommandDiagnostic, extractControlErrorIdentifier, extractNativeCatalogVerifierDiagnostic,
  extractSqlState, sanitizeCommandDiagnostic,
  extractSmokeFailure, FIXTURE_SMOKE_CONTEXT, isFixtureSmokeSuccess,
} from '../../scripts/integration/payload-preauthority-diagnostics.mjs';
import { createFixtureCommandFailure, runFixtureCommand } from '../../scripts/integration/payload-preauthority-command.mjs';
import { createRecoveryFailureReportFields } from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';
import { qualifyCandidate, RECOVERY_CHECKS, RECOVERY_NEGATIVES } from '../../scripts/lib/payload-candidate-qualification.mjs';

const recoveryRunner = await readFile(new URL('../../scripts/test-payload-preauthority-recovery.mjs', import.meta.url), 'utf8');
const controlRuntime = await readFile(new URL('../../ops/payload-control-runtime.py', import.meta.url), 'utf8');
const controlState = await readFile(new URL('../../ops/payload-control-state.py', import.meta.url), 'utf8');
const controlInventory = await readFile(new URL('../../ops/payload-control-inventory.py', import.meta.url), 'utf8');
const controlEntrypoint = await readFile(new URL('../../ops/payload-control', import.meta.url), 'utf8');
const controlGuard = await readFile(new URL('../../ops/payload-operations-guard.sh', import.meta.url), 'utf8');

const smokeWire = (diagnostic={check:'root',reason:'http_status',httpStatus:503}) => JSON.stringify({check:'smoke',status:'failed',attempts:2,diagnostic})+'\n';

test('smoke failure protocol requires exact context, clean actual failure and one canonical finite record', () => {
  const context={smokeCommandContext:FIXTURE_SMOKE_CONTEXT,substep:'fixture_full_smoke',status:1,stdout:Buffer.alloc(0)};
  const wire=smokeWire();
  assert.deepEqual(extractSmokeFailure(wire,context),{check:'root',reason:'http_status',httpStatus:503});
  assert.deepEqual(extractSmokeFailure(wire.replace(/\n$/u,'\r\n'),context),extractSmokeFailure(wire,context));
  for(const override of [{smokeCommandContext:undefined},{smokeCommandContext:'docker-compose'},{substep:'unclassified_command'},{substep:undefined},{status:0},{status:2},{signal:'SIGTERM'},{errorCode:'ETIMEDOUT'},{stdout:'{"check":"smoke","status":"ok","attempt":1}\n'}]){
    assert.equal(extractSmokeFailure(wire,{...context,...override}),null);
  }
  const malformed=[wire.trimEnd(),wire+'private-url-with-credentials\n','private\n'+wire,wire+wire,
    wire.replace('"attempts":2','"attempts":2,"attempts":2'),wire.replace('"check":"root"','"check":"root","check":"root"'),
    wire.replace('"root"','"http://user:password@private.invalid"'),wire.replace('"http_status"','"private_reason"'),
    wire.replace('"httpStatus":503','"httpStatus":503,"body":"secret"'),wire+' '.repeat(513)];
  for(const text of malformed)assert.equal(extractSmokeFailure(text,context),null);
  for(const httpStatus of [99,600,-1,503.5,'503',false])assert.equal(extractSmokeFailure(smokeWire({check:'root',reason:'http_status',httpStatus}),context),null);
  assert.equal(extractSmokeFailure(smokeWire({check:'root',reason:'readiness',httpStatus:null}),context),null);
  assert.equal(extractSmokeFailure(smokeWire({check:'router_module',reason:'content',httpStatus:200}),context),null);
});

test('smoke metadata crosses the actual throwing wrapper/sanitizer only on failure; unknown output remains private', () => {
  const evidence=[];
  assert.throws(()=>runFixtureCommand(process.execPath,['-e',`process.stderr.write(${JSON.stringify(smokeWire())});process.exitCode=1`],{
    smokeCommandContext:FIXTURE_SMOKE_CONTEXT,substep:'fixture_full_smoke',failureCode:'fixture_full_smoke_failed',
    privateCommandEvidence:evidence,preservePrivateErrorEvidence:true,
  }),error=>{
    assert.deepEqual(error.diagnostic.smokeFailure,{check:'root',reason:'http_status',httpStatus:503});
    assert.deepEqual(sanitizeCommandDiagnostic(error.diagnostic),error.diagnostic);
    assert.deepEqual(createRecoveryFailureReportFields({primaryError:error}).commandDiagnostic.smokeFailure,error.diagnostic.smokeFailure);
    return true;
  });
  assert.equal(evidence.length,1);
  const privateText=smokeWire()+'http://user:password@private.invalid/path body-secret\n';
  const unknown=createFixtureCommandFailure({status:1,stderr:Buffer.from(privateText),stdout:Buffer.alloc(0)},{
    smokeCommandContext:FIXTURE_SMOKE_CONTEXT,privateCommandEvidence:evidence,preservePrivateErrorEvidence:true,
  });
  assert.equal(unknown.diagnostic.smokeFailure,undefined);
  assert.doesNotMatch(JSON.stringify(createRecoveryFailureReportFields({primaryError:unknown})),/password|private\.invalid|body-secret/u);
  assert.equal(evidence.at(-1).stderr.toString(),privateText);
  for(const command of [{commandExitCode:0},{commandExitCode:1,commandError:'command_timeout'},{commandExitCode:1,commandSignal:'SIGTERM'}]){
    assert.equal(sanitizeCommandDiagnostic({...command,smokeFailure:{check:'root',reason:'http_status',httpStatus:503}}).smokeFailure,undefined);
  }
  const success='{"check":"smoke","status":"ok","attempt":1}\n';
  assert.equal(isFixtureSmokeSuccess(success,''),true);
  for(const output of ['PASS\n',smokeWire(),success+success,success.replace('"attempt":1','"attempt":1,"attempt":1')]){
    assert.throws(()=>runFixtureCommand(process.execPath,['-e',`process.stdout.write(${JSON.stringify(output)})`],{smokeCommandContext:FIXTURE_SMOKE_CONTEXT}),{code:'fixture_smoke_protocol_invalid'});
  }
  assert.equal(isFixtureSmokeSuccess(success,smokeWire()),false);
});

test('restore smoke metadata belongs only to its consistent single failure frame, never a prior guard, timeout or private appended body', () => {
  const frame=(body=smokeWire(),step='restore_smoke',status=1)=>`PAYLOAD_COORDINATOR_STEP step=${step}\n${body}PAYLOAD_COORDINATOR_FAILURE step=${step} status=${status}\n`;
  const options={substep:'payload_coordinator_restore',status:1,coordinatorCommandContext:'payload-coordinator:restore'};
  const diagnostic=createCommandDiagnostic({...options,stderr:frame()+'private-cleanup-output\n'});
  assert.equal(diagnostic.coordinatorStep,'restore_smoke');
  assert.deepEqual(diagnostic.smokeFailure,{check:'root',reason:'http_status',httpStatus:503});
  for(const change of [
    {stderr:frame(smokeWire()+'http://user:password@private.invalid\n')},
    {stderr:frame(smokeWire()+smokeWire())},
    {stderr:frame()+ 'PAYLOAD_COORDINATOR_FAILURE step=restore_smoke status=1\n'},
    {stderr:'PAYLOAD_COORDINATOR_STEP step=restore_smoke\n'+frame()},
    {stderr:'PAYLOAD_COORDINATOR_STEP step=unknown_private_context\n'+frame()},
    {stderr:frame().replace('STEP step=restore_smoke','STEP step=restore_smoke private-message')},
    {stderr:frame()+'PAYLOAD_COORDINATOR_STEP step=restore_smoke\n'},
    {stderr:frame(smokeWire(),'guard_verify_restored')},
    {stderr:frame().replace('FAILURE step=restore_smoke','FAILURE step=resume_writers')},
    {stderr:frame(),status:2},{stderr:frame(),signal:'SIGTERM'},{stderr:frame(),errorCode:'ETIMEDOUT'},
    {stderr:frame(),coordinatorCommandContext:'payload-coordinator:backup'},
    {stderr:frame(),substep:'payload_coordinator_backup'},
  ])assert.equal(createCommandDiagnostic({...options,...change}).smokeFailure,undefined);
});

test('failure-only smoke metadata does not broaden the existing qualified success report schema (synthetic schema test, not recovery evidence)', () => {
  const run={commit:'f'.repeat(40),runId:'37997573123',runAttempt:'1'};
  const images=Object.fromEntries(['api','cron','cms'].map((service,index)=>[service,`ghcr.io/ownerinc/ownerinc-portal-${service}@sha256:${String(index+1).repeat(64)}`]));
  const ddl=new Set(['unexpected_schema','weak_native_constraint','materialized_view','migration_ledger_mismatch']);
  const report={schemaVersion:1,status:'passed',run,images,sourceInventoryIdentity:'a'.repeat(64),targetInventoryIdentity:'b'.repeat(64),
    negativeCases:RECOVERY_NEGATIVES.map(name=>({name,rejected:true,targetContentUnchanged:true,...(ddl.has(name)?{fixtureDdlCleaned:true}:{}),
      ...(name==='target_changed_after_restore_preflight'?{raceInjectedAfterLeaseReservation:true}:{})})),
    checks:Object.fromEntries(RECOVERY_CHECKS.map(name=>[name,true])),
    recoveryProgress:Object.fromEntries(['source','target','leaseTarget'].map(role=>[role,{initialCmsHealthPassed:true,writersRestartedHealthy:true,quiescentSnapshotComparison:'passed'}])),
    restoreAcceptanceProgress:Object.fromEntries(['first','second'].map(role=>[role,{coordinatorReturnedSuccessfully:true,fullSnapshotComparisonPassed:true}])),
    evidence:{kind:'redacted-metadata-only',privateFixtureRetainedForRunnerLifetime:false}};
  const input={candidateBytes:Buffer.from(JSON.stringify({schemaVersion:1,...run,images})),expectedRun:run,expectedImages:images};
  assert.doesNotThrow(()=>qualifyCandidate({...input,reportBytes:Buffer.from(JSON.stringify(report))}));
  assert.throws(()=>qualifyCandidate({...input,reportBytes:Buffer.from(JSON.stringify({...report,commandDiagnostic:{smokeFailure:{check:'root',reason:'http_status',httpStatus:503}}}))}),/invalid_recovery_report_shape/u);
  assert.deepEqual(createRecoveryFailureReportFields({}),{});
});

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
  sourceCodes.add('native_catalog_verifier_launch_failed');
  sourceCodes.add('native_catalog_verifier_execution_failed');
  sourceCodes.add('admission_state_not_open');
  sourceCodes.add('admission_state_not_closed');
  for (const identifier of ['state_head_corrupt', 'proof_not_canonical', 'proof_shape_invalid']) {
    assert.ok(controlState.includes(`'${identifier}'`), `expected state helper to emit ${identifier}`);
    sourceCodes.add(identifier);
  }
  for (const identifier of sourceCodes) {
    if (['initializer_command_failed', 'initializer_command_launch_failed', 'initializer_command_signaled'].includes(identifier)) {
      assert.equal(extractControlErrorIdentifier(`${identifier}\n`, context), null,
        'initializer-only command reasons must not be parsed from a preflight/verify invocation');
      assert.equal(sanitizeCommandDiagnostic({ controlErrorIdentifier: identifier }).controlErrorIdentifier, identifier,
        `fixed initializer reason ${identifier} must survive redacted report sanitization`);
      continue;
    }
    assert.equal(extractControlErrorIdentifier(`${identifier}\n`, context), identifier,
      `fixed adapter reason ${identifier} must be in the explicit finite allowlist`);
  }
});

test('ownership diagnostics are source-grounded finite codes with exact context and no private detail', () => {
  const identifiers = [
    'invalid_environment_file_owner', 'environment_unavailable',
    'unsafe_environment_file', 'unsafe_environment_permissions', 'unsafe_environment_owner',
    'unsafe_environment_ancestry', 'unsafe_inventory_ancestry',
  ];
  const directReasons = new Set([...controlInventory.matchAll(/fail\('([a-z][a-z0-9_]+)'\)/gu)]
    .map(match => match[1]));
  const ancestryReasons = new Set([...controlInventory.matchAll(
    /_verify_ancestry\([^\r\n]+, '([a-z][a-z0-9_]+)'\)/gu,
  )].map(match => match[1]));
  assert.match(controlInventory, /def _verify_ancestry\(path, trusted_uids, reason\):[\s\S]*?fail\(reason\)/u);
  assert.match(controlRuntime, /INVENTORY\.verify_environment_file\(/u);
  assert.match(controlRuntime, /except INVENTORY\.InventoryError as error:\s+fail\(str\(error\)\)/u);
  for (const identifier of identifiers) {
    assert.ok(directReasons.has(identifier) || ancestryReasons.has(identifier),
      `${identifier} must be an actual fixed reason emitted by the inventory helper`);
    for (const context of ['payload-control:release-preflight', 'payload-control:verify-release', 'payload-operations-guard']) {
      const options = { controlCommandContext: context };
      assert.equal(extractControlErrorIdentifier(`${identifier}\n`, options), identifier);
      assert.equal(createCommandDiagnostic({
        substep: 'ownership_preflight', status: 2, stderr: Buffer.from(`${identifier}\r\n`), ...options,
      }).controlErrorIdentifier, identifier);
      for (const stderr of [
        identifier,
        `${identifier} private-owner-detail\n`,
        `${identifier}\nprivate-owner-detail\n`,
        `private-owner-detail\n${identifier}\n`,
        'unsafe_environment_attacker_value\n',
      ]) {
        const diagnostic = createCommandDiagnostic({ substep: 'ownership_preflight', status: 2, stderr, ...options });
        assert.equal(diagnostic.controlErrorIdentifier, null);
        assert.doesNotMatch(JSON.stringify(diagnostic), /private-owner-detail|attacker_value/u);
      }
    }
    for (const context of [undefined, 'docker-compose', 'payload-control:backup-metadata', 'logical-snapshot-cli']) {
      assert.equal(extractControlErrorIdentifier(`${identifier}\n`, { controlCommandContext: context }), null,
        'a known ownership reason cannot authorize an unknown command context');
    }
    assert.equal(sanitizeCommandDiagnostic({ controlErrorIdentifier: identifier }).controlErrorIdentifier, identifier);
  }
  assert.equal(sanitizeCommandDiagnostic({
    controlErrorIdentifier: 'unsafe_environment_attacker_value',
  }).controlErrorIdentifier, null, 'sanitization must not accept a reason just because it matches the identifier pattern');
});

test('native catalog verifier metadata distinguishes rejection, launch failure, and opaque process failure', async t => {
  const context = { controlCommandContext: 'payload-control:verify-release' };
  const tempRoot = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const fixture = await mkdtemp(path.join(tempRoot, 'payload-report-release-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const release = path.join(fixture, 'releases', 'payload-candidate');
  await Promise.all([
    mkdir(path.join(release, 'cms', 'src', 'migrations'), { recursive: true }),
    mkdir(path.join(release, 'cms', 'scripts'), { recursive: true }),
  ]);
  await Promise.all([
    cp(new URL('../../cms/src/migrations/20261006_181424_z_owner_news_native.json', import.meta.url),
      path.join(release, 'cms', 'src', 'migrations', '20261006_181424_z_owner_news_native.json')),
    cp(new URL('../../cms/scripts/finalize-news-protocol.ts', import.meta.url),
      path.join(release, 'cms', 'scripts', 'finalize-news-protocol.ts')),
    writeFile(path.join(release, '.image-env'), [
      `API_IMAGE=ghcr.io/ownerinc/ownerinc-portal-api@sha256:${'a'.repeat(64)}`,
      `CRON_IMAGE=ghcr.io/ownerinc/ownerinc-portal-cron@sha256:${'b'.repeat(64)}`,
      `CMS_IMAGE=ghcr.io/ownerinc/ownerinc-portal-cms@sha256:${'c'.repeat(64)}`,
      'RELEASE_FORMAT=payload-v1', '',
    ].join('\n')),
  ]);
  const rejected = 'native_catalog_verification_failed\n'
    + 'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=native_constraints reason=preauthority_native_constraint_inventory_mismatch sqlstate=none\n'
    + 'PREAUTHORITY_CONSTRAINT_DIAGNOSTIC category=check_definition table=news_migration_runs '
    + 'constraint=news_migration_runs_manifest_sha256_check expectedCount=119 observedCount=119 '
    + `expectedSha256=${'a'.repeat(64)} observedSha256=${'b'.repeat(64)}\n`;
  const rejectionDiagnostic = createCommandDiagnostic({
    substep: 'payload_control_verify_release', status: 2, stderr: rejected, controlCommandContext: context.controlCommandContext,
    release,
  });
  assert.equal(rejectionDiagnostic.controlErrorIdentifier, 'native_catalog_verification_failed');
  assert.deepEqual(rejectionDiagnostic.nativeCatalogVerifier, {
    stage: 'native_constraints', reason: 'preauthority_native_constraint_inventory_mismatch', sqlState: null,
    constraintMismatch: {
      category: 'check_definition', table: 'news_migration_runs',
      constraint: 'news_migration_runs_manifest_sha256_check', expectedCount: 119, observedCount: 119,
      expectedDefinitionSha256: 'a'.repeat(64), observedDefinitionSha256: 'b'.repeat(64),
    },
  });
  const forgedReport = sanitizeCommandDiagnostic({
    substep: 'payload_control_verify_release',
    nativeCatalogVerifier: {
      stage: 'native_constraints', reason: 'preauthority_native_constraint_inventory_mismatch', sqlState: null,
      constraintMismatch: {
        category: 'check_definition', table: 'news_migration_runs',
        constraint: 'private_customer_email', expectedCount: 119, observedCount: 119,
        expectedDefinitionSha256: 'a'.repeat(64), observedDefinitionSha256: 'b'.repeat(64),
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(forgedReport), /private_customer_email/u,
    'report sanitization cannot accept caller-supplied identity strings without release validation');
  assert.equal(extractNativeCatalogVerifierDiagnostic(rejected, context), null,
    'constraint identity is not authorized from the report generator checkout when no selected release is supplied');

  const postgresFailure = 'native_catalog_verification_failed\r\n'
    + 'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=native_columns reason=postgres_error sqlstate=42703\r\n';
  assert.deepEqual(extractNativeCatalogVerifierDiagnostic(Buffer.from(postgresFailure), { ...context, release }), {
    stage: 'native_columns', reason: 'postgres_error', sqlState: '42703',
  });
  const ownershipFailure = 'native_catalog_verification_failed\n'
    + 'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=protocol_control_ownership '
    + 'reason=unsafe_preinstallation_control_state sqlstate=none\n';
  assert.deepEqual(extractNativeCatalogVerifierDiagnostic(ownershipFailure, { ...context, release }), {
    stage: 'protocol_control_ownership', reason: 'unsafe_preinstallation_control_state', sqlState: null,
  });
  const installedProtocol = 'native_catalog_verification_failed\n'
    + 'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=protocol_inventory '
    + 'reason=diagnostic_installed_protocol_deep_check_skipped sqlstate=none\n';
  assert.deepEqual(extractNativeCatalogVerifierDiagnostic(installedProtocol, { ...context, release }), {
    stage: 'protocol_inventory', reason: 'diagnostic_installed_protocol_deep_check_skipped', sqlState: null,
  });

  const launchFailure = 'native_catalog_verifier_launch_failed\n'
    + 'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=launch reason=executable_not_found sqlstate=none\n';
  assert.equal(extractControlErrorIdentifier(launchFailure, context), 'native_catalog_verifier_launch_failed');
  assert.deepEqual(createCommandDiagnostic({
    substep: 'payload_control_verify_release', status: 2, stderr: launchFailure,
    controlCommandContext: context.controlCommandContext, release,
  }).nativeCatalogVerifier, { stage: 'launch', reason: 'executable_not_found', sqlState: null });

  const opaqueProcessFailure = 'native_catalog_verifier_execution_failed\n'
    + 'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=process reason=process_exit_without_diagnostic sqlstate=none\n';
  assert.equal(extractControlErrorIdentifier(opaqueProcessFailure, context), 'native_catalog_verifier_execution_failed');

  for (const text of [
    `${rejected.trimEnd()}\npostgres://private-user:secret@host/database\n`,
    'native_catalog_verification_failed\nPREAUTHORITY_CATALOG_DIAGNOSTIC stage=native_constraints reason=unknown_internal_error sqlstate=none\n',
    'native_catalog_verification_failed\nPREAUTHORITY_CATALOG_DIAGNOSTIC stage=native_constraints reason=postgres_error sqlstate=secret\n',
    'native_catalog_verification_failed\n'
      + 'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=native_constraints reason=preauthority_native_constraint_inventory_mismatch sqlstate=none\n'
      + 'PREAUTHORITY_CONSTRAINT_DIAGNOSTIC category=check_definition table=fixture_table constraint=fixture_check '
      + `expectedCount=119 observedCount=119 expectedSha256=${'a'.repeat(64)} observedSha256=${'b'.repeat(64)}\n`,
    'native_catalog_verifier_launch_failed\nPREAUTHORITY_CATALOG_DIAGNOSTIC stage=launch reason=permission_denied sqlstate=23514\n',
    'native_catalog_verification_failed\nPREAUTHORITY_CATALOG_DIAGNOSTIC stage=process reason=process_exit_without_diagnostic sqlstate=none\n',
  ]) {
    assert.equal(extractNativeCatalogVerifierDiagnostic(text, { ...context, release }), null,
      'malformed, mismatched, or secret-bearing metadata remains unclassified');
  }
  assert.equal(extractNativeCatalogVerifierDiagnostic(rejected, {
    controlCommandContext: 'payload-control:backup-metadata',
  }), null, 'native catalog metadata is parsed only for explicit control invocations');
  assert.doesNotMatch(JSON.stringify(rejectionDiagnostic), /postgres:|private-user|secret/u);
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
