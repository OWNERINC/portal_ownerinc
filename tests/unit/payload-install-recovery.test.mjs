import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { qualify, childLocations, childFailures, finiteDiagnostic } from '../../scripts/integration/payload-install-recovery-isolated.mjs';

const setup = String.raw`
import copy,hashlib,importlib.util,io,json,os,pathlib,sys,tarfile
repo,folder=sys.argv[1:]; root=pathlib.Path(folder)
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,pathlib.Path(repo)/'ops'/file)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
E=load('recovery_executor','payload-install-recovery-isolated.py')
if os.name=='nt':
 # Explicit Windows descriptor observation double. Native Linux retains the
 # real no-follow/inode/metadata checks; these tests do not qualify those checks.
 def windows_private_bytes(path,maximum=E.CAP):
  value=pathlib.Path(path).read_bytes();E.require(len(value)<=maximum);return value
 E.private_bytes=windows_private_bytes
R=load('recovery_runtime','payload-control-runtime.py');S=R.STATE
H=E.digest
images={n:'ghcr.io/ownerinc/ownerinc-portal-'+n+'@sha256:'+str(i)*64 for i,n in enumerate(('api','cron','cms'),1)}
previous={n:images[n] for n in ('api','cron')}
db={'systemIdentifier':'123456','databaseOid':'16384','databaseName':'portal'}
def volume(n):return {'name':n,'driver':'local','mountpoint':str(root/n),'fingerprint':H(n.encode())}
lease=open(root/'lease','w+b');os.chmod(root/'lease',0o600)
if os.name!='nt':
 import fcntl
 fcntl.flock(lease.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
info=os.fstat(lease.fileno())
binding={'bindingVersion':2,'candidate':{'schemaVersion':1,'purpose':'isolated-recovery-producer','commit':'a'*40,'runId':'1','runAttempt':'1','images':images,'candidateSha256':'b'*64,'sourceMaterialSha256':'c'*64},
 'candidateRelease':str(root/'releases'/('a'*40)),'sourceRelease':str(root/'releases'/('c'*40)),'previousImages':previous,
 'inventoryIdentity':'d'*64,'lease':{'device':info.st_dev,'inode':info.st_ino},'portalTarget':{'database':db,'volumes':{n:volume(n) for n in ('portalPostgres','portalUploads')}},
 'b0':{'directory':str(root/'b0'),'proofSha256':''}}
buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode='w:gz') as tar:
 for name in ('original.txt','nested.txt'):
  item=tarfile.TarInfo(name);item.size=8;item.mode=0o644;tar.addfile(item,io.BytesIO(b'original'))
uploads=buffer.getvalue()
artifacts={'postgres.dump':b'actual-consumed-test-double-bytes','uploads.tar.gz':uploads}
baseline={'database':H(b'original'),'roles':H(b'unchanged'),'schema':H(b'unchanged'),'uploads':E.uploads_fingerprint(uploads)}
baseline.update(dataFingerprint=H(b'original'),uploadsFingerprint=R._tar_tree(io.BytesIO(uploads),compressed=True))
S.initialize(str(root),binding['inventoryIdentity']);key=E.private_bytes(root/'payload-control.key',32)
proof={'schemaVersion':1,'kind':'preauthority-legacy-source','phase':'preauthority','authority':{'mode':'legacy','epoch':1},'protocol':{'status':'absent','coverage':'not-applicable'},
 'inventoryIdentity':binding['inventoryIdentity'],'images':previous,'targetImages':images,'source':{'portal':db,'cms':None},
 'migrations':{'portal':{'versions':S.PORTAL_MIGRATIONS,'fingerprint':H(S.canonical(S.PORTAL_MIGRATIONS))},'cms':None,'nativeCatalogFingerprint':None},
 'dataFingerprints':{'portalDatabase':baseline['dataFingerprint'],'portalUploads':baseline['uploadsFingerprint'],'cmsDatabase':None,'cmsUploads':None},
 'artifacts':[{'name':n,'sha256':H(b),'size':len(b)} for n,b in artifacts.items()],'createdAtUtc':'2026-10-14T00:00:00Z'}
artifacts['manifest.sha256']=''.join(H(artifacts[n])+'  '+n+'\n' for n in S.LEGACY_ARTIFACTS).encode()
artifacts['preauthority-proof.json']=S.canonical(S.sign_envelope(proof,key))
binding['b0']['proofSha256']=H(artifacts['preauthority-proof.json'])
(root/'b0').mkdir(mode=0o700)
for n,b in artifacts.items():S._write_exclusive(str(root/'b0'/n),b,0o600)
S.transition(str(root),lambda b:b.update(admission='closed',plannedReleaseImages=images,latestProofSha256=binding['b0']['proofSha256'],legacySourceProofSha256=binding['b0']['proofSha256']))
S.reserve_install(str(root),binding,proof,binding['b0']['proofSha256'],{'nonce':'a'*64,'volumes':{},'containers':{}})
helpers={}
for n in E.HELPERS:
 b=(pathlib.Path(repo)/'ops'/n).read_bytes();helpers[n]=H(b);S._write_exclusive(str(root/n),b,0o600)
fence={'scope':'TEST-only','network':'none','writers':[],'databaseContainerId':'e'*64}
recovery={'recoveryVersion':1,'purpose':'isolated-b0-recovery','installBindingSha256':H(S.canonical(binding)),'originStateSha256':S.read_state(str(root))[3],
 'b0ProofSha256':binding['b0']['proofSha256'],'manifestSha256':H(artifacts['manifest.sha256']),'portalTarget':binding['portalTarget'],
 'sourceRelease':binding['sourceRelease'],'previousImages':previous,'securityProfileSha256':H(S.canonical(baseline)),'fenceProfileSha256':H(S.canonical(fence)),
 'restoreProfile':'same-target-legacy-objects-acl-v1'}
request={'kind':'isolated-b0-recovery-request-v1','binding':binding,'recovery':recovery,'helpers':helpers,'artifacts':{n:H(b) for n,b in artifacts.items()},'baseline':baseline,'fenceProfile':fence}
raw=S.canonical(S.sign_envelope(request,key))
class Ops:
 def __init__(self):self.database='damaged';self.files='damaged';self.events=[];self.safe=True
 def fence(self,b,p,f):
  self.events.append('fence');E.require(self.safe and b==binding and p==baseline and f==fence)
 def database_matches(self,p):self.events.append('compare_database');return self.database==p['database']
 def restore_database(self,b):
  self.events.append('restore_database');assert b==artifacts['postgres.dump'];self.database=H(b'original')
 def clear_uploads(self):self.events.append('clear_uploads');self.files='cleared'
 def extract_uploads(self,b):self.events.append('restore_uploads');self.files=E.uploads_fingerprint(b)
 def uploads(self):self.events.append('compare_uploads');return self.files
ops=Ops()
def executor(data=raw):return E.Executor(root,R,key,data,ops,lease)
def refused(fn):
 try:fn()
 except (E.Refused,S.StateError,R.ControlError):pass
 else:raise AssertionError('expected refusal')
def snapshot():return {p.name:p.read_bytes() for p in (root/'payload-control-state').iterdir()}
`;

async function probe(code) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'b0-recovery-unit-'));
  try {
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', '-B', '-c', setup + code, path.resolve('.'), directory], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('real HMAC journal: optional recovery never rewrites historical bodies, advances adjacently and freezes install', async () => {
  await probe(String.raw`
before=snapshot();assert 'recovery' not in S.read_state(str(root))[2]['installIntent']
S.begin_install_recovery(str(root),binding,recovery)
for name,data in before.items():
 if name!='current.json':assert snapshot()[name]==data
refused(lambda:S.advance_install_recovery(str(root),binding,'uploads_restored'))
refused(lambda:S.advance_install(str(root),binding,'portal_grants_pending'))
refused(lambda:S.begin_install_floor(str(root),binding,'a'*64))
refused(lambda:S.transition(str(root),lambda b:b.update(admission='open')))
refused(lambda:S.transition(str(root),lambda b:b['installIntent'].pop('recovery')))
for stage in S.INSTALL_RECOVERY_STAGES[1:]:S.advance_install_recovery(str(root),binding,stage)
old=snapshot();S.advance_install_recovery(str(root),binding,'data_verified_readiness_pending');assert snapshot()==old
refused(lambda:S.advance_install_recovery(str(root),binding,'reserved'))
assert S.read_state(str(root))[2]['admission']=='closed'
`);
});

test('executor doubles consume authenticated bytes and reconcile both commit/checkpoint gaps in real journal', async () => {
  await probe(String.raw`
refused(lambda:executor().execute('database'))
assert S.read_state(str(root))[2]['installIntent']['recovery']['stage']=='database_restore_pending'
refused(lambda:executor().execute('uploads'))
assert S.read_state(str(root))[2]['installIntent']['recovery']['stage']=='uploads_restore_pending'
result=executor().execute()
assert result['dataVerified'] and result['readinessPending'] and result['productionAuthorized'] is False
assert ops.events.count('restore_database')==1 and ops.events.count('restore_uploads')==2
assert S.read_state(str(root))[2]['installIntent']['stage']=='reserved'
assert S.read_state(str(root))[2]['installIntent']['recovery']['stage']=='data_verified_readiness_pending'
`);
});

test('profile, artifact, helper, origin, lease and target substitutions refuse without destructive callbacks', async () => {
  await probe(String.raw`
for field in ('b0ProofSha256','installBindingSha256','originStateSha256'):
 changed=copy.deepcopy(recovery);changed[field]='f'*64
 refused(lambda:S.begin_install_recovery(str(root),binding,changed))
changed=copy.deepcopy(request);changed['fenceProfile']['network']='host'
refused(lambda:executor(S.canonical(S.sign_envelope(changed,key))))
changed=copy.deepcopy(request);changed['recovery']['manifestSha256']='f'*64
refused(lambda:executor(S.canonical(S.sign_envelope(changed,key))))
bad=json.loads(raw);bad['body']['baseline']['roles']='changed';refused(lambda:executor(S.canonical(bad)))
ops.safe=False;refused(lambda:executor().execute());ops.safe=True
assert 'restore_database' not in ops.events
path=root/'payload-control-runtime.py';original=path.read_bytes();path.write_bytes(b'changed')
refused(lambda:executor().execute());path.write_bytes(original)
path=root/'b0'/'postgres.dump';path.write_bytes(b'changed');refused(lambda:executor());path.write_bytes(artifacts['postgres.dump'])
lease.close();refused(lambda:executor().execute())
assert 'restore_database' not in ops.events
`);
});

test('v3 is state-only and isolated executor refuses before any operation or artifact access', async () => {
  await probe(String.raw`
changed=copy.deepcopy(request);changed['binding']['bindingVersion']=3
refused(lambda:executor(S.canonical(S.sign_envelope(changed,key))))
assert ops.events==[]
# Validate the exact optional production state shape, without upgrading a v2 journal.
body=S.read_state(str(root))[2];i=body['installIntent'];b=i['binding'];b['bindingVersion']=3
b['candidate']={k:v for k,v in b['candidate'].items() if k not in ('schemaVersion','purpose','sourceMaterialSha256')}
b['candidate'].update(reportSha256='1'*64,qualificationSha256='2'*64,bundleSha256='3'*64)
b.update(project='ownerinc-portal-prod',sourceCommit='c'*40,authority={k:'4'*64 for k in ('sourceApprovalSha256','policySha256','recordSha256')})
i['creation'].update(receiptVersion=1,fingerprintAlgorithm='production-container-mounts-v1')
r=copy.deepcopy(recovery);r.update(purpose='production-b0-recovery',installBindingSha256=H(S.canonical(b)))
i['recovery']={'binding':r,'stage':'reserved'};S.validate_state_body(body)
for stage in ('floor_commit_pending','floor_committed'):
 wrong=copy.deepcopy(body);wrong['installIntent']['stage']=stage
 refused(lambda:S.validate_state_body(wrong))
`);
});

test('immutable verified artifact copy is consumed, not a subsequently reopened path', async () => {
  await probe(String.raw`
e=executor();(root/'b0'/'postgres.dump').write_bytes(b'changed after verification')
e.execute();assert ops.database==H(b'original')
refused(lambda:executor())
`);
});

test('grants-pending entry keeps its stage and runtime initializer refuses recovery before effects', async () => {
  await probe(String.raw`
S.advance_install(str(root),binding,'portal_grants_pending')
request['recovery']['originStateSha256']=S.read_state(str(root))[3]
updated=S.canonical(S.sign_envelope(request,key));executor(updated).execute()
body=S.read_state(str(root))[2];assert body['installIntent']['stage']=='portal_grants_pending'
adapter=object.__new__(R.Runtime);adapter.state=body
adapter._admission_closed=lambda: (_ for _ in ()).throw(AssertionError('effect before recovery refusal'))
refused(lambda:adapter._install_origin_check())
`);
});

test('bounded uploads reject links, traversal, extra members and oversized expansion', async () => {
  await probe(String.raw`
import gzip
refused(lambda:E.uploads_fingerprint(gzip.compress(b'0'*(E.CAP+1))))
for name,kind in (('../original.txt',tarfile.REGTYPE),('other.txt',tarfile.REGTYPE),('original.txt',tarfile.SYMTYPE)):
 buf=io.BytesIO()
 with tarfile.open(fileobj=buf,mode='w:gz') as tar:
  item=tarfile.TarInfo(name);item.type=kind;tar.addfile(item)
 refused(lambda:E.uploads_fingerprint(buf.getvalue()))
`);
});

test('bounded isolated query transport preserves the historical database fingerprint algorithm', async () => {
  await probe(String.raw`
from unittest.mock import patch
inventory={'tables':[{'schema':'public','name':'records'}],'sequences':[{'schema':'public','name':'serial'}],'unsupportedRelations':[]}
lines=b'["public.records", {"id":1,"body":"original"}]\n'
def query(text):return json.dumps(inventory).encode() if 'unsupportedRelations' in text else lines
class Process:
 def __init__(self):self.stdin=io.BytesIO();self.stdout=io.BytesIO(lines);self.killed=False
 def wait(self):return 0
 def kill(self):self.killed=True
process=Process()
with patch.object(R,'_psql_json',return_value=inventory),patch.object(R,'_container_id',return_value='fixture'),patch.object(R.subprocess,'Popen',return_value=process):
 historical=R._data_fingerprint('postgres')
isolated=R._data_fingerprint('postgres',isolated_query=query)
expected=H(S.canonical([
 {'relation':'public.records','kind':'table','rowCount':1,'rowContentsSha256':H(S.canonical({'id':1,'body':'original'})+b'\n')},
 {'relation':'public.serial','kind':'sequence','rowCount':0,'rowContentsSha256':H(b'')}]))
assert historical==isolated==expected
raw_volume={'Name':'fixture','Driver':'local','Mountpoint':'/fixture/data','Labels':{'scope':'test'},'Options':None,'Scope':'local','CreatedAt':'2026-10-14T00:00:00Z'}
expected_volume={'name':'fixture','driver':'local','mountpoint':'/fixture/data','fingerprint':H(S.canonical({'name':'fixture','driver':'local','mountpoint':'/fixture/data','labels':{'scope':'test'},'options':None,'scope':'local','createdAt':'2026-10-14T00:00:00Z'}))}
assert R._volume_receipt(raw_volume)==expected_volume
`);
});

test('native guard rejects before commands and does not accept target flags', async () => {
  let calls = 0;
  await assert.rejects(qualify({ env: {}, platform: 'linux', command: async () => { calls++; } }));
  assert.equal(calls, 0);
});

test('lexer suppresses newline string continuations before any fragment can expose tokens', async () => {
  await probe(String.raw`
# Reviewer reproduction: the second quote is escaped under the initial E mode.
attack=b"SELECT E'prefix'\n'\\'PUBLIC -- private';"
refused(lambda:E.redacted_schema(attack))
separators=(b'\n',b' \r\n\t',b' -- comment\n',b' /* comment\n */ ',b'\n/* outer /* nested */ end */',b'\r',b' ')
for prefix in (b"E'prefix'",b"'prefix'",b"U&'prefix'",b"e'prefix'"):
 for separator in separators:
  for tail in (b"'SELECT PUBLIC CREATE TABLE'",b"'second'\n'ALTER TABLE PUBLIC'",b"'\\'PUBLIC -- private';",b"'unterminated"):
   candidate=b'SELECT '+prefix+separator+tail
   refused(lambda:E.redacted_schema(candidate))
   try:E.capture_schema_discrepancy(root,b'SELECT 1;',candidate)
   except E.Refused:pass
   else:assert False
   assert not (root/E.REPORT_NAME).exists()
# Explicitly prefixed adjacent strings are also conservatively unsupported.
for tail in (b"E'SELECT'",b"U&'PUBLIC'",b"B'101'",b"N'SELECT'"):
 refused(lambda:E.redacted_schema(b"SELECT 'first'\n"+tail))
# Ordinary isolated literals/comments/casts retain useful diagnostics.
for sql in (b"SELECT E'prefix\\'PUBLIC';",b"SELECT 'PUBLIC' /* comment\n */ ::text;",b"SELECT U&'PUBLIC\\0061';",b"SELECT 'PUBLIC', 'SELECT';"):
 tokens=E.redacted_schema(sql)
 assert all(t.get('value')!='PUBLIC' for t in tokens)
for malformed in (b"SELECT 'first' /* unfinished",b"SELECT E'first\\",b"SELECT 'first'\n'broken"):
 refused(lambda:E.redacted_schema(malformed))
`);
});

test('one-shot discrepancy redacts all literals/bodies/comments and preserves bounded structural changes', async () => {
  await probe(String.raw`
before=E.normalize_dump(b'\\restrict a\n-- Name: private_name; Type: TABLE; Schema: public; Owner: postgres\nCREATE TABLE public.private_name (id integer DEFAULT 123, secret text DEFAULT E\'SECRET\\\\VALUE\');\nCOMMENT ON TABLE public.private_name IS \'PRIVATE comment\';\nALTER TABLE public.private_name OWNER TO postgres;\n\\unrestrict a\n')
after=before.replace(b'OWNER TO postgres',b'OWNER TO portal_api').replace(b'DEFAULT 123',b'DEFAULT 456')
raw=E.schema_discrepancy(before,after);report=E.validate_schema_report(raw)
assert len(raw)<=65536 and report['regionCount']>=1 and not report['truncated']
for secret in (b'private_name',b'SECRET',b'VALUE',b'PRIVATE comment',b'123',b'456'):
 # Look only at visible token values: hashes/line numbers may contain digits.
 assert not any(secret.decode() in token.get('value','') for region in report['regions'] for side in region.values() for token in side['tokens'])
assert report['before']=={'length':len(before),'sha256':H(before)}
cases=[b"SELECT 'SECRET\nMULTILINE';",b"SELECT E'SECRET\\'PRIVATE';",b'SELECT U&"SECRET\\0061";',b"SELECT U&'SECRET\\0061';",b'SELECT "postgres";',b'SELECT $$SECRET\nCREATE TABLE private_name;$$;',b'SELECT $tag$SECRET$tag$;',b'/* SECRET /* PRIVATE */ hidden */ SELECT 1;',b"CREATE TABLE x(a text CHECK(a !~* 'SECRET'));",b'CREATE EXTENSION pgcrypto WITH SCHEMA public;']
for sql in cases:
 tokens=E.redacted_schema(sql)
 assert all('SECRET' not in token.get('value','') and 'PRIVATE' not in token.get('value','') for token in tokens)
for invalid in (b"SELECT 'SECRET",b'SELECT "SECRET',b'SELECT $x$SECRET',b'/* SECRET',b'\xff',b'SELECT '+bytes([96])+b'SECRET',b'\x00',b'x'*(E.CAP+1)):
 try:E.capture_schema_discrepancy(root,b'SELECT 1;',invalid)
 except Exception:pass
 else:assert False
assert not (root/E.REPORT_NAME).exists()
E.capture_schema_discrepancy(root,b'SELECT 1;',b'SELECT 2;')
saved=(root/E.REPORT_NAME).read_bytes();E.validate_schema_report(saved)
try:E.capture_schema_discrepancy(root,b'SELECT 1;',b'SELECT 3;')
except FileExistsError:pass
else:assert False
assert (root/E.REPORT_NAME).read_bytes()==saved
for bad in (saved.replace(b'"version":1',b'"version":1,"version":1'),saved.replace(b'"version":1',b'"version":true'),b'x'*65537):
 try:E.validate_schema_report(bad)
 except Exception:pass
 else:assert False
left=b''.join(('SELECT '+str(i)+';\n-- stable '+str(i)+'\n').encode() for i in range(500))
right=left.replace(b'SELECT ',b'SELECT 999 + ')
large=E.validate_schema_report(E.schema_discrepancy(left,right));assert large['truncated'] and large['regionCount']>len(large['regions'])
body=S.read_state(str(root))[2]
def failed_write(*args):raise OSError('SECRET')
try:E.assert_schema_dump(before,after,H(before),failed_write)
except E.SchemaMismatch as error:assert E.failure_for_exception(error,'uploads')[1]==73
else:assert False
assert S.read_state(str(root))[2]==body and body['admission']=='closed'
`);
});

test('actual dump normalizer and schema diagnostics never accept order, SQL, owner or comment changes', async () => {
  await probe(String.raw`
before=b'\\restrict alpha\n-- Name: fixture; Type: TABLE; Owner: postgres\nCREATE TABLE fixture (id integer);\nALTER TABLE fixture OWNER TO postgres;\n\\unrestrict alpha\n'
same=before.replace(b'alpha',b'beta')
assert E.normalize_dump(before)==E.normalize_dump(same)
expected=E.normalize_dump(before)
E.assert_schema_dump(expected,E.normalize_dump(same),H(expected))
cases=[
 (expected.replace(b'CREATE TABLE fixture (id integer);\nALTER TABLE fixture OWNER TO postgres;\n',b'ALTER TABLE fixture OWNER TO postgres;\nCREATE TABLE fixture (id integer);\n'),'schema_line_order_delta'),
 (expected.replace(b'-- Name: fixture',b'-- Name: changed'),'schema_comment_delta'),
 (expected.replace(b'id integer',b'id text'),'schema_sql_delta'),
 (expected.replace(b'OWNER TO postgres',b'OWNER TO portal_api'),'schema_sql_delta'),
 (expected+b'CREATE TABLE unexpected(id integer);\n','schema_sql_delta'),
 (expected+b'GRANT SELECT ON fixture TO PUBLIC;\n','schema_sql_delta'),
]
for observed,category in cases:
 try:E.assert_schema_dump(expected,observed,H(expected))
 except E.SchemaMismatch as error:
  failure,code=E.failure_for_exception(error,'uploads');assert (failure,code)==(category,73)
  frame=E.parse_child_frame(E.child_frame(failure),code,'uploads')
  assert frame['location']=='schema_compare' and 'fixture' not in E.child_frame(failure).decode()
 else:assert False
refused(lambda:E.assert_schema_dump(expected,expected,'f'*64))
# Comment classification is not SQL semantic equivalence (including bodies).
body=b'CREATE FUNCTION x() RETURNS text AS $$\n--original\n$$ LANGUAGE sql;\n'
assert E.schema_delta(body,body.replace(b'original',b'changed'))=='schema_comment_delta'
assert E.failure_for_exception(E.Refused('schema_sql_delta'),'uploads')==('refused',73)
assert S.read_state(str(root))[2]['admission']=='closed'
`);
});

test('discrepancy export validates exact redacted schema and uses fixed descriptor-relative exclusive paths', async () => {
  await probe(String.raw`
from unittest.mock import patch
from types import SimpleNamespace
E.capture_schema_discrepancy(root,b'CREATE SCHEMA public;',b'ALTER SCHEMA public OWNER TO postgres;')
raw=(root/E.REPORT_NAME).read_bytes()
value=json.loads(raw)
for mutate in (lambda x:x.update(extra='SECRET'),lambda x:x['regions'][0]['before']['tokens'][0].update(value='SECRET'),lambda x:x.update(version=True)):
 bad=copy.deepcopy(value);mutate(bad);refused(lambda:E.validate_schema_report(S.canonical(bad)))
calls=[];fds={};counter=[10];out=io.BytesIO()
class Output:
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def fileno(self):return 99
 def write(self,b):out.write(b)
 def flush(self):pass
def opened(name,flags,mode=0,**kwargs):
 calls.append(('open',name,flags,kwargs));counter[0]+=1;fds[counter[0]]=name;return counter[0]
def info(fd):
 return SimpleNamespace(st_uid=0,st_nlink=1,st_mode=(0o100600 if fd==99 else 0o40700))
fake=SimpleNamespace(O_RDONLY=0,O_DIRECTORY=1,O_NOFOLLOW=2,O_WRONLY=4,O_CREAT=8,O_EXCL=16,
 open=opened,close=lambda fd:None,mkdir=lambda *a,**kw:calls.append(('mkdir',a,kw)),
 fstat=info,fdopen=lambda *a:Output(),fsync=lambda fd:None,fchmod=lambda *a:calls.append(('chmod',a)))
with patch.object(E,'os',fake),patch.object(E,'private_bytes',return_value=raw):
 E.export_schema_discrepancy(root)
assert out.getvalue()==raw
names=[c[1] for c in calls if c[0]=='open']
assert names==['/','home','runner','work','_temp',E.REPORT_EXPORT_DIRECTORY,E.REPORT_NAME]
assert all(c[2]&fake.O_NOFOLLOW and 'dir_fd' in c[3] for c in calls if c[0]=='open' and c[1]!='/')
assert ('chmod',(99,0o644)) in calls and any(c[0]=='chmod' and c[1][1]==0o755 for c in calls)
for blocked in ('home',E.REPORT_EXPORT_DIRECTORY,E.REPORT_NAME):
 def denied(name,*args,**kwargs):
  if name==blocked:raise FileExistsError('symlink or occupied target')
  return opened(name,*args,**kwargs)
 out.seek(0);out.truncate()
 with patch.object(E,'os',fake),patch.object(fake,'open',denied),patch.object(E,'private_bytes',return_value=raw):
  try:E.export_schema_discrepancy(root)
  except OSError:pass
  else:assert False
 assert out.getvalue()==b''
for unsafe in (SimpleNamespace(st_uid=9876,st_nlink=1,st_mode=0o40700),SimpleNamespace(st_uid=0,st_nlink=1,st_mode=0o40777)):
 with patch.object(E,'os',fake),patch.object(fake,'fstat',return_value=unsafe),patch.object(E,'private_bytes',return_value=raw):
  refused(lambda:E.export_schema_discrepancy(root))
# Source hardlink refusal occurs before descriptor identity/platform differences.
real=load('report_file_checks','payload-install-recovery-isolated.py')
linked=root/'linked-report';os.link(root/E.REPORT_NAME,linked)
try:real.private_bytes(root/E.REPORT_NAME,E.REPORT_LIMIT)
except real.Refused:pass
else:assert False
`);
});

test('CI exports only the fixed nonqualifying redacted report on failure', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const job = workflow.split('  isolated-b0-recovery:\n')[1].split('  validate:\n')[0];
  assert.match(job, /test "\$RUNNER_TEMP" = \/home\/runner\/work\/_temp/);
  const upload = job.split('      - name: Upload nonqualifying B0 schema discrepancy\n')[1];
  assert.match(upload, /if: failure\(\)/);
  assert.match(upload, /name: nonqualifying-isolated-b0-schema-discrepancy/);
  assert.match(upload, /path: \$\{\{ runner.temp \}\}\/payload-b0-schema-diagnostic\/schema-discrepancy.json/);
  assert.match(upload, /if-no-files-found: warn/);
  assert.doesNotMatch(upload, /\*|\.dump|\.sql|continue-on-error/);
  const original = 'isolated_b0_recovery_qualification_failed:recover_uploads_interruption;child:schema_compare:schema_sql_delta;cleanup:none';
  assert.equal(finiteDiagnostic(`isolated_b0_schema_report_unavailable\n${original}`), original);
  assert.equal(finiteDiagnostic(`SECRET\n${original}`), 'isolated_b0_recovery_native_failed');
});

test('finite child diagnostics preserve real-journal post-restore refusals without advancing or leaking errors', async () => {
  await probe(String.raw`
refused(lambda:executor().execute('database'))
assert S.read_state(str(root))[2]['installIntent']['recovery']['stage']=='database_restore_pending'
E.mark('uploads_extract')
E.parse_child_frame(E.child_frame('expected_interruption'),72,'uploads')
refused(lambda:E.check_child_checkpoint(S.read_state(str(root))[2],'uploads'))
original=ops.fence
for location in ('security_compare','schema_compare','role_authentication'):
 def fail_boundary(*args):
  E.mark(location);raise E.Refused('SECRET password SQL path')
 ops.fence=fail_boundary
 try:executor().execute('uploads')
 except Exception as error:
  failure,code=E.failure_for_exception(error,'uploads')
  assert (failure,code)==('refused',73)
  frame=E.parse_child_frame(E.child_frame(failure),code,'uploads')
  assert frame['location']==location and 'SECRET' not in E.child_frame(failure).decode()
 else:assert False
 body=S.read_state(str(root))[2];assert body['admission']=='closed' and body['workerHold']
 assert body['installIntent']['recovery']['stage']=='database_restore_pending'
ops.fence=original
for comparison in ('database_dump_compare','database_data_compare'):
 def not_reconciled(p):E.mark(comparison);return False
 ops.database_matches=not_reconciled
 try:executor().execute('uploads')
 except Exception as error:
  failure,code=E.failure_for_exception(error,'uploads');assert code==73
  assert E.parse_child_frame(E.child_frame(failure),code,'uploads')['location']==comparison
 else:assert False
assert S.read_state(str(root))[2]['installIntent']['recovery']['stage']=='database_restore_pending'
`);
});

test('upload diagnostic locations and expected interruption cannot certify the signed checkpoint', async () => {
  await probe(String.raw`
refused(lambda:executor().execute('database'))
clear,extract=ops.clear_uploads,ops.extract_uploads
for location in ('uploads_clear','uploads_extract'):
 def broken(*args):raise RuntimeError('SECRET /private credential query')
 ops.clear_uploads=broken if location=='uploads_clear' else clear
 ops.extract_uploads=broken if location=='uploads_extract' else extract
 try:executor().execute('uploads')
 except Exception as error:
  failure,code=E.failure_for_exception(error,'uploads');assert (failure,code)==('unknown',73)
  frame=E.parse_child_frame(E.child_frame(failure),code,'uploads');assert frame['location']==location
  assert 'SECRET' not in E.child_frame(failure).decode()
 else:assert False
 body=S.read_state(str(root))[2];assert body['admission']=='closed'
 assert body['installIntent']['recovery']['stage']=='uploads_restore_pending'
ops.clear_uploads,ops.extract_uploads=clear,extract
try:executor().execute('uploads')
except Exception as error:
 failure,code=E.failure_for_exception(error,'uploads');assert (failure,code)==('expected_interruption',72)
 E.parse_child_frame(E.child_frame(failure),code,'uploads')
else:assert False
body=S.read_state(str(root))[2];E.check_child_checkpoint(body,'uploads')
wrong=copy.deepcopy(body);wrong['installIntent']['recovery']['stage']='database_restore_pending'
refused(lambda:E.check_child_checkpoint(wrong,'uploads'))
assert S.read_state(str(root))[2]==body
`);
});

test('child protocol rejects malformed, oversized, duplicate and unknown fields and preserves finite JS parity', async () => {
  await probe(String.raw`
E.mark('uploads_extract');raw=E.child_frame('expected_interruption')
assert len(raw)<=1024
for bad in (b'',b'{}',b'x'*1025,b'{"version":1,"version":1}',raw[:-1],raw.replace(b'"version":1',b'"version":true'),raw.replace(b'"proof":null',b'"proof":null,"extra":true'),raw.replace(b'uploads_extract',b'SECRET')):
 try:E.parse_child_frame(bad,72,'uploads')
 except Exception:pass
 else:assert False
refused(lambda:E.parse_child_frame(raw,73,'uploads'))
refused(lambda:E.parse_child_frame(raw,72,'database'))
refused(lambda:E.parse_child_frame(raw,-9,'uploads'))
E.mark('complete')
missing=E.child_frame('expected_interruption_missing')
assert E.parse_child_frame(missing,73,'uploads')['failure']=='expected_interruption_missing'
refused(lambda:E.parse_child_frame(missing,72,'uploads'))
readfd,writefd=os.pipe()
try:
 E.mark('entry_authentication');E.write_child_frame(writefd,'unknown');os.close(writefd)
 assert E.parse_child_frame(os.read(readfd,1025),73,'uploads')['location']=='entry_authentication'
finally:os.close(readfd)
E.mark('SECRET');assert json.loads(E.child_frame('SECRET'))['location']=='unknown'
assert E.failure_for_exception(RuntimeError('isolated_b0_test_interruption'),'uploads')==('unknown',73)
assert E.failure_for_exception(E.Refused('isolated_b0_test_interruption'),None)==('refused',73)
from unittest.mock import patch
with patch.object(E.os,'write',side_effect=OSError('SECRET')):
 E.write_child_frame(-1,'unknown')
assert E.CHILD_LOCATIONS==tuple(${JSON.stringify(childLocations)})
assert E.CHILD_FAILURES==tuple(${JSON.stringify(childFailures)})
`);
  for (const location of childLocations) for (const failure of childFailures) {
    const diagnostic = `isolated_b0_recovery_qualification_failed:recover_uploads_interruption;child:${location}:${failure};cleanup:none`;
    assert.equal(finiteDiagnostic(diagnostic), diagnostic);
    assert.equal(finiteDiagnostic(`${diagnostic}\nSECRET`), 'isolated_b0_recovery_native_failed');
  }
  assert.equal(finiteDiagnostic('isolated_b0_recovery_qualification_failed:recover_uploads_interruption;child:SECRET:unknown;cleanup:none'), 'isolated_b0_recovery_native_failed');
});

test('required native isolated B0 recovery (not portable evidence)', { skip: process.env.PAYLOAD_REQUIRE_NATIVE_B0_RECOVERY !== '1', timeout: 300000 }, async () => {
  const proof = await qualify();
  console.log(JSON.stringify(proof));
});
