import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const python = process.platform === 'win32' ? 'python' : 'python3';
const preamble = String.raw`
import importlib.util, json, os, pathlib, tempfile, types, sys, shutil, hashlib
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('monitor', 'ops/portal-operational-observe.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;
function run(code) {
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', preamble + code], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 65536,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}
test('phase adapter refuses new schema/recovery and compares authenticated admission separately', () => run(String.raw`
body = dict(schemaVersion=2, phase='preauthority', authority=dict(mode='legacy', epoch=1),
            workerHold=True, admission='closed', cmsStatus='cold', installIntent=None, restoreIntent=None)
assert m.phase_checks(body, True)[0]['reason'] == 'planned_hold'
assert m.phase_checks(body, False)[1]['reason'] == 'admission_mismatch'
assert m.phase_checks(dict(body,cmsStatus='migrated'),True)[0]['reason']=='unsupported_contract'
assert m.phase_checks(dict(body,cmsStatus='migrated'),True)[1]['reason']=='ready'
for change in [dict(schemaVersion=3), dict(phase='active'), dict(installIntent={'stage':'new_stage'}),
               dict(installIntent={'stage':'reserved','recovery':{}}), dict(workerHold=False), dict(cmsStatus='future')]:
    assert all(row['reason']=='unsupported_contract' for row in m.phase_checks(dict(body, **change), True))
`));
test('disk byte/inode thresholds and wrong device/missing mount are never healthy', () => run(String.raw`
root = os.path.abspath('.')
mount = {'path':root,'mountPoint':root,'device':12}
stat = lambda _: types.SimpleNamespace(st_dev=12)
usage = lambda _: types.SimpleNamespace(f_blocks=1000,f_bavail=90,f_files=1000,f_favail=900)
assert m.disk_check('monitor',mount,{root:['rw']},stat,usage)['reason']=='disk_critical'
usage = lambda _: types.SimpleNamespace(f_blocks=1000,f_bavail=900,f_files=1000,f_favail=150)
assert m.disk_check('monitor',mount,{root:['rw']},stat,usage)['reason']=='disk_warning'
assert m.disk_check('monitor',mount,{root:['ro']},stat,usage)['reason']=='storage_read_only'
assert m.disk_check('monitor',mount,{},stat,usage)['reason']=='storage_unavailable'
assert m.disk_check('monitor',dict(mount,device=99),{root:['rw']},stat,usage)['reason']=='storage_unavailable'
parent=os.path.dirname(root)
assert m.disk_check('monitor',dict(mount,mountPoint=parent),{parent:['rw'],root:['rw']},stat,usage)['reason']=='storage_unavailable'
usage = lambda _: types.SimpleNamespace(f_blocks=1000,f_bavail=100,f_files=1000,f_favail=900)
assert m.disk_check('monitor',mount,{root:['rw']},stat,usage)['reason']=='disk_critical'
`));
test('host verifier failure still emits finite backup/unit observations with no controller calls', () => run(String.raw`
m.config=lambda: {'mounts':{}}
def unavailable(_): raise ValueError('secret-canary')
m.observe_state=unavailable
def missing(_): raise FileNotFoundError('private-canary')
m.read_json=missing
seen=[]
def properties(unit):
    seen.append(unit)
    return dict(LoadState='loaded',ActiveState='active',Result='success',ExecMainStatus='0',NextElapseUSecRealtime='next')
m.unit_properties=properties
result=m.collect()
rows={row['id']:row for row in result['checks']}
assert len(rows)==10 and rows['host_state']['reason']=='state_unverified'
assert rows['backup_timer']['reason']=='ready' and rows['backup_age']['reason']=='backup_missing'
assert seen==['ownerinc-portal-backup.service','ownerinc-portal-backup.timer']
assert 'canary' not in json.dumps(result)
`));
test('backup capture age persists while running and partial/coordinated evidence is denied', () => run(String.raw`
captured = int(m.datetime.datetime(2026,11,2,tzinfo=m.datetime.timezone.utc).timestamp()*1000)
receipt = {'version':1,'attempt':{'id':'a'*32,'startedAt':captured+86400000,'finishedAt':None,'outcome':'running'},
    'verified':{'captureAt':captured,'verifiedAt':captured+1000,'name':'20261102T000000Z','format':'legacy',
    'manifestSha256':'b'*64,'artifacts':{name:{} for name in m.ARTIFACTS['legacy']+('manifest.sha256',)}}}
rows = m.backup_checks(receipt,captured+86401000,verify=False)
assert rows[0]['reason']=='backup_running' and rows[1]['reason']=='backup_stale'
receipt['attempt'].update(outcome='failed',finishedAt=captured+86401000)
assert m.backup_checks(receipt,captured+86401000,verify=False)[1]['reason']=='backup_stale'
receipt['verified']['format']='payload-v2-shared-postgres'
try: m.backup_checks(receipt,captured+86401000,verify=False)
except ValueError: pass
else: raise AssertionError('partial coordinated accepted')
receipt['verified']=None
assert m.backup_checks(receipt,captured+86401000,verify=False)[1]['reason']=='backup_missing'
`));
test('backup receipt timestamps use a fresh post-read clock while genuine future evidence is rejected', () => run(String.raw`
base=int(m.datetime.datetime(2026,11,2,1,tzinfo=m.datetime.timezone.utc).timestamp()*1000)
captured=base-3600000
m.config=lambda: {'mounts':{}}
m.observe_state=lambda _: [m.check('host_state','planned_hold','degraded'),m.check('host_admission','ready','ok')]
m.unit_properties=lambda _: dict(LoadState='loaded',ActiveState='active',Result='success',ExecMainStatus='0',NextElapseUSecRealtime='next')
artifacts={name:{} for name in m.ARTIFACTS['legacy']+('manifest.sha256',)}
manifest=b'fixture manifest'
m.artifact_metadata=lambda *_: artifacts
m.read_file=lambda *_: manifest
for outcome in ('running','verified'):
    for future in (False,True):
        clock=[base]
        receipt_at=base+(4000 if future else 2000)
        receipt={'version':1,'attempt':{'id':'a'*32,'startedAt':receipt_at if outcome=='running' else base+1000,
            'finishedAt':None if outcome=='running' else receipt_at,'outcome':outcome},
            'verified':{'captureAt':captured,'verifiedAt':captured+1000 if outcome=='running' else receipt_at,
                'name':'20261102T000000Z','format':'legacy','manifestSha256':hashlib.sha256(manifest).hexdigest(),'artifacts':artifacts}}
        def read(_):
            clock[0]=base+3000
            return receipt
        m.read_json=read
        result=m.collect(clock=lambda: clock[0]/1000)
        rows={row['id']:row for row in result['checks']}
        assert result['observedAt']==base
        if future:
            assert rows['backup_attempt']['reason']=='backup_invalid' and rows['backup_age']['reason']=='backup_invalid'
        else:
            assert rows['backup_attempt']['reason']==('backup_running' if outcome=='running' else 'verified_local')
            assert rows['backup_age']['reason']=='verified_local' and rows['backup_age']['value']==3603
`));
test('actual signed state reader rejects tampering without repair or runtime invocation', () => run(String.raw`
spec = importlib.util.spec_from_file_location('fixture_state','ops/payload-control-state.py')
state = importlib.util.module_from_spec(spec); spec.loader.exec_module(state)
parent = os.path.join(tempfile.gettempdir(),'opencode') if os.name=='nt' else tempfile.gettempdir()
with tempfile.TemporaryDirectory(prefix='own34-signature-',dir=parent) as temp:
    root = os.path.realpath(temp)
    os.chmod(root,0o700)
    identity = 'a'*64
    state.initialize(root,identity)
    _, _, body, _ = state.read_state(root,repair_head=False,inventory_identity=identity)
    assert body['schemaVersion']==2
    head = os.path.join(root,'payload-control-state','current.json')
    before = pathlib.Path(head).read_bytes()
    changed = before.replace(b'"epoch":1',b'"epoch":2')
    assert changed != before
    pathlib.Path(head).write_bytes(changed)
    try: state.read_state(root,repair_head=False,inventory_identity=identity)
    except state.StateError: pass
    else: raise AssertionError('HMAC tamper accepted')
    assert pathlib.Path(head).read_bytes()==changed
`));
test('native root receipt persistence preserves last verification and detects modified artifacts', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0,
}, () => run(String.raw`
with tempfile.TemporaryDirectory(prefix='own34-receipt-') as temp:
    m.OBSERVATIONS=temp+'/observations'; m.BACKUPS=temp+'/backups'
    os.mkdir(m.OBSERVATIONS,0o700); os.mkdir(m.BACKUPS,0o700)
    name='20260101T000000Z'; directory=m.BACKUPS+'/'+name; os.mkdir(directory,0o700)
    manifest=[]
    for filename in m.ARTIFACTS['legacy']:
        raw=b'fixture artifact\n'; path=directory+'/'+filename
        pathlib.Path(path).write_bytes(raw); os.chmod(path,0o600)
        manifest.append(hashlib.sha256(raw).hexdigest()+'  '+filename+'\n')
    pathlib.Path(directory+'/manifest.sha256').write_text(''.join(manifest)); os.chmod(directory+'/manifest.sha256',0o600)
    m.record_backup('backup-start'); m.record_backup('backup-verified',name)
    prior=m.read_json(m.OBSERVATIONS+'/backup.json')['verified']
    m.record_backup('backup-start'); m.record_backup('backup-failed')
    receipt=m.read_json(m.OBSERVATIONS+'/backup.json')
    assert receipt['verified']==prior and receipt['attempt']['outcome']=='failed'
    rows=m.backup_checks(receipt,int(m.time.time()*1000))
    assert rows[1]['reason']=='backup_stale'
    pathlib.Path(directory+'/postgres.dump').write_bytes(b'changed')
    try: m.backup_checks(receipt,int(m.time.time()*1000))
    except ValueError: pass
    else: raise AssertionError('modified artifacts accepted')
`));
test('units keep failed collector independent, constrain privileges and never grant Docker/controller', async () => {
  const [collector, mailer, timer, source, wrapper] = await Promise.all([
    'ops/ownerinc-portal-observe.service', 'ops/ownerinc-portal-monitor.service', 'ops/ownerinc-portal-monitor.timer',
    'ops/portal-operational-observe.py', 'ops/backup-from-timer.sh',
  ].map(filename => readFile(filename, 'utf8')));
  assert.match(mailer, /^Wants=ownerinc-portal-observe.service$/m);
  assert.match(mailer, /^After=ownerinc-portal-observe.service/m);
  assert.doesNotMatch(mailer, /^Requires=/m); assert.match(mailer, /^User=portal-monitor$/m);
  assert.match(mailer, /flock --nonblock --no-fork/);
  assert.match(collector, /^ProtectSystem=strict$/m); assert.match(collector, /^IPAddressDeny=any$/m);
  assert.match(collector, /InaccessiblePaths=.*docker.sock/);
  assert.match(timer, /^OnUnitActiveSec=60s$/m);
  assert.doesNotMatch(source, /\['docker'|\['bash'|shell=True|repair_head=True|\.transition\(/);
  assert.match(source, /repair_head=False/);
  assert.ok(wrapper.indexOf('verify_backup_manifest "$destination"') < wrapper.indexOf('monitor_receipt backup-verified'));
  assert.ok(wrapper.indexOf('flock -w') < wrapper.indexOf('monitor_receipt backup-start'));
});
