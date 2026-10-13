import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validateAdmissionPolicy } from '../../scripts/register-payload-candidate-admission.mjs';

const python = process.platform === 'win32' ? 'python' : 'python3';
const modulePath = path.resolve('ops/provision-payload-candidate-trust.py');
const verifierPath = path.resolve('ops/payload-candidate-verifier.py');
const load = `import importlib.util\nspec=importlib.util.spec_from_file_location('p',${JSON.stringify(modulePath)})\np=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)\n`;
function probe(code, input, native = false) {
  return spawnSync(native ? '/usr/bin/python3' : python, ['-I', '-S', '-B', '-c', load + code], {
    input, encoding: 'utf8', timeout: 30000,
    ...(native ? { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } } : {}),
  });
}

test('bootstrap policy validator agrees with both existing validators on valid and malformed contract corpus', () => {
  const files = ['ops/payload-candidate-verifier.py', 'scripts/register-payload-candidate-admission.mjs',
    'scripts/package-payload-candidate.mjs', 'scripts/lib/payload-candidate-qualification.mjs'];
  const policy = { schemaVersion: 1, kind: 'ownerinc-payload-candidate-policy-v1', environment: 'production',
    repository: 'OWNERINC/portal_ownerinc', repositoryId: '123', workflow: '.github/workflows/ci.yml', workflowId: '456',
    approvedRevisions: [{ commit: 'a'.repeat(40), workflowSha256: 'b'.repeat(64) }],
    toolchain: { files: Object.fromEntries(files.map(file => [file, 'c'.repeat(64)])),
      executables: Object.fromEntries(['node', 'git', 'python', 'gitRemoteHttps'].map(role => [role, {
        path: role === 'gitRemoteHttps' ? '/opt/ownerinc/lib/payload-candidate/bin/git-remote-https' : `/usr/bin/${role}`,
        sha256: 'd'.repeat(64),
      }])) } };
  const mutations = [p => { p.schemaVersion = true; }, p => { p.schemaVersion = '1'; }, p => { p.schemaVersion = 2; },
    p => { p.unknown = 1; }, p => { delete p.kind; }, p => { p.environment = 'staging'; },
    p => { p.repository = 'elsewhere/repo'; }, p => { p.workflow = '.github/workflows/other.yml'; },
    p => { p.repositoryId = 123; }, p => { p.workflowId = '01'; }, p => { p.approvedRevisions = []; },
    p => { p.approvedRevisions = Array(129).fill(p.approvedRevisions[0]); },
    p => { p.approvedRevisions.push(p.approvedRevisions[0]); }, p => { p.approvedRevisions[0].commit = 'main'; },
    p => { p.approvedRevisions[0].workflowSha256 += '\n'; }, p => { p.approvedRevisions[0].approved = true; },
    p => { delete p.toolchain.files[files[0]]; }, p => { p.toolchain.files.extra = 'e'.repeat(64); },
    p => { p.toolchain.files[files[0]] = 'wrong'; }, p => { p.toolchain.extra = {}; },
    p => { p.toolchain.executables.node.path = 'relative'; }, p => { p.toolchain.executables.node.path = '/usr/../node'; },
    p => { p.toolchain.executables.node.path = p.toolchain.executables.git.path; },
    p => { p.toolchain.executables.git.path = '/bin/git-other'; },
    p => { p.toolchain.executables.gitRemoteHttps.path = '/usr/bin/git-remote-https'; },
    p => { p.toolchain.executables.python.sha256 = '0'; }, p => { p.toolchain.executables.python.uid = 0; }];
  const corpus = [policy, ...mutations.map(mutate => { const item = structuredClone(policy); mutate(item); return item; })];
  const expected = corpus.map(item => { try { validateAdmissionPolicy(item); return true; } catch { return false; } });
  assert.deepEqual(expected, [true, ...mutations.map(() => false)]);
  const result = probe(`
import json,sys,posixpath
spec=importlib.util.spec_from_file_location('v',${JSON.stringify(verifierPath)})
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
p.os.path=posixpath # Pure Linux-path contract validation, even on Windows.
results=[]
for policy in json.load(sys.stdin):
    values=[]
    for validate in [p.validate_policy,v.validate_policy]:
        try:validate(policy);values.append(True)
        except Exception:values.append(False)
    results.append(values)
print(json.dumps(results))
`, JSON.stringify(corpus));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected.map(value => [value, value]));
});

const filesystem = String.raw`
import copy,json,os,pathlib,stat,tempfile,shutil,types
root=tempfile.mkdtemp(prefix='trust-provision-',dir=os.path.join(os.environ['LOCALAPPDATA'],'Temp','opencode') if os.name=='nt' else None)
original_metadata=p.file_metadata
original_directory=p.directory_metadata
# Host ownership is a double; files, reads, hashes, writes and rename collisions
# are real. On Windows ONLY, modes/nofollow/directory-fsync/renameat2 are unavailable.
def file_metadata(info,mode,limit):
    p.require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and 0<info.st_size<=limit,'unsafe_file')
    if os.name!='nt':p.require(stat.S_IMODE(info.st_mode)==mode,'unsafe_file')
def directory_metadata(info,private=False):
    p.require(stat.S_ISDIR(info.st_mode),'unsafe_directory')
    if os.name!='nt' and private:p.require(stat.S_IMODE(info.st_mode)==0o700,'unsafe_directory')
p.file_metadata=file_metadata;p.directory_metadata=directory_metadata
if os.name=='nt':
    # Windows descriptor/path timestamps and executable mode bits differ; native
    # POSIX identity checks remain unchanged and require separate Linux evidence.
    p.identity=lambda info:(info.st_dev,info.st_ino,info.st_size,info.st_nlink)
    p.canonical_path=lambda value: value if os.path.isabs(value) and os.path.normpath(value)==os.path.normpath(os.path.abspath(value)) else p.require(False,'unsafe_path')
    # Use actual Windows ancestry rather than the production Linux '/' walker.
    def directories(filename,create=False,private=False,missing=False):
        current=pathlib.Path(filename)
        for directory in reversed([current,*current.parents]):
            if not directory.exists():
                if create:directory.mkdir(mode=0o700)
                elif missing:continue
                else:raise p.ProvisionError('missing_directory')
            p.directory_metadata(os.lstat(directory),private and directory==current)
    p.directories=directories
    os.O_NOFOLLOW=0;os.O_NONBLOCK=0
    os.fchmod=lambda *_:None
    p.sync_directory=lambda *_:None
    real_fsync=os.fsync
    def fsync_windows(fd):
        os.fstat(fd) # Invalid descriptors still fail; Windows cannot flush read-only handles.
        try:real_fsync(fd)
        except OSError as error:
            if error.errno!=9:raise
    os.fsync=fsync_windows
    p.rename_noreplace=os.rename # Windows rename refuses an existing destination.
def write(filename,raw,mode):
    os.makedirs(os.path.dirname(filename),exist_ok=True)
    with open(filename,'wb') as stream:stream.write(raw)
    os.chmod(filename,mode)
def setup(label):
    base=os.path.join(root,label);bundle=os.path.join(base,'bundle')
    p.TOOL_ROOT=os.path.join(base,'installed');p.POLICY_PATH=os.path.join(base,'etc','production-policy.json');p.STATE_ROOT=os.path.join(base,'state')
    # Bundle payloads would fail or create a sentinel if executed; bootstrap must
    # only hash/copy them. No candidate-supplied parser is used in these tests.
    content={file:b'UNTRUSTED_DATA_NOT_EXECUTABLE\n' for file in p.TOOL_FILES}
    executables={}
    for role in ['node','git','python']:
        filename=os.path.join(base,'host',role);data=('binary-'+role).encode();write(filename,data,0o755)
        executables[role]={'path':filename,'sha256':p.sha(data)}
    content['bin/git-remote-https']=b'HTTPS_BINARY_DATA'
    executables['gitRemoteHttps']={'path':p.TOOL_ROOT+'/bin/git-remote-https','sha256':p.sha(content['bin/git-remote-https'])}
    policy={'schemaVersion':1,'kind':'ownerinc-payload-candidate-policy-v1','environment':'production',
        'repository':'OWNERINC/portal_ownerinc','repositoryId':'123','workflow':'.github/workflows/ci.yml','workflowId':'456',
        'approvedRevisions':[{'commit':'a'*40,'workflowSha256':'b'*64}],
        'toolchain':{'files':{file:p.sha(content[file]) for file in p.TOOL_FILES},'executables':executables}}
    policy_raw=(json.dumps(policy)+'\n').encode()
    for file,data in content.items():write(bundle+'/'+file,data,0o755 if file.endswith('.py') or file.startswith('bin/') else 0o644)
    write(bundle+'/production-policy.json',policy_raw,0o600)
    approval={'schemaVersion':1,'kind':'ownerinc-payload-trust-provisioning-v1','policySha256':p.sha(policy_raw),'toolchain':copy.deepcopy(policy['toolchain'])}
    raw=(json.dumps(approval)+'\n').encode();filename=os.path.join(base,'approval.json');write(filename,raw,0o600)
    return filename,p.sha(raw),bundle,policy
def call(inputs,mode='apply'):return p.provision(mode,*inputs[:3])
def denied(fn,reason=None):
    try:fn()
    except (p.ProvisionError,OSError) as error:
        if reason:assert str(error)==reason,(str(error),reason)
    else:raise AssertionError('unexpected success')
def inventory():
    return {str(file.relative_to(root)):file.read_bytes() for file in pathlib.Path(root).rglob('*') if file.is_file()}
`;

test('preparation profile reuses protected publication and retries without changing candidate CLI (ownership doubles)', () => {
  const result = probe(filesystem + String.raw`
try:
    base=os.path.join(root,'preparation');bundle=os.path.join(base,'bundle')
    p.PREPARATION_ROOT=os.path.join(base,'installed');p.PREPARATION_LAUNCHER=os.path.join(base,'libexec','prepare.py')
    p.PREPARATION_APPROVAL=os.path.join(base,'etc','approval.json');p.STATE_ROOT=os.path.join(base,'state')
    content={name:b'UNTRUSTED_DATA_NEVER_EXECUTED\n' for name in p.PREPARATION_FILES}
    for name,data in content.items():write(bundle+'/'+name,data,p.preparation_mode(name))
    approval={'schemaVersion':1,'kind':'ownerinc-payload-preparation-approval-v1','environment':'production',
      'repository':'OWNERINC/portal_ownerinc','source':{'commit':'a'*40,'files':{n:p.sha(d) for n,d in content.items()}},
      'hostBaseline':{'currentCommit':'b'*40,'legacyImages':{s:'ghcr.io/ownerinc/ownerinc-portal-'+s+'@sha256:'+'c'*64 for s in ('api','cron')},
        'releaseComposeSha256':'d'*64,'runtimeComposeSha256':'e'*64,'releaseOverrideSha256':None,'inventoryIdentity':'f'*64,
        'installedPredecessors':{'commonReceiver':'1'*64,'receiverHelper':None,'productionWrapper':None,'operationsGuard':None,'cmsCandidate':None}},
      'admission':{'policySha256':'2'*64,'archiveSha256':'3'*64,'recordSha256':'4'*64}}
    raw=(json.dumps(approval)+'\n').encode();filename=os.path.join(base,'input.json');write(filename,raw,0o600)
    args=(filename,p.sha(raw),bundle);before=inventory()
    assert 'no files written' in p.provision_preparation('check',*args) and inventory()==before
    original_publish=p.publish;events=[]
    def interrupted(name,expected):
        if len(events)==6:raise OSError('interruption')
        original_publish(name,expected);events.append(name)
    p.publish=interrupted;denied(lambda:p.provision_preparation('apply',*args))
    assert not os.path.lexists(p.PREPARATION_APPROVAL)
    def observe(name,expected):original_publish(name,expected);events.append(name)
    p.publish=observe;events.clear();p.provision_preparation('apply',*args)
    assert events[-1]==p.PREPARATION_APPROVAL
    assert len(os.listdir(p.STATE_ROOT+'/trust-snapshots'))==2
    before=inventory();p.provision_preparation('apply',*args);assert inventory()==before
    write(p.PREPARATION_LAUNCHER,b'unknown',0o755);events.clear()
    denied(lambda:p.provision_preparation('apply',*args),'destination_conflict');assert events==[]
    # Existing seven-argument CLI still selects candidate trust, never preparation.
    from unittest.mock import patch
    cli=['--check','--approval',filename,'--approval-sha256',p.sha(raw),'--bundle',bundle]
    with patch.object(p.sys,'platform','linux'),patch.object(p.os,'getuid',return_value=0,create=True), \
         patch.object(p.os,'geteuid',return_value=0,create=True),patch.object(p.os,'getgid',return_value=0,create=True), \
         patch.object(p.os,'getegid',return_value=0,create=True),patch.dict(p.os.environ,{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},clear=True), \
         patch.object(p.os.path,'realpath',return_value='/usr/bin/python3'):
        denied(lambda:p.main(cli),'invalid_shape')
        with patch.object(p,'provision_preparation',return_value='verify-only profile') as selected:
            p.main(cli+['--profile','preparation']);assert selected.call_count==1
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('offline real filesystem: read-only check, exact publication, retained snapshots, idempotence and record preservation (ownership doubles)', () => {
  const result = probe(filesystem + String.raw`
try:
    inputs=setup('success');before=inventory()
    assert 'no files written' in call(inputs,'check');assert inventory()==before
    assert not os.path.exists(p.STATE_ROOT) and not os.path.exists(p.TOOL_ROOT)
    assert not os.path.exists(os.path.dirname(p.POLICY_PATH))
    os.makedirs(p.STATE_ROOT+'/records',mode=0o700)
    write(p.STATE_ROOT+'/records/existing.json',b'preserved-record',0o600)
    events=[];publish=p.publish
    def tracked(filename,expected):
        if filename==p.POLICY_PATH:
            for file in p.TOOL_FILES:assert pathlib.Path(p.TOOL_ROOT+'/'+file).is_file()
            assert pathlib.Path(p.TOOL_ROOT+'/bin/git-remote-https').is_file()
        events.append(filename);return publish(filename,expected)
    p.publish=tracked
    call(inputs)
    assert events[-1]==p.POLICY_PATH
    assert pathlib.Path(p.POLICY_PATH).read_bytes()==pathlib.Path(inputs[2]+'/production-policy.json').read_bytes()
    assert pathlib.Path(p.STATE_ROOT+'/records/existing.json').read_bytes()==b'preserved-record'
    snapshots=list(pathlib.Path(p.STATE_ROOT+'/trust-snapshots').iterdir());assert len(snapshots)==1
    manifest=json.loads((snapshots[0]/'manifest.json').read_bytes());assert all(not item['present'] for item in manifest['files'])
    before=inventory();call(inputs);assert inventory()==before
    assert list(pathlib.Path(root).rglob('__pycache__'))==[]
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr);
});

test('native Linux root filesystem validates protected ancestry, fsync and no-replace publication without ownership doubles', {
  skip: process.env.PAYLOAD_REQUIRE_NATIVE_TRUST !== '1' && (process.platform !== 'linux' || process.getuid?.() !== 0),
}, t => {
  assert.equal(process.platform, 'linux', 'required native qualification cannot skip a non-Linux host');
  assert.equal(process.getuid(), 0);
  assert.equal(process.geteuid(), 0);
  assert.equal(process.getgid(), 0);
  assert.equal(process.getegid(), 0);
  const nativeFixture = filesystem
    .replace(/^root=tempfile\.mkdtemp\(.+$/mu, "root=tempfile.mkdtemp(prefix='trust-provision-',dir='/root')")
    .replace(/original_metadata=p\.file_metadata[\s\S]*?(?=def write\()/u, '');
  assert.doesNotMatch(nativeFixture, /p\.(?:file_metadata|directory_metadata|identity|canonical_path|directories|sync_directory|rename_noreplace)\s*=|os\.(?:fsync|open|fchmod)\s*=/u);
  const result = probe(String.raw`
import errno,sys
assert p.TOOL_ROOT=='/opt/ownerinc/lib/payload-candidate'
assert p.POLICY_PATH=='/etc/ownerinc/payload-candidate/production-policy.json'
assert p.STATE_ROOT=='/var/lib/ownerinc/payload-candidate'
# Only these three constants are redirected by setup(). No function replacement.
originals={name:getattr(p,name) for name in ['read_protected','file_metadata','directory_metadata',
    'directories','publish','sync_directory','rename_noreplace','identity']}
assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
` + nativeFixture + String.raw`
try:
    inputs=setup('native')
    # Actual main() uses the real canonical host Python, not the synthetic binary
    # data used by portable fixtures. This is test approval, never host approval.
    python_path=os.path.realpath('/usr/bin/python3')
    python_hash=p.sha(p.read_protected(python_path,0o755,p.MAX_BINARY))
    inputs[3]['toolchain']['executables']['python']={'path':python_path,'sha256':python_hash}
    policy_raw=(json.dumps(inputs[3])+'\n').encode();write(inputs[2]+'/production-policy.json',policy_raw,0o600)
    approval={'schemaVersion':1,'kind':'ownerinc-payload-trust-provisioning-v1',
        'policySha256':p.sha(policy_raw),'toolchain':copy.deepcopy(inputs[3]['toolchain'])}
    approval_raw=(json.dumps(approval)+'\n').encode();write(inputs[0],approval_raw,0o600)
    inputs=(inputs[0],p.sha(approval_raw),inputs[2],inputs[3])
    import contextlib,io
    before=inventory();check_output=io.StringIO()
    with contextlib.redirect_stdout(check_output):
        p.main(['--check','--approval',inputs[0],'--approval-sha256',inputs[1],'--bundle',inputs[2]])
    assert check_output.getvalue()=='Trust provisioning check passed; no files written.\n'
    assert inventory()==before
    assert not os.path.exists(p.TOOL_ROOT) and not os.path.exists(p.STATE_ROOT)
    assert not os.path.exists(os.path.dirname(p.POLICY_PATH))
    # Real partial publication represents an interrupted prior application.
    # Functions/syscalls are not replaced to manufacture the restart state.
    _,_,targets=p.load_inputs(*inputs[:3])
    partial=list(targets)[:2]
    for filename in partial:
        p.directories(os.path.dirname(filename),create=True)
        p.publish(filename,targets[filename])
    inodes={filename:os.stat(filename).st_ino for filename in partial}
    assert not os.path.exists(p.POLICY_PATH)
    p.directories(p.STATE_ROOT+'/records',create=True,private=True)
    record=p.STATE_ROOT+'/records/preserved.json';write(record,b'private-test-record',0o600)
    record_before=os.stat(record)
    synced=[];policy_events=[]
    # Profile observes real calls; no I/O, metadata or publication function is mocked.
    def observe(frame,event,arg):
        if event=='call' and frame.f_code is p.sync_directory.__code__:
            synced.append(frame.f_locals['filename'])
        if event=='call' and frame.f_code is p.publish.__code__ and frame.f_locals['filename']==p.POLICY_PATH:
            policy_events.append('publish-policy')
            assert not os.path.exists(p.POLICY_PATH)
            for filename,expected in targets.items():
                if filename!=p.POLICY_PATH:assert p.read_protected(filename,expected[1],expected[2])==expected[0]
    sys.setprofile(observe)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            p.main(['--apply','--approval',inputs[0],'--approval-sha256',inputs[1],'--bundle',inputs[2]])
    finally:sys.setprofile(None)
    assert policy_events==['publish-policy']
    # Previously created ancestry entries must have their parents fsynced on retry.
    current=os.path.dirname(partial[0])
    while current!='/':
        assert os.path.dirname(current) in synced,current
        current=os.path.dirname(current)
    assert all(os.stat(filename).st_ino==inode for filename,inode in inodes.items())
    assert pathlib.Path(record).read_bytes()==b'private-test-record'
    assert os.stat(record).st_ino==record_before.st_ino
    before=inventory();call(inputs);assert inventory()==before
    assert stat.S_IMODE(os.stat(p.POLICY_PATH).st_mode)==0o600
    for filename,expected in targets.items():
        info=os.stat(filename)
        assert (info.st_uid,info.st_gid,info.st_nlink)==(0,0,1)
        assert stat.S_IMODE(info.st_mode)==expected[1]
    source=os.path.join(root,'noreplace-source');write(source,b'new',0o600)
    policy_inode=os.stat(p.POLICY_PATH).st_ino
    try:p.rename_noreplace(source,p.POLICY_PATH)
    except FileExistsError as error:assert error.errno==errno.EEXIST
    else:raise AssertionError('replaced existing destination')
    assert os.stat(p.POLICY_PATH).st_ino==policy_inode and pathlib.Path(source).read_bytes()==b'new'
    assert inventory()[str(pathlib.Path(p.POLICY_PATH).relative_to(root))]==before[str(pathlib.Path(p.POLICY_PATH).relative_to(root))]
    destination=os.path.join(root,'noreplace-success');inode=os.stat(source).st_ino
    p.rename_noreplace(source,destination);p.sync_directory(root)
    assert not os.path.exists(source) and os.stat(destination).st_ino==inode and os.stat(destination).st_nlink==1
    linked=os.path.join(root,'linked');os.symlink(inputs[0],linked)
    denied(lambda:p.read_protected(linked,0o600,p.MAX_JSON))
    try:fd=os.open(linked,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except OSError as error:assert error.errno==errno.ELOOP
    else:os.close(fd);raise AssertionError('kernel NOFOLLOW did not reject symlink')
    os.unlink(linked);os.link(inputs[0],linked)
    denied(lambda:p.read_protected(inputs[0],0o600,p.MAX_JSON),'unsafe_file');os.unlink(linked)
    unsafe=os.path.join(root,'unsafe');os.mkdir(unsafe,0o700)
    protected=unsafe+'/input';write(protected,b'private',0o600);os.chmod(unsafe,0o777)
    denied(lambda:p.read_protected(protected,0o600,p.MAX_JSON),'unsafe_directory')
    assert stat.S_IMODE(os.stat(unsafe).st_mode)==0o777
    os.chmod(unsafe,0o700)
    os.chown(protected,65534,0)
    denied(lambda:p.read_protected(protected,0o600,p.MAX_JSON),'unsafe_file')
    assert os.stat(protected).st_uid==65534
    os.chown(protected,0,65534)
    denied(lambda:p.read_protected(protected,0o600,p.MAX_JSON),'unsafe_file')
    assert os.stat(protected).st_gid==65534
    inputs=setup('conflict');write(p.TOOL_ROOT+'/'+p.TOOL_FILES[0],b'conflict',0o755)
    before=inventory();denied(lambda:call(inputs),'destination_conflict');assert inventory()==before
    assert not os.path.exists(p.POLICY_PATH)
    assert all(getattr(p,name) is function for name,function in originals.items())
    assert list(pathlib.Path(root).rglob('__pycache__'))==[]
    print(json.dumps({'kind':'native-trust-filesystem-proof','schemaVersion':1,
        'checks':['cli-check-apply','read-only','partial-retry','parent-fsync','policy-last','record-preserved','idempotent',
            'root-metadata','rename-no-clobber','rename-success','nofollow','hardlink','unsafe-ancestor',
            'wrong-owner','wrong-group','conflict-preserved','no-bytecode']}))
finally:shutil.rmtree(root)
`, undefined, true);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'native-trust-filesystem-proof', schemaVersion: 1,
    checks: ['cli-check-apply', 'read-only', 'partial-retry', 'parent-fsync', 'policy-last', 'record-preserved', 'idempotent',
      'root-metadata', 'rename-no-clobber', 'rename-success', 'nofollow', 'hardlink', 'unsafe-ancestor',
      'wrong-owner', 'wrong-group', 'conflict-preserved', 'no-bytecode'] });
  t.diagnostic(result.stdout.trim());
});

test('offline real filesystem: partial publication, conflicting races, input drift and restart never publish premature policy (ownership doubles)', () => {
  const result = probe(filesystem + String.raw`
try:
    inputs=setup('interrupted');publish=p.publish;count=[0]
    def interrupted(filename,expected):
        if filename.startswith(p.TOOL_ROOT):
            count[0]+=1
            if count[0]==3:raise p.ProvisionError('injected_interruption')
        return publish(filename,expected)
    p.publish=interrupted;denied(lambda:call(inputs),'injected_interruption')
    assert not os.path.exists(p.POLICY_PATH)
    p.publish=publish;call(inputs)
    assert len(list(pathlib.Path(p.STATE_ROOT+'/trust-snapshots').iterdir()))==2
    inputs=setup('conflict');write(p.TOOL_ROOT+'/'+p.TOOL_FILES[0],b'conflict',0o755)
    before=inventory();denied(lambda:call(inputs),'destination_conflict');assert inventory()==before
    inputs=setup('race');rename=p.rename_noreplace
    def racing(source,destination):
        if destination==p.TOOL_ROOT+'/'+p.TOOL_FILES[0]:write(destination,b'appeared-mid-run',0o755)
        return rename(source,destination)
    p.rename_noreplace=racing;denied(lambda:call(inputs),'destination_conflict')
    assert pathlib.Path(p.TOOL_ROOT+'/'+p.TOOL_FILES[0]).read_bytes()==b'appeared-mid-run'
    assert not os.path.exists(p.POLICY_PATH);p.rename_noreplace=rename
    inputs=setup('policy-race')
    def policy_race(source,destination):
        if destination==p.POLICY_PATH:write(destination,b'conflicting-policy',0o600)
        return rename(source,destination)
    p.rename_noreplace=policy_race;denied(lambda:call(inputs),'destination_conflict')
    assert pathlib.Path(p.POLICY_PATH).read_bytes()==b'conflicting-policy';p.rename_noreplace=rename
    inputs=setup('input-drift')
    def changed(filename,expected):
        result=publish(filename,expected)
        if filename==p.TOOL_ROOT+'/'+p.TOOL_FILES[-1]:write(inputs[2]+'/'+p.TOOL_FILES[0],b'changed',0o755)
        return result
    p.publish=changed;denied(lambda:call(inputs),'bundle_hash_mismatch');assert not os.path.exists(p.POLICY_PATH)
    p.publish=publish;inputs=setup('durability-retry');sync=p.sync_directory;failed=[False]
    def interrupted_sync(directory):
        if directory==os.path.dirname(p.POLICY_PATH) and os.path.exists(p.POLICY_PATH) and not failed[0]:
            failed[0]=True;raise p.ProvisionError('injected_fsync_failure')
        return sync(directory)
    p.sync_directory=interrupted_sync;denied(lambda:call(inputs),'injected_fsync_failure')
    assert os.path.exists(p.POLICY_PATH)
    resumed=[]
    def resumed_sync(directory):resumed.append(directory);return sync(directory)
    p.sync_directory=resumed_sync;call(inputs)
    assert os.path.dirname(p.POLICY_PATH) in resumed
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr);
});

test('offline inputs reject independent digest mismatch, extras, executable drift, policy/approval mismatch and hardlinks before writes', () => {
  const result = probe(filesystem + String.raw`
try:
    inputs=setup('bad-digest');before=inventory()
    denied(lambda:p.provision('apply',inputs[0],'0'*64,inputs[2]),'approval_digest_mismatch');assert inventory()==before
    for label,mutate,reason in [
        ('extra',lambda i:write(i[2]+'/unexpected',b'ignored?',0o600),'unexpected_bundle_entry'),
        ('host',lambda i:write(i[3]['toolchain']['executables']['node']['path'],b'changed',0o755),'host_executable_mismatch'),
        ('policy',lambda i:write(i[2]+'/production-policy.json',b'{}',0o600),'policy_digest_mismatch'),
        ('hardlink',lambda i:os.link(i[2]+'/'+p.TOOL_FILES[0],i[0]+'.linked'),'unsafe_file')]:
        inputs=setup(label);mutate(inputs);before=inventory()
        denied(lambda:call(inputs),reason);assert inventory()==before
    inputs=setup('toolchain-mismatch')
    approval=json.loads(pathlib.Path(inputs[0]).read_bytes());approval['toolchain']['files'][p.TOOL_FILES[0]]='0'*64
    raw=json.dumps(approval).encode();write(inputs[0],raw,0o600)
    denied(lambda:p.provision('apply',inputs[0],p.sha(raw),inputs[2]),'toolchain_approval_mismatch')
    inputs=setup('replaced-read');original_open=os.open;replaced=[False]
    def replaced_open(filename,*args,**kwargs):
        descriptor=original_open(filename,*args,**kwargs)
        if filename==inputs[0] and not replaced[0]:
            replaced[0]=True;raw=pathlib.Path(filename).read_bytes()
            if os.name=='nt':write(filename,raw+b' ',0o600)
            else:os.rename(filename,filename+'.old');write(filename,raw,0o600)
        return descriptor
    os.open=replaced_open;denied(lambda:call(inputs),'file_changed');os.open=original_open
    for raw in [b'{}',b'{"schemaVersion":1,"schemaVersion":1}',b'{"a":1.0}',b'{"a":NaN}']:
        denied(lambda:p.validate_approval(p.strict_json(raw)))
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr);
});

test('production metadata guards reject root/group/modes/links and CLI rejects overrides without host writes', async () => {
  const result = probe(String.raw`
import stat,types
def denied(fn):
    try:fn()
    except p.ProvisionError:return
    raise AssertionError('unexpected success')
for uid,gid,mode in [(1000,0,0o700),(0,1000,0o700),(0,0,0o777),(0,0,0o1700)]:
    denied(lambda:p.directory_metadata(types.SimpleNamespace(st_mode=stat.S_IFDIR|mode,st_uid=uid,st_gid=gid)))
for uid,gid,mode,links in [(1000,0,0o600,1),(0,1000,0o600,1),(0,0,0o644,1),(0,0,0o600,2)]:
    denied(lambda:p.file_metadata(types.SimpleNamespace(st_mode=stat.S_IFREG|mode,st_uid=uid,st_gid=gid,st_nlink=links,st_size=3),0o600,10))
for args in [[],['--apply'],['--apply','--approval','a','--approval','b','--bundle','c'],
    ['--apply','--approval','a','--approval-sha256','b','--destination','c']]:denied(lambda:p.main(args))
# Explicit root/process double: environment rejection must precede input reads.
p.sys.platform='linux'
for name in ['getuid','geteuid','getgid','getegid']:setattr(p.os,name,lambda:0)
def forbidden(*_):raise AssertionError('input read before environment guard')
p.load_inputs=forbidden
p.os.environ.clear();p.os.environ.update({'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','NODE_OPTIONS':'--require=untrusted'})
denied(lambda:p.main(['--check','--approval','/root/approval','--approval-sha256','a'*64,'--bundle','/root/bundle']))
`);
  assert.equal(result.status, 0, result.stderr);
  const source = await readFile(modulePath, 'utf8');
  assert.doesNotMatch(source, /subprocess|os\.system|importlib|exec\(/u);
  assert.match(source, /renameat2/u);
  assert.match(source, /sys\.dont_write_bytecode/u);
});

test('actual directory-chain algorithm reaffirms every parent on retry after mkdir succeeds but fsync fails (host observation doubles)', () => {
  const result = probe(String.raw`
import posixpath,stat,types
from unittest.mock import patch
safe=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=0,st_gid=0)
tree={'/':safe,'/opt':safe};events=[];failed=[False]
def lstat(directory):
    if directory not in tree:raise FileNotFoundError(directory)
    return tree[directory]
def mkdir(directory,mode):
    assert mode==0o700
    assert directory not in tree
    tree[directory]=safe;events.append(('mkdir',directory))
def sync(directory):
    events.append(('sync',directory))
    if directory=='/opt' and not failed[0]:
        failed[0]=True;raise p.ProvisionError('injected_parent_fsync_failure')
target='/opt/ownerinc/lib/payload-candidate'
with patch.object(p.os,'path',posixpath),patch.object(p.os,'lstat',lstat),patch.object(p.os,'mkdir',mkdir),patch.object(p,'sync_directory',sync):
    try:p.directories(target,create=True)
    except p.ProvisionError as error:assert str(error)=='injected_parent_fsync_failure'
    else:raise AssertionError('missing failure injection')
    assert '/opt/ownerinc' in tree,'mkdir must succeed before the injected failure'
    events.clear()
    p.directories(target,create=True);events.append(('complete',target))
    assert [value for action,value in events if action=='sync']==['/','/opt','/opt/ownerinc','/opt/ownerinc/lib'],events
    assert ('mkdir','/opt/ownerinc') not in events,'retry must not repair/recreate existing entries'
    assert events.index(('sync','/opt')) < events.index(('complete',target))
    events.clear();p.directories(target,create=True)
    assert events==[('sync',directory) for directory in ['/','/opt','/opt/ownerinc','/opt/ownerinc/lib']]
    events.clear();p.directories(target,missing=True);assert events==[],'check must never mkdir or fsync'
    tree['/opt/ownerinc']=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o777,st_uid=0,st_gid=0)
    try:p.directories(target,create=True)
    except p.ProvisionError as error:assert str(error)=='unsafe_directory'
    else:raise AssertionError('unsafe existing directory repaired or accepted')
    assert tree['/opt/ownerinc'].st_mode==stat.S_IFDIR|0o777
`);
  assert.equal(result.status, 0, result.stderr);
});
