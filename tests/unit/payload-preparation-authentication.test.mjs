import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 l.ENVIRONMENT,l.RUNTIME+'/compose.production.yaml',l.RUNTIME+'/compose.payload.production.yaml','portal')
baseline=approval['hostBaseline'];baseline['inventoryIdentity']=inv.identity(expected)
release=l.RELEASES+'/'+baseline['currentCommit'];host={};reads=[]
def put_host(name,data,owner=(1000,1000),mode=0o644):host[name]=(data,owner,mode)
put_host(l.HOST_ROOT+'/current-release',(release+'\n').encode())
put_host(release+'/.image-env',('API_IMAGE='+images['api']+'\nCRON_IMAGE='+images['cron']+'\n').encode())
for filename,field in [(release+'/docker-compose.yml','releaseComposeSha256'),(l.RUNTIME+'/compose.production.yaml','runtimeComposeSha256')]:
 put_host(filename,b'approved-compose\n');baseline[field]=p.sha(b'approved-compose\n')
environment_secret=b'COLLECTOR_MUST_NOT_READ_THIS_SECRET_VALUE'
put_host(l.ENVIRONMENT,b'PRIVATE='+environment_secret+b'\nPOSTGRES_DB=portal\nCMS_PORTAL_DATABASE_NAME=portal\n',mode=0o600)
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
def run_host(metadata_only=False):
 # This fixture represents a root administrative caller and root-owned state,
 # not the Node runner's UID. Exercise POSIX guards even on Windows. Only OS
 # observations are doubled: actual state.read_state/HMAC/journal checks run.
 with patch.multiple(l.os,name='posix',getuid=lambda:0,geteuid=lambda:0,getgid=lambda:0,getegid=lambda:0,create=True), \
      patch.object(l.os.path,'lexists',side_effect=exists),patch.object(l.os,'lstat',side_effect=metadata),patch.object(l.os,'listdir',return_value=names):
   l.verify_host_baseline(approval,captured,images['cms'],p,metadata_only=metadata_only)
def run_inspect(metadata_only=False):
 with patch.multiple(l.os,name='posix',getuid=lambda:0,geteuid=lambda:0,getgid=lambda:0,getegid=lambda:0,create=True), \
      patch.object(l.os.path,'lexists',side_effect=exists),patch.object(l.os,'lstat',side_effect=metadata),patch.object(l.os,'listdir',return_value=names):
  return l.inspect_install_host(approval,captured,metadata_only=metadata_only)
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

test('collector and inspection authenticate the protected environment while binding the configured Portal database', () => {
  probe(hostModel + String.raw`
install_state(initial)
assert environment_secret in host[l.ENVIRONMENT][0]
reads.clear();run_host(metadata_only=True)
assert l.ENVIRONMENT in reads
reads.clear();runtime,document,body,observations=run_inspect(metadata_only=True)
assert l.ENVIRONMENT in reads and body==initial
# Both paths now read the protected file without sourcing it so POSTGRES_DB and
# CMS_PORTAL_DATABASE_NAME are bound to the authenticated inventory identity.
reads.clear();run_host();assert l.ENVIRONMENT in reads
reads.clear();run_inspect();assert l.ENVIRONMENT in reads
data,owner,mode=host[l.ENVIRONMENT]
put_host(l.ENVIRONMENT,data,owner,0o644)
for operation in (lambda:run_host(metadata_only=True),lambda:run_inspect(metadata_only=True)):
 reads.clear()
 try:operation()
 except Exception as error:assert str(error)=='unsafe_environment_permissions',str(error)
 else:raise AssertionError('unsafe collector environment metadata accepted')
 assert l.ENVIRONMENT not in reads
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

test('native Linux root qualifies the production context envelope on an isolated real filesystem',
  { skip: process.env.PAYLOAD_REQUIRE_NATIVE_PREPARATION !== '1' &&
      !(process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0 &&
        process.getgid?.() === 0 && process.getegid?.() === 0) }, () => {
    assert.equal(process.platform, 'linux', 'required native preparation proof needs Linux');
    for (const identity of ['getuid', 'geteuid', 'getgid', 'getegid']) {
      assert.equal(process[identity]?.(), 0, `required native preparation proof needs ${identity}=0`);
    }
    let sandbox;
    let result;
    try {
      sandbox = mkdtempSync('/root/payload-context-observer-');
      result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', String.raw`
import os,sys,pathlib,fcntl,importlib.util,shutil,json,hashlib,time,stat
assert sys.platform=='linux' and os.getuid()==os.geteuid()==os.getgid()==os.getegid()==0
assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
repo=pathlib.Path(sys.argv[1]);root=sys.argv[2];source_path=repo/'ops/prepare-cms-authenticated.py'
assert os.path.basename(root).startswith('payload-context-observer-') and os.path.dirname(root)=='/root'
assert os.path.isdir(root) and os.stat(root).st_uid==0;os.chmod(root,0o700)
audit_log=root+'/file-open-audit.jsonl'
audit_dir=root+'/process-open-audits';os.mkdir(audit_dir,0o700);os.chmod(audit_dir,0o700)
real_os_open=os.open
parent_audit_fd=real_os_open(audit_log,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_APPEND,0o600)
os.fchmod(parent_audit_fd,0o600);audit_active=[True];audit_state=[None];parent_audit_records=[]
production_roots=tuple(os.path.realpath(os.path.abspath(os.path.normpath(item))) for item in
 ('/opt/ownerinc','/etc/ownerinc','/var/lib/ownerinc','/usr/local/libexec'))
def pipe_target(target):
 return target.startswith('pipe:[') and target.endswith(']') and bool(target[6:-1]) and all('0'<=character<='9' for character in target[6:-1])
def descriptor_target(descriptor,reason,require_directory=False):
 try:target=os.readlink('/proc/self/fd/'+str(descriptor))
 except OSError as error:raise RuntimeError(reason) from error
 info=os.fstat(descriptor)
 if os.path.isabs(target) and not target.endswith(' (deleted)'):
  if require_directory and not stat.S_ISDIR(info.st_mode):raise RuntimeError(reason)
  return 'filesystem',os.path.realpath(target)
 if not require_directory and pipe_target(target) and stat.S_ISFIFO(info.st_mode):
  return 'pipe',target
 raise RuntimeError(reason)
def canonical_target(filename,dir_fd=None):
 if isinstance(filename,int):
  return descriptor_target(filename,'unresolved_open_descriptor')
 value=os.fsdecode(filename)
 if not os.path.isabs(value):
  if dir_fd is None:base=os.getcwd()
  else:base=descriptor_target(dir_fd,'unresolved_parent_dir_fd',True)[1]
  value=os.path.join(base,value)
 return 'filesystem',os.path.realpath(value)
def forbidden_target(target_kind,target):
 return target_kind=='filesystem' and any(os.path.commonpath((target,item))==item for item in production_roots)
def append_parent_open(api,target_kind,target):
 entry={'api':api,'pid':os.getpid(),'target':target,'targetKind':target_kind}
 frame=(json.dumps(entry,sort_keys=True,separators=(',',':'))+'\n').encode()
 written=os.write(parent_audit_fd,frame)
 if written!=len(frame):raise RuntimeError('parent_audit_short_write')
 parent_audit_records.append(entry)
 if forbidden_target(target_kind,target):raise AssertionError('unchanged_production_root_open:'+target)
def record_open(event,args):
 if not audit_active[0]:return
 state=audit_state[0]
 if state is not None:
  if event!='open' or not args or os.fsdecode(args[0])!=state['path']:raise RuntimeError('unexpected_parent_audit_reentrancy')
  state['seen']=True;return
 if event=='open':append_parent_open('open',*canonical_target(args[0]))
sys.addaudithook(record_open)
def audited_os_open(filename,flags,mode=0o777,*,dir_fd=None):
 target_kind,target=canonical_target(filename,dir_fd);append_parent_open('os.open',target_kind,target)
 state={'path':os.fsdecode(filename),'seen':False};audit_state[0]=state
 try:return real_os_open(filename,flags,mode,dir_fd=dir_fd)
 finally:
  audit_state[0]=None
  if not state['seen']:raise RuntimeError('missing_parent_os_open_audit_event')
os.open=audited_os_open
assert forbidden_target(*canonical_target('/opt/ownerinc/../ownerinc/audit-probe'))
escape=root+'/audit-production-link';os.symlink('/opt/ownerinc',escape)
assert forbidden_target(*canonical_target(escape+'/audit-probe'));os.unlink(escape)
root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
try:assert canonical_target(b'dir-fd-probe',root_fd)==('filesystem',root+'/dir-fd-probe')
finally:os.close(root_fd)
def load(name,filename):
 spec=importlib.util.spec_from_file_location(name,filename);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
production=load('production_launcher_contract',source_path)
assert production.HOST_ROOT=='/opt/ownerinc/apps/portal-ownerinc-real'
assert production.ROOT=='/opt/ownerinc/lib/payload-preparation'
assert production.APPROVAL=='/etc/ownerinc/payload-preparation/production-approval.json'
prefixes={'/opt/ownerinc':root+'/opt/ownerinc','/etc/ownerinc':root+'/etc/ownerinc',
 '/var/lib/ownerinc':root+'/var/lib/ownerinc','/usr/local/libexec':root+'/usr/local/libexec'}
forbidden=tuple(prefixes)
def redirect(raw):
 for old,new in prefixes.items():raw=raw.replace(old.encode(),new.encode())
 return raw
def instrument(raw):
 first,separator,rest=raw.partition(b'\n');assert separator
 hook=f'''import os as _fixture_audit_os,sys as _fixture_audit_sys,json as _fixture_audit_json,stat as _fixture_audit_stat
if _fixture_audit_sys.argv[1:]==['collect-context'] and _fixture_audit_os.path.realpath(_fixture_audit_sys.argv[0])==_fixture_audit_os.path.realpath({(prefixes['/opt/ownerinc']+'/lib/payload-preparation/ops/payload-production-observer.py')!r}) and not getattr(_fixture_audit_sys,'_payload_fixture_open_audit',False):
 _fixture_audit_sys._payload_fixture_open_audit=True
 _fixture_real_os_open=_fixture_audit_os.open
 _fixture_audit_log={audit_dir!r}+'/child-'+str(_fixture_audit_os.getpid())+'.jsonl'
 _fixture_log_fd=_fixture_real_os_open(_fixture_audit_log,_fixture_audit_os.O_WRONLY|_fixture_audit_os.O_CREAT|_fixture_audit_os.O_EXCL|_fixture_audit_os.O_APPEND,0o600)
 _fixture_audit_os.fchmod(_fixture_log_fd,0o600);_fixture_audit_os.close(_fixture_log_fd)
 _fixture_audit_state=[None]
 _fixture_production_roots={production_roots!r}
 def _fixture_pipe_target(_target):
  return _target.startswith('pipe:[') and _target.endswith(']') and bool(_target[6:-1]) and all('0'<=_character<='9' for _character in _target[6:-1])
 def _fixture_descriptor_target(_descriptor,_reason,_require_directory=False):
  try:_target=_fixture_audit_os.readlink('/proc/self/fd/'+str(_descriptor))
  except OSError as _error:raise RuntimeError(_reason) from _error
  _info=_fixture_audit_os.fstat(_descriptor)
  if _fixture_audit_os.path.isabs(_target) and not _target.endswith(' (deleted)'):
   if _require_directory and not _fixture_audit_stat.S_ISDIR(_info.st_mode):raise RuntimeError(_reason)
   return 'filesystem',_fixture_audit_os.path.realpath(_target)
  if not _require_directory and _fixture_pipe_target(_target) and _fixture_audit_stat.S_ISFIFO(_info.st_mode):
   return 'pipe',_target
  raise RuntimeError(_reason)
 def _fixture_canonical_target(_filename,_dir_fd=None):
  if isinstance(_filename,int):
   return _fixture_descriptor_target(_filename,'unresolved_child_open_descriptor')
  _value=_fixture_audit_os.fsdecode(_filename)
  if not _fixture_audit_os.path.isabs(_value):
   if _dir_fd is None:_base=_fixture_audit_os.getcwd()
   else:_base=_fixture_descriptor_target(_dir_fd,'unresolved_child_dir_fd',True)[1]
   _value=_fixture_audit_os.path.join(_base,_value)
  return 'filesystem',_fixture_audit_os.path.realpath(_value)
 def _fixture_forbidden_target(_target_kind,_target):
  return _target_kind=='filesystem' and any(_fixture_audit_os.path.commonpath((_target,_root))==_root for _root in _fixture_production_roots)
 _fixture_audit_records=[]
 def _fixture_append_open(_api,_target_kind,_target):
  _entry={{'api':_api,'pid':_fixture_audit_os.getpid(),'target':_target,'targetKind':_target_kind}}
  _frame=(_fixture_audit_json.dumps(_entry,sort_keys=True,separators=(',',':'))+'\\n').encode()
  _state={{'mode':'log','path':_fixture_audit_log,'seen':False}};_fixture_audit_state[0]=_state
  _fd=None
  try:
   _fd=_fixture_real_os_open(_fixture_audit_log,_fixture_audit_os.O_WRONLY|_fixture_audit_os.O_APPEND)
  finally:
   _fixture_audit_state[0]=None
   if not _state['seen']:raise RuntimeError('missing_child_log_open_audit_event')
  try:
   _written=_fixture_audit_os.write(_fd,_frame)
   if _written!=len(_frame):raise RuntimeError('child_audit_short_write')
  finally:_fixture_audit_os.close(_fd)
  if _fixture_forbidden_target(_target_kind,_target):raise AssertionError('unchanged_production_root_open:'+_target)
  _fixture_audit_records.append(_entry)
 def _fixture_record_open(_event,_args):
  _state=_fixture_audit_state[0]
  if _state is not None:
   if _event!='open' or not _args or _fixture_audit_os.fsdecode(_args[0])!=_state['path']:raise RuntimeError('unexpected_child_audit_reentrancy')
   _state['seen']=True;return
  if _event=='open':_fixture_append_open('open',*_fixture_canonical_target(_args[0]))
 _fixture_audit_sys.addaudithook(_fixture_record_open)
 def _fixture_audited_os_open(_filename,_flags,mode=0o777,*,dir_fd=None):
  _dir_fd=dir_fd
  _open_mode=mode
  _target_kind,_target=_fixture_canonical_target(_filename,_dir_fd);_fixture_append_open('os.open',_target_kind,_target)
  _state={{'mode':'os.open','path':_fixture_audit_os.fsdecode(_filename),'seen':False}};_fixture_audit_state[0]=_state
  try:return _fixture_real_os_open(_filename,_flags,_open_mode,dir_fd=_dir_fd)
  finally:
   _fixture_audit_state[0]=None
   if not _state['seen']:raise RuntimeError('missing_child_os_open_audit_event')
 _fixture_audit_os.open=_fixture_audited_os_open
'''.encode()
 return first+b'\n'+hook+rest
def mkdir(filename,mode=0o755):
 pathlib.Path(filename).mkdir(parents=True,exist_ok=True);os.chmod(filename,mode)
def write(filename,data,mode=0o600,owner=(0,0)):
 pathlib.Path(filename).parent.mkdir(parents=True,exist_ok=True)
 pathlib.Path(filename).write_bytes(data);os.chmod(filename,mode);os.chown(filename,*owner)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def sha(raw):return hashlib.sha256(raw).hexdigest()
proof={'kind':'native-production-context-envelope-proof','schemaVersion':1,'rootIdentity':True,'isolatedPython':True}
try:
 # Redirect fixed production roots in fixture copies only. The launcher and observer
 # fixture bytes also receive a CPython open-event audit hook; production bytes stay untouched.
 files=production.FILES;captured={relative:redirect((repo/relative).read_bytes()) for relative in files}
 # Scan redirected executable bytes before adding the fixture hook, whose denylist
 # intentionally contains the unchanged production roots as data.
 for data in captured.values():
  text=data.decode('utf-8')
  for value in forbidden:assert ("'"+value) not in text and ('"'+value) not in text
 for relative in ('ops/prepare-cms-authenticated.py','ops/payload-production-observer.py'):
  captured[relative]=instrument(captured[relative])
 launcher=prefixes['/usr/local/libexec']+'/ownerinc-payload-prepare.py'
 prep=prefixes['/opt/ownerinc']+'/lib/payload-preparation'
 for relative,data in captured.items():
  target=launcher if relative=='ops/prepare-cms-authenticated.py' else prep+'/'+relative
  write(target,data,0o644 if relative.endswith(('.yaml','.yml')) else 0o755)
 m=load('fixture_launcher',launcher)
 support=m.load_authenticated(captured['ops/provision-payload-candidate-trust.py'],prep+'/ops/provision-payload-candidate-trust.py')
 tool_files={relative:redirect((repo/relative).read_bytes()) for relative in support.TOOL_FILES}
 for relative,data in tool_files.items():write(support.TOOL_ROOT+'/'+relative,data,0o755 if relative.endswith('.py') else 0o644)
 verifier=m.load_authenticated(tool_files['ops/payload-candidate-verifier.py'],support.TOOL_ROOT+'/ops/payload-candidate-verifier.py')
 assert m.HOST_ROOT==prefixes['/opt/ownerinc']+'/apps/portal-ownerinc-real'
 assert m.ROOT==prep and m.LAUNCHER==launcher and m.APPROVAL.startswith(root+'/') and m.OBSERVER.startswith(root+'/')
 assert support.TOOL_ROOT.startswith(root+'/') and support.POLICY_PATH.startswith(root+'/')
 assert verifier.REGISTRY.startswith(root+'/') and verifier.POLICY_PATH.startswith(root+'/')
 python_path=os.path.realpath(sys.executable)
 executables={'node':root+'/bin/node','git':root+'/bin/git','python':python_path,
              'gitRemoteHttps':support.TOOL_ROOT+'/bin/git-remote-https'}
 for role,filename in executables.items():
  if role!='python':write(filename,('fixture-'+role+'\n').encode(),0o755)
 policy={'schemaVersion':1,'kind':'ownerinc-payload-candidate-policy-v1','environment':'production',
  'repository':'OWNERINC/portal_ownerinc','repositoryId':'123','workflow':'.github/workflows/ci.yml','workflowId':'456',
  'approvedRevisions':[{'commit':'a'*40,'workflowSha256':'b'*64}],
  'toolchain':{'files':{name:sha(data) for name,data in tool_files.items()},'executables':{}}}
 for role,filename in executables.items():policy['toolchain']['executables'][role]={'path':filename,'sha256':sha(pathlib.Path(filename).read_bytes())}
 policy_raw=canonical(policy)+b'\n';write(support.POLICY_PATH,policy_raw,0o600)
 images={name:'ghcr.io/ownerinc/ownerinc-portal-'+name+'@sha256:'+'c'*64 for name in ('api','cron','cms')}
 record={'schemaVersion':1,'kind':'payload-candidate-admission-record-v1','environment':'production','policySha256':sha(policy_raw),
  'repository':'OWNERINC/portal_ownerinc','repositoryId':'123','workflow':'.github/workflows/ci.yml','workflowId':'456',
  'workflowSha256':'b'*64,'commit':'a'*40,'runId':'789','runAttempt':'1','images':images,
  'artifacts':{role:{'id':str(index+1),'digest':'sha256:'+'d'*64} for index,role in enumerate(verifier.ROLES)},
  'qualificationContract':verifier.CONTRACT,'sourceTreeSha':'e'*40,'archiveBytes':42,'deploymentAuthorized':False}
 for field in ('candidateSha256','qualifiedManifestSha256','recoveryReportSha256','sourceArchiveSha256','archiveSha256'):record[field]='f'*64
 record_raw=canonical(record)+b'\n';mkdir(verifier.REGISTRY,0o700)
 write(verifier.REGISTRY+'/'+record['archiveSha256']+'.'+record['policySha256']+'.json',record_raw,0o600)

 runtime=m.RUNTIME;release=m.RELEASES+'/'+'1'*40
 for directory,mode in ((m.HOST_ROOT,0o755),(runtime,0o755),(m.RELEASES,0o755),(release,0o755)):mkdir(directory,mode)
 daily=prefixes['/opt/ownerinc']+'/backups/portal-ownerinc/daily'
 for backup in (daily,m.PRODUCTION_BACKUP):mkdir(backup+'/000-initial-install-b0',0o700)
 inventory=m.load_authenticated(captured['ops/payload-control-inventory.py'],prep+'/ops/payload-control-inventory.py')
 expected=inventory.production_inventory(m.HOST_ROOT,runtime,m.RELEASES,m.HOST_ROOT+'/current-release',m.LOCK,
  daily,m.PRODUCTION_BACKUP,m.PRODUCTION_BACKUP+'/restore-protection',m.ENVIRONMENT,
  runtime+'/compose.production.yaml',runtime+'/compose.payload.production.yaml','portal')
 inventory_identity=inventory.identity(expected)
 compose=b'fixture-compose\n';image_raw=('API_IMAGE='+images['api']+'\nCRON_IMAGE='+images['cron']+'\n').encode()
 write(m.HOST_ROOT+'/current-release',(release+'\n').encode(),0o600,(1000,1000))
 write(release+'/.image-env',image_raw,0o600,(1000,1000));write(release+'/docker-compose.yml',compose,0o644,(1000,1000))
 write(runtime+'/compose.production.yaml',compose,0o644,(1000,1000))
 private_marker=b'NATIVE_PRIVATE_MATERIAL_MUST_NOT_ESCAPE'
 write(m.ENVIRONMENT,b'PRIVATE='+private_marker+b'\nPOSTGRES_DB=portal\nCMS_PORTAL_DATABASE_NAME=portal\n',0o600,(1000,1000));write(m.LOCK,b'lease-fixture\n',0o600)
 write(runtime+'/payload-control-inventory.json',inventory.canonical(expected)+b'\n',0o600)
 key=b'private-key-material-32-bytes!!!';assert len(key)==32
 write(runtime+'/payload-control.key',key,0o600);state_dir=runtime+'/payload-control-state';mkdir(state_dir,0o700)
 state=m.load_state_captured(captured,inventory)
 body={'schemaVersion':2,'phase':'preauthority','cmsStatus':'cold','authority':{'mode':'legacy','epoch':1},
  'workerHold':True,'admission':'open','sequence':0,'previousStateSha256':None,'restoreIntent':None,'installIntent':None,
  'latestProofSha256':None,'legacySourceProofSha256':None,'releaseImages':None,'plannedReleaseImages':None,
  'rollbackTargetImages':None,'nativeCatalogFingerprint':None,'inventoryIdentity':inventory_identity}
 envelope=state.canonical(state.sign_envelope(body,key))+b'\n'
 write(state_dir+'/00000000000000000000.json',envelope,0o600);write(state_dir+'/current.json',envelope,0o600)
 predecessor=prefixes['/usr/local/libexec']+'/ownerinc-portal-deploy';predecessor_raw=b'fixture-predecessor\n';write(predecessor,predecessor_raw,0o755)
 approval={'schemaVersion':1,'kind':'ownerinc-payload-preparation-approval-v1','environment':'production','repository':'OWNERINC/portal_ownerinc',
  'source':{'commit':'2'*40,'files':{name:sha(data) for name,data in captured.items()}},
  'hostBaseline':{'currentCommit':'1'*40,'legacyImages':{'api':images['api'],'cron':images['cron']},
   'releaseComposeSha256':sha(compose),'runtimeComposeSha256':sha(compose),'releaseOverrideSha256':None,
   'inventoryIdentity':inventory_identity,'installedPredecessors':{'commonReceiver':sha(predecessor_raw),'receiverHelper':None,
    'productionWrapper':None,'operationsGuard':None,'cmsCandidate':None}},
  'admission':{'policySha256':sha(policy_raw),'archiveSha256':record['archiveSha256'],'recordSha256':sha(record_raw)}}
 write(m.APPROVAL,canonical(approval)+b'\n',0o600)

 # Transparently retain real Popen while independently observing the live child PID
 # and Linux start ticks before request delivery lets the observer exit.
 real_popen=m.subprocess.Popen;children=[]
 def proc_start(pid):
  raw=pathlib.Path('/proc/'+str(pid)+'/stat').read_bytes();closing=raw.rfind(b')')
  assert closing>0;fields=raw[closing+1:].strip().split();assert len(fields)>=20
  return int(fields[19])
 def transparent_popen(*args,**kwargs):
  child=real_popen(*args,**kwargs);pid=child.pid
  assert os.path.exists('/proc/'+str(pid))
  children.append({'pid':pid,'processStart':proc_start(pid),'spawned':time.monotonic(),'command':args[0]})
  return child
 m.subprocess.Popen=transparent_popen
 successful_parent_event_start=len(parent_audit_records)
 response=m.collect_context()
 successful_parent_event_end=len(parent_audit_records)
 assert len(children)==1;successful_child=children[0]
 assert response['context']['pid']==successful_child['pid']
 assert response['context']['processStart']==successful_child['processStart']
 assert not os.path.exists('/proc/'+str(successful_child['pid']))
 proof['processIdentityBound']=True
 false_fields=('destructiveOperationAuthorized','installationExecuted','deploymentAuthorized','productionAuthorized')
 assert all(response[name] is False for name in false_fields);proof['authorityRemainedFalse']=True
 exposed=canonical(response)
 assert private_marker not in exposed and key not in exposed;proof['privateMaterialAbsent']=True

 material=m.authenticate();digest=material[4]
 request={'schemaVersion':1,'kind':'payload-production-context-request-v1','operation':'collect-context',
          'nonce':'7'*64,'approvalSha256':digest}
 with m.deployment_lease(close_only=True) as reaffirm:
  observed=m.run_bounded_observer(request);lease=os.fstat(9)
  assert (observed['context']['leaseDevice'],observed['context']['leaseInode'])==(lease.st_dev,lease.st_ino)
  proof['exclusiveLeaseInherited']=True
  probe=os.open(m.LOCK,os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   try:fcntl.flock(probe,fcntl.LOCK_SH|fcntl.LOCK_NB)
   except BlockingIOError:pass
   else:raise AssertionError('observer released or changed the inherited exclusive lease')
  finally:os.close(probe)
  reaffirm();proof['sameOpenDescriptionRetained']=True

 old=m.LOCK+'.original';renamed=False;replacement_written=False;replacement_refused=False
 class ExpectedReplacementRefusal(Exception):pass
 try:
  with m.deployment_lease(close_only=True) as reaffirm:
   os.rename(m.LOCK,old);renamed=True
   write(m.LOCK,b'replacement\n',0o600);replacement_written=True
   try:reaffirm()
   except m.VerificationError:
    replacement_refused=True;raise ExpectedReplacementRefusal()
   else:raise AssertionError('lock path replacement accepted')
 except ExpectedReplacementRefusal:pass
 finally:
  if replacement_written and os.path.lexists(m.LOCK):os.unlink(m.LOCK)
  if renamed and os.path.lexists(old):os.rename(old,m.LOCK)
 assert renamed and replacement_written and replacement_refused and pathlib.Path(m.LOCK).read_bytes()==b'lease-fixture\n'
 proof['pathReplacementRefused']=True

 overflow=root+'/overflow.py';timeout_script=root+'/timeout.py'
 overflow_started=root+'/overflow-started';overflow_prefix=root+'/overflow-prefix-written';overflow_survived=root+'/overflow-survived'
 timeout_started=root+'/timeout-started';timeout_survived=root+'/timeout-survived'
 overflow_source=f'''import os,time,pathlib
pathlib.Path({overflow_started!r}).write_text(str(os.getpid()))
os.write(1,b"x"*4096)
pathlib.Path({overflow_prefix!r}).write_text(str(os.getpid()))
os.write(1,b"x")
time.sleep(5)
pathlib.Path({overflow_survived!r}).write_text("cap missing")
'''.encode()
 timeout_source=f'''import os,time,pathlib
pathlib.Path({timeout_started!r}).write_text(str(os.getpid()))
time.sleep(3)
pathlib.Path({timeout_survived!r}).write_text("timeout missing")
'''.encode()
 write(overflow,overflow_source,0o755);write(timeout_script,timeout_source,0o755)
 observer_path=m.OBSERVER;observer_timeout=m.OBSERVER_TIMEOUT_SECONDS
 def refused(script,timeout):
  before=len(children)
  m.OBSERVER=script;m.OBSERVER_TIMEOUT_SECONDS=timeout
  try:
   with m.deployment_lease(close_only=True):m.run_bounded_observer(request)
  except m.VerificationError:pass
  else:raise AssertionError('replacement observer was accepted')
  assert len(children)==before+1,'rejection occurred before replacement observer spawn'
  child=children[-1];assert child['command'][4]==script
  return child,time.monotonic()-child['spawned']
 try:
  overflow_child,overflow_elapsed=refused(overflow,8)
  assert pathlib.Path(overflow_started).read_text()==str(overflow_child['pid'])
  assert pathlib.Path(overflow_prefix).read_text()==str(overflow_child['pid'])
  assert 0<overflow_elapsed<4,'overflow fell through to timeout/EOF parsing'
  assert not os.path.exists('/proc/'+str(overflow_child['pid'])) and not os.path.exists(overflow_survived)
  proof['outputOverflowRefused']=True
  timeout_limit=0.4;timeout_child,timeout_elapsed=refused(timeout_script,timeout_limit)
  assert pathlib.Path(timeout_started).read_text()==str(timeout_child['pid'])
  assert timeout_limit*0.75<=timeout_elapsed<=2,'shortened timeout was not causal and bounded'
  assert not os.path.exists('/proc/'+str(timeout_child['pid'])) and not os.path.exists(timeout_survived)
  proof['timeoutRefused']=True
 finally:
  m.OBSERVER=observer_path;m.OBSERVER_TIMEOUT_SECONDS=observer_timeout;m.subprocess.Popen=real_popen

 audit_active[0]=False;os.open=real_os_open;os.close(parent_audit_fd);parent_audit_fd=None
 def parse_audit(filename,expected_pid):
  raw=pathlib.Path(filename).read_bytes();assert raw and raw.endswith(b'\n') and b'\r' not in raw
  events=[]
  for line in raw[:-1].split(b'\n'):
   entry=json.loads(line.decode('utf-8'))
   assert set(entry)=={'api','pid','target','targetKind'} and canonical(entry)==line
   assert entry['pid']==expected_pid and entry['api'] in ('open','os.open')
   assert entry['targetKind'] in ('filesystem','pipe')
   if entry['targetKind']=='filesystem':
    assert os.path.isabs(entry['target']) and entry['target']==os.path.realpath(entry['target'])
    assert not forbidden_target('filesystem',entry['target']),entry
   else:assert pipe_target(entry['target'])
   events.append(entry)
  assert events and {'open','os.open'}<={entry['api'] for entry in events}
  return events
 parent_events=parse_audit(audit_log,os.getpid())
 assert parent_events==parent_audit_records
 successful_parent_events=parent_events[successful_parent_event_start:successful_parent_event_end]
 successful_parent_pipes=[entry for entry in successful_parent_events if entry['api']=='open' and entry['targetKind']=='pipe']
 assert len(successful_parent_pipes)>=2
 instrumented_children=[child for child in children if child['command'][4]==observer_path]
 assert len(instrumented_children)==2
 expected_logs={'child-'+str(child['pid'])+'.jsonl' for child in instrumented_children}
 assert set(os.listdir(audit_dir))==expected_logs
 child_events={child['pid']:parse_audit(audit_dir+'/child-'+str(child['pid'])+'.jsonl',child['pid']) for child in instrumented_children}
 successful_targets={entry['target'] for entry in child_events[successful_child['pid']] if entry['targetKind']=='filesystem'}
 assert m.LAUNCHER in successful_targets and '/proc/'+str(successful_child['pid'])+'/stat' in successful_targets
finally:
 audit_active[0]=False
 os.open=real_os_open
 if 'real_popen' in locals():m.subprocess.Popen=real_popen
 if locals().get('parent_audit_fd') is not None:os.close(parent_audit_fd)
 shutil.rmtree(root)
assert not os.path.exists(root)
proof['sandboxRemoved']=True
print(json.dumps(proof,sort_keys=True,separators=(',',':')))
`, repo, sandbox], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      });
    } finally {
      if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    }
    assert.ok(sandbox, 'native sandbox must be allocated inside the cleanup scope');
    assert.equal(existsSync(sandbox), false, 'Node fallback cleanup must remove the native sandbox');
    assert.ifError(result?.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 1024, 'native proof must be bounded');
    assert.deepEqual(JSON.parse(result.stdout), {
      kind: 'native-production-context-envelope-proof', schemaVersion: 1, rootIdentity: true,
      isolatedPython: true, exclusiveLeaseInherited: true, sameOpenDescriptionRetained: true,
      processIdentityBound: true, pathReplacementRefused: true, outputOverflowRefused: true,
      timeoutRefused: true, privateMaterialAbsent: true, authorityRemainedFalse: true,
      sandboxRemoved: true,
    });
    console.log(result.stdout.trim());
  });

test('generated child audit classifies Popen pipes and delegates os.open default, dir_fd, and keyword mode', () => {
  let root;
  try {
    root = mkdtempSync(path.join(tmpdir(), 'payload-generated-audit-'));
    const real = path.join(root, 'real');
    mkdirSync(path.join(real, 'inner'), { recursive: true });
    symlinkSync(path.join(real, 'inner'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const generated = spawnSync(python, ['-I', '-S', '-B', '-c', String.raw`
import json,os,pathlib,stat,sys
source=pathlib.Path(sys.argv[1]).read_text()
forbidden_digit_method='.'+'isdigit()';assert forbidden_digit_method not in source
native=source.index('\nimport os,sys,pathlib,fcntl,importlib.util,shutil,json,hashlib,time,stat\n')+1
native_script_end=source.index('\n'+chr(96)+', repo, sandbox]',native)
native_source=source[native:native_script_end]
compile(native_source,'<actual-native-fixture>','exec')
tool_files_at=native_source.index("tool_files={relative:redirect((repo/relative).read_bytes()) for relative in support.TOOL_FILES}")
verifier_at=native_source.index("verifier=m.load_authenticated(tool_files['ops/payload-candidate-verifier.py']")
instrument_at=native_source.index("for relative in ('ops/prepare-cms-authenticated.py','ops/payload-production-observer.py'):")
redirect_scan_at=native_source.index("for data in captured.values():",native_source.index("captured={relative:redirect"))
assert tool_files_at<verifier_at and redirect_scan_at<instrument_at
start=source.index('def instrument(raw):',native);end=source.index('def mkdir(filename,mode=0o755):',start)
root=os.path.realpath(sys.argv[2]);audit_dir=os.path.join(root,'audits');os.mkdir(audit_dir)
prefixes={'/opt/ownerinc':os.path.join(root,'redirected','opt','ownerinc'),
 '/etc/ownerinc':os.path.join(root,'redirected','etc','ownerinc'),
 '/var/lib/ownerinc':os.path.join(root,'redirected','var','lib','ownerinc'),
 '/usr/local/libexec':os.path.join(root,'redirected','usr','local','libexec')}
production_roots=tuple(os.path.realpath(item) for item in ('/opt/ownerinc','/etc/ownerinc','/var/lib/ownerinc','/usr/local/libexec'))
namespace={'audit_dir':audit_dir,'prefixes':prefixes,'production_roots':production_roots}
exec(compile(source[start:end],'<actual-instrument-source>','exec'),namespace)
instrument=namespace['instrument']
repository=pathlib.Path(sys.argv[1]).resolve().parents[2]
compile_prefixes={old:new.replace('\\','/') for old,new in prefixes.items()}
def redirect_actual(raw):
 for old,new in compile_prefixes.items():raw=raw.replace(old.encode(),new.encode())
 return raw
actual_generated={}
for relative in ('ops/prepare-cms-authenticated.py','ops/payload-production-observer.py'):
 redirected=redirect_actual((repository/relative).read_bytes())
 text=redirected.decode('utf-8')
 for value in compile_prefixes:assert ("'"+value) not in text and ('"'+value) not in text
 actual_generated[relative]=instrument(redirected)
 compile(actual_generated[relative],relative,'exec')
tool_files={'ops/payload-candidate-verifier.py':redirect_actual((repository/'ops/payload-candidate-verifier.py').read_bytes())}
compile(tool_files['ops/payload-candidate-verifier.py'],'ops/payload-candidate-verifier.py','exec')
observer=prefixes['/opt/ownerinc']+'/lib/payload-preparation/ops/payload-production-observer.py'
launcher=prefixes['/usr/local/libexec']+'/ownerinc-payload-prepare.py'
default_file=os.path.join(root,'default.bin');mode_file=os.path.join(root,'mode.bin');dir_base=os.path.join(root,'dir-base');child_file=os.path.join(dir_base,'child.bin')
real_target=os.path.join(root,'real','target');lexical_wrong=os.path.join(root,'target')
os.mkdir(dir_base);pathlib.Path(default_file).write_bytes(b'default');pathlib.Path(child_file).write_bytes(b'dir-fd')
pathlib.Path(real_target).write_bytes(b'real-target');pathlib.Path(lexical_wrong).write_bytes(b'lexical-wrong')
portable_calls=[];actual_open=os.open;actual_readlink=os.readlink;actual_fstat=os.fstat
if os.open in os.supports_dir_fd and os.name=='posix':
 portable_dir_fd=actual_open(dir_base,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
 def portable_open(filename,flags,mode=0o777,*,dir_fd=None):
  portable_calls.append((os.fsdecode(filename),dir_fd,mode))
  return actual_open(filename,flags,mode,dir_fd=dir_fd)
else:
 portable_dir_fd=731
 def portable_open(filename,flags,mode=0o777,*,dir_fd=None):
  portable_calls.append((os.fsdecode(filename),dir_fd,mode))
  if dir_fd is None:return actual_open(filename,flags,mode)
  if dir_fd!=portable_dir_fd:raise OSError('unexpected portable dir_fd')
  effective=os.path.join(dir_base,os.fsdecode(filename))
  state=globals().get('_fixture_audit_state',[None])[0]
  if state is not None:state['path']=effective
  return actual_open(effective,flags,mode)
 def portable_readlink(filename):
  if filename=='/proc/self/fd/'+str(portable_dir_fd):return dir_base
  if filename.startswith('/proc/self/fd/'):
   descriptor=int(filename.rsplit('/',1)[1])
   try:info=actual_fstat(descriptor)
   except OSError:raise OSError('invalid portable descriptor') from None
   if stat.S_ISFIFO(info.st_mode):return 'pipe:['+str(descriptor)+']'
   raise OSError('non-path portable descriptor')
  return actual_readlink(filename)
 def portable_fstat(descriptor):
  if descriptor==portable_dir_fd:return os.stat(dir_base)
  return actual_fstat(descriptor)
 os.readlink=portable_readlink;os.fstat=portable_fstat
os.open=portable_open
symlink_dotdot=os.path.join(root,'link','..','target')
exercise=f'''if _fixture_audit_os.name=='nt':
 _original_realpath=_fixture_audit_os.path.realpath
 def _component_preserving_realpath(_value):
  if _value=={symlink_dotdot!r}:return {real_target!r}
  return _original_realpath(_value)
 _fixture_audit_os.path.realpath=_component_preserving_realpath
 try:assert _fixture_canonical_target({symlink_dotdot!r})==('filesystem',{real_target!r})
 finally:_fixture_audit_os.path.realpath=_original_realpath
else:assert _fixture_canonical_target({symlink_dotdot!r})==('filesystem',{real_target!r})
assert _fixture_canonical_target(_fixture_audit_os.fsencode({(os.path.join(root,'real','inner','..','..','real','target'))!r}))==('filesystem',{real_target!r})
assert _fixture_canonical_target('child.bin',portable_dir_fd)==('filesystem',{child_file!r})
try:_fixture_canonical_target('child.bin',portable_dir_fd+1)
except RuntimeError:pass
else:raise AssertionError('invalid dir_fd accepted')
def _assert_descriptor_refused(_descriptor,_reason):
 try:_fixture_descriptor_target(_descriptor,_reason)
 except (OSError,RuntimeError):return
 raise AssertionError(_reason+' accepted')
assert _fixture_pipe_target('pipe:[0]') and _fixture_pipe_target('pipe:[1234567890]')
assert not _fixture_pipe_target('pipe:[]') and not _fixture_pipe_target('pipe:['+chr(0x0661)+']')
_assert_descriptor_refused(1000000,'invalid_descriptor')
import socket as _fixture_socket
_socket=_fixture_socket.socket()
try:_assert_descriptor_refused(_socket.fileno(),'socket_descriptor')
finally:_socket.close()
_original_readlink=_fixture_audit_os.readlink;_original_fstat=_fixture_audit_os.fstat
_unicode_read_fd,_unicode_write_fd=_fixture_audit_os.pipe();_unicode_fifo_info=_fixture_audit_os.fstat(_unicode_read_fd)
_synthetic={{1000001:('pipe:[1000001]',_fixture_audit_os.stat({default_file!r})),
 1000002:('anon_inode:[eventpoll]',_fixture_audit_os.stat({default_file!r})),
 1000003:({default_file!r}+' (deleted)',_fixture_audit_os.stat({default_file!r})),
 1000004:('pipe:['+chr(0x0661)+']',_unicode_fifo_info)}}
def _synthetic_readlink(_filename):
 _descriptor=int(_filename.rsplit('/',1)[1])
 if _descriptor in _synthetic:return _synthetic[_descriptor][0]
 return _original_readlink(_filename)
def _synthetic_fstat(_descriptor):
 if _descriptor in _synthetic:return _synthetic[_descriptor][1]
 return _original_fstat(_descriptor)
_fixture_audit_os.readlink=_synthetic_readlink;_fixture_audit_os.fstat=_synthetic_fstat
try:
 _assert_descriptor_refused(1000001,'mismatched_pipe_descriptor')
 _assert_descriptor_refused(1000002,'anon_inode_descriptor')
 _assert_descriptor_refused(1000003,'deleted_descriptor')
 _assert_descriptor_refused(1000004,'unicode_digit_pipe_descriptor')
finally:
 _fixture_audit_os.readlink=_original_readlink;_fixture_audit_os.fstat=_original_fstat
 _fixture_audit_os.close(_unicode_read_fd);_fixture_audit_os.close(_unicode_write_fd)
_fd=_fixture_audit_os.open({default_file!r},_fixture_audit_os.O_RDONLY)
try:assert _fixture_audit_os.read(_fd,32)==b'default'
finally:_fixture_audit_os.close(_fd)
_fd=_fixture_audit_os.open('child.bin',_fixture_audit_os.O_RDONLY,dir_fd=portable_dir_fd)
try:assert _fixture_audit_os.read(_fd,32)==b'dir-fd'
finally:_fixture_audit_os.close(_fd)
_fd=_fixture_audit_os.open({mode_file!r},_fixture_audit_os.O_WRONLY|_fixture_audit_os.O_CREAT|_fixture_audit_os.O_EXCL,mode=0o600)
_fixture_audit_os.close(_fd)
assert any(_path=={default_file!r} and _dir is None for _path,_dir,_mode in portable_calls)
assert any(_path=='child.bin' and _dir==portable_dir_fd for _path,_dir,_mode in portable_calls)
assert any(_path=={mode_file!r} and _dir is None and _mode==0o600 for _path,_dir,_mode in portable_calls)
_pipe_before=len([_entry for _entry in _fixture_audit_records if _entry['targetKind']=='pipe'])
_read_fd,_write_fd=_fixture_audit_os.pipe();_fixture_audit_os.write(_write_fd,b'wrapped-pipe');_fixture_audit_os.close(_write_fd)
with _fixture_audit_os.fdopen(_read_fd,'rb') as _pipe_stream:assert _pipe_stream.read()==b'wrapped-pipe'
_pipe_after_wrap=len([_entry for _entry in _fixture_audit_records if _entry['targetKind']=='pipe']);assert _pipe_after_wrap>_pipe_before
import subprocess as _fixture_subprocess
_pipe_before_popen=len([_entry for _entry in _fixture_audit_records if _entry['targetKind']=='pipe'])
_process=_fixture_subprocess.Popen([_fixture_audit_sys.executable,'-I','-S','-B','-c','import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'],stdin=_fixture_subprocess.PIPE,stdout=_fixture_subprocess.PIPE,stderr=_fixture_subprocess.PIPE)
_stdout,_stderr=_process.communicate(b'popen-pipe')
assert _process.returncode==0 and _stdout==b'popen-pipe' and _stderr==b''
assert len([_entry for _entry in _fixture_audit_records if _entry['targetKind']=='pipe'])>_pipe_before_popen
for _entry in _fixture_audit_records:
 assert set(_entry)=={{'api','pid','target','targetKind'}} and _entry['pid']==_fixture_audit_os.getpid()
 assert _entry['api'] in ('open','os.open') and _entry['targetKind'] in ('filesystem','pipe')
 if _entry['targetKind']=='filesystem':
  assert _fixture_audit_os.path.isabs(_entry['target']) and _entry['target']==_fixture_audit_os.path.realpath(_entry['target'])
  assert not _fixture_forbidden_target('filesystem',_entry['target'])
 else:assert _fixture_pipe_target(_entry['target'])
'''.encode()
base=b'#!/usr/bin/python3\n'+exercise
observer_raw=instrument(base);launcher_raw=instrument(b'#!/usr/bin/python3\nVALUE=1\n')
compile(observer_raw,observer,'exec');compile(launcher_raw,launcher,'exec')
pathlib.Path(observer).parent.mkdir(parents=True);pathlib.Path(launcher).parent.mkdir(parents=True)
pathlib.Path(observer).write_bytes(observer_raw);pathlib.Path(launcher).write_bytes(launcher_raw)
sys.argv=[observer,'collect-context'];exec(compile(observer_raw,observer,'exec'),globals())
if os.name=='posix':actual_fstat(portable_dir_fd);os.close(portable_dir_fd)
print(json.dumps({'generatedModulesCompiled':True,'defaultDelegated':True,'dirFdDelegated':True,'keywordModeDelegated':True,
 'pipeWrappingRecorded':True,'popenPipeSetupRecorded':True,'asciiPipeIdsOnly':True,
 'rejectedDescriptorClasses':['invalid','mismatched-pipe','socket','anon-inode','deleted','unicode-digit-pipe'],
 'auditLog':_fixture_audit_log,'auditPid':_fixture_audit_os.getpid(),
 'symlinkDotDotResolved':True,'platformProcModel':'native' if os.name=='posix' else 'portable-injected',
 'symlinkModel':'native' if os.name=='posix' else 'component-preserving-injected'},sort_keys=True,separators=(',',':')))
`, path.join(repo, 'tests/unit/payload-preparation-authentication.test.mjs'), root], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 4096,
    });
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    const evidence = JSON.parse(generated.stdout);
    const actualAuditDir = statSync(path.dirname(evidence.auditLog), { bigint: true });
    const expectedAuditDir = statSync(path.join(root, 'audits'), { bigint: true });
    assert.equal(actualAuditDir.dev, expectedAuditDir.dev);
    assert.equal(actualAuditDir.ino, expectedAuditDir.ino);
    const auditLines = readFileSync(evidence.auditLog, 'utf8').split('\n');
    assert.equal(auditLines.pop(), '');
    assert.ok(auditLines.length > 0);
    const auditRecords = auditLines.map((line) => JSON.parse(line));
    for (const record of auditRecords) {
      assert.deepEqual(Object.keys(record), ['api', 'pid', 'target', 'targetKind']);
      assert.equal(record.pid, evidence.auditPid);
      assert.ok(record.api === 'open' || record.api === 'os.open');
      assert.ok(record.targetKind === 'filesystem' || record.targetKind === 'pipe');
      if (record.targetKind === 'filesystem') assert.ok(path.isAbsolute(record.target));
      else assert.match(record.target, /^pipe:\[[0-9]+\]$/);
    }
    assert.ok(auditRecords.some((record) => record.targetKind === 'pipe'));
    delete evidence.auditLog;
    delete evidence.auditPid;
    assert.deepEqual(evidence, {
      asciiPipeIdsOnly: true,
      defaultDelegated: true,
      dirFdDelegated: true,
      generatedModulesCompiled: true,
      keywordModeDelegated: true,
      pipeWrappingRecorded: true,
      platformProcModel: process.platform === 'win32' ? 'portable-injected' : 'native',
      popenPipeSetupRecorded: true,
      rejectedDescriptorClasses: ['invalid', 'mismatched-pipe', 'socket', 'anon-inode', 'deleted', 'unicode-digit-pipe'],
      symlinkModel: process.platform === 'win32' ? 'component-preserving-injected' : 'native',
      symlinkDotDotResolved: true,
    });
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test('candidate-only CI gate retains exact native preparation discovery without widening deployment', () => {
  const workflow = readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
  const lines = workflow.split(/\r?\n/u);
  const jobs = lines.indexOf('jobs:');
  assert.ok(jobs >= 0, 'workflow jobs boundary is missing');
  const jobStarts = lines.map((line, index) => (index > jobs && /^  [a-z0-9-]+:$/u.test(line) ? index : -1)).filter(index => index >= 0);
  const validateStart = jobStarts.filter(index => lines[index] === '  validate:');
  assert.deepEqual(validateStart.length, 1, 'validate job boundary must remain unique');
  const validateEnd = jobStarts.find(index => index > validateStart[0]) ?? lines.length;
  const validate = lines.slice(validateStart[0], validateEnd);
  const steps = validate.indexOf('    steps:');
  assert.ok(steps >= 0, 'validate steps boundary is missing');
  const exactStepName = '      - name: Test preauthority CI setup with native Linux root';
  const stepStarts = validate.map((line, index) => (index > steps && /^      - /u.test(line) ? index : -1)).filter(index => index >= 0);
  const start = stepStarts.filter(index => validate[index] === exactStepName);
  assert.deepEqual(start.length, 1, 'required native step must have one exact name with no suffix');
  const next = stepStarts.find(index => index > start[0]) ?? validate.length;
  const step = validate.slice(start[0], next);
  assert.deepEqual(step, [
    exactStepName,
    "        if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.publish_candidate_only == true && inputs.cms_image_only != true",
    '        run: |',
    '          set -euo pipefail',
    '          sudo env PATH="$PATH" HOME=/root node --test tests/unit/payload-preauthority-ci-setup.test.mjs',
    '          NODE_BIN="$(readlink -f -- "$(command -v node)")"',
    '          test -f "$NODE_BIN" && test -x "$NODE_BIN"',
    '          sudo -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \\',
    '            PAYLOAD_REQUIRE_NATIVE_TRUST=1 "$NODE_BIN" --test \\',
    '            tests/unit/payload-candidate-trust-provisioning.test.mjs',
    '          sudo -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \\',
    '            PAYLOAD_REQUIRE_NATIVE_PREPARATION=1 "$NODE_BIN" --test \\',
    '            tests/unit/payload-preparation-authentication.test.mjs',
  ], 'native step name, attached gate, run key, and complete shell body must be exact');

  const deployStart = jobStarts.filter(index => lines[index] === '  deploy-production:');
  assert.deepEqual(deployStart.length, 1, 'deploy job boundary must remain unique');
  const deployEnd = jobStarts.find(index => index > deployStart[0]) ?? lines.length;
  const deploy = lines.slice(deployStart[0], deployEnd);
  assert.deepEqual(deploy.slice(0, 10), [
    '  deploy-production:',
    '    name: Deploy production',
    '    needs: [validate, publish-images]',
    '    if: >-',
    '      !cancelled() &&',
    "      needs.validate.result == 'success' && needs.publish-images.result == 'success' &&",
    "      (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&",
    "      github.ref == 'refs/heads/main' &&",
    '      inputs.cms_image_only != true &&',
    '      inputs.publish_candidate_only != true',
  ]);
});

test('Task 4 retains executable wrong-PID and returned process-context mismatch refusal evidence', () => {
  const source = readFileSync(path.join(repo, 'tests/unit/payload-preparation-authentication.test.mjs'), 'utf8');
  const transportStart = source.lastIndexOf("test('bounded observer transport denies timeout, overflow, child/status/frame/binding/PID failures and always reaps");
  const transportEnd = source.indexOf("\ntest('", transportStart + 1);
  assert.ok(transportStart >= 0 && transportEnd > transportStart);
  const transport = source.slice(transportStart, transportEnd);
  assert.match(transport, /for scenario in \('timeout','overflow','nonzero','malformed','wrong-nonce','wrong-approval','wrong-pid'\):/u);
  assert.match(transport, /if scenario=='wrong-pid':value\['context'\]\['pid'\]=999/u);
  assert.match(transport, /try:l\.run_bounded_observer\(request\)\r?\n  except l\.VerificationError as error:assert str\(error\)=='preparation_verification_denied'\r?\n  else:raise AssertionError\(scenario\+' accepted'\)/u);

  const contextStart = source.lastIndexOf("test('context collection owns the lease, independently projects context, and denies all post-child drift");
  const contextEnd = source.indexOf("\ntest('", contextStart + 1);
  assert.ok(contextStart >= 0 && contextEnd > contextStart);
  const context = source.slice(contextStart, contextEnd);
  assert.match(context, /if kind=='result':value\['context'\]\['stateSha256'\]='0'\*64/u);
  assert.match(context, /try:l\.collect_context\(\)\r?\n  except l\.VerificationError:pass\r?\n  else:raise AssertionError\(kind\+' drift accepted'\)/u);
  assert.match(context, /for kind in \('source','closure','approval','inventory','state','fd9','result'\):attempt\(kind\)/u);
});

test('authenticated preparation subprocess supervisor bounds finite, infinite and timed-out output while preserving JSON', () => {
  const source = String.raw`
import importlib.util,sys,time
spec=importlib.util.spec_from_file_location('bounded_preparation',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
ok=m.run_bounded_subprocess([sys.executable,'-I','-S','-c','print("{\\"status\\":\\"ok\\"}")'],1024,5)
assert ok.returncode==0 and ok.stdout.strip()==b'{"status":"ok"}' and ok.stderr==b''
inherited=m.run_bounded_subprocess([sys.executable,'-I','-S','-c','print("inherited")'],1024,5,group_mode='inherit')
assert inherited.returncode==0 and inherited.stdout.strip()==b'inherited'
for code,timeout in [
 ('import sys;sys.stdout.buffer.write(b"x"*200000)',5),
 ('import os\nwhile True: os.write(1,b"x"*8192)',5),
 ('import sys,time;sys.stderr.write("private-do-not-echo");sys.stderr.flush();time.sleep(30)',1),
]:
 started=time.monotonic()
 try:m.run_bounded_subprocess([sys.executable,'-I','-S','-c',code],1024,timeout)
 except m.VerificationError as error:assert str(error)=='preparation_verification_denied'
 else:raise AssertionError('unbounded child accepted')
 assert time.monotonic()-started < 8
`;
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', source, path.join(repo, 'ops', 'prepare-cms-authenticated.py')],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr + result.stdout, /private-do-not-echo/u);
});

test('apply runtime inherits the receiver group, has cleanup reserve, and no supervisor uses unbounded wait', () => {
  const preparation = readFileSync(path.join(repo, 'ops', 'prepare-cms-authenticated.py'), 'utf8');
  const receiver = readFileSync(path.join(repo, 'ops', 'payload-receiver-admission.py'), 'utf8');
  const runtime = readFileSync(path.join(repo, 'ops', 'payload-control-runtime.py'), 'utf8');
  assert.doesNotMatch(preparation, /process\.wait\(\)/u);
  assert.doesNotMatch(receiver, /process\.wait\(\)/u);
  assert.doesNotMatch(runtime, /process\.wait\(\)/u);
  assert.match(preparation, /initialize-isolated[\s\S]*timeout=APPLY_RUNTIME_TIMEOUT_SECONDS,[\s\S]*group_mode='inherit'/u);
  assert.match(preparation, /authenticated-' \+ mode[\s\S]*group_mode='new'/u);
  const inner = Number(/APPLY_RUNTIME_TIMEOUT_SECONDS = (\d+)/u.exec(preparation)?.[1]);
  const outer = Number(/APPLY_SUBPROCESS_TIMEOUT = (\d+)/u.exec(receiver)?.[1]);
  const cleanup = Number(/SUBPROCESS_CLEANUP_SECONDS = (\d+)/u.exec(receiver)?.[1]);
  assert.ok(inner > 0 && outer > inner && outer - inner > cleanup);
});

test('inherited runtime-like group leaves no nested child after timeout or output overflow', {
  skip: process.platform !== 'linux',
}, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'payload-inherited-group-'));
  try {
    for (const scenario of ['timeout', 'overflow']) {
      const pidfile = path.join(root, `${scenario}.pid`);
      const script = String.raw`
import importlib.util,os,subprocess,sys,time
spec=importlib.util.spec_from_file_location('bounded_inherited',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
mode,pidfile=sys.argv[2:]
code='import os,subprocess,sys,time; p=subprocess.Popen([sys.executable,"-I","-S","-c","import time;time.sleep(60)"]); open(sys.argv[1],"w").write(str(p.pid)); time.sleep(.1); ' + ('time.sleep(60)' if mode=='timeout' else '[(os.write(1,b"x"*8192)) for _ in iter(int,1)]')
m.run_bounded_subprocess([sys.executable,'-I','-S','-c',code,pidfile],1024,1,group_mode='inherit')
`;
      const result = spawnSync(python, ['-I', '-S', '-B', '-c', script,
        path.join(repo, 'ops', 'prepare-cms-authenticated.py'), scenario, pidfile],
      { encoding: 'utf8', timeout: 15000, detached: true });
      assert.notEqual(result.status, 0, `${scenario} unexpectedly returned normally`);
      const child = Number(readFileSync(pidfile, 'utf8'));
      let alive = true;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try { process.kill(child, 0); } catch { alive = false; break; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      assert.equal(alive, false, `${scenario} left nested child ${child}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated preparation supervisor kills and reaps the Linux child process group', {
  skip: process.platform !== 'linux',
}, () => {
  const source = String.raw`
import importlib.util,os,sys,tempfile,time
spec=importlib.util.spec_from_file_location('bounded_preparation_group',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
 pidfile=os.path.join(root,'child.pid')
 code='import subprocess,sys,time; p=subprocess.Popen([sys.executable,"-I","-S","-c","import time;time.sleep(60)"]);open(sys.argv[1],"w").write(str(p.pid));time.sleep(60)'
 try:m.run_bounded_subprocess([sys.executable,'-I','-S','-c',code,pidfile],1024,1)
 except m.VerificationError:pass
 else:raise AssertionError('timeout accepted')
 child=int(open(pidfile).read())
 for _ in range(100):
  try:os.kill(child,0)
  except ProcessLookupError:break
  time.sleep(.01)
 else:raise AssertionError('orphan child survived')
`;
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', source, path.join(repo, 'ops', 'prepare-cms-authenticated.py')],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
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
 assert held[0] and kwargs['pass_fds']==(9,) and kwargs['group_mode']=='new'
 assert args==['/bin/bash','--noprofile','--norc',l.ROOT+'/ops/prepare-cms-infrastructure.sh','--authenticated-apply',material[4]]
 events.append('child');return types.SimpleNamespace(returncode=0)
with patch.object(l,'deployment_lease',lease),patch.object(l,'verify_host_baseline',side_effect=baseline),patch.object(l,'run_bounded_subprocess',side_effect=child):
 result=l.dispatch('apply');assert result['preparationExecuted'] is True and result['deploymentAuthorized'] is False
 assert events.index('host')<events.index('child')<events.index('release') and events.count('host')==2
 with patch.object(l,'run_bounded_subprocess',return_value=types.SimpleNamespace(returncode=2)):
  denied(lambda:l.dispatch('apply'));assert not held[0]
 with patch.object(l,'authenticate',side_effect=[material,(*material[:4],'0'*64)]),patch.object(l,'run_bounded_subprocess') as run:
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

test('bounded observer transport authenticates before the exact isolated child and validates a capped response (portable process doubles)', () => {
  probe(String.raw`
from unittest.mock import patch
material=l.authenticate();digest=material[4];nonce='7'*64
request={'schemaVersion':1,'kind':'payload-production-context-request-v1','operation':'collect-context','nonce':nonce,'approvalSha256':digest}
context={'approvalSha256':digest,'sourceCommit':approval['hostBaseline']['currentCommit'],'inventoryIdentity':'8'*64,
 'stateSha256':'9'*64,'stateSequence':3,'pid':321,'processStart':654,'leaseDevice':7,'leaseInode':8}
response={'schemaVersion':1,'kind':'payload-production-context-observation-v1','operation':'collect-context','nonce':nonce,
 'context':context,'sourceAuthenticated':True,'inventoryAuthenticated':True,'stateAuthenticated':True,'leaseVerified':True,
 'destructiveOperationAuthorized':False,'installationExecuted':False,'deploymentAuthorized':False,'productionAuthorized':False}
observer=l.load_authenticated(material[1]['ops/payload-production-observer.py'],l.OBSERVER)
frame=observer.canonical(response)+b'\n';events=[];chunks=[frame[:17],frame[17:],b'']
class Pipe:
 def __init__(self,fd):self.fd=fd;self.closed=False;self.written=b''
 def fileno(self):return self.fd
 def write(self,value):self.written+=value;events.append(('write',value));return len(value)
 def close(self):self.closed=True;events.append(('close',self.fd))
class Process:
 pid=321
 def __init__(self):self.stdin=Pipe(10);self.stdout=Pipe(11);self.returncode=0;self.killed=False
 def wait(self,timeout=None):events.append(('wait',timeout));return self.returncode
 def kill(self):self.killed=True;events.append('kill')
process=Process()
def popen(args,**kwargs):
 assert events==['authenticate'],'authentication must precede spawn'
 assert args==['/usr/bin/python3','-I','-S','-B',l.ROOT+'/ops/payload-production-observer.py','collect-context']
 assert kwargs=={'stdin':l.subprocess.PIPE,'stdout':l.subprocess.PIPE,'stderr':l.subprocess.DEVNULL,
  'pass_fds':(9,),'env':{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},'shell':False,'bufsize':0}
 events.append('spawn');return process
class Selector:
 def register(self,fileobj,event):assert fileobj is process.stdout and event==l.selectors.EVENT_READ;events.append('register')
 def select(self,timeout):assert 0<=timeout<=l.OBSERVER_TIMEOUT_SECONDS;return [(types.SimpleNamespace(fileobj=process.stdout),None)]
 def unregister(self,fileobj):assert fileobj is process.stdout;events.append('unregister')
 def close(self):events.append('selector-close')
def authenticate():events.append('authenticate');return material
with patch.object(l,'authenticate',side_effect=authenticate),patch.object(l.subprocess,'Popen',side_effect=popen), \
     patch.object(l.selectors,'DefaultSelector',return_value=Selector()),patch.object(l.os,'read',side_effect=lambda fd,n:chunks.pop(0)), \
     patch.object(l.os,'set_blocking',side_effect=lambda fd,value:events.append(('nonblocking',fd,value))):
 result=l.run_bounded_observer(request)
assert result==response and result['destructiveOperationAuthorized'] is False and result['productionAuthorized'] is False
expected_request=observer.canonical(request)+b'\n'
assert process.stdin.written==expected_request and len(expected_request)<=4096
assert not process.killed and process.stdin.closed and process.stdout.closed
wait_index=next(i for i,value in enumerate(events) if isinstance(value,tuple) and value[0]=='wait')
assert events.index('authenticate')<events.index('spawn')<wait_index
`);
});

test('bounded observer transport denies timeout, overflow, child/status/frame/binding/PID failures and always reaps (portable process doubles)', () => {
  probe(String.raw`
from unittest.mock import patch
material=l.authenticate();digest=material[4];nonce='7'*64
request={'schemaVersion':1,'kind':'payload-production-context-request-v1','operation':'collect-context','nonce':nonce,'approvalSha256':digest}
base_context={'approvalSha256':digest,'sourceCommit':approval['hostBaseline']['currentCommit'],'inventoryIdentity':'8'*64,
 'stateSha256':'9'*64,'stateSequence':3,'pid':321,'processStart':654,'leaseDevice':7,'leaseInode':8}
base={'schemaVersion':1,'kind':'payload-production-context-observation-v1','operation':'collect-context','nonce':nonce,
 'context':base_context,'sourceAuthenticated':True,'inventoryAuthenticated':True,'stateAuthenticated':True,'leaseVerified':True,
 'destructiveOperationAuthorized':False,'installationExecuted':False,'deploymentAuthorized':False,'productionAuthorized':False}
observer=l.load_authenticated(material[1]['ops/payload-production-observer.py'],l.OBSERVER)
class Pipe:
 def __init__(self,fd):self.fd=fd
 def fileno(self):return self.fd
 def write(self,value):return len(value)
 def close(self):pass
class Selector:
 def __init__(self,timeout):self.timeout=timeout;self.selects=0
 def register(self,*args):pass
 def unregister(self,*args):pass
 def close(self):pass
 def select(self,remaining):self.selects+=1;return [] if self.timeout else [(types.SimpleNamespace(fileobj=process.stdout),None)]
class Process:
 pid=321
 def __init__(self,status):self.stdin=Pipe(10);self.stdout=Pipe(11);self.returncode=status;self.killed=False;self.waited=False
 def wait(self,timeout=None):self.waited=True;return self.returncode
 def kill(self):self.killed=True
for scenario in ('timeout','overflow','nonzero','malformed','wrong-nonce','wrong-approval','wrong-pid'):
 value=copy.deepcopy(base);status=0;timeout=scenario=='timeout'
 if scenario=='overflow':frame=b'x'*(l.OBSERVER_MAX_FRAME+1)
 elif scenario=='malformed':frame=b'{not-json}\n'
 else:
  if scenario=='wrong-nonce':value['nonce']='6'*64
  if scenario=='wrong-approval':value['context']['approvalSha256']='6'*64
  if scenario=='wrong-pid':value['context']['pid']=999
  frame=observer.canonical(value)+b'\n'
 if scenario=='nonzero':status=4
 chunks=[frame,b''];process=Process(status);selector=Selector(timeout)
 clock=iter((0,0,31,31) if timeout else (0,0,0,0,0,0))
 with patch.object(l,'authenticate',return_value=material),patch.object(l.subprocess,'Popen',return_value=process), \
      patch.object(l.selectors,'DefaultSelector',return_value=selector),patch.object(l.os,'read',side_effect=lambda fd,n:chunks.pop(0)), \
      patch.object(l.os,'set_blocking'),patch.object(l.time,'monotonic',side_effect=lambda:next(clock)):
  try:l.run_bounded_observer(request)
  except l.VerificationError as error:assert str(error)=='preparation_verification_denied'
  else:raise AssertionError(scenario+' accepted')
 assert process.waited,scenario
 assert process.killed==(scenario in ('timeout','overflow')),scenario
 if timeout:assert selector.selects==1,'timeout must pass through selector before deadline denial'
`);
});

test('every post-spawn BaseException and cleanup failure terminates and reaps before sanitized denial (portable process doubles)', () => {
  probe(String.raw`
from unittest.mock import patch
material=l.authenticate();digest=material[4];nonce='7'*64
request={'schemaVersion':1,'kind':'payload-production-context-request-v1','operation':'collect-context','nonce':nonce,'approvalSha256':digest}
context={'approvalSha256':digest,'sourceCommit':approval['hostBaseline']['currentCommit'],'inventoryIdentity':'8'*64,
 'stateSha256':'9'*64,'stateSequence':3,'pid':321,'processStart':654,'leaseDevice':7,'leaseInode':8}
response={'schemaVersion':1,'kind':'payload-production-context-observation-v1','operation':'collect-context','nonce':nonce,
 'context':context,'sourceAuthenticated':True,'inventoryAuthenticated':True,'stateAuthenticated':True,'leaseVerified':True,
 'destructiveOperationAuthorized':False,'installationExecuted':False,'deploymentAuthorized':False,'productionAuthorized':False}
observer=l.load_authenticated(material[1]['ops/payload-production-observer.py'],l.OBSERVER);frame=observer.canonical(response)+b'\n'
events=[];scenario=''
class Pipe:
 def __init__(self,name,fd):self.name=name;self.fd=fd;self.close_calls=0;self.open=True
 def fileno(self):return self.fd
 def write(self,value):
  events.append('stdin-write')
  if scenario=='stdin-write':raise SystemExit('private')
  return len(value)
 def close(self):
  self.close_calls+=1;events.append(self.name+'-close')
  if scenario==self.name+'-close' and self.close_calls==1:raise KeyboardInterrupt()
  self.open=False
class Process:
 pid=321
 def __init__(self):
  self.stdin=Pipe('stdin',10);self.stdout=Pipe('stdout',11);self.kill_calls=0;self.wait_calls=0;self.reaped=False
 def kill(self):
  self.kill_calls+=1;events.append('kill')
  if scenario=='kill-wait-retry' and self.kill_calls==1:raise InterruptedError()
 def wait(self,timeout=None):
  self.wait_calls+=1;events.append('wait-timeout' if timeout is not None else 'wait-reap')
  assert timeout is not None
  if scenario=='kill-wait-retry' and self.wait_calls==1:raise KeyboardInterrupt()
  self.reaped=True;events.append('reaped');return 0
class Selector:
 def __init__(self):self.close_calls=0;self.open=True
 def register(self,*args):
  events.append('register')
  if scenario=='register':raise SystemExit('private')
 def unregister(self,*args):events.append('unregister')
 def select(self,*args):
  events.append('select')
  if scenario in ('select','interrupt','kill-wait-retry'):raise KeyboardInterrupt()
  return [(types.SimpleNamespace(fileobj=process.stdout),None)]
 def close(self):
  self.close_calls+=1;events.append('selector-close')
  if scenario=='selector-close':raise SystemExit('private')
  self.open=False
def popen(*args,**kwargs):
 if scenario=='popen':raise KeyboardInterrupt()
 events.append('spawn');return process
def selector_factory():
 events.append('selector-create')
 if scenario=='selector-create':raise SystemExit('private')
 return selector
def set_blocking(*args):
 events.append('nonblocking')
 if scenario=='nonblocking':raise KeyboardInterrupt()
def read(*args):
 events.append('read')
 if scenario=='read':raise SystemExit('private')
 return chunks.pop(0)
for scenario in ('popen','stdin-write','stdin-close','nonblocking','selector-create','register','select','read',
                 'interrupt','kill-wait-retry','selector-close','stdout-close'):
 events.clear();chunks=[frame,b''];process=Process();selector=Selector()
 with patch.object(l,'authenticate',return_value=material),patch.object(l.subprocess,'Popen',side_effect=popen), \
      patch.object(l.selectors,'DefaultSelector',side_effect=selector_factory),patch.object(l.os,'set_blocking',side_effect=set_blocking), \
      patch.object(l.os,'read',side_effect=read),patch.object(l.time,'monotonic',return_value=0), \
      patch.object(l,'_observer_cleanup_fail_stop',side_effect=AssertionError('unexpected-fail-stop')):
  try:l.run_bounded_observer(request)
  except l.VerificationError as error:assert str(error)=='preparation_verification_denied'
  except BaseException as error:raise AssertionError((scenario,'unsanitized',type(error).__name__))
  else:raise AssertionError(scenario+' accepted')
 events.append('caller-resumed')
 if scenario=='popen':
  assert 'spawn' not in events and process.kill_calls==process.wait_calls==0
  continue
 assert process.reaped and 'reaped' in events,scenario
 denial_cleanup_end=max(events.index('reaped'),max(i for i,value in enumerate(events) if value.endswith('-close')))
 assert denial_cleanup_end<events.index('caller-resumed'),scenario
 assert events.index('reaped')<max(i for i,value in enumerate(events) if value=='stdin-close'),scenario
 assert events.index('reaped')<max(i for i,value in enumerate(events) if value=='stdout-close'),scenario
 if 'selector-close' in events:assert events.index('reaped')<events.index('selector-close'),scenario
 if scenario in ('selector-close','stdout-close'):
  assert process.kill_calls==0,'already reaped child must not be killed'
 else:
  assert process.kill_calls>=1,scenario
 assert process.stdin.close_calls>=1 and process.stdout.close_calls>=1,scenario
 assert process.stdin.open is False,scenario
 assert process.stdout.open==(scenario=='stdout-close'),scenario
 if scenario=='selector-close':
  assert selector.open is True and process.stdin.open is process.stdout.open is False
 elif 'selector-create' in events and scenario!='selector-create':assert selector.open is False,scenario
 if scenario=='kill-wait-retry':assert process.kill_calls==2 and process.wait_calls>=2
`);
});

test('persistent child termination failures invoke one fail-stop after finite independent resource cleanup (portable process doubles)', () => {
  probe(String.raw`
from unittest.mock import patch
assert hasattr(l,'_observer_cleanup_fail_stop'),'terminal cleanup-failure policy is missing'
material=l.authenticate();digest=material[4];nonce='7'*64
request={'schemaVersion':1,'kind':'payload-production-context-request-v1','operation':'collect-context','nonce':nonce,'approvalSha256':digest}
events=[];mode=''
class FailStop(BaseException):pass
class Pipe:
 def __init__(self,name,fd):self.name=name;self.fd=fd;self.open=True
 def fileno(self):return self.fd
 def write(self,value):return len(value)
 def close(self):events.append(self.name+'-close');self.open=False
class Process:
 pid=321
 def __init__(self):self.stdin=Pipe('stdin',10);self.stdout=Pipe('stdout',11);self.kill_calls=0;self.wait_calls=0
 def kill(self):
  self.kill_calls+=1;events.append('kill')
  if mode=='kill':raise OSError('persistent private kill failure')
  if mode=='kill-interrupt':raise KeyboardInterrupt()
 def wait(self,timeout=None):
  self.wait_calls+=1;events.append('wait')
  assert timeout is not None
  if mode=='wait':raise OSError('persistent private wait failure')
  if mode=='wait-interrupt':raise KeyboardInterrupt()
  return 0
class Selector:
 def __init__(self):self.open=True
 def register(self,*args):pass
 def unregister(self,*args):events.append('unregister')
 def select(self,*args):raise RuntimeError('enter cleanup')
 def close(self):events.append('selector-close');self.open=False
def fail_stop():events.append('fail-stop');raise FailStop()
for mode in ('kill','wait','kill-interrupt','wait-interrupt'):
 events.clear();process=Process();selector=Selector()
 with patch.object(l,'authenticate',return_value=material),patch.object(l.subprocess,'Popen',return_value=process), \
      patch.object(l.selectors,'DefaultSelector',return_value=selector),patch.object(l.os,'set_blocking'), \
      patch.object(l,'_observer_cleanup_fail_stop',side_effect=fail_stop),patch.object(l.time,'monotonic',return_value=0):
  try:l.run_bounded_observer(request)
  except FailStop:pass
  except BaseException as error:raise AssertionError((mode,'wrong terminal path',type(error).__name__))
  else:raise AssertionError(mode+' returned through normal denial/success')
 assert events.count('fail-stop')==1 and events[-1]=='fail-stop',events
 expected_kills=l.OBSERVER_CLEANUP_INTERRUPT_RETRIES if mode=='kill-interrupt' else 1
 expected_waits=l.OBSERVER_CLEANUP_INTERRUPT_RETRIES if mode=='wait-interrupt' else (1 if mode=='wait' else 0)
 assert process.kill_calls==expected_kills and process.wait_calls==expected_waits,events
 assert selector.open is False and process.stdin.open is False and process.stdout.open is False,events
 last_stdin=max(i for i,value in enumerate(events) if value=='stdin-close')
 assert events.index('selector-close')<last_stdin<events.index('stdout-close')<events.index('fail-stop'),events
`);
});

test('context collection owns the lease, independently projects context, and denies all post-child drift (portable observation doubles)', () => {
  probe(String.raw`
from contextlib import contextmanager
from unittest.mock import patch
material=l.authenticate();digest=material[4];captured=material[1];held=[False];events=[]
body={'sequence':4,'private':'not-returned'}
class State:
 @staticmethod
 def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
class Inventory:
 @staticmethod
 def identity(value):return value['identity']
runtime=types.SimpleNamespace(STATE=State,INVENTORY=Inventory)
inventory={'identity':'8'*64}
lease_info=types.SimpleNamespace(st_dev=7,st_ino=8)
@contextmanager
def lease(close_only=False):
 assert close_only is True;held[0]=True;events.append('acquire')
 def reaffirm():assert held[0];events.append('reaffirm')
 try:yield reaffirm
 finally:held[0]=False;events.append('release')
def baseline(*args,**kwargs):
 assert held[0] and kwargs=={'metadata_only':True};events.append('host')
def inspect(*args,**kwargs):
 assert held[0] and kwargs=={'metadata_only':True};events.append('inspect');return runtime,inventory,body,None
def child(request):
 assert held[0];events.append('child')
 context={'approvalSha256':digest,'sourceCommit':material[0]['hostBaseline']['currentCommit'],'inventoryIdentity':'8'*64,
  'stateSha256':hashlib.sha256(State.canonical(body)).hexdigest(),'stateSequence':4,'leaseDevice':7,'leaseInode':8,
  'pid':321,'processStart':654}
 return {'schemaVersion':1,'kind':'payload-production-context-observation-v1','operation':'collect-context','nonce':request['nonce'],
  'context':context,'sourceAuthenticated':True,'inventoryAuthenticated':True,'stateAuthenticated':True,'leaseVerified':True,
  'destructiveOperationAuthorized':False,'installationExecuted':False,'deploymentAuthorized':False,'productionAuthorized':False}
with patch.object(l,'authenticate',side_effect=[material,material,material]),patch.object(l,'deployment_lease',lease), \
     patch.object(l,'verify_host_baseline',side_effect=baseline),patch.object(l,'inspect_install_host',side_effect=inspect), \
     patch.object(l,'run_bounded_observer',side_effect=child),patch.object(l.os,'fstat',return_value=lease_info), \
     patch.object(l.os,'urandom',return_value=b'N'*32):
 result=l.collect_context()
assert result['nonce']==(b'N'*32).hex() and result['context']['stateSequence']==4
assert result['deploymentAuthorized'] is False and result['productionAuthorized'] is False
assert events.index('acquire')<events.index('child')<events.index('release') and events.count('host')==2 and events.count('inspect')==2

def attempt(kind):
 final=list(material);current_inventory={'identity':'8'*64};current_body={'sequence':4,'private':'not-returned'}
 infos=[lease_info,lease_info]
 if kind=='source':
  final[0]=copy.deepcopy(material[0]);final[0]['hostBaseline']['currentCommit']='0'*40
 if kind=='closure':final[1]=dict(captured,extra=b'drift')
 if kind=='approval':final[4]='0'*64
 if kind=='inventory':current_inventory={'identity':'0'*64}
 if kind=='state':current_body={'sequence':5,'private':'not-returned'}
 if kind=='fd9':infos[1]=types.SimpleNamespace(st_dev=7,st_ino=9)
 calls=[0]
 def changing_inspect(*args,**kwargs):
  assert kwargs=={'metadata_only':True}
  calls[0]+=1
  return runtime,(inventory if calls[0]==1 else current_inventory),(body if calls[0]==1 else current_body),None
 def mismatching_child(request):
  value=child(request)
  if kind=='result':value['context']['stateSha256']='0'*64
  return value
 with patch.object(l,'authenticate',side_effect=[material,material,tuple(final)]),patch.object(l,'deployment_lease',lease), \
      patch.object(l,'verify_host_baseline'),patch.object(l,'inspect_install_host',side_effect=changing_inspect), \
      patch.object(l,'run_bounded_observer',side_effect=mismatching_child),patch.object(l.os,'fstat',side_effect=infos):
  try:l.collect_context()
  except l.VerificationError:pass
  else:raise AssertionError(kind+' drift accepted')
for kind in ('source','closure','approval','inventory','state','fd9','result'):attempt(kind)
`);
});

test('collect-context CLI has exact two-token grammar and authenticates the supplied approval before collection', () => {
  probe(String.raw`
from unittest.mock import patch
material=l.authenticate();digest=material[4]
result={'kind':'bounded','deploymentAuthorized':False}
safe_env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}
identity={'getuid':lambda:0,'geteuid':lambda:0,'getgid':lambda:0,'getegid':lambda:0}
with patch.object(l.sys,'platform','linux'),patch.multiple(l.os,create=True,**identity),patch.object(l.os.path,'realpath',side_effect=lambda value:value), \
     patch.object(l.os,'environ',safe_env),patch.object(l,'authenticate',return_value=material),patch.object(l,'collect_context',return_value=result) as collect, \
     patch('builtins.print') as output:
 l.sys.argv=['launcher','--collect-context',digest];l.main();collect.assert_called_once_with()
 output.assert_called_once_with(json.dumps(result,sort_keys=True,separators=(',',':')))
 for args in (['--collect-context'],['--collect-context',digest,'extra'],['--collect-context','0'*64],['--collect-context='+digest]):
  l.sys.argv=['launcher']+args
  try:l.main()
  except l.VerificationError:pass
  else:raise AssertionError('grammar accepted '+repr(args))
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

test('all 16 source files authenticate before any closure helper; fixed report never authorizes execution (read doubles)', () => {
  probe(String.raw`
assert len(p.PREPARATION_FILES)==16
assert p.PREPARATION_FILES==l.FILES
assert 'ops/payload-production-observer.py' in p.PREPARATION_FILES
assert p.PREPARATION_LAUNCHER=='/usr/local/libexec/ownerinc-payload-prepare.py'
assert p.PREPARATION_ROOT=='/opt/ownerinc/lib/payload-preparation'
assert p.PREPARATION_APPROVAL=='/etc/ownerinc/payload-preparation/production-approval.json'
result=l.verify()
assert result=={'kind':'payload-preparation-verification-only','sourceAuthenticated':True,
    'admissionRecordAuthenticated':True,'cmsImage':images['cms'],'hostBaselineChecked':True,
    'archiveBytesChecked':False,'preparationExecuted':False,'deploymentAuthorized':False}
assert len(loads)==2
observer='ops/payload-production-observer.py';observer_target=p.preparation_target(observer)
before=store[observer_target];loads.clear()
put(observer_target,b'raise Exception("MUST NOT EXECUTE")\n',before[1])
try:l.verify()
except l.VerificationError:pass
else:raise AssertionError('observer hash mismatch accepted')
assert loads==[]
store[observer_target]=before
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
 lambda a:a['source']['files'].update({'extra':'a'*64}),lambda a:a['source']['files'].pop('ops/payload-production-observer.py'),
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
