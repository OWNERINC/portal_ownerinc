import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const fixture = String.raw`
import sys,pathlib,types,json,copy,io,tarfile,gzip,posixpath,stat,os
from unittest.mock import patch
from contextlib import contextmanager
repo=pathlib.Path(sys.argv[1])
def module(relative):
 m=types.ModuleType(relative);m.__file__=str(repo/relative)
 exec(compile((repo/relative).read_bytes(),m.__file__,'exec'),m.__dict__);return m
l=module('ops/prepare-cms-authenticated.py');p=module('ops/provision-payload-candidate-trust.py');v=module('ops/payload-candidate-verifier.py')
captured={r:(repo/r).read_bytes() for r in p.PREPARATION_FILES}
os.path=posixpath;sys.executable='/usr/bin/python3';l.__file__=l.LAUNCHER
os.O_NOFOLLOW=getattr(os,'O_NOFOLLOW',0);os.O_NONBLOCK=getattr(os,'O_NONBLOCK',0)
files={};directories={'/':0o755};fds={};held=[False];constructors=[];metadata_overrides={}
def directory(name,mode=0o755):
 if name!='/' and posixpath.dirname(name) not in directories:directory(posixpath.dirname(name))
 directories[name]=mode
def put(name,data,mode=0o600,owner=(0,0)):
 directory(posixpath.dirname(name),directories.get(posixpath.dirname(name),0o755));files[name]=(data,mode,owner)
def meta(name):
 if name in files:
  data,mode,owner=files[name];kind=stat.S_IFREG;size=len(data)
 elif name in directories:mode=directories[name];owner=(0,0);kind=stat.S_IFDIR;size=0
 else:raise FileNotFoundError(name)
 result=types.SimpleNamespace(st_mode=kind|mode,st_uid=owner[0],st_gid=owner[1],st_nlink=1,st_size=size,
  st_dev=1,st_ino=abs(hash(name)),st_mtime_ns=1,st_ctime_ns=1)
 result.__dict__.update(metadata_overrides.get(name,{}));return result
def listing(name):
 if name not in directories:raise FileNotFoundError(name)
 return sorted({posixpath.basename(n) for n in set(files)|set(directories) if n!='/' and posixpath.dirname(n)==name})
def read(name,mode,limit):
 data,actual,owner=files[name];assert actual==mode and owner==(0,0) and 0<len(data)<=limit
 return data
def raw(value):return (json.dumps(value)+'\n').encode()
for r,data in captured.items():put(p.preparation_target(r),data,p.preparation_mode(r))
policy={'schemaVersion':1,'kind':'ownerinc-payload-candidate-policy-v1','environment':'production',
 'repository':'OWNERINC/portal_ownerinc','repositoryId':'123','workflow':'.github/workflows/ci.yml','workflowId':'456',
 'approvedRevisions':[{'commit':'a'*40,'workflowSha256':'b'*64}], 'toolchain':{'files':{},'executables':{}}}
for r in p.TOOL_FILES:
 data=(repo/r).read_bytes();put(p.TOOL_ROOT+'/'+r,data,0o755 if r.endswith('.py') else 0o644);policy['toolchain']['files'][r]=p.sha(data)
for role in ('node','git','python','gitRemoteHttps'):
 name=p.TOOL_ROOT+'/bin/git-remote-https' if role=='gitRemoteHttps' else '/usr/bin/'+('python3' if role=='python' else role)
 data=('synthetic-'+role).encode();put(name,data,0o755);policy['toolchain']['executables'][role]={'path':name,'sha256':p.sha(data)}
images={s:'ghcr.io/ownerinc/ownerinc-portal-'+s+'@sha256:'+'c'*64 for s in ('api','cron','cms')}
entries={'.ci-commit':b'a'*40+b'\n','.ci-images':('\n'.join(images.values())+'\n').encode(),
 'docker-compose.yml':b'services: {}\n','docker-compose.payload.yml':b'services: {}\n',
 'scripts/do-not-execute.py':b'raise AssertionError("RECEIVED CODE EXECUTED")\n','empty':b''}
buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode='w') as archive:
 for name,data in entries.items():
  entry=tarfile.TarInfo(name);entry.size=len(data);archive.addfile(entry,io.BytesIO(data))
archive_raw=gzip.compress(buffer.getvalue(),mtime=0)
record={'schemaVersion':1,'kind':'payload-candidate-admission-record-v1','environment':'production',
 'repository':'OWNERINC/portal_ownerinc','repositoryId':'123','workflow':'.github/workflows/ci.yml','workflowId':'456',
 'workflowSha256':'b'*64,'commit':'a'*40,'runId':'789','runAttempt':'1','images':copy.deepcopy(images),
 'artifacts':{role:{'id':str(i+1),'digest':'sha256:'+'d'*64} for i,role in enumerate(v.ROLES)},
 'qualificationContract':v.CONTRACT,'sourceTreeSha':'e'*40,'archiveBytes':len(archive_raw),
 'archiveSha256':p.sha(archive_raw),'deploymentAuthorized':False}
for field in ('candidateSha256','qualifiedManifestSha256','recoveryReportSha256','sourceArchiveSha256'):record[field]='f'*64
approval={'schemaVersion':1,'kind':'ownerinc-payload-preparation-approval-v1','environment':'production',
 'repository':'OWNERINC/portal_ownerinc','source':{'commit':'1'*40,'files':{r:p.sha(d) for r,d in captured.items()}},
 'hostBaseline':{'currentCommit':'2'*40,'legacyImages':{s:images[s] for s in ('api','cron')},
 'releaseComposeSha256':p.sha(b'compose'),'runtimeComposeSha256':p.sha(b'compose'),'releaseOverrideSha256':None,
 'inventoryIdentity':'5'*64,'installedPredecessors':{'commonReceiver':'6'*64,'receiverHelper':None,
 'productionWrapper':None,'operationsGuard':None,'cmsCandidate':None}},'admission':{}}
receipt='/var/lib/ownerinc/payload-candidate/incoming/payload-abcdefgh'
directory(receipt,0o700);directory(receipt+'/release',0o700)
put(receipt+'/candidate.tar.gz',archive_raw)
put(receipt+'/admission.json',b'UNTRUSTED SIDECAR IS NOT AUTHORITY')
for name,data in entries.items():put(receipt+'/release/'+name,data,0o644)
def bind():
 put(p.POLICY_PATH,raw(policy));record['policySha256']=p.sha(raw(policy))
 approval['admission']={'policySha256':p.sha(raw(policy)),'archiveSha256':record['archiveSha256'],'recordSha256':p.sha(raw(record))}
 directory(v.REGISTRY,0o700);put(v.REGISTRY+'/'+record['archiveSha256']+'.'+record['policySha256']+'.json',raw(record))
 put(l.APPROVAL,raw(approval))
real_load=l.load_authenticated
def load(data,filename):
 m=real_load(data,filename)
 if filename.endswith('provision-payload-candidate-trust.py'):m.read_protected=read
 elif filename.endswith('payload-candidate-verifier.py'):
  m.read_protected=lambda name,limit,modes=(0o600,),private_parent=False:read(name,modes[0],limit)
 return m
l.load_authenticated=load;l.protected=read
r=l.load_runtime_captured(captured);s=r.STATE;inv=r.INVENTORY
document=inv.production_inventory(l.HOST_ROOT,l.RUNTIME,l.RELEASES,l.HOST_ROOT+'/current-release',l.LOCK,
 '/opt/ownerinc/backups/portal-ownerinc/daily',l.PRODUCTION_BACKUP,l.PRODUCTION_BACKUP+'/restore-protection',
  l.ENVIRONMENT,l.RUNTIME+'/compose.production.yaml',l.RUNTIME+'/compose.payload.production.yaml','portal')
approval['hostBaseline']['inventoryIdentity']=inv.identity(document);bind()
directory(l.RUNTIME);directory(l.RELEASES);directory(l.RUNTIME+'/payload-control-state',0o700)
source=l.RELEASES+'/'+'2'*40
put(l.HOST_ROOT+'/current-release',(source+'\n').encode(),0o644,(1000,1000))
put(source+'/.image-env',('API_IMAGE='+images['api']+'\nCRON_IMAGE='+images['cron']+'\n').encode(),0o644,(1000,1000))
put(source+'/docker-compose.yml',b'compose',0o644,(1000,1000))
put(l.RUNTIME+'/compose.production.yaml',b'compose',0o644,(1000,1000))
put(l.ENVIRONMENT,b'PRIVATE=never-output\nPOSTGRES_DB=portal\nCMS_PORTAL_DATABASE_NAME=portal\n',0o600,(1000,1000));put(l.LOCK,b'lock')
put(l.RUNTIME+'/payload-control-inventory.json',inv.canonical(document)+b'\n')
key=b'K'*32;put(l.RUNTIME+'/payload-control.key',key)
initial={'schemaVersion':2,'phase':'preauthority','cmsStatus':'cold','authority':{'mode':'legacy','epoch':1},
 'workerHold':True,'admission':'open','sequence':0,'previousStateSha256':None,'restoreIntent':None,'installIntent':None,
 'latestProofSha256':None,'legacySourceProofSha256':None,'releaseImages':None,'plannedReleaseImages':None,
 'rollbackTargetImages':None,'nativeCatalogFingerprint':None,'inventoryIdentity':inv.identity(document)}
history=[]
def append(body):
 body=copy.deepcopy(body);body['sequence']=len(history);body['previousStateSha256']=p.sha(s.canonical(history[-1])) if history else None
 s.validate_state_body(body)
 if history:s.validate_state_transition(history[-1]['body'],body)
 envelope=s.sign_envelope(body,key);history.append(envelope)
 put(l.RUNTIME+'/payload-control-state/'+str(body['sequence']).zfill(20)+'.json',s.canonical(envelope)+b'\n')
 put(l.RUNTIME+'/payload-control-state/current.json',s.canonical(envelope)+b'\n');return copy.deepcopy(body)
body=append(initial)
@contextmanager
def lease():
 assert not held[0];held[0]=True
 try:yield lambda:None
 finally:held[0]=False
l.deployment_lease=lease
def open_file(name,flags,*args):
 assert held[0] and not flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC),'unexpected write'
 assert name in files;fd=len(fds)+20;fds[fd]=name;return fd
def memory_fdopen(fd,*args,**kwargs):
 class Stream(io.BytesIO):
  def fileno(self):return fd
  def close(self):
   if kwargs.get('closefd',True):fds.pop(fd,None)
   super().close()
 return Stream(files[fds[fd]][0])
real_runtime=l.load_runtime_captured
def runtime(c):
 value=real_runtime(c)
 def forbidden(*args):constructors.append(True);raise AssertionError('Runtime constructor forbidden')
 value.Runtime=forbidden;return value
l.load_runtime_captured=runtime
def run(receipt_id='payload-abcdefgh'):
 before=copy.deepcopy(files)
 with patch.multiple(os,name='posix',getuid=lambda:0,geteuid=lambda:0,getgid=lambda:0,getegid=lambda:0,create=True), \
      patch.object(os,'lstat',side_effect=meta),patch.object(os,'fstat',side_effect=lambda fd:meta(fds[fd])), \
      patch.object(os.path,'lexists',side_effect=lambda n:n in files or n in directories),patch.object(os,'listdir',side_effect=listing), \
      patch.object(os,'open',side_effect=open_file),patch.object(os,'close',side_effect=lambda fd:fds.pop(fd)), \
      patch.object(os,'fdopen',side_effect=memory_fdopen), \
      patch.object(os,'mkdir',side_effect=AssertionError('write forbidden')),patch.object(l.subprocess,'run',side_effect=AssertionError('subprocess forbidden')):
  result=l.check_install_plan(receipt_id)
 assert files==before and not constructors and not held[0] and not fds
 return result
def denied(fn):
 before=copy.deepcopy(files)
 try:fn()
 except Exception:pass
 else:raise AssertionError('unexpected acceptance')
 assert files==before and not held[0] and not constructors
`;

function probe(code) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-S', '-B', '-c', fixture + code, path.resolve('.')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('install plan reuses actual archive/admission/tree and signed-state validators without Runtime construction or effects (I/O doubles)', () => {
  probe(String.raw`
result=run();assert result['classification']=='initial_cold'
assert result['candidate']['bundleSha256']==record['archiveSha256']
assert result['candidate']['reportSha256']==record['recoveryReportSha256']
assert result['candidate']['qualificationSha256']==record['qualifiedManifestSha256']
assert result['trust']['recordSha256']==approval['admission']['recordSha256']
assert result['installationExecuted'] is False and result['deploymentAuthorized'] is False
assert 'production_runtime_ownership_incompatible' in result['blockers']
assert 'production_creation_binding_unsupported' in result['blockers']
assert len(json.dumps(result).encode())<=4096 and 'PRIVATE' not in json.dumps(result) and receipt not in json.dumps(result)
for name in ('../payload-abcdefgh','/tmp/path','newest','payload-abcdefgh/../other','APPROVED=1'):denied(lambda:run(name))
directory(receipt+'-newest',0o700);put(receipt+'-newest/admission.json',b'forged');assert run()==result
`);
});

test('wrong archive, extracted bytes/tree, policy and reapproved malformed records fail without effects (I/O doubles)', () => {
  probe(String.raw`
run()
for name in (receipt+'/candidate.tar.gz',receipt+'/release/.ci-images',receipt+'/release/empty'):
 old=files[name];put(name,b'altered',old[1],old[2]);denied(run);files[name]=old
put(receipt+'/release/.image-env',b'forged',0o644);denied(run);del files[receipt+'/release/.image-env']
for defect in ({'st_mode':stat.S_IFLNK|0o644},{'st_nlink':2},{'st_uid':1000}):
 metadata_overrides[receipt+'/release/empty']=defect;denied(run);metadata_overrides.clear()
old=copy.deepcopy(record)
for field,value in [('images',dict(images,cms='ghcr.io/ownerinc/ownerinc-portal-cms@sha256:'+'0'*64)),
 ('workflowSha256','0'*64),('qualificationContract','forged'),('deploymentAuthorized',True)]:
 record.clear();record.update(copy.deepcopy(old));record[field]=value;bind();denied(run)
record.clear();record.update(old);bind();run()
saved=files[p.POLICY_PATH];put(p.POLICY_PATH,raw(dict(policy,repositoryId='999')));denied(run);files[p.POLICY_PATH]=saved
for filename in (source+'/.image-env',source+'/docker-compose.yml',l.HOST_ROOT+'/current-release',l.RUNTIME+'/payload-control-inventory.json'):
 saved=files[filename];put(filename,b'not approved',saved[1],saved[2]);denied(run);files[filename]=saved
head=l.RUNTIME+'/payload-control-state/current.json';saved=files[head]
envelope=json.loads(saved[0]);envelope['signature']['value']='0'*64;put(head,s.canonical(envelope)+b'\n');denied(run);files[head]=saved
directory(document['paths']['backupRoots'][0]+'/000-initial-install-b0',0o700)
assert run()['b0Status']=='unbound' and 'partial_or_unbound_b0' in run()['blockers']
`);
});

test('actual signed pending/floor journals classify without repair, clearing intent or enabling installation (I/O doubles)', () => {
  probe(String.raw`
candidate=run()['candidate']
def target(database,keys):
 return {'database':{'systemIdentifier':'123','databaseOid':'456','databaseName':database},
  'volumes':{k:{'name':k,'driver':'local','mountpoint':'/volumes/'+k,'fingerprint':'7'*64} for k in keys}}
b0=l.PRODUCTION_BACKUP+'/install-b0'
binding={'candidate':candidate,'candidateRelease':l.RELEASES+'/'+record['commit'],'sourceRelease':source,
 'previousImages':approval['hostBaseline']['legacyImages'],'b0':{'directory':b0,'proofSha256':'9'*64},
 'inventoryIdentity':inv.identity(document),'lease':{'device':1,'inode':2},
 'portalTarget':target('portal',('portalPostgres','portalUploads'))}
body.update(admission='closed',plannedReleaseImages=images,legacySourceProofSha256='9'*64,latestProofSha256='9'*64)
body=append(body)
body['installIntent']={'binding':binding,'stage':'reserved','cmsTarget':None};body=append(body)
result=run();assert result['classification']=='pre_floor_install_pending'
assert 'creation_receipts_incomplete' in result['blockers'] and result['b0Status']=='absent'
directory(b0,0o700);put(b0+'/postgres.dump',b'partial')
assert run()['b0Status']=='partial'
for stage in s.INSTALL_STAGES[1:]:
 body['installIntent']['stage']=stage
 if stage=='cms_resources_bound':body['installIntent']['cmsTarget']=target('ownerinc_cms',('cmsPostgres','cmsUploads'))
 if stage=='provisioned':body['cmsStatus']='provisioned'
 body=append(body);assert run()['classification']=='pre_floor_install_pending'
body['installIntent'].update(stage='floor_commit_pending',floor={'nativeCatalogFingerprint':'8'*64,
 'sourceRelease':source,'candidateRelease':binding['candidateRelease']});body=append(body)
assert run()['classification']=='floor_commit_pending'
put(l.HOST_ROOT+'/current-release',(binding['candidateRelease']+'\n').encode())
assert run()['classification']=='floor_commit_pending'
body['installIntent']['stage']='floor_committed';body.update(cmsStatus='migrated',releaseImages=images,
 plannedReleaseImages=None,nativeCatalogFingerprint='8'*64);body=append(body)
result=run();assert result['classification']=='floor_committed' and 'install_intent_retained' in result['blockers']
assert result['deploymentAuthorized'] is False and result['installationExecuted'] is False
# Restore may legally coexist with the retained committed install intent.
portal=binding['portalTarget'];cms=body['installIntent']['cmsTarget']
body['restoreIntent']={'proofSha256':'6'*64,'stage':'reserved','releaseImages':images,
 'targetFingerprints':{name:'7'*64 for name in ('portalDatabase','cmsDatabase','portalUploads','cmsUploads')},
 'target':{'inventoryIdentity':inv.identity(document),'portal':portal['database'],'cms':cms['database'],
 'volumes':dict(portal['volumes'],**cms['volumes'])}}
body=append(body) # Real body/transition validation and HMAC-signed journal append.
del files[b0+'/postgres.dump'];del directories[b0]
result=run();assert result['classification']=='restore_pending' and result['b0Status']=='absent'
for blocker in ('restore_intent_retained','install_intent_retained','bound_b0_missing','creation_receipts_incomplete'):
 assert blocker in result['blockers'],blocker
assert 'existing_install_candidate_mismatch' not in result['blockers']
record['candidateSha256']='0'*64;bind() # Valid newly approved candidate, not a forged state mutation.
result=run();assert result['classification']=='restore_pending'
for blocker in ('restore_intent_retained','install_intent_retained','bound_b0_missing',
                'creation_receipts_incomplete','existing_install_candidate_mismatch'):
 assert blocker in result['blockers'],blocker
assert result['deploymentAuthorized'] is False and result['installationExecuted'] is False
# A unique signed append/head window must remain unrepaired by this check.
head=l.RUNTIME+'/payload-control-state/current.json';put(head,s.canonical(history[-2])+b'\n')
try:run()
except Exception as error:assert str(error)=='state_head_mismatch',str(error)
else:raise AssertionError('interrupted head repaired or accepted')
assert files[head][0]==s.canonical(history[-2])+b'\n'
`);
});

test('production v4 shared-cluster correspondence uses authenticated context and created-resource diagnostics (signed I/O doubles)', () => {
  probe(String.raw`
candidate=run()['candidate']
def target(database,keys):
 return {'database':{'systemIdentifier':'123','databaseOid':'456','databaseName':database},
  'volumes':{k:{'name':k,'driver':'local','mountpoint':'/volumes/'+k,'fingerprint':'7'*64} for k in keys}}
trust=run()['trust']
binding={'bindingVersion':4,'authority':trust,'sourceCommit':approval['hostBaseline']['currentCommit'],
 'project':'ownerinc-portal-prod','candidate':candidate,'candidateRelease':l.RELEASES+'/'+record['commit'],
 'sourceRelease':source,'previousImages':approval['hostBaseline']['legacyImages'],
 'b0':{'directory':l.PRODUCTION_BACKUP+'/v3-b0','proofSha256':'9'*64},
 'inventoryIdentity':inv.identity(document),'lease':{'device':1,'inode':2},
 'portalTarget':target('portal',('portalPostgres','portalUploads')),'sharedCluster':document['databaseCluster']}
assert s.validate_production_correspondence(binding,approval,record,document,trust)==binding
for mutate in (lambda b:b['authority'].update(recordSha256='0'*64),
 lambda b:b['authority'].update(policySha256='0'*64),lambda b:b['authority'].update(sourceApprovalSha256='0'*64),
 lambda b:b['candidate'].update(reportSha256='0'*64),lambda b:b['b0'].update(directory='/elsewhere/b0'),
 lambda b:b.update(sourceCommit='3'*40,sourceRelease=l.RELEASES+'/'+'3'*40),
 lambda b:b.update(candidateRelease='/other/'+record['commit'],sourceRelease='/other/'+'2'*40)):
 wrong=copy.deepcopy(binding);mutate(wrong)
 try:s.validate_production_correspondence(wrong,approval,record,document,trust)
 except s.StateError:pass
 else:raise AssertionError('incorrect correspondence accepted')
backup=binding['b0']['directory'];directory(backup,0o700)
upload=io.BytesIO()
with tarfile.open(fileobj=upload,mode='w') as tar:
 entry=tarfile.TarInfo('data');entry.size=3;tar.addfile(entry,io.BytesIO(b'abc'))
upload=gzip.compress(upload.getvalue(),mtime=0)
put(backup+'/postgres.dump',b'not-a-restorability-claim');put(backup+'/uploads.tar.gz',upload)
proof={'schemaVersion':1,'kind':'preauthority-legacy-source','phase':'preauthority',
 'authority':{'mode':'legacy','epoch':1},'protocol':{'status':'absent','coverage':'not-applicable'},
 'inventoryIdentity':binding['inventoryIdentity'],'images':binding['previousImages'],'targetImages':images,
 'source':{'portal':binding['portalTarget']['database'],'cms':None},
 'migrations':{'portal':{'versions':s.PORTAL_MIGRATIONS,'fingerprint':p.sha(s.canonical(s.PORTAL_MIGRATIONS))},
 'cms':None,'nativeCatalogFingerprint':None},'dataFingerprints':{'portalDatabase':'a'*64,
 'portalUploads':r._tar_tree(io.BytesIO(upload),compressed=True),'cmsDatabase':None,'cmsUploads':None},
 'artifacts':[{'name':name,'size':len(files[backup+'/'+name][0]),'sha256':p.sha(files[backup+'/'+name][0])}
 for name in s.LEGACY_ARTIFACTS],'createdAtUtc':'2026-10-13T00:00:00Z'}
proof_raw=s.canonical(s.sign_envelope(proof,key))+b'\n';put(backup+'/preauthority-proof.json',proof_raw)
put(backup+'/manifest.sha256',''.join(a['sha256']+'  '+a['name']+'\n' for a in proof['artifacts']).encode())
binding['b0']['proofSha256']=p.sha(proof_raw)
body.update(admission='closed',plannedReleaseImages=images,legacySourceProofSha256=p.sha(proof_raw),latestProofSha256=p.sha(proof_raw))
body=append(body)
body['installIntent']={'binding':binding,'stage':'reserved','cmsTarget':None,
  'creation':{'receiptVersion':2,'fingerprintAlgorithm':'shared-cluster-container-mounts-v2','nonce':'b'*64,
  'resourceLifecycle':{'preexisting':['postgres','portalPostgres','portalUploads'],'created':['cmsUploads']},'volumes':{},'containers':{}}}
body=append(body)
result=run();assert result['classification']=='pre_floor_install_pending'
assert result['b0Status']=='integrity_verified'
assert result['b0Verification']=={'artifactIntegrityVerified':True,'storageFingerprintVerified':True,
 'databaseRestoreVerified':False,'liveSourceVerified':False,'rollbackAuthorized':False,
 'installationExecuted':False,'deploymentAuthorized':False}
head=l.RUNTIME+'/payload-control-state/current.json';saved_head=files[head]
material=l._authenticated_material;calls=[0]
def change_journal_before_output():
 value=material();calls[0]+=1
 if calls[0]==2:put(head,s.canonical(history[-2])+b'\n')
 return value
with patch.object(l,'_authenticated_material',side_effect=change_journal_before_output):
 try:run()
 except l.VerificationError:pass
 else:raise AssertionError('journal changed before output was accepted')
assert files[head][0]==s.canonical(history[-2])+b'\n' # Not repaired on refusal.
files[head]=saved_head
assert 'production_creation_execution_not_integrated' in result['blockers']
assert 'production_creation_binding_unsupported' not in result['blockers']
assert 'production_binding_context_mismatch' not in result['blockers']
for stage in ('portal_grants_pending','portal_grants_verified','cms_resources_pending'):
 body['installIntent']['stage']=stage;body=append(body)
cms=target('ownerinc_cms',('cmsUploads',))
body['installIntent']['creation']['volumes']=cms['volumes'];body=append(body)
for i,service in enumerate(('cms','api','cron')):
 body['installIntent']['creation']['containers'][service]={'id':str(i+1)*64,
  'image':images[service],
 'fingerprint':'e'*64,'releasePath':binding['candidateRelease'],'creationState':'created'}
 body=append(body)
 assert ('creation_receipts_incomplete' in run()['blockers']) is (service!='cron')
for stage in ('cms_resources_bound','cms_provision_pending','provisioned','floor_commit_pending','floor_committed'):
 body['installIntent']['stage']=stage
 body['installIntent']['cmsTarget']=cms
 if stage in ('provisioned','floor_commit_pending'):body['cmsStatus']='provisioned'
 if stage=='floor_commit_pending':body['installIntent']['floor']={'nativeCatalogFingerprint':'8'*64,
 'sourceRelease':source,'candidateRelease':binding['candidateRelease']}
 if stage=='floor_committed':
  body.update(cmsStatus='migrated',releaseImages=images,plannedReleaseImages=None,nativeCatalogFingerprint='8'*64)
  put(l.HOST_ROOT+'/current-release',(binding['candidateRelease']+'\n').encode())
 body=append(body);run()
portal=binding['portalTarget']
body['restoreIntent']={'proofSha256':'6'*64,'stage':'reserved','releaseImages':images,
 'targetFingerprints':{name:'7'*64 for name in ('portalDatabase','cmsDatabase','portalUploads','cmsUploads')},
 'target':{'inventoryIdentity':inv.identity(document),'portal':portal['database'],'cms':cms['database'],
 'volumes':dict(portal['volumes'],**cms['volumes'])}}
body=append(body)
# A newly authenticated authority cannot silently rebind an existing signed reservation.
for name in ('postgres.dump','uploads.tar.gz','preauthority-proof.json','manifest.sha256'):del files[backup+'/'+name]
del directories[backup]
approval['source']['commit']='3'*40;bind()
result=run();assert result['classification']=='restore_pending'
assert 'existing_install_authority_mismatch' in result['blockers']
assert 'bound_b0_missing' in result['blockers'] and 'install_intent_retained' in result['blockers']
assert result['installationExecuted'] is False and result['deploymentAuthorized'] is False
`);
});

test('captured imports and existing unconditional receiver/runtime denials remain intact', () => {
  probe(String.raw`
import importlib.util
with patch.object(importlib.util,'spec_from_file_location',side_effect=AssertionError('unchecked helper reopened')):
 loaded=l.load_runtime_captured(captured)
 assert loaded.STATE.INVENTORY is loaded.INVENTORY
try:r.Runtime.install_receiver_preflight(None)
except Exception as error:assert str(error)=='release_not_preflighted'
else:raise AssertionError('runtime installation denial removed')
receiver=captured['ops/payload-receiver-admission.py'].decode()
assert "raise ReceiverError('release_not_preflighted')" in receiver
assert 'initialize-production' not in r.ACTION_SET and 'check-install-plan' not in r.ACTION_SET
with patch.object(sys,'argv',['launcher','--check-install-plan','payload-abcdefgh']),patch.object(sys,'platform','linux'), \
     patch.multiple(os,getuid=lambda:0,geteuid=lambda:0,getgid=lambda:0,getegid=lambda:0,create=True), \
     patch.dict(os.environ,{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','APPROVED':'1'},clear=True), \
     patch.object(l,'check_install_plan') as plan:
 denied(l.main);plan.assert_not_called()
`);
});
