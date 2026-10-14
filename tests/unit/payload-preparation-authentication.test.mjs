import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve('.');
const python = process.platform === 'win32' ? 'python' : 'python3';
const setup = String.raw`
import pathlib,sys,types,json,copy,hashlib,posixpath
repo=pathlib.Path(sys.argv[1])
def module(relative):
    m=types.ModuleType(relative);m.__file__=str(repo/relative)
    exec(compile((repo/relative).read_bytes(),m.__file__,'exec'),m.__dict__)
    return m
p=module('ops/provision-payload-candidate-trust.py')
l=module('ops/prepare-cms-authenticated.py')
v=module('ops/payload-candidate-verifier.py')
# Explicit protected-read/ownership/filesystem doubles, not native root evidence.
# Actual source bytes, schema validators, binding validators and hash checks run.
p.os.path=posixpath
sys.executable='/usr/bin/python3' # Explicit Linux interpreter identity double.
l.__file__=l.LAUNCHER
store={};events=[];loads=[]
def raw(value):return (json.dumps(value)+'\n').encode()
def put(name,data,mode=0o755):store[name]=(data,mode)
def read(name,mode,limit):
    data,actual=store[name]
    assert actual==mode and 0<len(data)<=limit
    return data
bootstrap_read=l.protected
p.read_protected=read;l.protected=read
for relative in p.PREPARATION_FILES:
    put(p.preparation_target(relative),(repo/relative).read_bytes(),p.preparation_mode(relative))
policy={'schemaVersion':1,'kind':'ownerinc-payload-candidate-policy-v1','environment':'production',
    'repository':'OWNERINC/portal_ownerinc','repositoryId':'123','workflow':'.github/workflows/ci.yml','workflowId':'456',
    'approvedRevisions':[{'commit':'a'*40,'workflowSha256':'b'*64}],
    'toolchain':{'files':{},'executables':{}}}
for relative in p.TOOL_FILES:
    data=(repo/relative).read_bytes();put(p.TOOL_ROOT+'/'+relative,data,0o755 if relative.endswith('.py') else 0o644)
    policy['toolchain']['files'][relative]=p.sha(data)
for role in ('node','git','python','gitRemoteHttps'):
    filename=p.TOOL_ROOT+'/bin/git-remote-https' if role=='gitRemoteHttps' else '/usr/bin/'+role
    if role=='python':filename=posixpath.realpath(sys.executable)
    data=('synthetic-executable-'+role).encode();put(filename,data)
    policy['toolchain']['executables'][role]={'path':filename,'sha256':p.sha(data)}
images={s:'ghcr.io/ownerinc/ownerinc-portal-'+s+'@sha256:'+'c'*64 for s in ('api','cron','cms')}
record={'schemaVersion':1,'kind':'payload-candidate-admission-record-v1','environment':'production',
    'repository':'OWNERINC/portal_ownerinc','repositoryId':'123','workflow':'.github/workflows/ci.yml','workflowId':'456',
    'workflowSha256':'b'*64,'commit':'a'*40,'runId':'789','runAttempt':'1','images':images,
    'artifacts':{role:{'id':str(i+1),'digest':'sha256:'+'d'*64} for i,role in enumerate(v.ROLES)},
    'qualificationContract':v.CONTRACT,'sourceTreeSha':'e'*40,'archiveBytes':42,'deploymentAuthorized':False}
for key in ('candidateSha256','qualifiedManifestSha256','recoveryReportSha256','sourceArchiveSha256','archiveSha256'):
    record[key]='f'*64
approval={'schemaVersion':1,'kind':'ownerinc-payload-preparation-approval-v1','environment':'production',
    'repository':'OWNERINC/portal_ownerinc','source':{'commit':'1'*40,
    'files':{r:p.sha(store[p.preparation_target(r)][0]) for r in p.PREPARATION_FILES}},
    'hostBaseline':{'currentCommit':'2'*40,'legacyImages':{s:images[s] for s in ('api','cron')},
    'releaseComposeSha256':'3'*64,'runtimeComposeSha256':'4'*64,'releaseOverrideSha256':None,
    'inventoryIdentity':'5'*64,'installedPredecessors':{'commonReceiver':'6'*64,'receiverHelper':None,
    'productionWrapper':None,'operationsGuard':None,'cmsCandidate':None}},'admission':{}}
def bind():
    policy_raw=raw(policy);put(p.POLICY_PATH,policy_raw,0o600)
    record['policySha256']=p.sha(policy_raw);record_raw=raw(record)
    approval['admission']={'policySha256':p.sha(policy_raw),'archiveSha256':record['archiveSha256'],'recordSha256':p.sha(record_raw)}
    put(v.REGISTRY+'/'+record['archiveSha256']+'.'+p.sha(policy_raw)+'.json',record_raw,0o600)
    put(l.APPROVAL,raw(approval),0o600)
bind()
real_load=l.load_authenticated
def load(data,filename):
    loads.append(filename)
    # Execute the actual captured, authenticated bytes, not a substitute validator.
    m=real_load(data,filename)
    if filename.endswith('provision-payload-candidate-trust.py'):m.read_protected=read
    else:
        m.read_protected=lambda name,limit,modes=(0o600,),private_parent=False:read(name,modes[0],limit)
    return m
l.load_authenticated=load
host_gate=l.verify_host_under_lock
l.verify_host_under_lock=lambda *args:None # Prior tests isolate source/admission from the host gate.
def denied(fn):
    try:fn()
    except Exception:return
    raise AssertionError('unexpected acceptance')
`;
function probe(code) {
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', setup + code, repo], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const hostModel = String.raw`
import stat
from unittest.mock import patch
captured={r:store[p.preparation_target(r)][0] for r in p.PREPARATION_FILES}
inv=l.load_authenticated(captured['ops/payload-control-inventory.py'],l.ROOT+'/ops/payload-control-inventory.py')
expected=inv.production_inventory(l.HOST_ROOT,l.RUNTIME,l.RELEASES,l.HOST_ROOT+'/current-release',l.LOCK,
 '/opt/ownerinc/backups/portal-ownerinc/daily',l.PRODUCTION_BACKUP,l.PRODUCTION_BACKUP+'/restore-protection',
 l.ENVIRONMENT,l.RUNTIME+'/compose.production.yaml',l.RUNTIME+'/compose.payload.production.yaml')
baseline=approval['hostBaseline'];baseline['inventoryIdentity']=inv.identity(expected)
release=l.RELEASES+'/'+baseline['currentCommit'];host={};reads=[]
def put_host(name,data,owner=(1000,1000),mode=0o644):host[name]=(data,owner,mode)
put_host(l.HOST_ROOT+'/current-release',(release+'\n').encode())
put_host(release+'/.image-env',('API_IMAGE='+images['api']+'\nCRON_IMAGE='+images['cron']+'\n').encode())
for filename,field in [(release+'/docker-compose.yml','releaseComposeSha256'),(l.RUNTIME+'/compose.production.yaml','runtimeComposeSha256')]:
 put_host(filename,b'approved-compose\n');baseline[field]=p.sha(b'approved-compose\n')
put_host(l.ENVIRONMENT,b'PRIVATE=not-printed\n',mode=0o600)
put_host('/usr/local/libexec/ownerinc-portal-deploy',b'approved predecessor',(0,0),0o755)
baseline['installedPredecessors']['commonReceiver']=p.sha(b'approved predecessor')
def host_read(name,owner=(1000,1000),modes=(0o600,0o644),limit=2*1024*1024):
 reads.append(name);data,actual_owner,mode=host[name]
 assert actual_owner==owner and mode in modes and 0<len(data)<=limit
 return data
l.host_read=host_read;l.host_ancestry=lambda _:None
metadata_overrides={}
def metadata(name):
 if name in host:
  data,owner,mode=host[name];kind=stat.S_IFREG;size=len(data)
 else:
  owner=(0,0);mode=0o700 if name.endswith('payload-control-state') else 0o755;kind=stat.S_IFDIR;size=0
 result=types.SimpleNamespace(st_mode=kind|mode,st_uid=owner[0],st_gid=owner[1],st_nlink=1,st_size=size,
  st_dev=1,st_ino=2,st_mtime_ns=3,st_ctime_ns=4)
 result.__dict__.update(metadata_overrides.get(name,{}))
 return result
state_present=[False];names=['00000000000000000000.json','current.json']
def exists(name):return name in host or name==l.RUNTIME+'/payload-control-state' and state_present[0]
state=l.load_state_captured(captured,inv)
assert state.INVENTORY is inv
initial={'schemaVersion':2,'phase':'preauthority','cmsStatus':'cold','authority':{'mode':'legacy','epoch':1},
 'workerHold':True,'admission':'open','sequence':0,'previousStateSha256':None,'restoreIntent':None,'installIntent':None,
 'latestProofSha256':None,'legacySourceProofSha256':None,'releaseImages':None,'plannedReleaseImages':None,
 'rollbackTargetImages':None,'nativeCatalogFingerprint':None,'inventoryIdentity':baseline['inventoryIdentity']}
key=b'K'*32
def install_state(body):
 state_present[0]=True
 put_host(l.RUNTIME+'/payload-control-inventory.json',inv.canonical(expected)+b'\n',(0,0),0o600)
 put_host(l.RUNTIME+'/payload-control.key',key,(0,0),0o600)
 envelope=state.canonical(state.sign_envelope(body,key))+b'\n'
 for name in names:put_host(l.RUNTIME+'/payload-control-state/'+name,envelope,(0,0),0o600)
def run_host():
 # This fixture represents a root administrative caller and root-owned state,
 # not the Node runner's UID. Exercise POSIX guards even on Windows. Only OS
 # observations are doubled: actual state.read_state/HMAC/journal checks run.
 with patch.multiple(l.os,name='posix',getuid=lambda:0,geteuid=lambda:0,getgid=lambda:0,getegid=lambda:0,create=True), \
      patch.object(l.os.path,'lexists',side_effect=exists),patch.object(l.os,'lstat',side_effect=metadata),patch.object(l.os,'listdir',return_value=names):
  l.verify_host_baseline(approval,captured,images['cms'],p)
`;

test('root host fixture verifies signed state even when the test runner is POSIX non-root (identity doubles)', () => {
  probe(hostModel + String.raw`
install_state(initial)
with patch.object(l.os,'name','posix'),patch.object(l.os,'geteuid',return_value=1001,create=True):
 run_host()
 assert l.os.geteuid()==1001,'fixture identity must not escape run_host scope'
`);
});

test('root host fixture still rejects unsafe POSIX runtime metadata and invalid signed journals (observation doubles)', () => {
  probe(hostModel + String.raw`
install_state(initial);run_host()
for defect in ({'st_uid':1001},{'st_mode':stat.S_IFDIR|0o777},{'st_mode':stat.S_IFLNK|0o755}):
 metadata_overrides[l.RUNTIME]=defect
 try:run_host()
 except Exception as error:assert str(error)=='unsafe_private_state_directory',str(error)
 else:raise AssertionError('unsafe runtime metadata accepted')
 metadata_overrides.clear()
run_host()
# Canonical, correctly shaped envelope with only its HMAC altered: failure must
# come from the real cryptographic verifier, not JSON parsing or a stub reader.
head=l.RUNTIME+'/payload-control-state/current.json'
envelope=json.loads(host[head][0]);signature=envelope['signature']['value']
envelope['signature']['value']=('0' if signature[0]!='0' else '1')+signature[1:]
put_host(head,state.canonical(envelope)+b'\n',(0,0),0o600)
try:run_host()
except Exception as error:assert str(error)=='signature_invalid',str(error)
else:raise AssertionError('invalid signature accepted')
`);
});

test('host gate checks fixed approved baseline, predecessor/desired retries and exact signed initial state without writes (I/O doubles)', () => {
  probe(hostModel + String.raw`
run_host() # Completely absent state/inventory is eligible; nothing created.
assert not state_present[0] and l.RUNTIME+'/payload-control.key' not in host
put_host('/usr/local/libexec/ownerinc-portal-deploy',captured['ops/deploy-from-ci.sh'],(0,0),0o755)
put_host(l.RUNTIME+'/cms-image-candidate.env',('CMS_IMAGE='+images['cms']+'\n').encode(),(0,0),0o644)
run_host() # Desired publication is an allowed retry, even when predecessor was absent.
install_state(initial);before=copy.deepcopy(host);run_host();assert host==before
# State imports the captured inventory even if adjacent filesystem import is poisoned.
import importlib.util
with patch.object(importlib.util,'spec_from_file_location',side_effect=AssertionError('reopened helper')):
 assert l.load_state_captured(captured,inv).INVENTORY is inv
`);
});

test('altered host baselines, partial keys, unknown inventory and signed noninitial states refuse without effects (I/O doubles)', () => {
  probe(hostModel + String.raw`
run_host()
for filename in list(host):
 if filename==l.ENVIRONMENT:continue # Secrets are deliberately not approved content hashes.
 before=host[filename];put_host(filename,b'changed',before[1],before[2]);denied(run_host);host[filename]=before
for field in ('inventoryIdentity','currentCommit','releaseComposeSha256','runtimeComposeSha256','releaseOverrideSha256'):
 before=baseline[field];baseline[field]='0'*(40 if field=='currentCommit' else 64);denied(run_host);baseline[field]=before
put_host(release+'/compose.ownerinc-vps.yaml',b'override');denied(run_host)
baseline['releaseOverrideSha256']=p.sha(b'override');run_host()
del host[release+'/compose.ownerinc-vps.yaml'];denied(run_host);baseline['releaseOverrideSha256']=None
put_host(l.RUNTIME+'/payload-control.key',key,(0,0),0o600);denied(run_host);del host[l.RUNTIME+'/payload-control.key']
state_present[0]=True;denied(run_host);state_present[0]=False
install_state(initial);run_host()
inventory_path=l.RUNTIME+'/payload-control-inventory.json';before=host.pop(inventory_path);denied(run_host);host[inventory_path]=before
for field,value in [('schemaVersion',1),('sequence',1),('cmsStatus','migrated'),('admission','closed'),
 ('workerHold',False),('restoreIntent',{}),('installIntent',{}),('nativeCatalogFingerprint','0'*64),
 ('plannedReleaseImages',images),('latestProofSha256','0'*64),('inventoryIdentity','0'*64)]:
 body=copy.deepcopy(initial);body[field]=value;install_state(body);before=copy.deepcopy(host);denied(run_host);assert host==before
install_state(initial)
head=l.RUNTIME+'/payload-control-state/current.json';data,owner,mode=host[head]
put_host(head,data.replace(b'"hmacSha256":"',b'"hmacSha256":"0'),owner,mode)
# Corrupt any byte if envelope spelling differs; always invalidate authenticated bytes.
put_host(head,b'not a signed head',owner,mode);denied(run_host)
install_state(initial);names.append('00000000000000000001.json');denied(run_host)
`);
});

test('lease is noncreating nontruncating FD9, refuses busy/replaced/missing lock before host reads, and releases own lock (syscall doubles)', () => {
  probe(String.raw`
import errno,stat
from unittest.mock import patch
info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o644,st_uid=1000,st_gid=1000,st_nlink=1,st_size=7,
 st_dev=1,st_ino=2,st_mtime_ns=3,st_ctime_ns=4)
changed=copy.copy(info);changed.st_ino=3
l.host_ancestry=lambda _:None
l.os.O_NOFOLLOW=getattr(l.os,'O_NOFOLLOW',0);l.os.O_NONBLOCK=getattr(l.os,'O_NONBLOCK',0)
for scenario in ('success','busy','replaced-before','replaced-on-lock','replaced-after','missing','host-fails'):
 calls=[];held=[False];acquired=[False];opened=[False]
 def fstat(fd):
  if fd==9 and not opened[0]:raise OSError(errno.EBADF,'not open')
  return info
 def lstat(_):
  if scenario=='missing':raise FileNotFoundError()
  if scenario=='replaced-before' and opened[0] or scenario=='replaced-after' and acquired[0] or scenario=='replaced-on-lock' and held[0]:return changed
  return info
 def open_lock(filename,flags):
  assert filename==l.LOCK and not flags & (l.os.O_CREAT|l.os.O_TRUNC);opened[0]=True;return 9
 def lease(fd,unlock=False):
  assert fd==9
  calls.append('unlock' if unlock else 'lock')
  if scenario=='busy' and not unlock:raise BlockingIOError()
  held[0]=not unlock
 def host(*args):
  assert held[0];calls.append('host');acquired[0]=True
  if scenario=='host-fails':raise ValueError('refuse')
 with patch.object(l.os,'fstat',side_effect=fstat),patch.object(l.os,'lstat',side_effect=lstat), \
      patch.object(l.os,'open',side_effect=open_lock),patch.object(l.os,'close',side_effect=lambda fd:calls.append('close')), \
      patch.object(l,'lease_operation',side_effect=lease),patch.object(l,'verify_host_baseline',side_effect=host):
  if scenario=='success':host_gate(approval,{},images['cms'],p)
  else:denied(lambda:host_gate(approval,{},images['cms'],p))
 assert not held[0]
 if scenario in ('busy','replaced-before','replaced-on-lock','missing'):assert 'host' not in calls
 if scenario in ('success','replaced-on-lock','replaced-after','host-fails'):assert calls[-2:]==['unlock','close']
`);
});

test('native Linux flock preserves lock bytes, refuses contention and replacement, and releases FD9 (not host end-to-end)',
  { skip: process.env.PAYLOAD_REQUIRE_NATIVE_PREPARATION !== '1' &&
      !(process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0 &&
        process.getgid?.() === 0 && process.getegid?.() === 0) }, () => {
    assert.equal(process.platform, 'linux', 'required native preparation proof needs Linux');
    for (const identity of ['getuid', 'geteuid', 'getgid', 'getegid']) {
      assert.equal(process[identity]?.(), 0, `required native preparation proof needs ${identity}=0`);
    }
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', String.raw`
import os,sys,tempfile,pathlib,fcntl,importlib.util,shutil,subprocess,json
assert sys.platform=='linux' and os.getuid()==os.geteuid()==os.getgid()==os.getegid()==0
assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
spec=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert m.LOCK=='/opt/ownerinc/apps/portal-ownerinc-real/runtime/deploy.lock'
m.host_ancestry('/root/preparation-ancestry-check')
root=tempfile.mkdtemp(prefix='preparation-flock-',dir='/root')
proof={'kind':'native-preparation-lease-proof','rootIdentity':True,'protectedAncestry':True}
try:
 m.LOCK=root+'/deploy.lock';pathlib.Path(m.LOCK).write_bytes(b'never truncated');os.chmod(m.LOCK,0o600)
 # Only LOCK is redirected; all production metadata and lease primitives run.
 m.host_ancestry(m.LOCK)
 # Regression: a sole inherited SH lease must not be upgraded to EX by checking.
 shared=os.open(m.LOCK,os.O_RDWR)
 if shared!=9:os.dup2(shared,9);os.close(shared)
 fcntl.flock(9,fcntl.LOCK_SH|fcntl.LOCK_NB)
 try:
  try:m.verify_inherited_lease()
  except m.VerificationError:pass
  else:raise AssertionError('inherited shared lease accepted/upgraded')
  proof['sharedRefused']=True
  assert os.fstat(9).st_ino==os.stat(m.LOCK).st_ino,'rejection closed original FD9'
  probe=os.open(m.LOCK,os.O_RDWR)
  try:
   fcntl.flock(probe,fcntl.LOCK_SH|fcntl.LOCK_NB) # Original must still be SH, not EX.
   fcntl.flock(probe,fcntl.LOCK_UN)
   try:fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:pass # Original SH must still be held, not unlocked.
   else:raise AssertionError('rejection released original shared lease')
   proof['originalSharedUnchanged']=True
  finally:os.close(probe)
 finally:os.close(9)
 busy=os.open(m.LOCK,os.O_RDWR);fcntl.flock(busy,fcntl.LOCK_EX|fcntl.LOCK_NB)
 try:
  try:
   with m.deployment_lease():raise AssertionError('busy lease accepted')
  except BlockingIOError:pass
  proof['busyRefused']=True
  # A separate FD9 must not claim another open description's existing EX lock.
  foreign=os.open(m.LOCK,os.O_RDWR)
  if foreign!=9:os.dup2(foreign,9);os.close(foreign)
  try:
   try:m.verify_inherited_lease()
   except BlockingIOError:pass
   else:raise AssertionError('foreign exclusive lock accepted')
   assert os.fstat(9).st_ino==os.stat(m.LOCK).st_ino
   proof['foreignDescriptionRefused']=True
  finally:os.close(9)
 finally:os.close(busy)
 with m.deployment_lease() as reaffirm:
  assert os.fstat(9).st_ino==os.stat(m.LOCK).st_ino;reaffirm()
  assert pathlib.Path(m.LOCK).read_bytes()==b'never truncated'
  code="import importlib.util,sys; s=importlib.util.spec_from_file_location('m',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); assert m.LOCK=='/opt/ownerinc/apps/portal-ownerinc-real/runtime/deploy.lock'; m.LOCK=sys.argv[2]; m.verify_inherited_lease(); print('inherited-FD9-PASS')"
  child=subprocess.run([sys.executable,'-I','-S','-B','-c',code,sys.argv[1],m.LOCK],pass_fds=(9,),capture_output=True,text=True,timeout=10)
  assert child.returncode==0 and child.stdout=='inherited-FD9-PASS\n',child.stderr
  proof['exclusiveSubprocessInheritance']=True
  probe=os.open(m.LOCK,os.O_RDWR)
  try:
   try:fcntl.flock(probe,fcntl.LOCK_SH|fcntl.LOCK_NB)
   except BlockingIOError:pass
   else:raise AssertionError('child released or downgraded parent exclusive lock')
   proof['parentExclusiveRetained']=True
  finally:os.close(probe)
 try:os.fstat(9)
 except OSError:pass
 else:raise AssertionError('FD9 leaked')
 proof['fd9Closed']=True
 try:
  with m.deployment_lease():
   os.rename(m.LOCK,m.LOCK+'.old');pathlib.Path(m.LOCK).write_bytes(b'replaced');os.chmod(m.LOCK,0o600)
 except m.VerificationError:pass
 else:raise AssertionError('replacement accepted')
 proof['pathReplacementRefused']=True
 old=os.open(m.LOCK+'.old',os.O_RDWR);fcntl.flock(old,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(old)
 assert pathlib.Path(m.LOCK+'.old').read_bytes()==b'never truncated'
 proof['originalBytesPreserved']=True
finally:shutil.rmtree(root)
assert not os.path.exists(root)
proof['sandboxRemoved']=True
print(json.dumps(proof,sort_keys=True))
`, path.join(repo, 'ops/prepare-cms-authenticated.py')], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 1024, 'native proof must be bounded');
    assert.deepEqual(JSON.parse(result.stdout), { kind: 'native-preparation-lease-proof',
      rootIdentity: true, protectedAncestry: true, sharedRefused: true, originalSharedUnchanged: true,
      busyRefused: true, foreignDescriptionRefused: true, exclusiveSubprocessInheritance: true,
      parentExclusiveRetained: true, fd9Closed: true, pathReplacementRefused: true,
      originalBytesPreserved: true, sandboxRemoved: true });
    console.log(result.stdout.trim());
  });

test('host-data reader retains exact deploy ownership, bounded stable bytes, and distinct trust ancestry (metadata doubles)', () => {
  probe(String.raw`
import stat,io
from unittest.mock import patch
info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o644,st_uid=1000,st_gid=1000,st_nlink=1,st_size=4,
 st_dev=1,st_ino=2,st_mtime_ns=3,st_ctime_ns=4)
l.host_ancestry=lambda _:None
l.os.O_NOFOLLOW=getattr(l.os,'O_NOFOLLOW',0);l.os.O_NONBLOCK=getattr(l.os,'O_NONBLOCK',0)
for field,value in [('st_uid',1234),('st_gid',0),('st_nlink',2),('st_mode',stat.S_IFLNK|0o644),
 ('st_mode',stat.S_IFREG|0o666),('st_size',3*1024*1024)]:
 bad=copy.copy(info);setattr(bad,field,value)
 with patch.object(l.os,'lstat',return_value=bad),patch.object(l.os,'open') as opened:
  denied(lambda:l.host_read('/host/data'));opened.assert_not_called()
for changed in (False,True):
 later=copy.copy(info)
 if changed:later.st_mtime_ns+=1
 with patch.object(l.os,'lstat',side_effect=[info,later]),patch.object(l.os,'open',return_value=4), \
      patch.object(l.os,'fstat',return_value=info),patch.object(l.os,'fdopen',return_value=io.BytesIO(b'data')),patch.object(l.os,'close'):
  if changed:denied(lambda:l.host_read('/host/data'))
  else:assert l.host_read('/host/data')==b'data'
# A preexisting FD9 is never adopted or closed in this check-only gate.
with patch.object(l.os,'fstat',return_value=info),patch.object(l.os,'open') as opened,patch.object(l.os,'close') as closed:
 def attempt():
  with l.deployment_lease():pass
 denied(attempt);opened.assert_not_called();closed.assert_not_called()
`);
});

test('dispatch retains parent lease across fixed child, binds approval continuity and fails closed on child/context errors (process doubles)', () => {
  probe(String.raw`
from contextlib import contextmanager
from unittest.mock import patch
material=l.authenticate();events=[];held=[False]
@contextmanager
def lease(close_only=False):
 assert close_only is True
 held[0]=True;events.append('acquire')
 def reaffirm():assert held[0];events.append('reaffirm')
 try:yield reaffirm
 finally:held[0]=False;events.append('release')
def baseline(*args):assert held[0];events.append('host')
def child(args,**kwargs):
 assert held[0] and kwargs['pass_fds']==(9,) and kwargs['check'] is False
 assert args==['/bin/bash','--noprofile','--norc',l.ROOT+'/ops/prepare-cms-infrastructure.sh','--authenticated-apply',material[4]]
 assert kwargs['env']=={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}
 events.append('child');return types.SimpleNamespace(returncode=0)
with patch.object(l,'deployment_lease',lease),patch.object(l,'verify_host_baseline',side_effect=baseline),patch.object(l.subprocess,'run',side_effect=child):
 result=l.dispatch('apply');assert result['preparationExecuted'] is True and result['deploymentAuthorized'] is False
 assert events.index('host')<events.index('child')<events.index('release') and events.count('host')==2
 with patch.object(l.subprocess,'run',return_value=types.SimpleNamespace(returncode=2)):
  denied(lambda:l.dispatch('apply'));assert not held[0]
 with patch.object(l,'authenticate',side_effect=[material,(*material[:4],'0'*64)]),patch.object(l.subprocess,'run') as run:
  denied(lambda:l.dispatch('apply'));run.assert_not_called();assert not held[0]
# Inherited-context flags/digests do not replace independent authentication.
with patch.object(l,'verify_inherited_lease') as inherited,patch.object(l,'verify_host_baseline'):
 frame=l.verified_context(material[4]).splitlines()
 assert len(frame)==8 and frame[:3]==[material[4],approval['hostBaseline']['currentCommit'],images['cms']]
 assert inherited.call_count==2
 denied(lambda:l.verified_context('0'*64));denied(lambda:l.verified_context('APPROVED=1'))
 with patch.object(l,'authenticate',side_effect=ValueError('untrusted')):
  denied(lambda:l.verified_context(material[4]))
`);
});

test('inherited context refuses shared, unlocked, foreign-description, missing and replaced FD9 without unlocking parent (syscall doubles)', () => {
  probe(String.raw`
import stat
from unittest.mock import patch
info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o644,st_uid=1000,st_gid=1000,st_nlink=1,st_size=7,
 st_dev=1,st_ino=2,st_mtime_ns=3,st_ctime_ns=4)
other=copy.copy(info);other.st_ino=3
l.host_ancestry=lambda _:None;l.os.O_NOFOLLOW=getattr(l.os,'O_NOFOLLOW',0);l.os.O_NONBLOCK=getattr(l.os,'O_NONBLOCK',0)
for scenario in ('valid','shared','unlocked','foreign','missing','replaced'):
 calls=[]
 def fstat(fd):
  if scenario=='missing' and fd==9:raise OSError('missing')
  return other if scenario=='replaced' and fd==9 else info
 def lease(fd,unlock=False,shared=False):
  calls.append((fd,unlock));assert not (fd==9 and unlock)
  if not unlock and (fd==10 and scenario!='unlocked' and not (scenario=='shared' and shared) or fd==9 and scenario=='foreign'):raise BlockingIOError()
 with patch.object(l.os,'lstat',return_value=info),patch.object(l.os,'fstat',side_effect=fstat), \
      patch.object(l.os,'open',return_value=10),patch.object(l.os,'close') as closed,patch.object(l,'lease_operation',side_effect=lease):
  if scenario=='valid':l.verify_inherited_lease()
  else:denied(l.verify_inherited_lease)
  assert (9,True) not in calls
  if scenario in ('shared','unlocked'):assert all(fd!=9 for fd,_ in calls),'must reject before touching inherited FD9'
  if scenario=='shared':closed.assert_called_once_with(10)
# A dispatch error closes the parent's reference, never explicitly unlocks a
# possibly surviving descendant that inherited the same open description.
import errno
count=[0]
def initial_fd(fd):
 count[0]+=1
 if count[0]==1:raise OSError(errno.EBADF,'not open')
 return info
with patch.object(l.os,'lstat',return_value=info),patch.object(l.os,'fstat',side_effect=initial_fd), \
     patch.object(l.os,'open',return_value=9),patch.object(l.os,'close') as closed,patch.object(l,'lease_operation') as locking:
 def interrupted():
  with l.deployment_lease(close_only=True):raise ValueError('child interrupted')
 denied(interrupted)
 assert locking.call_args_list==[__import__('unittest.mock',fromlist=['call']).call(9)]
 closed.assert_called_once_with(9)
`);
});

test('all 15 source files authenticate before any closure helper; fixed report never authorizes execution (read doubles)', () => {
  probe(String.raw`
assert p.PREPARATION_FILES==l.FILES and len(l.FILES)==15
assert p.PREPARATION_LAUNCHER=='/usr/local/libexec/ownerinc-payload-prepare.py'
assert p.PREPARATION_ROOT=='/opt/ownerinc/lib/payload-preparation'
assert p.PREPARATION_APPROVAL=='/etc/ownerinc/payload-preparation/production-approval.json'
result=l.verify()
assert result=={'kind':'payload-preparation-verification-only','sourceAuthenticated':True,
    'admissionRecordAuthenticated':True,'cmsImage':images['cms'],'hostBaselineChecked':True,
    'archiveBytesChecked':False,'preparationExecuted':False,'deploymentAuthorized':False}
assert len(loads)==2
for relative in p.PREPARATION_FILES:
    filename=p.preparation_target(relative);before=store[filename];loads.clear()
    put(filename,b'raise Exception("MUST NOT EXECUTE")\n',before[1])
    denied(l.verify);assert loads==[],relative
    store[filename]=before
sys.argv=['launcher','--apply'];denied(l.main)
sys.argv=['launcher','--check','--source=/deploy/checkout'];denied(l.main)
`);
});

test('strict independent approval rejects extra/missing fields and candidate-policy substitution', () => {
  probe(String.raw`
p.validate_preparation_approval(approval)
denied(lambda:p.validate_approval(approval));denied(lambda:p.validate_preparation_approval(policy))
mutations=[lambda a:a.update(schemaVersion=True),lambda a:a.update(kind=policy['kind']),
 lambda a:a.update(environment='staging'),lambda a:a.update(repository='other/repo'),
 lambda a:a.update(approvedRevisions=policy['approvedRevisions']),lambda a:a['source'].update(commit='main'),
 lambda a:a['source']['files'].update({'extra':'a'*64}),lambda a:a['source']['files'].pop(l.FILES[0]),
 lambda a:a['hostBaseline'].update(currentCommit='observed'),lambda a:a['hostBaseline'].update(inventoryIdentity=None),
 lambda a:a['hostBaseline'].update(releaseOverrideSha256=False),lambda a:a['hostBaseline'].update(allowMigrated=True),
 lambda a:a['hostBaseline']['legacyImages'].update(api='latest'),
 lambda a:a['hostBaseline']['installedPredecessors'].update(commonReceiver=None),
 lambda a:a['admission'].update(recordSha256='not-a-hash'),lambda a:a['admission'].update(cmsImage=images['cms'])]
for mutate in mutations:
    a=copy.deepcopy(approval);mutate(a);denied(lambda:p.validate_preparation_approval(a))
denied(lambda:p.strict_json(b'{"schemaVersion":1,"schemaVersion":1}'))
`);
});

test('bootstrap reader rejects unsafe ancestry and leaf metadata before opening helpers (metadata doubles)', () => {
  probe(String.raw`
import stat
from unittest.mock import patch
def info(mode,uid=0,gid=0,nlink=1):
    return types.SimpleNamespace(st_mode=mode,st_uid=uid,st_gid=gid,st_nlink=nlink,st_size=10,
      st_dev=1,st_ino=2,st_mtime_ns=3,st_ctime_ns=4)
safe=info(stat.S_IFDIR|0o755);leaf=info(stat.S_IFREG|0o755)
for bad in [info(stat.S_IFLNK|0o755),info(stat.S_IFDIR|0o777),info(stat.S_IFDIR|0o755,uid=1000),
            info(stat.S_IFDIR|0o775),info(stat.S_IFDIR|0o755,gid=1000)]:
    with patch.object(l.os,'lstat',return_value=bad),patch.object(l.os,'open') as opened:
        denied(lambda:bootstrap_read('/fixed/support.py',0o755,100));opened.assert_not_called()
for bad in [info(stat.S_IFLNK|0o755),info(stat.S_IFREG|0o777),info(stat.S_IFREG|0o755,uid=1000),
            info(stat.S_IFREG|0o755,nlink=2),info(stat.S_IFREG|0o644)]:
    with patch.object(l.os,'lstat',side_effect=lambda f:bad if f.endswith('.py') else safe),patch.object(l.os,'open') as opened:
        denied(lambda:bootstrap_read('/fixed/support.py',0o755,100));opened.assert_not_called()
`);
});

test('actual admission validators reject forged approved-hash records and wrong policy/image/toolchain (read doubles)', () => {
  probe(String.raw`
assert l.verify()['admissionRecordAuthenticated'] is True
original=copy.deepcopy(record)
for key,value in [('deploymentAuthorized',True),('qualificationContract','forged'),('workflowSha256','0'*64),
                  ('commit','0'*40),('repositoryId','999'),('archiveBytes',0),('images',dict(images,cms='latest'))]:
    record.clear();record.update(copy.deepcopy(original));record[key]=value;bind()
    denied(l.verify)
record.clear();record.update(original);bind()
record_path=v.REGISTRY+'/'+record['archiveSha256']+'.'+record['policySha256']+'.json'
record['images']=dict(images,cms='ghcr.io/ownerinc/ownerinc-portal-cms@sha256:'+'0'*64)
put(record_path,raw(record),0o600);denied(l.verify) # Valid-shaped image cannot escape exact approved bytes.
record.clear();record.update(copy.deepcopy(original));bind()
approval['admission']['archiveSha256']='0'*64;put(l.APPROVAL,raw(approval),0o600);denied(l.verify)
bind();approval['admission']['recordSha256']='0'*64;put(l.APPROVAL,raw(approval),0o600);denied(l.verify)
bind();approval['admission']['policySha256']='0'*64;put(l.APPROVAL,raw(approval),0o600);denied(l.verify)
bind()
for filename in [p.TOOL_ROOT+'/'+r for r in p.TOOL_FILES]+[e['path'] for e in policy['toolchain']['executables'].values()]:
    before=store[filename];put(filename,b'not approved',before[1]);loads.clear();denied(l.verify)
    assert len(loads)==1,'verifier executed before complete toolchain authentication'
    store[filename]=before
`);
});

test('preparation provisioning snapshots, conflicts, interruption retry and approval-last reuse existing primitives (publication doubles)', () => {
  probe(String.raw`
# Publication model tests ordering only. Native syscall proof remains in trust suite.
bundle='/root/preparation-bundle';approval_path='/root/approval.json'
for relative in p.PREPARATION_FILES:store[bundle+'/'+relative]=store.pop(p.preparation_target(relative))
put(approval_path,store.pop(l.APPROVAL)[0],0o600)
digest=p.sha(store[approval_path][0]);original=copy.deepcopy(store)
p.directories=lambda *args,**kwargs:None
p.bundle_layout=lambda b,n:p.require(set(k[len(b)+1:] for k in store if k.startswith(b+'/'))==set(n),'layout')
def existing(filename,expected):
    if filename not in store:return False
    p.require(store[filename]==expected[:2],'destination_conflict');return True
p.existing_target=existing
p.snapshot_prestate=lambda *args:events.append('snapshot')
def publish(filename,expected):
    existing(filename,expected);events.append(filename);put(filename,*expected[:2])
p.publish=publish
call=lambda mode:p.provision_preparation(mode,approval_path,digest,bundle)
assert 'no files written' in call('check') and store==original and events==[]
# Unknown destination refuses before snapshot or any publication.
target=p.preparation_target(p.PREPARATION_FILES[0]);put(target,b'unknown');denied(lambda:call('apply'))
assert events==[];del store[target]
def interrupted(filename,expected):
    if len(events)==5:raise OSError('interrupted')
    publish(filename,expected)
p.publish=interrupted;denied(lambda:call('apply'));assert l.APPROVAL not in store
p.publish=publish;events.clear();call('apply')
assert events[0]=='snapshot' and events[-1]==l.APPROVAL
before=copy.deepcopy(store);events.clear();call('apply')
assert store==before and 'snapshot' not in events
# Existing different approval is not replaced; source approval is independently pinned.
put(l.APPROVAL,b'conflict',0o600);events.clear();denied(lambda:call('apply'));assert events==[]
denied(lambda:p.load_preparation_inputs(approval_path,'0'*64,bundle))
`);
});
