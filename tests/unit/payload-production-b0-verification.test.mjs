import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const setup = String.raw`
import sys,os,io,tarfile,gzip,json,hashlib,copy,tempfile,importlib.util,stat
from unittest.mock import patch
from contextlib import contextmanager
from types import SimpleNamespace
repo=sys.argv[1]
spec=importlib.util.spec_from_file_location('b0_runtime',os.path.join(repo,'ops','payload-control-runtime.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r);s=r.STATE
def sha(raw):return hashlib.sha256(raw).hexdigest()
temporary=tempfile.TemporaryDirectory(prefix='payload-b0-',dir=sys.argv[2]);root=temporary.name
directory=os.path.join(root,'backups','b0');os.makedirs(directory)
inventory=r.INVENTORY.production_inventory(root,os.path.join(root,'runtime'),os.path.join(root,'releases'),
 os.path.join(root,'current-release'),os.path.join(root,'runtime','deploy.lock'),os.path.join(root,'daily'),os.path.join(root,'backups'),
 os.path.join(root,'protection'),os.path.join(root,'env'),os.path.join(root,'compose'),os.path.join(root,'payload'),'portal')
images={name:'ghcr.io/ownerinc/ownerinc-portal-'+name+'@sha256:'+'a'*64 for name in ('api','cron','cms')}
portal={'systemIdentifier':'123','databaseOid':'456','databaseName':'portal'}
binding={'bindingVersion':3,'authority':{k:'a'*64 for k in ('sourceApprovalSha256','policySha256','recordSha256')},
 'sourceCommit':'b'*40,'project':'ownerinc-portal-prod',
 'candidate':{'commit':'c'*40,'runId':'1','runAttempt':'1','images':images,
 **{k:'d'*64 for k in ('candidateSha256','reportSha256','qualificationSha256','bundleSha256')}},
 'candidateRelease':os.path.join(root,'releases','c'*40),'sourceRelease':os.path.join(root,'releases','b'*40),
 'previousImages':{k:images[k] for k in ('api','cron')},'b0':{'directory':directory,'proofSha256':'0'*64},
 'inventoryIdentity':r.INVENTORY.identity(inventory),'lease':{'device':1,'inode':2},
 'portalTarget':{'database':portal,'volumes':{name:{'name':name,'driver':'local','mountpoint':os.path.join(root,name),
 'fingerprint':'a'*64} for name in ('portalPostgres','portalUploads')}}}
key=b'K'*32
def write(name,data):
 with open(os.path.join(directory,name),'wb') as stream:stream.write(data)
 os.chmod(os.path.join(directory,name),0o600)
def archive(members=None):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w') as tar:
  if members is None:
   members=[('folder',tarfile.DIRTYPE,b''),('folder/data',tarfile.REGTYPE,b'content'*1000)]
  for name,kind,data in members:
   entry=tarfile.TarInfo(name);entry.type=kind;entry.mode=0o700 if kind==tarfile.DIRTYPE else 0o600
   entry.size=len(data) if kind==tarfile.REGTYPE else 0;entry.linkname='folder/data' if kind in (tarfile.LNKTYPE,tarfile.SYMTYPE) else ''
   tar.addfile(entry,io.BytesIO(data) if kind==tarfile.REGTYPE else None)
 return gzip.compress(out.getvalue(),mtime=0)
write('postgres.dump',b'dump-bytes-not-a-claim-of-pg-restorability'*100000)
write('uploads.tar.gz',archive())
proof={'schemaVersion':1,'kind':'preauthority-legacy-source','phase':'preauthority',
 'authority':{'mode':'legacy','epoch':1},'protocol':{'status':'absent','coverage':'not-applicable'},
 'inventoryIdentity':binding['inventoryIdentity'],'images':binding['previousImages'],'targetImages':images,
 'source':{'portal':portal,'cms':None},'migrations':{'portal':{'versions':s.PORTAL_MIGRATIONS,
 'fingerprint':sha(s.canonical(s.PORTAL_MIGRATIONS))},'cms':None,'nativeCatalogFingerprint':None},
 'dataFingerprints':{'portalDatabase':'a'*64,'portalUploads':r._archive_tree(os.path.join(directory,'uploads.tar.gz')),
 'cmsDatabase':None,'cmsUploads':None},'artifacts':[],'createdAtUtc':'2026-10-13T00:00:00Z'}
def sign():
 proof['artifacts']=[]
 for name in s.LEGACY_ARTIFACTS:
  with open(os.path.join(directory,name),'rb') as stream:data=stream.read()
  proof['artifacts'].append({'name':name,'size':len(data),'sha256':sha(data)})
 write('manifest.sha256',''.join(a['sha256']+'  '+a['name']+'\n' for a in proof['artifacts']).encode())
 raw=s.canonical(s.sign_envelope(proof,key))+b'\n';write('preauthority-proof.json',raw);binding['b0']['proofSha256']=sha(raw)
sign()
real_lstat,real_fstat,real_open,real_fdopen=os.lstat,os.fstat,os.open,os.fdopen
metadata={};requests=[];fd_paths={}
synthetic_ancestors=set();parent=os.path.dirname(root)
while True:
 synthetic_ancestors.add(parent);next_parent=os.path.dirname(parent)
 if next_parent==parent:break
 parent=next_parent
ancestor_observations={}
def observed(info,name=None):
 # Ownership/permissions are doubled. Shared ancestors ABOVE the owned sandbox
 # are synthetic protected directories: snapshot their directory-content fields
 # per check so concurrent sibling fixtures cannot mutate that synthetic model.
 # Device/inode stay live everywhere; all file and in-sandbox directory metadata,
 # bytes, descriptor IO, gzip/tar parsing and signed proof validation stay real.
 # Windows fstat file IDs differ from lstat: mirror path metadata there only.
 names=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
 value={k:getattr(info,k) for k in names};value.update(st_uid=0,st_gid=0)
 value['st_mode']=stat.S_IFMT(info.st_mode)|(0o700 if stat.S_ISDIR(info.st_mode) else 0o600)
 if name in synthetic_ancestors:
  value.update(ancestor_observations.setdefault(name,{k:value[k] for k in
   ('st_nlink','st_size','st_mtime_ns','st_ctime_ns')}))
 # Explicit unsafe/replacement observations always override the fixture snapshot.
 value.update(metadata.get(name,{}));return SimpleNamespace(**value)
def safe_open(name,flags,*args):
 assert not flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC),'write attempted'
 fd=real_open(name,flags,*args);fd_paths[fd]=name;return fd
class Reader:
 def __init__(self,stream):self.stream=stream
 def __enter__(self):return self
 def __exit__(self,*args):self.stream.close()
 def read(self,size=-1):
  assert 0<=size<=1024*1024,'unbounded read';requests.append(size);return self.stream.read(size)
 def __getattr__(self,name):return getattr(self.stream,name)
@contextmanager
def checking():
 ancestor_observations.clear()
 with patch.object(os,'lstat',side_effect=lambda p:observed(real_lstat(p),p)), \
      patch.object(os,'fstat',side_effect=lambda fd:observed(real_lstat(fd_paths[fd]) if os.name=='nt' else real_fstat(fd))), \
      patch.object(os,'open',side_effect=safe_open), \
      patch.object(os,'fdopen',side_effect=lambda fd,*a,**kw:Reader(real_fdopen(fd,*a,**kw))), \
      patch.object(os,'mkdir',side_effect=AssertionError('mkdir forbidden')), \
      patch.object(r.subprocess,'run',side_effect=AssertionError('subprocess forbidden')), \
      patch.object(r.subprocess,'Popen',side_effect=AssertionError('subprocess forbidden')), \
      patch.object(r,'Runtime',side_effect=AssertionError('Runtime forbidden')), \
      patch.object(os,'O_NOFOLLOW',getattr(os,'O_NOFOLLOW',0),create=True), \
      patch.object(os,'O_NONBLOCK',getattr(os,'O_NONBLOCK',0),create=True):
  with r.verify_production_b0_artifacts(binding,inventory,key) as result:yield result
def check():
 with checking() as result:return result
def refused(callback=check,code=None):
 try:callback()
 except (r.ControlError,s.StateError,OSError) as error:
  if code is not None:assert str(error)==code,(str(error),code)
 else:raise AssertionError('unexpected B0 acceptance')
`;

function probe(code) {
  const temp = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode')
    : process.env.TMPDIR || '/tmp';
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-S', '-B', '-c', setup + '\ntry:\n' + code.split('\n').map(line => ' ' + line).join('\n')
      + '\nfinally: temporary.cleanup()\n', path.resolve('.'), temp], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('B0 verifies actual signed artifacts with bounded streaming and no writes/processes (metadata doubles)', () => {
  probe(String.raw`
before={name:open(os.path.join(directory,name),'rb').read() for name in os.listdir(directory)}
result=check()
assert result=={'artifactIntegrityVerified':True,'storageFingerprintVerified':True,
 'databaseRestoreVerified':False,'liveSourceVerified':False,'rollbackAuthorized':False,
 'installationExecuted':False,'deploymentAuthorized':False}
assert requests.count(1024*1024)>2 and max(requests)==1024*1024
assert before=={name:open(os.path.join(directory,name),'rb').read() for name in os.listdir(directory)}
assert r._archive_tree(os.path.join(directory,'uploads.tar.gz'))==proof['dataFingerprints']['portalUploads']
`);
});

test('shared bounded upload projection preserves historical bytes while numeric owners remain independent', () => {
  probe(String.raw`
def owned(uid,pax=False):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w') as tar:
  for name,kind,data in (('.',tarfile.DIRTYPE,b''),('empty',tarfile.DIRTYPE,b''),('file',tarfile.REGTYPE,b'\0\xff')):
   member=tarfile.TarInfo(name);member.type=kind;member.uid=member.gid=uid;member.mode=0o755 if kind==tarfile.DIRTYPE else 0o644
   if pax:member.pax_headers={'mtime':'0.5'}
   member.size=len(data);tar.addfile(member,io.BytesIO(data) if data else None)
 return gzip.compress(out.getvalue(),mtime=0)
limits=dict(r.PRODUCTION_B0_TAR_LIMITS,expanded=16*1024*1024)
projections=[];hashes=[]
for uid in (0,1000):
 raw=owned(uid);projection={}
 historical=r._tar_tree(io.BytesIO(raw),compressed=True)
 projected=r._bounded_gzip_tar_tree(io.BytesIO(raw),limits,projection=projection)
 assert historical==projected
 assert projection['.']['uid']==projection['.']['gid']==uid
 assert projection['file']['data']==b'\0\xff'
 hashes.append(historical);projections.append(projection)
assert hashes[0]==hashes[1] # Never silently add ownership to the old fingerprint.
assert projections[0]!=projections[1]
gold=[{'name':'.','type':'directory','mode':0o755,'size':0,'sha256':None},
 {'name':'empty','type':'directory','mode':0o755,'size':0,'sha256':None},
 {'name':'file','type':'file','mode':0o644,'size':2,'sha256':sha(b'\0\xff')}]
assert hashes[0]==sha(s.canonical(gold))
raw=owned(1000,True)
assert r._bounded_gzip_tar_tree(io.BytesIO(raw),limits)==r._tar_tree(io.BytesIO(raw),compressed=True)
try:r._bounded_gzip_tar_tree(io.BytesIO(raw),limits,projection={})
except r.ControlError as error:assert str(error)=='unsafe_storage_archive'
else:raise AssertionError('materialization must not ignore PAX')
`);
});

test('B0 rejects tampering, ordered-manifest and signed-context mismatches, partial/unbound paths (real bytes)', () => {
  probe(String.raw`
for name in ('postgres.dump','uploads.tar.gz','manifest.sha256','preauthority-proof.json'):
 path_=os.path.join(directory,name);old=open(path_,'rb').read()
 write(name,old[:-1]);refused();write(name,old)
write('extra',b'x');refused();os.unlink(os.path.join(directory,'extra'))
old=open(os.path.join(directory,'manifest.sha256'),'rb').read()
for raw in (b'\n'.join(old.splitlines()[::-1])+b'\n',old+old.splitlines()[0]+b'\n',b'0'*64+b'  unknown\n'):
 write('manifest.sha256',raw);refused()
write('manifest.sha256',old)
original=copy.deepcopy(proof)
for mutate in (lambda:proof['dataFingerprints'].update(portalUploads='0'*64),
 lambda:proof.update(inventoryIdentity='0'*64),lambda:proof['source']['portal'].update(databaseOid='999'),
 lambda:proof['images'].update(api=images['api'].replace('a'*64,'b'*64)),
 lambda:proof['targetImages'].update(cms=images['cms'].replace('a'*64,'b'*64))):
 proof=copy.deepcopy(original);mutate();sign();refused()
proof=copy.deepcopy(original);sign()
proof['dataFingerprints']['portalUploads']='0'*64;sign();refused(code='backup_storage_fingerprint_mismatch')
proof=copy.deepcopy(original);sign()
raw=json.loads(open(os.path.join(directory,'preauthority-proof.json'),'rb').read())
raw['signature']['value']='0'*64;raw=s.canonical(raw)+b'\n'
write('preauthority-proof.json',raw);binding['b0']['proofSha256']=sha(raw);refused();sign()
old=binding['b0']['proofSha256'];binding['b0']['proofSha256']='0'*64;refused();binding['b0']['proofSha256']=old
old=binding['b0']['directory'];binding['b0']['directory']=os.path.join(root,'unbound');refused();binding['b0']['directory']=old
os.unlink(os.path.join(directory,'postgres.dump'));refused()
`);
});

test('B0 rejects unsafe archives and bounded expansion/member/name exhaustion even with valid signatures', () => {
  probe(String.raw`
for members in ([('same',tarfile.REGTYPE,b'x'),('same',tarfile.REGTYPE,b'y')],
 [('a/../escape',tarfile.REGTYPE,b'x')],[('/absolute',tarfile.REGTYPE,b'x')],
 [('link',tarfile.SYMTYPE,b'')],[('hard',tarfile.LNKTYPE,b'')],[('device',tarfile.CHRTYPE,b'')]):
 write('uploads.tar.gz',archive(members));sign();refused(code='unsafe_storage_archive')
# Hidden non-padding data inside tarfile's read-ahead buffer is also rejected.
raw=gzip.decompress(archive());raw=raw[:9500]+b'hidden'+raw[9506:]
write('uploads.tar.gz',gzip.compress(raw));sign();refused(code='unsafe_storage_archive')
# Oversized PAX payload must be refused before tarfile allocates/parses it.
header=tarfile.TarInfo('pax');header.type=tarfile.XHDTYPE;header.size=128*1024
write('uploads.tar.gz',gzip.compress(header.tobuf()+b'x'*(128*1024)+b'\0'*1024));sign();refused(code='unsafe_storage_archive')
write('uploads.tar.gz',archive());sign()
for field,limit in (('expanded',1024),('members',1),('nameLength',3),('nameBytes',3)):
 with patch.dict(r.PRODUCTION_B0_TAR_LIMITS,{field:limit}):refused(code='unsafe_storage_archive')
# Exercise a highly compressible expansion after a tar end marker, not only member sizes.
raw=gzip.decompress(archive())+b'\0'*(1024*1024)
write('uploads.tar.gz',gzip.compress(raw));sign()
with patch.dict(r.PRODUCTION_B0_TAR_LIMITS,{'expanded':64*1024}):refused(code='unsafe_storage_archive')
`);
});

test('B0 rejects links, unsafe owners/modes and evidence replacement during its retained descriptor scope', () => {
  probe(String.raw`
dump=os.path.join(directory,'postgres.dump')
for change in ({'st_uid':1000},{'st_gid':1000},{'st_mode':stat.S_IFREG|0o644},{'st_nlink':2},
 {'st_mode':stat.S_IFLNK|0o600}):
 metadata[dump]=change;refused();metadata.clear()
metadata[os.path.dirname(directory)]={'st_mode':stat.S_IFDIR|0o777};refused();metadata.clear()
linked=os.path.join(root,'hardlink');os.link(dump,linked);refused();os.unlink(linked)
def replace_during_check():
 with checking():
  # Deliberate external-race simulation; verifier itself cannot open for writing.
  metadata[dump]={'st_ino':real_lstat(dump).st_ino+1}
refused(replace_during_check);metadata.clear()
def replace_directory():
 with checking():metadata[directory]={'st_ino':real_lstat(directory).st_ino+1}
refused(replace_directory);metadata.clear()
old=open(dump,'rb').read()
def alter_bytes():
 with checking():
  # Simulate a separate writer changing actual bytes while descriptors are held.
  with open(dump,'r+b') as out:out.write(b'CHANGED')
refused(alter_bytes);write('postgres.dump',old);sign()
check()
`);
});

test('B0 caps cumulative and consecutive extension work before yielding members (real compressed PAX)', () => {
  probe(String.raw`
def pax(index):
 text='key'+str(index)+'='+'v'*40+'\n';length=len(text)+2
 while len(str(length))+1+len(text)!=length:length=len(str(length))+1+len(text)
 payload=(str(length)+' '+text).encode()
 header=tarfile.TarInfo('global');header.type=tarfile.XGLTYPE;header.size=len(payload)
 return header.tobuf()+payload+b'\0'*((-len(payload))%512)
def file(index):
 header=tarfile.TarInfo('file'+str(index));header.size=0;return header.tobuf()
def install(raw):
 data=gzip.compress(raw+b'\0'*1024,mtime=0)
 proof['dataFingerprints']['portalUploads']=r._tar_tree(io.BytesIO(data),compressed=True)
 write('uploads.tar.gz',data);sign()
interleaved=b''.join(pax(i)+file(i) for i in range(12))
missed=[]
for field,cap in (('extensionCount',4),('extensionBytes',150),('globalPaxKeys',4),('globalPaxBytes',150)):
 install(interleaved)
 with patch.dict(r.PRODUCTION_B0_TAR_LIMITS,{field:cap}):
  try:check()
  except r.ControlError as error:assert str(error)=='unsafe_storage_archive'
  else:missed.append(field)
install(b''.join(pax(i) for i in range(12))+file(0))
with patch.dict(r.PRODUCTION_B0_TAR_LIMITS,{'extensionDepth':3}):
 try:check()
 except r.ControlError as error:assert str(error)=='unsafe_storage_archive'
 else:missed.append('extensionDepth')
assert not missed,missed
`);
});

test('B0 streaming parser does not retain per-member PAX copies and preserves the signed tree', () => {
  probe(String.raw`
out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w',format=tarfile.PAX_FORMAT,pax_headers={'comment':'global metadata'}) as tar:
 for i in range(40):
  entry=tarfile.TarInfo('nested/file'+str(i));entry.size=3
  entry.pax_headers={'mtime':'123.5','comment':'local metadata'}
  tar.addfile(entry,io.BytesIO(b'abc'))
data=gzip.compress(out.getvalue(),mtime=0)
proof['dataFingerprints']['portalUploads']=r._tar_tree(io.BytesIO(data),compressed=True)
write('uploads.tar.gz',data);sign()
original_next=tarfile.TarFile.next;retained=[]
def tracked_next(archive,*args,**kwargs):
 result=original_next(archive,*args,**kwargs);retained.append(len(archive.members));return result
with patch.object(tarfile.TarFile,'next',tracked_next):
 assert r._tar_tree(io.BytesIO(data),compressed=True)==proof['dataFingerprints']['portalUploads']
assert max(retained)==40 # The historical path still uses its original parser behavior.
retained.clear()
with patch.object(tarfile.TarFile,'next',tracked_next):result=check()
assert result['storageFingerprintVerified'] and max(retained)<=1,retained
`);
});

test('B0 fixture isolates synthetic protected ancestors from unrelated sibling temp activity', () => {
  probe(String.raw`
shared_parent=os.path.dirname(root);sibling=root+'-sibling-probe'
fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
before=real_lstat(shared_parent);changed=[];once=[False]
original_read=Reader.read
def read_with_sibling_activity(reader,size=-1):
 data=original_read(reader,size)
 if size==1024*1024 and not once[0]:
  once[0]=True
  # One deliberate external fixture actor, after ancestor capture and before
  # the verifier's first reaffirm. No production observation is mocked away.
  with open(sibling,'xb') as out:out.write(b'unrelated sibling fixture')
  after=real_lstat(shared_parent)
  changed.extend(name for name in fields if getattr(before,name)!=getattr(after,name))
 return data
failure=None
try:
 with patch.object(Reader,'read',read_with_sibling_activity):
  try:result=check()
  except r.ControlError as error:failure=str(error)
 assert once[0] and changed,'controlled sibling creation did not change ancestor metadata'
 assert failure is None,{'boundary':'shared-temp-ancestor','changedFields':changed,'failure':failure}
 assert result['storageFingerprintVerified'] is True
finally:
 if os.path.exists(sibling):os.unlink(sibling)
# An actual change INSIDE the owned sandbox must still be refused.
inside=os.path.join(root,'inside-probe');once[0]=False
def read_with_inside_activity(reader,size=-1):
 data=original_read(reader,size)
 if size==1024*1024 and not once[0]:
  once[0]=True
  with open(inside,'xb') as out:out.write(b'changed protected sandbox')
 return data
try:
 with patch.object(Reader,'read',read_with_inside_activity):refused(code='backup_artifact_changed')
 assert once[0]
finally:
 if os.path.exists(inside):os.unlink(inside)
# Simulated ancestor replacements remain observable, including outside root.
def replace_synthetic_parent():
 with checking():metadata[shared_parent]={'st_ino':real_lstat(shared_parent).st_ino+1}
try:refused(replace_synthetic_parent,code='backup_artifact_changed')
finally:metadata.clear()
`);
});
