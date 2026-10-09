import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
  .find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
async function fixture(t, body) {
  if (!python) return t.skip('Python 3 unavailable');
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const directory = await mkdtemp(path.join(parent, 'payload-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = String.raw`
import copy, hashlib, importlib.util, json, os, sys
from unittest.mock import patch
from types import SimpleNamespace
repo, directory = sys.argv[1:]
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(repo, 'ops', file))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
S = load('install_state', 'payload-control-state.py')
R = load('install_runtime', 'payload-control-runtime.py')
def expect(code, callback):
    try: callback()
    except (S.StateError, R.ControlError) as error:
        assert str(error) == code, (str(error), code)
    else: raise AssertionError('expected ' + code)
images = {name: 'ghcr.io/ownerinc/ownerinc-portal-' + name + '@sha256:' + letter * 64
          for name, letter in [('api','a'),('cron','b'),('cms','c')]}
previous = {name: images[name].replace(letter * 64, 'd' * 64)
            for name, letter in [('api','a'),('cron','b')]}
portal = {'systemIdentifier':'123456', 'databaseOid':'16384', 'databaseName':'portal'}
cms = {'systemIdentifier':'987654', 'databaseOid':'16385', 'databaseName':'ownerinc_cms'}
def volume(name): return {'name':name, 'driver':'local', 'mountpoint':os.path.join(directory,'volumes',name),
                         'fingerprint':hashlib.sha256(name.encode()).hexdigest()}
candidate = {'commit':'a' * 40, 'runId':'123', 'runAttempt':'1', 'images':images,
             'candidateSha256':'1' * 64, 'reportSha256':'2' * 64,
             'qualificationSha256':'3' * 64, 'bundleSha256':'4' * 64}
binding = {'candidate':candidate, 'candidateRelease':os.path.join(directory,'releases','a' * 40),
           'sourceRelease':os.path.join(directory,'releases','b' * 40), 'previousImages':previous,
           'b0':{'directory':os.path.join(directory,'backup','b0'), 'proofSha256':'5' * 64},
           'inventoryIdentity':'6' * 64, 'lease':{'device':1,'inode':2},
           'portalTarget':{'database':portal,'volumes':{name:volume(name) for name in ['portalPostgres','portalUploads']}}}
cms_target = {'database':cms,'volumes':{name:volume(name) for name in ['cmsPostgres','cmsUploads']}}
proof = {'schemaVersion':1,'kind':'preauthority-legacy-source','phase':'preauthority',
         'authority':{'mode':'legacy','epoch':1},'protocol':{'status':'absent','coverage':'not-applicable'},
         'inventoryIdentity':binding['inventoryIdentity'],'images':previous,'targetImages':images,
         'source':{'portal':portal,'cms':None},
         'migrations':{'portal':{'versions':S.PORTAL_MIGRATIONS,
                        'fingerprint':hashlib.sha256(S.canonical(S.PORTAL_MIGRATIONS)).hexdigest()},
                       'cms':None,'nativeCatalogFingerprint':None},
         'dataFingerprints':{'portalDatabase':'7' * 64,'portalUploads':'8' * 64,'cmsDatabase':None,'cmsUploads':None},
         'artifacts':[{'name':name,'sha256':'9' * 64,'size':1} for name in S.LEGACY_ARTIFACTS],
         'createdAtUtc':'2026-10-09T12:00:00Z'}
def fresh(label):
    root = os.path.join(directory,label)
    os.mkdir(root,0o700)
    S.initialize(root,binding['inventoryIdentity'])
    S.transition(root,lambda value: value.update({'admission':'closed','plannedReleaseImages':images,
        'latestProofSha256':binding['b0']['proofSha256'],'legacySourceProofSha256':binding['b0']['proofSha256']}))
    return root
` + body;
  const result = spawnSync(python, ['-B', '-c', source, path.resolve('.'), directory], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('signed installation milestones survive restart and exact retry without clearing evidence or enabling writers', async t => {
  await fixture(t, String.raw`
root = fresh('milestones')
S.reserve_install(root,binding,proof,binding['b0']['proofSha256'])
assert S.read_state(root)[2]['installIntent']['stage'] == 'reserved'
stages = ['portal_grants_pending','portal_grants_verified','cms_resources_pending','cms_resources_bound',
          'cms_provision_pending','provisioned']
for stage in stages:
    S.advance_install(root,binding,stage,cms_target if stage == 'cms_resources_bound' else None)
    # New module/process view of the signed journal, not an in-memory enum test.
    restarted = load('restarted_' + stage,'payload-control-state.py')
    state = restarted.read_state(root)[2]
    assert state['installIntent']['stage'] == stage
    before = state['sequence']
    S.advance_install(root,binding,stage,cms_target if stage == 'cms_resources_bound' else None)
    assert S.read_state(root)[2]['sequence'] == before, 'matching retry must be idempotent'
    assert state['admission'] == 'closed' and state['workerHold'] is True
    assert state['restoreIntent'] is None and state['legacySourceProofSha256'] == '5' * 64
    assert state['authority'] == {'mode':'legacy','epoch':1}
assert S.read_state(root)[2]['cmsStatus'] == 'provisioned'
expect('invalid_cold_state',lambda: S.advance_install(root,binding,'floor_committed'))
`);
});

test('install reservation and retry reject mismatched candidate/B0/physical target/lease and invalid stage ordering', async t => {
  await fixture(t, String.raw`
root = fresh('negative')
for field, replacement in [('targetImages',{**images,'cms':images['cms'].replace('c' * 64,'f' * 64)}),
                            ('images',{**previous,'api':images['api']}),('inventoryIdentity','0' * 64)]:
    wrong = copy.deepcopy(proof); wrong[field] = replacement
    expect('preauthority_source_recovery_proof_mismatch',lambda: S.reserve_install(root,binding,wrong,'5' * 64))
expect('preauthority_source_recovery_proof_mismatch',lambda: S.reserve_install(root,binding,proof,'0' * 64))
S.reserve_install(root,binding,proof,'5' * 64)
before = S.read_state(root)[2]
for mutate in [lambda b:b['candidate'].update({'runAttempt':'2'}),
               lambda b:b['candidate'].update({'reportSha256':'f' * 64}),
               lambda b:b['candidate']['images'].update({'api':images['api'].replace('a' * 64,'e' * 64)}),
               lambda b:b['lease'].update({'inode':3}),
               lambda b:b.update({'sourceRelease':os.path.join(directory,'releases','c' * 40)}),
               lambda b:b['portalTarget']['database'].update({'databaseOid':'16386'}),
               lambda b:b['portalTarget']['volumes']['portalUploads'].update({'fingerprint':'e' * 64})]:
    wrong = copy.deepcopy(binding); mutate(wrong)
    expect('planned_release_mismatch',lambda: S.advance_install(root,wrong,'portal_grants_pending'))
expect('invalid_cold_state',lambda: S.advance_install(root,binding,'provisioned'))
assert S.read_state(root)[2] == before
wrong = copy.deepcopy(binding); wrong['candidate']['ownerOverride'] = True
expect('invalid_cold_state',lambda: S.validate_install_binding(wrong))
for value in [True,0,'01','attacker']:
    wrong = copy.deepcopy(binding); wrong['candidate']['runAttempt'] = value
    expect('invalid_cold_state',lambda: S.validate_install_binding(wrong))
`);
});

test('journal v1 migration is explicit, signed and limited to safe unplanned cold state', async t => {
  await fixture(t, String.raw`
root = os.path.join(directory,'v1'); os.mkdir(root,0o700)
S.initialize(root,'6' * 64)
key,state_dir,body,_ = S.read_state(root)
body['schemaVersion'] = 1; del body['installIntent']
raw = S.canonical(S.sign_envelope(body,key)) + b'\n'
for name in [S._journal_name(0),'current.json']:
    with open(os.path.join(state_dir,name),'wb') as stream: stream.write(raw)
assert S.read_state(root)[2]['schemaVersion'] == 1
upgraded = S.upgrade_install_schema(root)
assert upgraded['schemaVersion'] == 2 and upgraded['sequence'] == 1 and upgraded['installIntent'] is None
assert S._key_for(root) == key
assert S.read_state(root)[2] == upgraded
for changes in [{'plannedReleaseImages':images},{'legacySourceProofSha256':'5' * 64},
                {'latestProofSha256':'5' * 64},{'rollbackTargetImages':previous}]:
    old = copy.deepcopy(body); old.update(changes)
    S.validate_state_body(old)
    with patch.object(S,'read_state',lambda _root:(key,state_dir,old,'a' * 64)):
        expect('invalid_cold_state',lambda: S.upgrade_install_schema(root))
`);
});

test('failure before/after every signed append resumes only the unique valid child head window', async t => {
  await fixture(t, String.raw`
root = fresh('crash')
S.reserve_install(root,binding,proof,'5' * 64)
for stage in S.INSTALL_STAGES[1:]:
    before = S.read_state(root)[2]
    target = cms_target if stage == 'cms_resources_bound' else None
    with patch.object(S,'_write_exclusive',side_effect=S.StateError('private_state_write_failed')):
        expect('private_state_write_failed',lambda: S.advance_install(root,binding,stage,target))
    assert S.read_state(root)[2] == before
    with patch.object(S,'_atomic_replace',side_effect=S.StateError('private_state_write_failed')):
        expect('private_state_write_failed',lambda: S.advance_install(root,binding,stage,target))
    expect('state_head_mismatch',lambda: S.read_state(root))
    restarted = load('restart_' + stage,'payload-control-state.py')
    recovered = restarted.read_state(root,repair_head=True)[2]
    assert recovered['sequence'] == before['sequence'] + 1
    assert recovered['installIntent']['stage'] == stage and recovered['admission'] == 'closed'
    assert recovered['legacySourceProofSha256'] == before['legacySourceProofSha256']
    assert S.advance_install(root,binding,stage,target) == recovered
key,state_dir,body,_ = S.read_state(root)
next_path = os.path.join(state_dir,S._journal_name(body['sequence'] + 1))
with open(next_path,'wb') as stream: stream.write(b'{"truncated":')
os.chmod(next_path,0o600)
expect('state_journal_corrupt',lambda: S.read_state(root,repair_head=True))
`);
});

test('pending install cannot skip milestones, change targets, clear its evidence or open through generic transitions', async t => {
  await fixture(t, String.raw`
root = fresh('immutable')
S.reserve_install(root,binding,proof,'5' * 64)
for mutate, reason in [
    (lambda b:b.update({'installIntent':None}), 'planned_release_mismatch'),
    (lambda b:b.update({'admission':'open'}), 'invalid_cold_state'),
    (lambda b:b['installIntent'].update({'stage':'cms_resources_pending'}), 'invalid_cold_state'),
    (lambda b:b['installIntent']['binding']['candidate'].update({'runId':'456'}), 'planned_release_mismatch'),
]:
    expect(reason,lambda: S.transition(root,mutate))
for stage in S.INSTALL_STAGES[1:4]:
    S.advance_install(root,binding,stage,cms_target if stage == 'cms_resources_bound' else None)
S.advance_install(root,binding,'cms_resources_bound',cms_target)
wrong = copy.deepcopy(cms_target); wrong['database']['systemIdentifier'] = '77777'
expect('restore_target_changed',lambda: S.advance_install(root,binding,'cms_resources_bound',wrong))
`);
});

test('retry adapter uses only the stage-reviewed grant range and revalidates B0/lease/targets without effects', async t => {
  await fixture(t, String.raw`
from contextlib import ExitStack
import stat
os.makedirs(binding['b0']['directory'],mode=0o700)
os.chmod(binding['b0']['directory'],0o700)
config = {'paths':{'lock':os.path.join(directory,'deploy.lock'),'backupRoots':[os.path.join(directory,'backup')]}}
with open(config['paths']['lock'],'wb') as stream: stream.write(b'fixture lease\n')
os.chmod(config['paths']['lock'],0o600)
# Inspect actual mode AND owner. Non-root unit fixtures cannot be root-owned;
# model only those two exact paths' UID, never the production safety predicate.
real_lstat = os.lstat
actual_b0 = real_lstat(binding['b0']['directory'])
native_posix = os.name != 'nt'
nonroot_posix = native_posix and os.geteuid() != 0
if native_posix:
    assert actual_b0.st_uid == os.geteuid()
    assert stat.S_IMODE(actual_b0.st_mode) == 0o700
def metadata(info,**updates):
    return SimpleNamespace(**{**{name:getattr(info,name) for name in dir(info) if name.startswith('st_')},**updates})
def fixture_lstat(selected,*args,**kwargs):
    info = real_lstat(selected,*args,**kwargs)
    if nonroot_posix and selected in (binding['b0']['directory'],config['paths']['lock']):
        return metadata(info,st_uid=0)
    return info
legacy = {'portalApiSessionPrivileges':[False] * 7,'portalCronSessionPrivileges':[False] * 7}
strict = {'portalApiSessionPrivileges':[True,True,True,True,False,False,False],'portalCronSessionPrivileges':[False] * 7}
base = {'versions':S.PORTAL_MIGRATIONS,'authorityRows':1,'authority':{'mode':'legacy','epoch':1}}
root = fresh('retry')
S.reserve_install(root,binding,proof,'5' * 64)
real_stat = os.stat
def lease_stat(selected,*args,**kwargs):
    if selected == config['paths']['lock'] or selected == '/proc/{}/fd/9'.format(os.getpid()):
        return SimpleNamespace(st_dev=1,st_ino=2)
    return real_stat(selected,*args,**kwargs)
def release(selected,**_kwargs):
    return (previous,False) if selected == binding['sourceRelease'] else (images,True)
for stage in S.INSTALL_STAGES:
    if stage != 'reserved': S.advance_install(root,binding,stage,cms_target if stage == 'cms_resources_bound' else None)
    runtime = R.Runtime.__new__(R.Runtime)
    runtime.state = S.read_state(root)[2]
    runtime.inventory = {'identity':'6' * 64,'document':config}
    runtime.release_path = binding['candidateRelease']; runtime.evidence = binding['b0']['directory']; runtime.key = b'K' * 32
    runtime._admission_closed = lambda: None
    runtime._current_release = lambda: binding['sourceRelease']
    runtime._install_target = lambda bound:(binding['portalTarget'],cms_target if bound else None)
    runtime._install_upload_fingerprint = lambda:'8' * 64
    probes = []
    runtime._install_role_verification = lambda: probes.append('verified-readonly-roles')
    with ExitStack() as stack:
        for name, value in [('_verify_environment_file',lambda _config:None),
                            ('_inventory',lambda **_kwargs:runtime.inventory),
                            ('_release',release),('_parse_proof',lambda *_args,**_kwargs:(proof,'5' * 64)),
                            ('_check_container_shape',lambda *_args,**_kwargs:[]),
                            ('_assert_database_quiescent',lambda _service:None),('_data_fingerprint',lambda _service:'7' * 64)]:
            stack.enter_context(patch.object(R,name,value))
        stack.enter_context(patch.object(R.os,'stat',lease_stat))
        stack.enter_context(patch.object(R.os,'lstat',fixture_lstat))
        stack.enter_context(patch.object(R.STATE,'transition',side_effect=AssertionError('retry must not mutate')))
        for grants in [legacy,strict]:
            accepted = grants == legacy if stage == 'reserved' else True if stage == 'portal_grants_pending' else grants == strict
            with patch.object(R,'_psql_json',lambda *_args:{**base,**grants}):
                if accepted: assert runtime.install_retry_check() == stage
                else:
                    expect('portal_legacy_session_grant_floor_mismatch' if stage == 'reserved' else
                           'portal_session_v2_grants_unprovisioned_or_mismatched',runtime.install_retry_check)
        valid_grants = legacy if stage == 'reserved' else strict
        with patch.object(R,'_psql_json',lambda *_args:{**base,**valid_grants}):
            # Exercise the real inline B0 predicate with POSIX metadata on every
            # platform. Windows metadata is synthetic, not native Linux proof.
            def b0_observation(info):
                def observe(selected,*args,**kwargs):
                    if selected == binding['b0']['directory']: return info
                    return fixture_lstat(selected,*args,**kwargs)
                return observe
            safe_b0 = metadata(actual_b0,st_uid=0,st_mode=stat.S_IFDIR | 0o700)
            with patch.object(R.os,'name','posix'):
                with patch.object(R.os,'lstat',b0_observation(safe_b0)):
                    assert runtime.install_retry_check() == stage
                for unsafe in [metadata(safe_b0,st_uid=1001),
                               metadata(safe_b0,st_mode=stat.S_IFDIR | 0o750),
                               metadata(safe_b0,st_mode=stat.S_IFLNK | 0o700),
                               metadata(safe_b0,st_mode=stat.S_IFREG | 0o700)]:
                    with patch.object(R.os,'lstat',b0_observation(unsafe)):
                        expect('unsafe_backup_directory',runtime.install_retry_check)
            if native_posix:
                with patch.object(R.os,'lstat',b0_observation(actual_b0)):
                    if actual_b0.st_uid == 0: assert runtime.install_retry_check() == stage
                    else: expect('unsafe_backup_directory',runtime.install_retry_check)
                if actual_b0.st_uid == 0:
                    # Native root runs exercise real chmod/chown and unmocked
                    # lstat too; mutate only this test-created B0, then restore.
                    with patch.object(R.os,'lstat',real_lstat):
                        try:
                            os.chmod(binding['b0']['directory'],0o750)
                            expect('unsafe_backup_directory',runtime.install_retry_check)
                            os.chmod(binding['b0']['directory'],0o700)
                            os.chown(binding['b0']['directory'],1001,-1)
                            expect('unsafe_backup_directory',runtime.install_retry_check)
                        finally:
                            os.chown(binding['b0']['directory'],actual_b0.st_uid,-1)
                            os.chmod(binding['b0']['directory'],0o700)
            wrong_target = copy.deepcopy(binding['portalTarget']); wrong_target['database']['databaseOid'] = '19999'
            original_target = runtime._install_target
            runtime._install_target = lambda bound:(wrong_target,cms_target if bound else None)
            expect('restore_target_changed',runtime.install_retry_check)
            runtime._install_target = original_target
            with patch.object(R,'_parse_proof',side_effect=R.ControlError('backup_artifact_mismatch')):
                expect('backup_artifact_mismatch',runtime.install_retry_check)
            with patch.object(runtime,'_install_upload_fingerprint',lambda:'f' * 64):
                expect('restored_storage_fingerprint_mismatch',runtime.install_retry_check)
            with patch.object(R.os,'stat',lambda *_args,**_kwargs:SimpleNamespace(st_dev=1,st_ino=3)):
                expect('operation_lease_inode_mismatch',runtime.install_retry_check)
            with patch.object(R,'_verify_environment_file',side_effect=R.ControlError('unsafe_environment_owner')):
                expect('unsafe_environment_owner',runtime.install_retry_check)
            with patch.object(R,'_inventory',lambda **_kwargs:{'identity':'0' * 64,'document':config}):
                expect('state_inventory_identity_mismatch',runtime.install_retry_check)
            original_current = runtime._current_release
            runtime._current_release = lambda:binding['candidateRelease']
            expect('current_release_invalid',runtime.install_retry_check)
            runtime._current_release = original_current
            partial = copy.deepcopy(strict); partial['portalApiSessionPrivileges'][1] = False
            with patch.object(R,'_psql_json',lambda *_args:{**base,**partial}):
                expect('portal_legacy_session_grant_floor_mismatch' if stage == 'reserved' else
                       'portal_session_grant_state_ambiguous' if stage == 'portal_grants_pending' else
                       'portal_session_v2_grants_unprovisioned_or_mismatched',runtime.install_retry_check)
    expected_probes = 3 if native_posix and actual_b0.st_uid == 0 else 2
    assert probes == (['verified-readonly-roles'] * expected_probes if stage == 'provisioned' else [])
`);
});

test('residual CMS without physical signed binding and missing intent never become a cold retry', async t => {
  await fixture(t, String.raw`
config = {'project':'payload-install-fixture','volumes':{name:{'name':name} for name in ['portalPostgres','portalUploads']}}
residue = [{'service':'postgres','state':'running'}, {'service':'cms-postgres','state':'exited'}]
with patch.object(R,'_container_inventory',lambda:residue),patch.object(R,'_inventory',lambda:{'document':config}):
    expect('unexpected_cold_cms_container',lambda:R._check_container_shape('cold',quiescent=False))
residue = [{'service':'postgres','state':'running'}]
with patch.object(R,'_container_inventory',lambda:residue),patch.object(R,'_inventory',lambda:{'document':config}), \
     patch.object(R,'_project_volumes',lambda:['payload-install-fixture_cms_postgres_data']):
    expect('unexpected_cold_cms_volume',lambda:R._check_container_shape('cold',quiescent=False))
runtime = R.Runtime.__new__(R.Runtime); runtime.state = {'installIntent':None,'restoreIntent':None}
runtime._admission_closed = lambda:None
expect('invalid_cold_state',runtime.install_retry_check)
`);
});

test('pending install/restore verification cannot clear intents, downgrade, commit a pointer or open admission', async t => {
  await fixture(t, String.raw`
runtime = R.Runtime.__new__(R.Runtime)
runtime._admission_closed = lambda:None
for state in [{'cmsStatus':'cold','installIntent':{'stage':'reserved'},'restoreIntent':None},
              {'cmsStatus':'provisioned','installIntent':{'stage':'provisioned'},'restoreIntent':None},
              {'cmsStatus':'migrated','installIntent':None,'restoreIntent':{'stage':'restoring'}}]:
    runtime.state = copy.deepcopy(state)
    with patch.object(R.STATE,'transition',side_effect=AssertionError('unrelated intent must not be mutated')):
        expect('release_not_preflighted',runtime.verify_release)
        if state['installIntent'] is not None:
            expect('admission_open_forbidden',runtime.open_admission)
            expect('rollback_requires_closed_admission',runtime.rollback_check)
    assert runtime.state == state
expect('release_not_preflighted',runtime.install_receiver_preflight)
`);
});

test('receiver hard barrier is executable in synthetic extracted stanzas before effects and already-current recovery', async t => {
  if (!python) return t.skip('Python 3 unavailable');
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  if (spawnSync(bash, ['--version'], { encoding: 'utf8' }).status !== 0) return t.skip('Bash unavailable');
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const directory = await mkdtemp(path.join(parent, 'payload-receiver-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receiver = await readFile('ops/deploy-from-ci.sh', 'utf8');
  const guard = await readFile('ops/payload-operations-guard.sh', 'utf8');
  assert.match(guard, /install-retry-check\|install-receiver-preflight/u);
  const alreadyCurrent = receiver.slice(receiver.indexOf('if [[ $current == "$releases/$requested_commit" ]]'),
    receiver.indexOf('[[ -z $current || $current =~'));
  const marker = receiver.indexOf("echo 'Missing reviewed Payload operations guard'");
  const coldStart = receiver.slice(receiver.lastIndexOf('if [[ $cms_release == true ]]; then', marker),
    receiver.indexOf('unlink "$staging/.ci-images"', marker));
  assert.ok(alreadyCurrent.includes('install-receiver-preflight') && coldStart.includes('install-receiver-preflight'));
  assert.ok(receiver.indexOf('install-receiver-preflight "$staging"') < receiver.indexOf('docker pull "$api_image"'));
  const bashPath = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):\//u, (_match, drive) => `/${drive.toLowerCase()}/`);
  const guardPath = path.join(directory, 'synthetic-guard.sh');
  // Explicit contract fixture: no lease, Docker, DB, runtime construction or host proof.
  // Execute the real permanent refusal method, not a fake PASS qualifier.
  await writeFile(guardPath, `#!/usr/bin/env bash\nexec "$INSTALL_TEST_PYTHON" -B -c '${[
    'import importlib.util,os,sys',
    'spec=importlib.util.spec_from_file_location("receiver_gate",os.environ["INSTALL_RUNTIME_SOURCE"])',
    'module=importlib.util.module_from_spec(spec)', 'spec.loader.exec_module(module)',
    'try: module.Runtime.install_receiver_preflight(None)',
    'except module.ControlError as error: print(str(error),file=sys.stderr); sys.exit(2)',
  ].join('\n')}'\n`);
  await chmod(guardPath, 0o755);
  for (const stanza of [alreadyCurrent, coldStart]) {
    const script = ['set -Eeuo pipefail',
      `PAYLOAD_OPERATIONS_GUARD='${bashPath(guardPath)}'`,
      'releases=/synthetic/releases; requested_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'current="$releases/$requested_commit"; staging=/synthetic/staging; cms_current=true; cms_release=true',
      'docker() { echo forbidden_service_effect >&2; exit 90; }',
      'curl() { echo forbidden_public_effect >&2; exit 91; }',
      stanza, 'echo forbidden_success >&2; exit 92',
    ].join('\n');
    const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', timeout: 20000,
      env: { ...process.env, INSTALL_TEST_PYTHON: python, INSTALL_RUNTIME_SOURCE: path.resolve('ops/payload-control-runtime.py'),
        PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /release_not_preflighted/u);
    assert.doesNotMatch(result.stderr, /forbidden_/u);
  }
});

test('provisioned recheck invokes read-only role verifiers and live B0 storage uses only a read-only fixed-volume mount', async t => {
  await fixture(t, String.raw`
calls = []
runtime = R.Runtime.__new__(R.Runtime); runtime.release_path = binding['candidateRelease']
with patch.object(R,'_compose_args',lambda _release:['docker','compose']), \
     patch.object(R.subprocess,'run',lambda args,**_kwargs:calls.append(args) or SimpleNamespace(returncode=0)):
    runtime._install_role_verification()
assert len(calls) == 2
assert calls[0][-1] == '--verify-control' and calls[1][-1] == '--verify-migrator'
assert all('--no-deps' in args and '--pull' in args and 'never' in args for args in calls)
assert not any('--provision' in args or '--bootstrap-control' in args or '--grants' in args for args in calls)
with patch.object(R,'_compose_args',lambda _release:['docker','compose']), \
     patch.object(R.subprocess,'run',lambda *_args,**_kwargs:SimpleNamespace(returncode=2)):
    expect('native_catalog_verification_failed',runtime._install_role_verification)
runtime.inventory = {'document':{'volumes':{'portalUploads':{'name':'isolated_portal_uploads'}}}}
process = SimpleNamespace(stdout=object(),wait=lambda:0)
with patch.object(R.subprocess,'Popen',lambda args,**_kwargs:calls.append(args) or process), \
     patch.object(R,'_tar_tree',lambda *_args,**_kwargs:'8' * 64):
    assert runtime._install_upload_fingerprint() == '8' * 64
args = calls[-1]
assert '--read-only' in args and args[args.index('--network') + 1] == 'none'
assert args[args.index('--volume') + 1] == 'isolated_portal_uploads:/data:ro'
assert args[args.index('--pull') + 1] == 'never'
assert args[-6:] == ['tar','-cf','-','-C','/data','.']
`);
});

test('journal repair refuses wrong inventory, a second unheaded append and invalid signatures without touching the head', async t => {
  await fixture(t, String.raw`
root = fresh('repair-negative')
S.reserve_install(root,binding,proof,'5' * 64)
head_path = os.path.join(root,'payload-control-state','current.json')
with open(head_path,'rb') as stream: original = stream.read()
with patch.object(S,'_atomic_replace',side_effect=S.StateError('private_state_write_failed')):
    expect('private_state_write_failed',lambda:S.advance_install(root,binding,'portal_grants_pending'))
expect('state_inventory_identity_mismatch',lambda:S.read_state(root,repair_head=True,inventory_identity='0' * 64))
with open(head_path,'rb') as stream: assert stream.read() == original
key = S._key_for(root)
latest = S.parse_canonical(S._read_file(os.path.join(root,'payload-control-state',S._journal_name(3)),0o600,True),'state_journal_corrupt')
second = copy.deepcopy(latest['body']); second['sequence'] += 1
second['previousStateSha256'] = hashlib.sha256(S.canonical(latest)).hexdigest()
second['installIntent']['stage'] = 'portal_grants_verified'
next_path = os.path.join(root,'payload-control-state',S._journal_name(4))
S._write_exclusive(next_path,S.canonical(S.sign_envelope(second,key)) + b'\n',0o600)
expect('state_head_mismatch',lambda:S.read_state(root,repair_head=True))
with open(head_path,'rb') as stream: assert stream.read() == original
bad = S.sign_envelope(second,key); bad['signature']['value'] = '0' * 64
with open(next_path,'wb') as stream: stream.write(S.canonical(bad) + b'\n')
expect('signature_invalid',lambda:S.read_state(root,repair_head=True))
with open(head_path,'rb') as stream: assert stream.read() == original
`);
});

test('valid-HMAC parent-linked journals reject illegal transition semantics before any head repair and retain all evidence', async t => {
  await fixture(t, String.raw`
def scenario(label, setup, mutate, reason):
    root = fresh('semantic-' + label)
    if setup == 'reserved': S.reserve_install(root,binding,proof,'5' * 64)
    if setup in ('bound','provisioned'):
        S.reserve_install(root,binding,proof,'5' * 64)
        limit = 'cms_resources_bound' if setup == 'bound' else 'provisioned'
        for stage in S.INSTALL_STAGES[1:]:
            S.advance_install(root,binding,stage,cms_target if stage == 'cms_resources_bound' else None)
            if stage == limit: break
    if setup in ('migrated','v1-clean','v1-active'):
        # Explicit bootstrap fixture: no predecessor for entry zero. This is not
        # a use of transition() to authorize an illegal pair under test.
        key,state_dir,old,_ = S.read_state(root)
        initial = copy.deepcopy(old)
        initial['sequence'] = 0; initial['previousStateSha256'] = None
        if setup == 'migrated':
            initial.update({'cmsStatus':'migrated','releaseImages':images,'nativeCatalogFingerprint':'a' * 64})
        else:
            initial['schemaVersion'] = 1; del initial['installIntent']
            if setup == 'v1-clean':
                initial.update({'plannedReleaseImages':None,'latestProofSha256':None,'legacySourceProofSha256':None})
        S.validate_state_body(initial)
        # Fresh local fixture only; no repair API deletes journal entries.
        replacement = os.path.join(directory,'genesis-' + label)
        os.mkdir(replacement,0o700); S.initialize(replacement,'6' * 64)
        root = replacement
        key,state_dir,_,_ = S.read_state(root)
        raw = S.canonical(S.sign_envelope(initial,key)) + b'\n'
        for name in [S._journal_name(0),'current.json']:
            with open(os.path.join(state_dir,name),'wb') as stream: stream.write(raw)
    key,state_dir,old,parent_hash = S.read_state(root)
    head_path = os.path.join(state_dir,'current.json')
    with open(head_path,'rb') as stream: original_head = stream.read()
    original_names = sorted(os.listdir(state_dir))
    # Both paths must implement the SAME pair contract, with no append on reject.
    expect(reason,lambda:S.transition(root,mutate))
    assert sorted(os.listdir(state_dir)) == original_names
    with open(head_path,'rb') as stream: assert stream.read() == original_head
    child = copy.deepcopy(old); mutate(child)
    child['sequence'] = old['sequence'] + 1; child['previousStateSha256'] = parent_hash
    S.validate_state_body(child)  # Every negative has a individually legal body.
    envelope = S.sign_envelope(child,key)
    S.verify_envelope(envelope,key,S.validate_state_body,'state_journal_corrupt')
    raw = S.canonical(envelope) + b'\n'
    journal_path = os.path.join(state_dir,S._journal_name(child['sequence']))
    S._write_exclusive(journal_path,raw,0o600)
    expected_files = {name:S._read_file(os.path.join(state_dir,name),0o600,True)
                      for name in os.listdir(state_dir)}
    for repair in (False,True):
        with patch.object(S,'_atomic_replace',side_effect=AssertionError('invalid transition must not repair the head')):
            expect(reason,lambda:S.read_state(root,repair_head=repair))
        assert sorted(os.listdir(state_dir)) == sorted(expected_files)
        for name, before in expected_files.items():
            assert S._read_file(os.path.join(state_dir,name),0o600,True) == before
    # The same invalid history is rejected even with a matching signed head;
    # validation is replay semantics, not merely an unheaded-child safeguard.
    with open(head_path,'wb') as stream: stream.write(raw)
    with patch.object(S,'_atomic_replace',side_effect=AssertionError('head must be retained')):
        expect(reason,lambda:S.read_state(root,repair_head=True))
    with open(head_path,'rb') as stream: assert stream.read() == raw
    with open(journal_path,'rb') as stream: assert stream.read() == raw
    # Even a later individually legal, adjacent child cannot hide the earlier
    # illegal pair and induce repair of its one-child head window.
    grandchild = copy.deepcopy(child)
    grandchild['sequence'] += 1
    grandchild['previousStateSha256'] = hashlib.sha256(S.canonical(envelope)).hexdigest()
    next_raw = S.canonical(S.sign_envelope(grandchild,key)) + b'\n'
    next_path = os.path.join(state_dir,S._journal_name(grandchild['sequence']))
    S._write_exclusive(next_path,next_raw,0o600)
    retained = {name:S._read_file(os.path.join(state_dir,name),0o600,True) for name in os.listdir(state_dir)}
    with patch.object(S,'_atomic_replace',side_effect=AssertionError('whole history must pass before repair')):
        expect(reason,lambda:S.read_state(root,repair_head=True))
    assert sorted(os.listdir(state_dir)) == sorted(retained)
    for name, before in retained.items():
        assert S._read_file(os.path.join(state_dir,name),0o600,True) == before
def migrated_without_intent(body):
    body.update({'cmsStatus':'migrated','releaseImages':images,'nativeCatalogFingerprint':'a' * 64,'installIntent':None})
def downgrade_schema(body):
    body['schemaVersion'] = 1; del body['installIntent']
def resurrect(body):
    body.update({'cmsStatus':'cold','releaseImages':None,'nativeCatalogFingerprint':None,
                 'installIntent':{'binding':copy.deepcopy(binding),'stage':'reserved','cmsTarget':None}})
def upgrade(body): body.update({'schemaVersion':2,'installIntent':None})
cases = [
    ('skip-stage','reserved',lambda b:b['installIntent'].update({'stage':'cms_resources_pending'}),'invalid_cold_state'),
    ('binding','reserved',lambda b:b['installIntent']['binding']['candidate'].update({'runId':'456'}),'planned_release_mismatch'),
    ('target','bound',lambda b:b['installIntent']['cmsTarget']['database'].update({'systemIdentifier':'777777'}),'restore_target_changed'),
    ('target-volume','bound',lambda b:b['installIntent']['cmsTarget']['volumes']['cmsUploads'].update({'fingerprint':'f' * 64}),'restore_target_changed'),
    ('schema-downgrade','none',downgrade_schema,'unsupported_state_phase'),
    ('intent-removal','reserved',lambda b:b.update({'installIntent':None}),'planned_release_mismatch'),
    ('illegal-floor-commit','provisioned',migrated_without_intent,'planned_release_mismatch'),
    ('floor-downgrade','migrated',lambda b:b.update({'cmsStatus':'cold','releaseImages':None,'nativeCatalogFingerprint':None}),'legacy_fallback_forbidden'),
    ('resurrect-after-floor','migrated',resurrect,'legacy_fallback_forbidden'),
    ('unsafe-v1-upgrade','v1-active',upgrade,'invalid_cold_state'),
    ('v1-upgrade-side-effect','v1-clean',lambda b:b.update({'schemaVersion':2,'installIntent':None,'admission':'open'}),'invalid_cold_state'),
    ('inventory','none',lambda b:b.update({'inventoryIdentity':'0' * 64}),'state_inventory_identity_mismatch'),
]
for args in cases: scenario(*args)
`);
});

test('bootstrap entry has no predecessor and legitimate v1 history and narrow schema upgrade replay unchanged', async t => {
  await fixture(t, String.raw`
for version in (1,2):
    root = os.path.join(directory,'bootstrap-' + str(version)); os.mkdir(root,0o700)
    S.initialize(root,'6' * 64)
    key,state_dir,initial,_ = S.read_state(root)
    if version == 1:
        initial['schemaVersion'] = 1; del initial['installIntent']
        raw = S.canonical(S.sign_envelope(initial,key)) + b'\n'
        for name in [S._journal_name(0),'current.json']:
            with open(os.path.join(state_dir,name),'wb') as stream: stream.write(raw)
    assert S.read_state(root,repair_head=True)[2] == initial
    S.transition(root,lambda b:b.update({'admission':'closed'}))
    assert S.read_state(root)[2]['schemaVersion'] == version
    if version == 1:
        with patch.object(S,'_atomic_replace',side_effect=S.StateError('private_state_write_failed')):
            expect('private_state_write_failed',lambda:S.upgrade_install_schema(root))
        upgraded = S.read_state(root,repair_head=True)[2]
        assert upgraded['schemaVersion'] == 2 and upgraded['sequence'] == 2
        assert upgraded['installIntent'] is None and upgraded['admission'] == 'closed'
        assert S._key_for(root) == key
`);
});
