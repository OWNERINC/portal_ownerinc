import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const python = process.platform === 'win32' ? 'python' : 'python3';
const helper = path.resolve('ops/payload-receiver-admission.py');
function probe(code) {
  return spawnSync(python, ['-I', '-S', '-B', '-c', `import importlib.util,io,os,tarfile,tempfile,pathlib\nspec=importlib.util.spec_from_file_location('receiver',${JSON.stringify(helper)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n${code}`], { encoding: 'utf8', timeout: 20000 });
}
const fixture = `
commit='a'*40
images=['ghcr.io/ownerinc/ownerinc-portal-'+s+'@sha256:'+str(i+1)*64 for i,s in enumerate(('api','cron','cms'))]
artifact_digests=['sha256:'+str(i+4)*64 for i in range(3)]
content_digests=[str(i+7)*64 for i in range(3)]
request='production:payload-v2 '+ ' '.join([commit,'123','2',*images,'11','12','13',*artifact_digests,*content_digests,'a'*64,'b'*64,'1999999999','c'*64])
def bundle(count=3, extras=()):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w:gz') as tar:
        for name,data in [('.ci-commit',(commit+'\\n').encode()),('.ci-images',('\\n'.join(images[:count])+'\\n').encode()),*extras]:
            item=tarfile.TarInfo(name);item.size=len(data);tar.addfile(item,io.BytesIO(data))
    return out.getvalue()
def denied(call):
    try: call()
    except m.ReceiverError: return
    raise AssertionError('unexpected acceptance')
`;

// These are transport/control-flow doubles, NOT host installation or authority
// evidence. Real policy/record/hash bindings live in payload-candidate-admission.
const transport = fixture + `
import types
trace=[]
m.os=types.SimpleNamespace(**{key:getattr(os,key) for key in dir(os)})
m.os.getuid=lambda:0;m.os.geteuid=lambda:0
m.protected_directory=lambda *a,**k:None
@m.contextmanager
def reservation(selected):
    trace.append('nonce')
    receipt=tempfile.mkdtemp(prefix='payload-',dir=m.INCOMING)
    yield receipt
m.reserve_admission=reservation
real_fstat=m.os.fstat;real_lstat=m.os.lstat
def metadata(info):
    return types.SimpleNamespace(st_dev=1,st_ino=1,st_size=info.st_size,
        st_mtime_ns=0,st_ctime_ns=0,st_mode=0o100600,
        st_uid=0,st_gid=0,st_nlink=1)
m.os.fstat=lambda fd:metadata(real_fstat(fd))
m.os.lstat=lambda file:metadata(real_lstat(file))
original_extract=m.extract_entries
def extract(*args):
    trace.append('extract');return original_extract(*args)
m.extract_entries=extract
`;

test('real strict versioned request parser accepts selectors only', () => {
  const result = probe(fixture + `
selected=m.parse_request(request)
assert selected['commit']==commit and selected['cms-image']==images[2]
for bad in [request+' extra',request+' ',request.replace('production:', 'staging:'),request.replace(' 123 ', ' 0123 '),request.replace(' 12 ', ' 11 '),request.replace('payload-v2','payload-v1'),request.replace(' 2 ','\\n2 '),request+' --policy /tmp/policy']:
    denied(lambda:m.parse_request(bad))
`);
  assert.equal(result.status, 0, result.stderr);
});

test('bounded receipt reads at most limit plus one and writes no overflow', () => {
  const result = probe(`
class Stream:
    consumed=0
    def read(self,n): self.consumed+=n;return b'x'*n
stream=Stream();out=io.BytesIO()
try:m.receive(stream,out)
except m.ReceiverError:pass
else:raise AssertionError('unbounded input accepted')
assert stream.consumed==m.MAX_ARCHIVE+1
assert len(out.getvalue())<=m.MAX_ARCHIVE
`);
  assert.equal(result.status, 0, result.stderr);
});

test('bounded subprocess streams output, kills over-limit and timeout producers, and never uses a shell', () => {
  const result = probe(`
command=[m.sys.executable,'-I','-S','-c','import sys;sys.stdout.buffer.write(b"x"*200000)']
try:m.bounded_subprocess(command,1024,5)
except m.ReceiverError as error:assert str(error)=='subprocess_output_limit_exceeded'
else:raise AssertionError('large output accepted')
command=[m.sys.executable,'-I','-S','-c','import time;time.sleep(30)']
started=m.time.monotonic()
try:m.bounded_subprocess(command,1024,1)
except m.ReceiverError as error:assert str(error)=='subprocess_timeout'
else:raise AssertionError('timeout accepted')
assert m.time.monotonic()-started < 5
`);
  assert.equal(result.status, 0, result.stderr);
});

test('bounded subprocess kills and reaps the Linux process group without orphaning a child', { skip: process.platform !== 'linux' }, () => {
  const result = probe(`
with tempfile.TemporaryDirectory() as root:
  for scenario in ('timeout','overflow'):
   pidfile=os.path.join(root,scenario+'.pid')
   tail='time.sleep(60)' if scenario=='timeout' else '[(os.write(1,b"x"*8192)) for _ in iter(int,1)]'
   code='import os,subprocess,sys,time; p=subprocess.Popen([sys.executable,"-I","-S","-c","import time;time.sleep(60)"]);open(sys.argv[1],"w").write(str(p.pid));time.sleep(.1);'+tail
   try:m.bounded_subprocess([m.sys.executable,'-I','-S','-c',code,pidfile],1024,1)
   except m.ReceiverError as error:assert str(error)==('subprocess_timeout' if scenario=='timeout' else 'subprocess_output_limit_exceeded')
   else:raise AssertionError(scenario+' accepted')
   child=int(open(pidfile).read())
   for _ in range(200):
    try:os.kill(child,0)
    except ProcessLookupError:break
    m.time.sleep(.01)
   else:raise AssertionError(scenario+' orphan child survived process-group kill')
`);
  assert.equal(result.status, 0, result.stderr);
});

test('expiry and nonce reservation reject stale, far-future and replayed production requests', () => {
  const result = probe(fixture + `
import tempfile,types
with tempfile.TemporaryDirectory() as root:
    m.NONCES=root;m.protected_directory=lambda *a,**k:None
    selected=m.parse_request(request)
    real_time=m.time.time
    m.time.time=lambda:1900000000
    selected['expires-at']='1900000000';denied(lambda:m.reserve_nonce(selected))
    selected['expires-at']='1900086401';denied(lambda:m.reserve_nonce(selected))
    selected['expires-at']='1900000100';m.reserve_nonce(selected)
    try:m.reserve_nonce(selected)
    except m.ReceiverError as error:assert str(error)=='request_replayed'
    else:raise AssertionError('nonce replay accepted')
    m.time.time=real_time
`);
  assert.equal(result.status, 0, result.stderr);
});

test('private incoming lock atomically reaps expired nonces and caps concurrent receipt bytes/count', { skip: process.platform === 'win32' }, () => {
  const result = probe(`
import multiprocessing
with tempfile.TemporaryDirectory() as root:
 m.INCOMING=os.path.join(root,'incoming');m.NONCES=os.path.join(root,'nonces');m.LOCK_ROOT=os.path.join(root,'locks');m.QUOTA_LOCK=os.path.join(m.LOCK_ROOT,'incoming.lock')
 for directory in (m.INCOMING,m.NONCES,m.LOCK_ROOT):os.mkdir(directory,0o700)
 m.protected_directory=lambda *a,**k:None
 m.RECEIVER_UID=os.getuid();m.RECEIVER_GID=os.getgid();m.MAX_RECEIPTS=2;m.MAX_INCOMING_BYTES=20;m.MAX_RECEIPT_BYTES=10
 expired=os.path.join(m.NONCES,'e'*64)
 descriptor=os.open(expired,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(descriptor,'wb') as stream:stream.write(b'1000000000\\n');stream.flush();os.fsync(stream.fileno())
 start=multiprocessing.Event();results=multiprocessing.Queue()
 def worker(index):
  selected={'expires-at':str(int(m.time.time())+100),'nonce':format(index+1,'064x')}
  start.wait()
  try:
   with m.reserve_admission(selected) as receipt:
    descriptor=os.open(os.path.join(receipt,'reserved.bin'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(descriptor,'wb') as output:output.write(b'x'*10);output.flush();os.fsync(output.fileno())
    m.time.sleep(.1)
   results.put('ok')
  except m.ReceiverError as error:results.put(str(error))
 processes=[multiprocessing.Process(target=worker,args=(index,)) for index in range(4)]
 for process in processes:process.start()
 start.set()
 for process in processes:process.join(10);assert process.exitcode==0
 observed=sorted(results.get(timeout=1) for _ in processes)
 assert observed==['incoming_quota_exceeded','incoming_quota_exceeded','ok','ok'],observed
 receipts=list(pathlib.Path(m.INCOMING).iterdir());assert len(receipts)==2
 assert sum((receipt/'reserved.bin').stat().st_size for receipt in receipts)==20
 assert not os.path.exists(expired) and len(os.listdir(m.NONCES))==2
`);
  assert.equal(result.status, 0, result.stderr);
});

test('apply forwards an expired exact receipt for signed-intent recovery but still requires a fresh nonce marker', () => {
  const result = probe(`
import json,types
nonce='c'*64;receipt='payload-abcdefgh';calls=[]
m.protected_directory=lambda *a,**k:None
m.time.time=lambda:1900000200
def private(filename,limit):
 if filename.endswith('admission.json'):
  return json.dumps({'authorization':{'nonce':nonce,'expiresAt':'1900000100'}}).encode()
 if filename.endswith('preflight.json'):
  return b'{"installationExecuted":false,"deploymentAuthorized":false}'
 raise m.ReceiverError('unsafe_receipt_file')
m.read_private_file=private;m.os.path.lexists=lambda filename:False
def bounded(command,*args):
 calls.append(command);return types.SimpleNamespace(returncode=0,stdout=b'{"status":"installed-private"}')
m.bounded_subprocess=bounded
m.apply_request('production:payload-apply-v2 '+receipt+' '+nonce)
assert len(calls)==1 and '--apply-install' in calls[0]
m.time.time=lambda:1900000000
try:m.apply_request('production:payload-apply-v2 '+receipt+' '+nonce)
except m.ReceiverError as error:assert str(error)=='unsafe_receipt_file'
else:raise AssertionError('fresh apply accepted without nonce marker')
`);
  assert.equal(result.status, 0, result.stderr);
});

test('real archive inspection rejects legacy Payload, duplicate metadata and unsafe entries before extraction', () => {
  const result = probe(fixture + `
selected=m.parse_request(request)
m.inspect_archive(bundle(2),commit,None)
m.inspect_archive(bundle(),commit,selected)
denied(lambda:m.inspect_archive(bundle(),commit,None))
for name in ('.ci-images','../outside','/absolute','a/../../outside'):
    denied(lambda:m.inspect_archive(bundle(extras=[(name,b'bad')]),commit,selected))
denied(lambda:m.inspect_archive(bundle(), 'b'*40,selected))
wrong=dict(selected);wrong['cms-image']=images[2][:-1]+'a'
denied(lambda:m.inspect_archive(bundle(),commit,wrong))
`);
  assert.equal(result.status, 0, result.stderr);
});

test('receiver fixed isolated admission precedes any runtime inspection; legacy receipt precedes extraction', async () => {
  const source = await readFile('ops/deploy-from-ci.sh', 'utf8');
  assert.match(source, /production:payload-v1/u);
  assert.match(source, /env -i[^\n]*\/usr\/bin\/python3 -I -S/u);
  assert.ok(source.indexOf('payload-receiver-admission.py') < source.indexOf('for command in docker'));
  assert.doesNotMatch(source, /cat >"\$archive"/u);
  assert.match(source, /payload-receiver-admission.py legacy/u);
  assert.ok(source.indexOf('payload-receiver-admission.py legacy') < source.indexOf('if [[ $current == "$releases/$requested_commit" ]]'),
    'already-current recovery cannot skip archive classification');
});

test('transport doubles: verifier denials retain bytes; accepted admission extracts then calls only preflight', () => {
  const result = probe(transport + `
original_name=m.os.name
with tempfile.TemporaryDirectory() as root:
    m.INCOMING=root
    raw=bundle()
    for reason in ('missing_policy','missing_record','wrong_selectors','stale_policy','altered_archive','accepted'):
        trace.clear()
        def verifier(command,*args,**kwargs):
            if m.VERIFIER in command:
                trace.append('verify')
                assert command[:5]==[m.PYTHON,'-I','-S',m.VERIFIER,'verify']
                assert command[5]=='--archive' and command[7:]==sum(([ '--'+key,m.parse_request(request)[key]] for key in m.FIELDS),[])
                return types.SimpleNamespace(returncode=0 if reason=='accepted' else 1,stdout=b'{"authorization":{"nonce":"'+b'c'*64+b'"},"deploymentAuthorized":false}\\n')
            trace.append('preflight')
            assert command[:5]==[m.PYTHON,'-I','-S','-B',m.PREFLIGHT]
            return types.SimpleNamespace(returncode=0,stdout=b'{"installationExecuted":false,"deploymentAuthorized":false}\\n')
        m.bounded_subprocess=verifier
        # Windows executes all transport logic with only POSIX identity checks doubled.
        m.os.name='posix'
        try:
            if reason=='accepted':m.payload_request(request,io.BytesIO(raw))
            else:
                try:m.payload_request(request,io.BytesIO(raw))
                except m.ReceiverError as error:assert str(error)=='candidate_admission_denied'
                else:raise AssertionError('invalid admission allowed')
        finally:m.os.name=original_name
        assert trace==(['nonce','verify','extract','preflight'] if reason=='accepted' else ['nonce','verify'])
    receipts=list(pathlib.Path(root).iterdir())
    assert len(receipts)==6
    assert all((receipt/'candidate.tar.gz').read_bytes()==raw for receipt in receipts)
    assert sum((receipt/'release').exists() for receipt in receipts)==1
    assert sum((receipt/'preflight.json').exists() for receipt in receipts)==1
`);
  assert.equal(result.status, 0, result.stderr);
});

test('transport double: same-byte inode replacement during verification is denied before extraction', () => {
  const result = probe(transport + `
with tempfile.TemporaryDirectory() as root:
    archive=os.path.join(root,'archive')
    raw=bundle()
    with open(archive,'w+b') as stream:
        stream.write(raw);stream.flush()
        def verifier(command,*args,**kwargs):
            # Model an identical-content replacement without depending on Windows rename sharing.
            previous=m.os.lstat
            def changed(file):
                info=previous(file);info.st_ino+=1;return info
            m.os.lstat=changed
            return types.SimpleNamespace(returncode=0,stdout=b'{}')
        m.bounded_subprocess=verifier
        try:m.verify_receipt(archive,stream,raw,m.parse_request(request))
        except m.ReceiverError as error:assert str(error)=='receipt_identity_changed'
        else:raise AssertionError('replacement accepted')
    assert trace==[]
`);
  assert.equal(result.status, 0, result.stderr);
});

test('real inspection rejects links, special files and oversized expanded data', () => {
  const result = probe(fixture + `
for kind in (tarfile.SYMTYPE,tarfile.LNKTYPE,tarfile.FIFOTYPE,tarfile.CHRTYPE):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w:gz') as archive:
        item=tarfile.TarInfo('link');item.type=kind;item.linkname='../outside';archive.addfile(item)
    denied(lambda:m.inspect_archive(out.getvalue(),commit,None))
m.MAX_EXPANDED=1024
denied(lambda:m.inspect_archive(bundle(),commit,m.parse_request(request)))
`);
  assert.equal(result.status, 0, result.stderr);
});

test('legacy transport: two images extract, three images never create a release (POSIX metadata double)', () => {
  const result = probe(transport + `
m.os.O_NOFOLLOW=getattr(os,'O_NOFOLLOW',0)
m.os.O_NONBLOCK=getattr(os,'O_NONBLOCK',0)
with tempfile.TemporaryDirectory() as root:
    for count in (2,3):
        archive=os.path.join(root,'archive-'+str(count))
        destination=os.path.join(root,'release-'+str(count))
        with open(archive,'xb'):pass
        os.chmod(archive,0o600)
        trace.clear()
        if count==2:
            m.legacy_request(archive,destination,commit,io.BytesIO(bundle(count)))
            assert trace==['extract']
            assert pathlib.Path(destination,'.ci-images').read_bytes()==('\\n'.join(images[:2])+'\\n').encode()
        else:
            denied(lambda:m.legacy_request(archive,destination,commit,io.BytesIO(bundle(count))))
            assert trace==[] and not os.path.exists(destination)
`);
  assert.equal(result.status, 0, result.stderr);
});

test('actual Bash receiver Payload route with installed-transport double never reaches runtime path', async () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const source = await readFile('ops/deploy-from-ci.sh', 'utf8');
  const marked = source.replace('exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/python3 -I -S \\\n    /usr/local/libexec/payload-receiver-admission.py payload "$SSH_ORIGINAL_COMMAND"',
    'printf "transport_only\\n"; exit 2');
  assert.notEqual(marked, source);
  const result = spawnSync(bash, ['-c', marked], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, SSH_ORIGINAL_COMMAND: 'production:payload-v1 invalid', DEPLOY_RECEIVER_ROLE: 'production' } });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, 'transport_only\n');
  assert.equal(result.stderr, '');
});

test('actual legacy receiver denial stanza cannot reach already-current recovery (transport double)', async () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const source = await readFile('ops/deploy-from-ci.sh', 'utf8');
  const stanza = source.slice(source.indexOf('# The installed transport helper bounds stdin'), source.indexOf('find "$staging" -type d'));
  const marked = stanza.replace('/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/python3 -I -S \\\n  /usr/local/libexec/payload-receiver-admission.py legacy', 'transport');
  assert.notEqual(marked, stanza);
  const script = `set -Eeuo pipefail\narchive=/synthetic/receipt; staging=/synthetic/staging; requested_commit=${'a'.repeat(40)}; releases=/synthetic/releases; current="$releases/$requested_commit"; cms_current=false\ntransport() { return 2; }\ncurl() { echo forbidden_effect; exit 90; }\ndocker() { echo forbidden_effect; exit 90; }\n${marked}\necho forbidden_fallthrough`;
  const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /retained incoming receipt: receipt/u);
});

test('Linux root native receipt identity and ancestry (verifier subprocess only is doubled)', { skip: process.platform !== 'linux' || process.getuid?.() !== 0 }, () => {
  const result = probe(fixture + `
import types
with tempfile.TemporaryDirectory(dir='/root') as root:
    m.INCOMING=root
    raw=bundle()
    def verifier(command,*args,**kwargs):
        return types.SimpleNamespace(returncode=0,stdout=b'{"deploymentAuthorized":false}\\n')
    m.bounded_subprocess=verifier
    try:m.payload_request(request,io.BytesIO(raw))
    except m.ReceiverError as error:assert str(error)=='release_not_preflighted'
    else:raise AssertionError('install allowed')
    archive=os.path.join(root,'replacement-test')
    with open(archive,'x+b') as stream:
        os.chmod(archive,0o600);stream.write(raw);stream.flush()
        def replace(command,*args,**kwargs):
            replacement=archive+'.new'
            with open(replacement,'xb') as output:output.write(raw)
            os.chmod(replacement,0o600);os.replace(replacement,archive)
            return types.SimpleNamespace(returncode=0,stdout=b'{}')
        m.bounded_subprocess=replace
        denied(lambda:m.verify_receipt(archive,stream,raw,m.parse_request(request)))
    os.chmod(root,0o777)
    denied(lambda:m.protected_directory(root,private=True))
    os.chmod(root,0o700)
`);
  assert.equal(result.status, 0, result.stderr);
});
