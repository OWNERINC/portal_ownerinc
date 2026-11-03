import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const required = process.env.PAYLOAD_REQUIRE_NATIVE_RECOVERY === '1';
const reportDirectory = path.resolve('recovery-ci-reports');
const nativeNames = ['admin-commit', 'admin-head', 'admin-upload', 'admin-expiry', 'postgres', 'application', 'admin-credential', 'witness'];
const deadlineKeys = ['RECOVERY_CI_STARTED_MS', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
function nativeRun(command, args, cap, minimum, extra = {}) {
  const env = { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C', LC_ALL: 'C',
    PAYLOAD_REQUIRE_NATIVE_RECOVERY: '1', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    ...Object.fromEntries(deadlineKeys.map(key => [key, process.env[key]])), ...extra };
  // The Linux subreaper owns deadline, process-group termination and adopted
  // descendants. The outer job supervisor bounds this foreground wait too.
  return spawnSync('/usr/bin/python3', ['-I', '-S', '-B', 'tests/fixtures/payload-production-recovery-ci.py',
    '--supervise', String(cap), String(minimum), '--', command, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
}

function requireTrue(value, fields) {
  for (const field of fields) assert.equal(value[field], true, `missing native proof: ${field}`);
}

function validateReport(name, value) {
  assert.equal(value.exactProductionB0Qualified, false);
  assert.equal(value.liveRecoveryExecuted, false);
  requireTrue(value.cleanup, ['verified', 'privateWorkspaceRemoved']);
  for (const field of ['ownedResourcesRemoved', 'childProcessesReaped']) {
    assert.ok(Number.isSafeInteger(value.cleanup[field]) && value.cleanup[field] >= 0, `cleanup count ${field}`);
  }
  if (name.startsWith('admin-')) {
    assert.equal(value.kind, 'authenticated-recovery-admin-ci-v1');
    assert.equal(value.case, name.slice(6));
    assert.equal(value.terminal, name === 'admin-expiry' ? 'protection_verified_expired_held' : 'legacy_ready_held');
    requireTrue(value, ['actualAdminCli', 'actualProvisionerCli', 'actualProtectedClosure', 'actualLeaseFd9',
      'actualHmacJournal', 'freshProcesses', 'replacedLeaseRejected', 'wrongReceiptRejected',
      'expiryBeforeReservationRejected', 'protectedSourceTamperRejected', 'dockerPostgresApplicationWitnessDoubles']);
    assert.equal(value.productionHostCompositionQualified, false);
    assert.equal(value.actualApiCredentialRefresh, name === 'admin-credential');
    assert.equal(value.credentialRenameGapReconciled, name === 'admin-credential');
    assert.ok(Object.keys(value.sourceClosure.capturedFiles).length > 10);
    assert.deepEqual(Object.keys(value.sourceClosure.capturedFiles).sort(), Object.keys(value.sourceClosure.sourceFiles).sort());
  } else if (name === 'postgres') {
    assert.equal(value.kind, 'production-recovery-pg-ci-v1');
    assert.equal(value.postgresMajor, 16);
    requireTrue(value, ['realDatabaseRestore', 'realCommitGapReconciled', 'compatiblePasswordAuthentication',
      'realKilledRestoreReconciled', 'preparedTransactionRefused', 'cmsAndUnrelatedDatabasePreserved']);
    requireTrue(value, ['unsupportedPublicationRefusedBeforeRestore']);
    assert.equal(value.unsupportedPublicationRestoreCount, 0);
    requireTrue(value, ['deletedNativeUuidHistoryRefused', 'freshUninitializedPositive']);
    assert.deepEqual(value.nativeHistoryEffects, { reservation: 0, capture: 0, restore: 0 });
    assert.equal(value.restoreCount, 1);
    for (const key of ['productionAdmissionQualified', 'externalWitnessTransportQualified', 'previousApplicationQualified']) assert.equal(value[key], false);
    assert.ok(value.cleanup.ownedResourcesRemoved >= 1);
  } else if (name === 'application') {
    assert.equal(value.kind, 'historical-recovery-app-ci-v1');
    requireTrue(value, ['actualHistoricalImages', 'fixedDbProbe', 'fixedApiProbe', 'actualPrivateCreateReceiptStart',
      'authenticatedReader', 'readOnlyUploads', 'cronBootstrapOnly', 'internalNetworks']);
    requireTrue(value, ['realApiAuthenticatedCredentialRefresh', 'realForeignMountAndNamespaceRejected', 'realReadOnlyBindVolumeAliasRejected']);
    requireTrue(value, ['ownedMountCleanupVerified']);
    assert.equal(value.hostBindAliasEffects, 0);
    assert.deepEqual(value.actualResourcesHostBindAliases, [
      { descendant: false, readOnly: false, running: true }, { descendant: true, readOnly: false, running: true },
      { descendant: false, readOnly: true, running: true }, { descendant: true, readOnly: true, running: false },
    ]);
    assert.deepEqual(value.effectiveRetainedBinds, [
      { hostRebound: false, readOnly: false, network: 'none' },
      { hostRebound: false, readOnly: true, network: 'none' },
      { hostRebound: true, readOnly: true, network: 'none' },
    ]);
    assert.deepEqual(value.mountAttachCrashCleanup, ['normal', 'emergency']);
    requireTrue(value, ['replacementMountRefused']);
    assert.deepEqual(value.replacementCleanupRefusals, ['normal', 'emergency']);
    assert.match(value.mountApiSourceSha256, /^[a-f0-9]{64}$/u);
    assert.equal(value.reentryCreateCount, 2);
    assert.deepEqual(value.negativePasswords, ['api-password', 'cron-password', 'invalid-signature']);
    assert.equal(value.selectedObservedBaseline, 'b573a3d900c823a700c167878717bb7534bef500');
    assert.equal(value.supersededDocumentedBaseline, 'ce324b1b3d36fafb98270c9dfd8e62fed87d67a3');
    assert.equal(value.firebaseVerification, 'real-admin-sdk-with-local-signed-https-peer');
    for (const key of ['realFirebaseQualified', 'productionAdmissionQualified', 'scheduledWorkerQualified']) assert.equal(value[key], false);
    assert.ok(value.cleanup.ownedResourcesRemoved >= 8);
    for (const service of ['api', 'cron']) {
      const image = value.historicalInputs[service];
      assert.equal(image.sourceCommit, value.selectedObservedBaseline);
      assert.match(image.localImageId, /^sha256:[a-f0-9]{64}$/u);
      for (const field of ['sourceArchiveSha256', 'dockerfileSha256', 'lockSha256']) assert.match(image[field], /^[a-f0-9]{64}$/u);
      assert.match(image.baseImage, /^node:24\.12\.0-alpine3\.23@sha256:[a-f0-9]{64}$/u);
      assert.equal(image.published, false);
    }
  } else if (name === 'witness') {
    assert.equal(value.kind, 'recovery-forced-ssh-ci-v1');
    requireTrue(value, ['actualOpenSsh', 'actualHttps', 'actualForcedHelper', 'callerCommandRejected']);
    assert.deepEqual(value.negatives, ['replay', 'mismatch', 'overflow', 'wrong-host-key', 'profile-mismatch',
      'upstream-502', 'body-mismatch', 'redirect', 'transport-failure']);
    assert.equal(value.externalProductionClosureQualified, false);
    assert.equal(value.scope, 'loopback-transport-only');
    assert.ok(value.cleanup.childProcessesReaped >= 1);
  } else assert.fail('unrecognized report');
  if (value.sourceClosure) {
    assert.ok(value.sourceClosure.adaptations.length >= 2);
    for (const [key, item] of Object.entries(value.sourceClosure)) {
      if (key.endsWith('Sha256')) assert.match(item, /^[a-f0-9]{64}$/u);
      if (key.endsWith('Files')) for (const digest of Object.values(item)) assert.match(digest, /^[a-f0-9]{64}$/u);
    }
  }
  // Reports are metadata only. Reject a future accidental private-artifact field.
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /PRIVATE KEY|postgres(?:ql)?:\/\/|Bearer |\/root\/|"(?:password|token|privateKey|environment)"\s*:/iu);
}

test('production recovery signed contracts, closed witness, database reconciliation and native storage interruptions', t => {
  const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
    .find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
  if (!python) {
    assert.equal(required, false, 'Python is mandatory for native qualification');
    return t.skip('Python 3 unavailable');
  }
  const result = required ? nativeRun('/usr/bin/python3', ['-B', 'tests/fixtures/payload-production-recovery.py'], 120, 30) : spawnSync(python, ['-B', 'tests/fixtures/payload-production-recovery.py'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...(process.platform === 'win32' && process.env.LOCALAPPDATA
      ? { TMP: path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode'), TEMP: path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') } : {}) },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  if (required) {
    assert.equal(process.platform, 'linux');
    assert.equal(process.getuid(), 0);
    assert.doesNotMatch(result.stderr, /skipped|skip=/iu);
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(path.join(reportDirectory, 'storage.json'), JSON.stringify({ nativeLinuxStorage: true, skipped: 0 }) + '\n');
  }
  t.diagnostic(result.stderr.trim());
});

test('native ADMIN, PostgreSQL, historical application and forced-witness qualification', { skip: !required }, () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0);
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  const proof = nativeRun('/usr/bin/python3', ['-I', '-S', '-B', 'tests/fixtures/payload-production-recovery-ci.py', '--process-proof'], 30, 10);
  assert.equal(proof.status, 0, 'detached process supervision failed');
  assert.deepEqual(JSON.parse(proof.stdout), { ownedDetachedDescendantsReaped: true, idleAndCrashedWork: true });
  const preparation = nativeRun(process.execPath, ['--test', '--test-reporter=tap',
    'tests/unit/payload-preparation-authentication.test.mjs'], 420, 60, { PAYLOAD_REQUIRE_NATIVE_PREPARATION: '1' });
  assert.equal(preparation.error?.code, undefined, 'native preparation supervisor timed out');
  assert.equal(preparation.status, 0, 'native preparation process checks failed (private diagnostics withheld)');
  assert.match(preparation.stdout, /# skipped 0\b/u, 'native preparation must not skip');
  assert.match(preparation.stdout, /# fail 0\b/u);
  writeFileSync(path.join(reportDirectory, 'preparation-processes.json'), JSON.stringify({
    actualNativePreparation: true, subprocessTimeoutAndGrandchildCleanup: true, detachedIdleAndCrashedWorkReaped: true, skipped: 0,
  }) + '\n');
  for (const name of nativeNames) {
    if (name === 'admin-credential') {
      // Created by the application fixture while its real private API is alive.
      validateReport(name, JSON.parse(readFileSync(path.join(reportDirectory, `${name}.json`), 'utf8')));
      continue;
    }
    const fixture = name.startsWith('admin-') ? 'admin' : name === 'application' ? 'app' : name === 'postgres' ? 'pg' : name;
    const args = ['-I', '-S', '-B', `tests/fixtures/payload-production-recovery-${fixture}.py`,
      ...(name.startsWith('admin-') ? [name.slice(6)] : [])];
    const result = nativeRun('/usr/bin/python3', args, fixture === 'app' ? 1200 : 360, fixture === 'app' ? 300 : 30);
    // Fixture tracebacks can contain generated private values. Expose only status.
    assert.equal(result.error?.code, undefined, `${name} process supervision failed`);
    assert.equal(result.status, 0, `${name} failed (private diagnostic output withheld)`);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(receipt, { fixture: name, passed: true, cleanupVerified: true });
    const filename = path.join(reportDirectory, `${name}.json`);
    assert.ok(existsSync(filename), `${name} report missing`);
    validateReport(name, JSON.parse(readFileSync(filename, 'utf8')));
  }
  assert.deepEqual(readdirSync(reportDirectory).sort(), [...nativeNames, 'storage', 'preparation-processes'].map(name => `${name}.json`).sort());
  assert.deepEqual(JSON.parse(readFileSync(path.join(reportDirectory, 'storage.json'), 'utf8')), { nativeLinuxStorage: true, skipped: 0 });
  writeFileSync(path.join(reportDirectory, 'qualification-report.json'), JSON.stringify({
    kind: 'production-recovery-native-components-v1', requiredFixtures: nativeNames,
    nativeComponentsQualified: true, nativePreparationProcessesQualified: true, skipped: 0, cleanupVerified: true,
    productionHostCompositionQualified: false, realFirebaseQualified: false,
    externalProductionClosureQualified: false, exactProductionB0Qualified: false, liveRecoveryExecuted: false,
  }, null, 2) + '\n');
});

test('native report contract refuses missing proof, cleanup failure and inflated production claims', () => {
  const report = { kind: 'recovery-forced-ssh-ci-v1', actualOpenSsh: true, actualHttps: true,
    actualForcedHelper: true, callerCommandRejected: true,
    negatives: ['replay', 'mismatch', 'overflow', 'wrong-host-key', 'profile-mismatch', 'upstream-502', 'body-mismatch', 'redirect', 'transport-failure'],
    externalProductionClosureQualified: false, scope: 'loopback-transport-only',
    exactProductionB0Qualified: false, liveRecoveryExecuted: false,
    cleanup: { verified: true, privateWorkspaceRemoved: true, ownedResourcesRemoved: 0, childProcessesReaped: 1 } };
  validateReport('witness', report);
  for (const field of ['actualOpenSsh', 'actualHttps', 'actualForcedHelper', 'callerCommandRejected']) {
    const missing = structuredClone(report); delete missing[field];
    assert.throws(() => validateReport('witness', missing));
  }
  for (const field of ['externalProductionClosureQualified', 'exactProductionB0Qualified', 'liveRecoveryExecuted']) {
    assert.throws(() => validateReport('witness', { ...report, [field]: true }));
  }
  assert.throws(() => validateReport('witness', { ...report, cleanup: { ...report.cleanup, verified: false } }));
  assert.throws(() => validateReport('witness', { ...report, negatives: report.negatives.slice(1) }));
  assert.throws(() => validateReport('witness', { ...report, token: 'sensitive' }));
});

test('native fixture adaptations compile and production environment guards remain intact offline', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', String.raw`
import ast,builtins,importlib.util,pathlib,sys,tempfile
root=pathlib.Path('.')
for path in (root/'tests/fixtures').glob('payload-production-recovery*.py'):
 tree=ast.parse(path.read_bytes(),str(path));compile(tree,str(path),'exec')
 if path.name.endswith('-admin.py'):
  adapter=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ADAPTER' for t in n.targets))
  compile(adapter.replace('__FIXTURE_ROOT__',repr('/root/recovery-ci-admin-fixture')),'authenticated-adapter','exec')
runtime=(root/'ops/payload-production-b0-recovery.py').read_text()
assert "values.get('NODE_ENV') == 'production'" in runtime
assert "values.get('FIREBASE_AUTH_EMULATOR_HOST','') == ''" in runtime
assert "'--single-transaction','--clean','--if-exists','--exit-on-error'" in runtime
ci=(root/'tests/fixtures/payload-production-recovery-ci.py').read_text()
tree=ast.parse(ci)
functions={n.name:n for n in tree.body if isinstance(n,ast.FunctionDef)}
# Exercise the fail-closed entry guard with no Linux services or imports of fixtures.
scope={'sys':type('Platform',(),{'platform':'win32'})()}
exec(compile(ast.Module(body=[functions['guard']],type_ignores=[]),'guard','exec'),scope)
try:scope['guard']()
except RuntimeError:pass
else:raise AssertionError('non-disposable host accepted')
# Build the actual mount-acquisition/cleanup child strings without executing
# any child, native API, compiler or service. AST-selected assignments preserve
# the fixture's real quoting and generated Python, including crash injection.
app=ast.parse((root/'tests/fixtures/payload-production-recovery-app.py').read_bytes())
main=next(n for n in app.body if isinstance(n,ast.FunctionDef) and n.name=='main')
assignments={t.id:n for n in ast.walk(main) if isinstance(n,ast.Assign) for t in n.targets if isinstance(t,ast.Name)}
scope={'ci_path':'/fixture/ci.py','gap':type('Owner',(),{'root':pathlib.Path('/fixture/gap')})(),
 'replacement':type('Owner',(),{'root':pathlib.Path('/fixture/replacement')})(),'mount':pathlib.Path('/fixture/source')}
for name in ('prefix','code','cleanup_code','replacement_code'):
 exec(compile(ast.Module(body=[assignments[name]],type_ignores=[]),'construct-mount-child','exec'),scope)
 compile(scope[name],name,'exec')
# Compile the actually generated authenticated closure, including its injected
# rename/receipt fault, without executing a native setup, service or subprocess.
path=root/'tests/fixtures/payload-production-recovery-admin.py'
spec=importlib.util.spec_from_file_location('offline_admin_construction',path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Constructed(Exception):pass
with tempfile.TemporaryDirectory(prefix='recovery-construction-') as directory:
 class Owner:
  def __init__(self,*args):self.root=pathlib.Path(directory)
  def cleanup(self):return {'verified':True}
 module.C.Owned=Owner
 def forbidden(*args,**kwargs):raise AssertionError('offline construction attempted a subprocess')
 module.C.run=forbidden
 source_text=[]
 def capture_compile(source,filename,mode):
  source_text.append(source)
  return builtins.compile(source,filename,mode)
 def capture_exec(code,scope):
  builtins.compile((root/'ops/payload-production-b0-recovery.py').read_bytes()+scope['fixture_adapter'],'constructed-recovery','exec')
  tree=ast.parse(source_text[-1])
  index=next(i for i,n in enumerate(tree.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='_credential_source' for t in n.targets))
  subset=ast.Module(body=tree.body[index:index+3],type_ignores=[])
  captured={'captured':{'ops/provision-payload-candidate-trust.py':(root/'ops/provision-payload-candidate-trust.py').read_bytes()}}
  builtins.exec(builtins.compile(subset,'construct-credential-fault','exec'),captured)
  builtins.compile(captured['captured']['ops/provision-payload-candidate-trust.py'],'constructed-provisioner','exec')
  raise Constructed()
 module.compile=capture_compile;module.exec=capture_exec
 original=sys.argv;sys.argv=['fixture','commit']
 try:
  try:module.main()
  except Constructed:pass
  else:raise AssertionError('native setup unexpectedly ran')
 finally:sys.argv=original
`], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
