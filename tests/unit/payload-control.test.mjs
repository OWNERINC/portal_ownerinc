import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const pythonCandidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
const python = pythonCandidates.find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);

test('preauthority state, signed proof, grant floors and worker hold fail closed', async t => {
  if (!python) return t.skip('Python 3 unavailable; production controller requires Python 3');
  const tempRoot = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const fixture = await mkdtemp(path.join(tempRoot, 'payload-control-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const script = String.raw`
import copy, hashlib, importlib.util, io, json, os, sys, tarfile

state_path, runtime_path, fixture = sys.argv[1:]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

S = load('payload_control_state', state_path)
R = load('payload_control_runtime', runtime_path)

def expect(code, callback):
    try:
        callback()
    except (S.StateError, R.ControlError) as error:
        assert str(error) == code, (str(error), code)
    else:
        raise AssertionError('expected ' + code)

legacy_images = {
    'api': 'ghcr.io/ownerinc/ownerinc-portal-api@sha256:' + 'a' * 64,
    'cron': 'ghcr.io/ownerinc/ownerinc-portal-cron@sha256:' + 'b' * 64,
}
payload_images = {**legacy_images, 'cms': 'ghcr.io/ownerinc/ownerinc-portal-cms@sha256:' + 'c' * 64}
manifest_path = os.path.join(fixture, 'release.images')
with open(manifest_path, 'w', encoding='ascii') as stream:
    stream.write('API_IMAGE=' + legacy_images['api'] + '\n')
    stream.write('CRON_IMAGE=' + legacy_images['cron'] + '\n')
os.chmod(manifest_path, 0o600)
legacy_manifest, legacy_payload = R._manifest(manifest_path)
assert legacy_manifest == legacy_images and legacy_payload is False, legacy_manifest
with open(manifest_path, 'w', encoding='ascii') as stream:
    stream.write('API_IMAGE=' + payload_images['api'] + '\n')
    stream.write('CRON_IMAGE=' + payload_images['cron'] + '\n')
    stream.write('CMS_IMAGE=' + payload_images['cms'] + '\nRELEASE_FORMAT=payload-v1\n')
payload_manifest, is_payload_manifest = R._manifest(manifest_path)
assert payload_manifest == payload_images and is_payload_manifest is True, payload_manifest
migration_hash = hashlib.sha256(S.canonical(S.PORTAL_MIGRATIONS)).hexdigest()
source = {'systemIdentifier': '123456', 'databaseOid': '16384', 'databaseName': 'portal'}
proof = {
    'schemaVersion': 1,
    'kind': 'preauthority-legacy-source',
    'phase': 'preauthority',
    'inventoryIdentity': '6' * 64,
    'authority': {'mode': 'legacy', 'epoch': 1},
    'protocol': {'status': 'absent', 'coverage': 'not-applicable'},
    'images': legacy_images,
    'targetImages': payload_images,
    'source': {'portal': source, 'cms': None},
    'migrations': {'portal': {'versions': S.PORTAL_MIGRATIONS, 'fingerprint': migration_hash},
                   'cms': None, 'nativeCatalogFingerprint': None},
    'dataFingerprints': {'portalDatabase': 'd' * 64, 'portalUploads': 'e' * 64,
                         'cmsDatabase': None, 'cmsUploads': None},
    'artifacts': [],
    'createdAtUtc': '2026-10-08T12:00:00Z',
}
for name, data in [('postgres.dump', b'portal dump'), ('uploads.tar.gz', b'portal files')]:
    with open(os.path.join(fixture, name), 'wb') as stream:
        stream.write(data)
    proof['artifacts'].append({'name': name, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})

S.validate_proof_body(proof)
unknown = copy.deepcopy(proof)
unknown['unreviewedField'] = True
expect('unsupported_proof_shape', lambda: S.validate_proof_body(unknown))
unsupported = copy.deepcopy(proof)
unsupported['phase'] = 'cutover'
expect('unsupported_proof_phase', lambda: S.validate_proof_body(unsupported))
wrong_database = copy.deepcopy(proof)
wrong_database['source']['portal']['databaseName'] = 'ownerinc_cms'
expect('invalid_proof_source', lambda: S.validate_proof_body(wrong_database))
expect('duplicate_json_field', lambda: S.parse_canonical(b'{"body":{},"body":{}}\n', 'bad_json'))

key = b'K' * 32
envelope = S.sign_envelope(proof, key)
S.verify_envelope(envelope, key, S.validate_proof_body, 'bad_proof')
tampered_signature = copy.deepcopy(envelope)
tampered_signature['signature']['value'] = '0' * 64
expect('signature_invalid', lambda: S.verify_envelope(tampered_signature, key, S.validate_proof_body, 'bad_proof'))

proof_path = os.path.join(fixture, 'preauthority-proof.json')
with open(proof_path, 'wb') as stream:
    stream.write(S.canonical(envelope) + b'\n')
os.chmod(proof_path, 0o600)
S.read_proof(fixture, key, payload=False)
with open(os.path.join(fixture, 'postgres.dump'), 'wb') as stream:
    stream.write(b'changed dump')
expect('backup_artifact_mismatch', lambda: S.read_proof(fixture, key, payload=False))

expect('restore_target_changed', lambda: S.assert_restore_target_matches(
    {'portal': {'databaseOid': '1'}}, {'portal': {'databaseOid': '2'}}))
expect('restore_target_changed', lambda: S.assert_restore_target_matches(
    {'volumes': {'portalPostgres': {'fingerprint': 'a' * 64}},
     'portal': source, 'cms': {'systemIdentifier': '123456', 'databaseOid': '16385', 'databaseName': 'ownerinc_cms'}},
    {'volumes': {'portalPostgres': {'fingerprint': 'b' * 64}},
     'portal': source, 'cms': {'systemIdentifier': '123456', 'databaseOid': '16385', 'databaseName': 'ownerinc_cms'}}))

state = {
    'schemaVersion': 1, 'phase': 'preauthority', 'cmsStatus': 'cold',
    'authority': {'mode': 'legacy', 'epoch': 1}, 'workerHold': True,
    'admission': 'open', 'sequence': 0, 'previousStateSha256': None,
    'restoreIntent': None, 'latestProofSha256': None, 'legacySourceProofSha256': None,
    'releaseImages': None, 'plannedReleaseImages': None, 'rollbackTargetImages': None,
    'nativeCatalogFingerprint': None, 'inventoryIdentity': '9' * 64,
}
S.validate_state_body(state)
state_root = os.path.join(fixture, 'private-runtime')
os.mkdir(state_root, 0o700)
S.initialize(state_root, '9' * 64)
assert S.verify_admission(state_root, 'open')['admission'] == 'open'
state_after_transition = S.transition(state_root, lambda value: value.update({'admission': 'closed'}))
assert state_after_transition['sequence'] == 1
assert S.read_state(state_root)[2]['admission'] == 'closed'
assert S.verify_admission(state_root, 'closed')['admission'] == 'closed'
expect('admission_state_not_open', lambda: S.verify_admission(state_root, 'open'))
with open(os.path.join(state_root, 'payload-control-state', S._journal_name(1)), 'ab') as stream:
    stream.write(b' ')
expect('state_journal_corrupt', lambda: S.read_state(state_root))

unsafe_state = copy.deepcopy(state)
unsafe_state['workerHold'] = False
expect('worker_admission_forbidden', lambda: S.validate_state_body(unsafe_state))
boolean_epoch = copy.deepcopy(state)
boolean_epoch['authority']['epoch'] = True
expect('unsupported_authority_state', lambda: S.validate_state_body(boolean_epoch))
boolean_version = copy.deepcopy(state)
boolean_version['schemaVersion'] = True
expect('unsupported_state_phase', lambda: S.validate_state_body(boolean_version))

restore_state = copy.deepcopy(state)
restore_state['cmsStatus'] = 'migrated'
restore_state['releaseImages'] = payload_images
restore_state['nativeCatalogFingerprint'] = 'f' * 64
volume_entry = {'name': 'fixture_volume', 'driver': 'local', 'mountpoint': '/var/lib/docker/volumes/fixture', 'fingerprint': 'a' * 64}
restore_state['restoreIntent'] = {
    'proofSha256': 'b' * 64,
    'stage': 'reserved',
    'targetFingerprints': {'portalDatabase': '1' * 64, 'cmsDatabase': '2' * 64,
                           'portalUploads': '3' * 64, 'cmsUploads': '4' * 64},
    'target': {
        'inventoryIdentity': '8' * 64,
        'portal': source,
        'cms': {'systemIdentifier': '123456', 'databaseOid': '16385', 'databaseName': 'ownerinc_cms'},
        'volumes': {name: copy.deepcopy(volume_entry) for name in ('portalPostgres', 'portalUploads', 'cmsPostgres', 'cmsUploads')},
    },
    'releaseImages': payload_images,
}
S.validate_state_body(restore_state)
for stage in ('restoring', 'portal_restored', 'portal_grants_restored'):
    staged = copy.deepcopy(restore_state)
    staged['restoreIntent']['stage'] = stage
    S.validate_state_body(staged)
invalid_restore_stage = copy.deepcopy(restore_state)
invalid_restore_stage['restoreIntent']['stage'] = 'grants_skipped'
expect('invalid_restore_intent', lambda: S.validate_state_body(invalid_restore_stage))
missing_portal_volume = copy.deepcopy(restore_state)
del missing_portal_volume['restoreIntent']['target']['volumes']['portalPostgres']
expect('invalid_restore_volumes', lambda: S.validate_state_body(missing_portal_volume))
wrong_target_database = copy.deepcopy(restore_state)
wrong_target_database['restoreIntent']['target']['portal']['databaseName'] = 'ownerinc_cms'
expect('invalid_restore_target', lambda: S.validate_state_body(wrong_target_database))

# Exercise the post-restore catalog binding with a real HMAC envelope and real
# artifact hashes; the observed runtime catalog intentionally disagrees.
R._INVENTORY_CACHE = {'identity': '7' * 64, 'document': {}}
restore_proof_dir = os.path.join(fixture, 'restore-proof')
os.mkdir(restore_proof_dir, 0o700)
payload_artifacts = []
for name, data in [('postgres.dump', b'synthetic portal dump'),
                   ('uploads.tar.gz', b'synthetic portal tree'),
                   ('cms-postgres.dump', b'synthetic CMS dump'),
                   ('cms-uploads.tar.gz', b'synthetic CMS tree')]:
    with open(os.path.join(restore_proof_dir, name), 'wb') as stream:
        stream.write(data)
    payload_artifacts.append({'name': name, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})
cms_identity = {'systemIdentifier': '123456', 'databaseOid': '16385', 'databaseName': 'ownerinc_cms'}
cms_migration_hash = hashlib.sha256(S.canonical(S.CMS_MIGRATIONS)).hexdigest()
restore_proof = R._proof_body(
    'preauthority-four-store-backup', payload_images, None,
    {'portal': source, 'cms': cms_identity},
    {'portal': {'versions': S.PORTAL_MIGRATIONS, 'fingerprint': migration_hash},
     'cms': {'names': S.CMS_MIGRATIONS, 'fingerprint': cms_migration_hash},
     'nativeCatalogFingerprint': 'a' * 64},
    {'portalDatabase': '1' * 64, 'cmsDatabase': '2' * 64,
     'portalUploads': '3' * 64, 'cmsUploads': '4' * 64},
    payload_artifacts,
)
with open(os.path.join(restore_proof_dir, 'operations-proof.json'), 'wb') as stream:
    stream.write(S.canonical(S.sign_envelope(restore_proof, key)) + b'\n')
os.chmod(os.path.join(restore_proof_dir, 'operations-proof.json'), 0o600)
signed_restore_body, _restore_proof_hash = S.read_proof(restore_proof_dir, key, payload=True)
runtime = R.Runtime.__new__(R.Runtime)
runtime.release_path = 'signed-fixture-release'
runtime.runtime_dir = state_root
restore_intent = {'proofSha256': '5' * 64, 'stage': 'portal_grants_restored'}
runtime.state = {'admission': 'closed', 'restoreIntent': restore_intent}
runtime._recheck_restore_boundary = lambda: signed_restore_body
runtime._storage_tree_fingerprint = lambda _service: (_ for _ in ()).throw(AssertionError('storage must not be accepted'))
old_verify_cms = R._verify_cms
old_data_fingerprint = R._data_fingerprint
old_transition = R.STATE.transition
transition_calls = []
try:
    R._verify_cms = lambda _release, catalog=True: {'nativeCatalogFingerprint': 'b' * 64}
    R._data_fingerprint = lambda _service: (_ for _ in ()).throw(AssertionError('database acceptance must not run'))
    R.STATE.transition = lambda *args: transition_calls.append(args)
    expect('restored_native_catalog_fingerprint_mismatch', runtime.verify_restored)
finally:
    R._verify_cms = old_verify_cms
    R._data_fingerprint = old_data_fingerprint
    R.STATE.transition = old_transition
assert runtime.state['admission'] == 'closed'
assert runtime.state['restoreIntent'] == restore_intent
assert transition_calls == []

privilege_names = R.SESSION_TABLE_PRIVILEGES
legacy_grants = {'portalApiSessionPrivileges': [False] * len(privilege_names),
                 'portalCronSessionPrivileges': [False] * len(privilege_names)}
strict_grants = {'portalApiSessionPrivileges': [True, True, True, True, False, False, False],
                 'portalCronSessionPrivileges': [False] * len(privilege_names)}
R._validate_portal_session_grants(legacy_grants, 'legacy')
expect('portal_session_v2_grants_unprovisioned_or_mismatched',
       lambda: R._validate_portal_session_grants(legacy_grants, 'strict'))
R._validate_portal_session_grants(strict_grants, 'strict')
R._validate_portal_session_grants(strict_grants, 'recovery')
R._validate_portal_session_grants(legacy_grants, 'recovery')
partial_grants = copy.deepcopy(strict_grants)
partial_grants['portalApiSessionPrivileges'][3] = False
expect('portal_session_v2_grants_unprovisioned_or_mismatched',
       lambda: R._validate_portal_session_grants(partial_grants, 'strict'))

base_portal = {'versions': S.PORTAL_MIGRATIONS, 'authorityRows': 1,
               'authority': {'mode': 'legacy', 'epoch': 1}}
R._psql_json = lambda service, sql: {**base_portal, **legacy_grants}
R._portal_state('legacy')
expect('portal_session_v2_grants_unprovisioned_or_mismatched', lambda: R._portal_state('strict'))
R._psql_json = lambda service, sql: {**base_portal, **strict_grants}
R._portal_state('strict')

# The Portal intermediate boundary accepts only the exact recovery floor, checks
# the restored Portal data fingerprint, and persists the stage before regrant.
intermediate_runtime = R.Runtime.__new__(R.Runtime)
intermediate_runtime.runtime_dir = state_root
intermediate_runtime.release_path = 'fixture-release'
intermediate_runtime.evidence = fixture
intermediate_runtime.state = {'restoreIntent': {'stage': 'restoring'}}
intermediate_body = {'dataFingerprints': {'portalDatabase': 'd' * 64}}
intermediate_modes = []
transitioned = []
old_transition = R.STATE.transition
old_data_fingerprint = R._data_fingerprint
try:
    intermediate_runtime._recheck_restore_boundary = lambda grant_mode='strict': (
        intermediate_modes.append(grant_mode) or intermediate_body)
    R._data_fingerprint = lambda service: 'd' * 64 if service == 'postgres' else None
    def record_intermediate_transition(_directory, mutate):
        state_value = copy.deepcopy(intermediate_runtime.state)
        mutate(state_value)
        transitioned.append(state_value)
        return state_value
    R.STATE.transition = record_intermediate_transition
    intermediate_runtime.portal_restore_intermediate()
    assert intermediate_modes == ['recovery']
    assert intermediate_runtime.state['restoreIntent']['stage'] == 'portal_restored'
    assert len(transitioned) == 1

    failed_intermediate = R.Runtime.__new__(R.Runtime)
    failed_intermediate.runtime_dir = state_root
    failed_intermediate.state = {'restoreIntent': {'stage': 'restoring'}}
    failed_intermediate._recheck_restore_boundary = lambda grant_mode='strict': intermediate_body
    R._data_fingerprint = lambda _service: 'e' * 64
    transitioned.clear()
    expect('restored_portal_database_fingerprint_mismatch', failed_intermediate.portal_restore_intermediate)
    assert failed_intermediate.state['restoreIntent']['stage'] == 'restoring'
    assert transitioned == []
finally:
    R.STATE.transition = old_transition
    R._data_fingerprint = old_data_fingerprint

R._psql_json = lambda service, sql: {'clientBackends': 0, 'activeQueries': 0, 'openTransactions': 0}
R._assert_database_quiescent('postgres')
R._psql_json = lambda service, sql: {'clientBackends': 1, 'activeQueries': 0, 'openTransactions': 0}
expect('database_sessions_not_quiescent', lambda: R._assert_database_quiescent('postgres'))

class Sink:
    def write(self, _value): pass
    def close(self): pass
class FakeProcess:
    def __init__(self, records):
        self.stdin = Sink()
        self.stdout = io.BytesIO(records)
    def wait(self): return 0
    def kill(self): raise AssertionError('valid fingerprint input was killed')
def fingerprint_for(value, sequence_state):
    records = b''.join([
        json.dumps(['public.items', value], separators=(',', ':')).encode() + b'\n',
        json.dumps(['public.items_id_seq', sequence_state], separators=(',', ':')).encode() + b'\n',
    ])
    R._psql_json = lambda service, sql: {
        'tables': [{'schema': 'public', 'name': 'items'}],
        'sequences': [{'schema': 'public', 'name': 'items_id_seq'}],
        'unsupportedRelations': [],
    }
    R._container_id = lambda service: 'fixture-postgres'
    R.subprocess.Popen = lambda *args, **kwargs: FakeProcess(records)
    return R._data_fingerprint('postgres')
assert fingerprint_for({'id': 1, 'title': 'first'}, {'last_value': 3, 'is_called': True}) != \
       fingerprint_for({'id': 1, 'title': 'changed'}, {'last_value': 3, 'is_called': True})
assert fingerprint_for({'id': 1, 'title': 'first'}, {'last_value': 3, 'is_called': True}) != \
       fingerprint_for({'id': 1, 'title': 'first'}, {'last_value': 4, 'is_called': True})
R._psql_json = lambda service, sql: {
    'tables': [{'schema': 'public', 'name': 'items'}],
    'sequences': [{'schema': 'public', 'name': 'items_id_seq'}],
    'unsupportedRelations': [{'schema': 'public', 'name': 'fixture_matview', 'kind': 'm'}],
}
expect('database_fingerprint_unsupported_relation', lambda: R._data_fingerprint('postgres'))

def tar_bytes(name, kind=tarfile.REGTYPE):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        entry = tarfile.TarInfo(name)
        entry.type = kind
        entry.size = 1 if kind == tarfile.REGTYPE else 0
        archive.addfile(entry, io.BytesIO(b'x') if entry.size else None)
    return output.getvalue()
R._tar_tree(io.BytesIO(tar_bytes('safe.txt')))
expect('unsafe_storage_archive', lambda: R._tar_tree(io.BytesIO(tar_bytes('../escape'))))
expect('unsafe_storage_archive', lambda: R._tar_tree(io.BytesIO(tar_bytes('linked', tarfile.SYMTYPE))))

old_inventory = R._container_inventory
try:
    R._container_inventory = lambda: [{'id': 'worker', 'service': 'cms-worker', 'state': 'running', 'name': 'fixture-worker'}]
    expect('worker_admission_forbidden', lambda: R._check_container_shape('migrated'))
finally:
    R._container_inventory = old_inventory
`;
  const result = spawnSync(python, ['-c', script, path.resolve('ops/payload-control-state.py'),
    path.resolve('ops/payload-control-runtime.py'), fixture], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
