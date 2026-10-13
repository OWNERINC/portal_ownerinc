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
def denied(fn):
    try:fn()
    except Exception:return
    raise AssertionError('unexpected acceptance')
`;
function probe(code) {
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', setup + code, repo], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('all 15 source files authenticate before any closure helper; fixed report never authorizes execution (read doubles)', () => {
  probe(String.raw`
assert p.PREPARATION_FILES==l.FILES and len(l.FILES)==15
assert p.PREPARATION_LAUNCHER=='/usr/local/libexec/ownerinc-payload-prepare.py'
assert p.PREPARATION_ROOT=='/opt/ownerinc/lib/payload-preparation'
assert p.PREPARATION_APPROVAL=='/etc/ownerinc/payload-preparation/production-approval.json'
result=l.verify()
assert result=={'kind':'payload-preparation-verification-only','sourceAuthenticated':True,
    'admissionRecordAuthenticated':True,'cmsImage':images['cms'],'hostBaselineChecked':False,
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
