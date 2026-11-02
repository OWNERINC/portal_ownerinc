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
    sentinel=os.path.join(base,'observer-executed')
    observer='ops/payload-production-observer.py'
    content[observer]=('import pathlib;pathlib.Path('+repr(sentinel)+').write_text("executed")\n').encode()
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
    assert not os.path.exists(sentinel)
    for label,mutate in [
        ('missing-observer',lambda value:value['source']['files'].pop(observer)),
        ('extra-hash',lambda value:value['source']['files'].update({'extra':'0'*64}))]:
        changed=copy.deepcopy(approval);mutate(changed);changed_raw=(json.dumps(changed)+'\n').encode()
        changed_path=os.path.join(base,label+'.json');write(changed_path,changed_raw,0o600)
        denied(lambda:p.provision_preparation('apply',changed_path,p.sha(changed_raw),bundle),'invalid_shape')
        assert not os.path.lexists(p.PREPARATION_APPROVAL) and not os.path.exists(sentinel)
    before_observer=content[observer];write(bundle+'/'+observer,b'altered after approval\n',p.preparation_mode(observer))
    denied(lambda:p.provision_preparation('apply',*args),'preparation_source_mismatch')
    assert not os.path.lexists(p.PREPARATION_APPROVAL) and not os.path.exists(sentinel)
    write(bundle+'/'+observer,before_observer,p.preparation_mode(observer))
    observer_target=p.preparation_target(observer);write(observer_target,b'conflicting observer bytes\n',p.preparation_mode(observer))
    denied(lambda:p.provision_preparation('apply',*args),'destination_conflict')
    assert not os.path.lexists(p.PREPARATION_APPROVAL) and not os.path.exists(sentinel)
    os.unlink(observer_target)
    original_publish=p.publish;events=[]
    def interrupted(name,expected):
        if name==p.PREPARATION_APPROVAL:raise OSError('interruption-before-approval')
        original_publish(name,expected);events.append(name)
    p.publish=interrupted;denied(lambda:p.provision_preparation('apply',*args))
    assert not os.path.lexists(p.PREPARATION_APPROVAL)
    assert all(os.path.lexists(p.preparation_target(name)) for name in p.PREPARATION_FILES)
    assert not os.path.exists(sentinel)
    def observe(name,expected):original_publish(name,expected);events.append(name)
    p.publish=observe;events.clear();p.provision_preparation('apply',*args)
    assert events[-1]==p.PREPARATION_APPROVAL
    assert not os.path.exists(sentinel)
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
p.rotation_approval=forbidden
p.os.environ.clear();p.os.environ.update({'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','NODE_OPTIONS':'--require=untrusted'})
denied(lambda:p.main(['--check','--approval','/root/approval','--approval-sha256','a'*64,'--bundle','/root/bundle']))
denied(lambda:p.main(['--profile','policy-rotation','--check','--approval','/root/approval','--approval-sha256','a'*64,'--bundle','/root/bundle']))
`);
  assert.equal(result.status, 0, result.stderr);
  const source = await readFile(modulePath, 'utf8');
  assert.doesNotMatch(source, /subprocess|os\.system|importlib/u);
  assert.doesNotMatch(source.slice(0, source.indexOf('def provision_b0_acceptance')), /exec\(/u);
  assert.match(source, /sha\(launcher_raw\) == approval\['source'\]\['files'\]\['ops\/prepare-cms-authenticated.py'\][\s\S]*exec\(compile\(launcher_raw/u);
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

const rotationApproval = {
  schemaVersion: 1, kind: 'ownerinc-payload-policy-rotation-approval-v1', environment: 'production',
  repository: 'OWNERINC/portal_ownerinc', repositoryId: '1308080511',
  workflow: '.github/workflows/ci.yml', workflowId: '317709204', rotationId: '1'.repeat(64),
  issuedAt: 1000, expiresAt: 4600, fromPolicySha256: '2'.repeat(64), toPolicySha256: '3'.repeat(64),
  candidate: { commit: '4'.repeat(40), runId: '41379393576', runAttempt: '1',
    approvalSha256: '5'.repeat(64), inventoryIdentity: '6'.repeat(64) },
  targetRevision: { commit: '4'.repeat(40), workflowSha256: '7'.repeat(64) },
};

test('rotation approval is closed, strictly typed, officially scoped and limited to a one-hour window', () => {
  const mutations = [
    a => { a.extra = 1; }, a => { delete a.rotationId; }, a => { a.schemaVersion = true; },
    a => { a.kind = 'ownerinc-payload-trust-provisioning-v1'; }, a => { a.environment = 'staging'; },
    a => { a.repository = 'elsewhere/repo'; }, a => { a.repositoryId = '123'; },
    a => { a.workflow = 'ci.yml'; }, a => { a.workflowId = '456'; },
    a => { a.rotationId = 'A'.repeat(64); }, a => { a.rotationId += '\n'; },
    a => { a.issuedAt = true; }, a => { a.expiresAt = false; }, a => { a.issuedAt = '1000'; },
    a => { a.expiresAt = '4600'; }, a => { a.issuedAt = 1000.5; }, a => { a.expiresAt = 4600.5; },
    a => { a.expiresAt = a.issuedAt; }, a => { a.expiresAt = a.issuedAt - 1; },
    a => { a.expiresAt = a.issuedAt + 3601; }, a => { a.fromPolicySha256 = a.toPolicySha256; },
    a => { a.fromPolicySha256 = 'bad'; }, a => { a.toPolicySha256 = 'F'.repeat(64); },
    a => { a.candidate.extra = 1; }, a => { delete a.candidate.inventoryIdentity; },
    a => { a.candidate.commit = 'main'; }, a => { a.candidate.commit = 'a'.repeat(40); },
    a => { a.candidate.runId = '01'; }, a => { a.candidate.runId = '1'.repeat(21); },
    a => { a.candidate.runId = 123; }, a => { a.candidate.runAttempt = '0'; },
    a => { a.candidate.runAttempt = '1\n'; }, a => { a.candidate.approvalSha256 = null; },
    a => { a.candidate.inventoryIdentity = 'bad'; }, a => { a.targetRevision.extra = 1; },
    a => { delete a.targetRevision.workflowSha256; }, a => { a.targetRevision.workflowSha256 = 'bad'; },
  ];
  const corpus = [rotationApproval, ...mutations.map(mutate => {
    const value = structuredClone(rotationApproval); mutate(value); return value;
  })];
  const result = probe(String.raw`
import json,sys
results=[]
for value in json.load(sys.stdin):
    try:p.validate_rotation_approval(value);results.append(True)
    except p.ProvisionError:results.append(False)
try:p.validate_rotation_approval(p.strict_json(b'{"schemaVersion":1,"schemaVersion":1}'))
except p.ProvisionError as error:assert str(error)=='duplicate_field'
else:raise AssertionError('duplicate accepted')
print(json.dumps(results))
`, JSON.stringify(corpus));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [true, ...mutations.map(() => false)]);
});

const rotationFixture = String.raw`
from unittest.mock import patch
import contextlib,io,time
def setup_rotation(label,native=False):
    inputs=setup(label);policy=inputs[3]
    policy['repositoryId']='1308080511';policy['workflowId']='317709204'
    if native:
        filename=os.path.realpath('/usr/bin/python3')
        policy['toolchain']['executables']['python']={'path':filename,'sha256':p.sha(p.read_protected(filename,0o755,p.MAX_BINARY))}
    before=(json.dumps(policy,indent=2)+'\n').encode()
    write(inputs[2]+'/production-policy.json',before,0o600)
    bootstrap=(json.dumps({'schemaVersion':1,'kind':'ownerinc-payload-trust-provisioning-v1',
        'policySha256':p.sha(before),'toolchain':policy['toolchain']})+'\n').encode()
    write(inputs[0],bootstrap,0o600)
    # Seed an already installed closure. Bootstrap behavior is covered above;
    # rotation must not execute bundle data or re-provision any of these files.
    for relative in (*p.TOOL_FILES,'bin/git-remote-https'):
        write(p.TOOL_ROOT+'/'+relative,pathlib.Path(inputs[2]+'/'+relative).read_bytes(),
            0o755 if relative.endswith('.py') or relative.startswith('bin/') else 0o644)
    write(p.POLICY_PATH,before,0o600)
    for name in ('records','work','incoming','trust-snapshots'):os.makedirs(p.STATE_ROOT+'/'+name,mode=0o700)
    target=copy.deepcopy(policy);target['approvedRevisions']=[{'commit':'4'*40,'workflowSha256':'7'*64}]
    after=(json.dumps(target,indent=4)+'\n').encode();bundle=os.path.dirname(inputs[2])+'/rotation-bundle'
    write(bundle+'/production-policy.json',after,0o600)
    now=int(time.time())
    approval={'schemaVersion':1,'kind':'ownerinc-payload-policy-rotation-approval-v1','environment':'production',
        'repository':'OWNERINC/portal_ownerinc','repositoryId':'1308080511','workflow':'.github/workflows/ci.yml','workflowId':'317709204',
        'rotationId':'1'*64,'issuedAt':now-10,'expiresAt':now+3590,'fromPolicySha256':p.sha(before),'toPolicySha256':p.sha(after),
        'candidate':{'commit':'4'*40,'runId':'41379393576','runAttempt':'1','approvalSha256':'5'*64,'inventoryIdentity':'6'*64},
        'targetRevision':copy.deepcopy(target['approvedRevisions'][0])}
    item={'approval':approval,'before':before,'after':after,'path':os.path.dirname(inputs[0])+'/rotation.json','bundle':bundle,
        'snapshot':p.STATE_ROOT+'/trust-snapshots/policy-rotation-'+approval['rotationId'],'oldPolicy':policy,'newPolicy':target}
    save_rotation(item)
    return item
def save_rotation(item):
    raw=(json.dumps(item['approval'],indent=2)+'\n').encode();write(item['path'],raw,0o600)
    item['raw']=raw;item['args']=(item['path'],p.sha(raw),item['bundle'])
def rotate(item,mode='apply'):return p.provision_policy_rotation(mode,*item['args'])
def rotation_denied(fn,code,attempted=False):
    try:fn()
    except p.RotationError as error:
        assert str(error)==code,(str(error),code,error.report)
        assert error.report['replacementAttempted'] is attempted,error.report
        assert error.report['deploymentAuthorized'] is False
        return error.report
    raise AssertionError('unexpected rotation success')
def readonly(fn):
    mutations=[];real_open=os.open
    def forbidden(*args,**kwargs):mutations.append(args);raise AssertionError('read-only action tried mutation')
    def checked_open(filename,flags,*args,**kwargs):
        if flags & (os.O_CREAT|os.O_TRUNC|os.O_WRONLY|os.O_RDWR|os.O_APPEND):forbidden(filename,flags)
        return real_open(filename,flags,*args,**kwargs)
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(os,'open',checked_open))
        for name in ('mkdir','fsync','fchmod','chmod','rename','replace','unlink','rmdir'):
            stack.enter_context(patch.object(os,name,forbidden))
        for name in ('publish','rotation_stage','sync_directory'):
            stack.enter_context(patch.object(p,name,forbidden))
        try:return fn()
        finally:assert mutations==[],mutations
def seed_prestate(item,complete=False):
    os.mkdir(item['snapshot'],0o700)
    manifest={'schemaVersion':1,'kind':'ownerinc-payload-policy-rotation-prestate-v1','rotationId':item['approval']['rotationId'],
        'approvalSha256':p.sha(item['raw']),'fromPolicySha256':p.sha(item['before']),'toPolicySha256':p.sha(item['after'])}
    # Deliberately noncanonical bytes: completion must hash this raw representation.
    raw=(json.dumps(manifest,indent=3)+' \n').encode()
    for name,data in [('approval.json',item['raw']),('policy.before.json',item['before']),('policy.after.json',item['after']),('manifest.json',raw)]:
        write(item['snapshot']+'/'+name,data,0o600)
    if complete:
        completion={'schemaVersion':1,'kind':'ownerinc-payload-policy-rotation-completion-v1','rotationId':item['approval']['rotationId'],
            'manifestSha256':p.sha(raw),'activePolicySha256':p.sha(item['after'])}
        write(item['snapshot']+'/completion.json',(json.dumps(completion)+'\n').encode(),0o600)
    return raw
`;

const rotationDoubles = String.raw`
# Portable suite: ownership/POSIX doubles inherited from filesystem above.
# Lease and interpreter identity are explicit doubles, NOT native lock proof.
class LeaseDouble:
    def __enter__(self):
        self.path=p.STATE_ROOT+'/records';self.token=p.rotation_directory_identity(self.path,private=True)
        self.empty_at_exit=False;return self
    def verify(self,empty=False):
        p.require(self.token==p.rotation_directory_identity(self.path,private=True),'rotation_context_changed')
        if empty:p.require(not os.listdir(self.path),'rotation_registry_not_empty')
    def __exit__(self,*_):self.verify(empty=self.empty_at_exit)
p.RotationLease=LeaseDouble
p.verify_rotation_interpreter=lambda policy:None
`;

test('fresh rotation check is mutation-free; expiry, policy deltas, bundle, closure and all registry entries fail closed (ownership/lease doubles)', () => {
  const result = probe(filesystem + rotationFixture + rotationDoubles + String.raw`
try:
    item=setup_rotation('fresh');before=inventory();report=readonly(lambda:rotate(item,'check'))
    assert report['eligible'] and not report['mutated'] and not report['deploymentAuthorized']
    assert not report['ciProvenanceChecked'] and not report['liveRuntimeChecked'] and not report['candidateAuthorizationRenewed']
    assert all(report[key] is False for key in ('networkUsed','githubAuthenticated','bundleCodeExecuted','liveInventoryChecked'))
    assert inventory()==before and not os.path.lexists(item['snapshot'])
    readonly(lambda:rotation_denied(lambda:p.provision_policy_rotation('check',item['path'],'0'*64,item['bundle']),'approval_digest_mismatch'))
    for label,now in [('future',item['approval']['issuedAt']-1),('expired',item['approval']['expiresAt'])]:
        with patch.object(p.time,'time',return_value=now):
            readonly(lambda:rotation_denied(lambda:rotate(item,'check'),'rotation_approval_not_current'))
    with patch.object(p.time,'time',return_value=item['approval']['issuedAt']):assert readonly(lambda:rotate(item,'check'))['eligible']
    for label,mutate,code in [
        ('extra-revision',lambda v:v['approvedRevisions'].append({'commit':'8'*40,'workflowSha256':'9'*64}),'rotation_delta_not_allowed'),
        ('wrong-target-workflow',lambda v:v['approvedRevisions'][0].update(workflowSha256='8'*64),'rotation_delta_not_allowed'),
        ('tool-file-change',lambda v:v['toolchain']['files'].update({p.TOOL_FILES[0]:'9'*64}),'rotation_delta_not_allowed'),
        ('tool-executable-change',lambda v:v['toolchain']['executables']['gitRemoteHttps'].update(sha256='9'*64),'rotation_delta_not_allowed'),
        ('wrong-repository-id',lambda v:v.update(repositoryId='123'),'rotation_policy_mismatch'),
        ('wrong-workflow-id',lambda v:v.update(workflowId='456'),'rotation_policy_mismatch'),
        ('bytes-only',lambda v:v.update(approvedRevisions=copy.deepcopy(item['oldPolicy']['approvedRevisions'])),'rotation_delta_not_allowed')]:
        item=setup_rotation(label);value=copy.deepcopy(item['newPolicy']);mutate(value)
        after=json.dumps(value).encode();write(item['bundle']+'/production-policy.json',after,0o600)
        item['approval']['toPolicySha256']=p.sha(after);save_rotation(item);before=inventory()
        readonly(lambda:rotation_denied(lambda:rotate(item),code));assert inventory()==before
        assert not os.path.lexists(item['snapshot'])
    item=setup_rotation('already-approved')
    old=copy.deepcopy(item['oldPolicy']);old['approvedRevisions'].append(item['approval']['targetRevision'])
    raw=json.dumps(old).encode();write(p.POLICY_PATH,raw,0o600);item['approval']['fromPolicySha256']=p.sha(raw);save_rotation(item)
    readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_delta_not_allowed'))
    item=setup_rotation('extra-bundle');write(item['bundle']+'/.extra',b'x',0o600)
    readonly(lambda:rotation_denied(lambda:rotate(item),'unexpected_bundle_entry'))
    item=setup_rotation('source-drift');write(p.POLICY_PATH,item['before']+b' ',0o600)
    readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_policy_mismatch'))
    for relative in p.TOOL_FILES:
        item=setup_rotation('file-'+str(p.TOOL_FILES.index(relative)))
        write(p.TOOL_ROOT+'/'+relative,b'drift',0o755 if relative.endswith('.py') else 0o644)
        readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_closure_mismatch'))
    for role in ('node','git','python','gitRemoteHttps'):
        item=setup_rotation('executable-'+role);write(item['oldPolicy']['toolchain']['executables'][role]['path'],b'drift',0o755)
        readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_closure_mismatch'))
    for name in ('record.json','.pending','.hidden','directory'):
        item=setup_rotation('registry-'+name.replace('.','-'));filename=p.STATE_ROOT+'/records/'+name
        if name=='directory':os.mkdir(filename,0o700)
        else:write(filename,b'do-not-delete',0o600)
        readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_registry_not_empty'))
        assert os.path.lexists(filename) and not os.path.lexists(item['snapshot'])
    for name in ('records','trust-snapshots'):
        item=setup_rotation('missing-'+name);os.rmdir(p.STATE_ROOT+'/'+name)
        readonly(lambda:rotation_denied(lambda:rotate(item),'missing_directory'))
        assert not os.path.lexists(p.STATE_ROOT+'/'+name)
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('consumed checks classify snapshot and active policy independently, before freshness/bundle/closure gates, with zero mutation (ownership/lease doubles)', () => {
  const result = probe(filesystem + rotationFixture + rotationDoubles + String.raw`
try:
    keys={'schemaVersion','kind','status','code','rotationId','eligible','approvalFresh','snapshotState','activePolicy',
        'observedPolicySha256','mutated','deploymentAuthorized'}
    for state in ('partial','prestate-valid','completion-recorded','conflict','unsafe'):
        for active in ('from','to','other','unknown'):
            item=setup_rotation(state+'-'+active)
            if state=='partial':os.mkdir(item['snapshot'],0o700)
            elif state=='unsafe':write(item['snapshot'],b'not-a-directory',0o600)
            else:
                seed_prestate(item,state=='completion-recorded')
                if state=='conflict':write(item['snapshot']+'/manifest.json',b'{}',0o600)
            if active=='to':write(p.POLICY_PATH,item['after'],0o600)
            if active=='other':write(p.POLICY_PATH,b'not-json-but-protected',0o600)
            if active=='unknown':os.unlink(p.POLICY_PATH)
            shutil.rmtree(item['bundle']);os.unlink(p.TOOL_ROOT+'/'+p.TOOL_FILES[0])
            write(p.STATE_ROOT+'/records/.unwrapped-writer',b'preserved',0o600)
            before=inventory()
            with patch.object(p.time,'time',return_value=item['approval']['expiresAt']), \
                 patch.object(p,'verify_rotation_closure',side_effect=AssertionError('consumed check read closure')), \
                 patch.object(p,'rotation_inputs',side_effect=AssertionError('consumed check loaded bundle')):
                report=readonly(lambda:rotate(item,'check'))
            assert set(report)==keys and report['schemaVersion']==1
            assert report['kind']=='ownerinc-payload-policy-rotation-check-v1' and report['status']=='consumed'
            assert report['snapshotState']==state and report['activePolicy']==active,report
            assert report['approvalFresh'] is False and report['eligible'] is False and report['mutated'] is False
            assert report['deploymentAuthorized'] is False
            expected={'unsafe':'rotation_evidence_unsafe','conflict':'rotation_evidence_conflict'}.get(state,'rotation_id_consumed')
            assert report['code']==expected
            observed=None if active=='unknown' else p.sha(pathlib.Path(p.POLICY_PATH).read_bytes())
            assert report['observedPolicySha256']==observed and inventory()==before
            readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'))
    # CLI must return exit 2 for the observational JSON, even with missing bundle
    # and policy. Root/environment here are explicitly process doubles.
    with patch.object(p.sys,'platform','linux'),patch.dict(os.environ,{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},clear=True),contextlib.ExitStack() as stack:
        for name in ('getuid','geteuid','getgid','getegid'):stack.enter_context(patch.object(os,name,return_value=0,create=True))
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            status=readonly(lambda:p.main(['--profile','policy-rotation','--check','--approval',item['path'],
                '--approval-sha256',item['args'][1],'--bundle',item['bundle']]))
        assert status==2 and json.loads(output.getvalue())['status']=='consumed'
    readonly(lambda:rotation_denied(lambda:p.provision_policy_rotation('check',item['path'],'0'*64,item['bundle']),'approval_digest_mismatch'))
    item['approval']['extra']=True;save_rotation(item)
    readonly(lambda:rotation_denied(lambda:rotate(item,'check'),'invalid_shape'))
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('consumed evidence rejects raw cross-binding conflicts and invalid completion instead of ignoring them (ownership/lease doubles)', () => {
  const result = probe(filesystem + rotationFixture + rotationDoubles + String.raw`
try:
    cases=[('approval.json',lambda raw:raw+b' '),('policy.before.json',lambda raw:raw+b' '),('policy.after.json',lambda raw:raw+b' '),
        ('manifest.json',lambda raw:raw.replace(b'"schemaVersion": 1',b'"schemaVersion": true')),
        ('manifest.json',lambda raw:raw.replace(b'"rotationId": "'+b'1'*64+b'"',b'"rotationId": "'+b'9'*64+b'"')),
        ('manifest.json',lambda raw:raw.replace(b'"approvalSha256": "',b'"approvalSha256": "0')),
        ('manifest.json',lambda raw:raw.replace(b'"fromPolicySha256": "',b'"fromPolicySha256": "0')),
        ('manifest.json',lambda raw:raw.replace(b'"toPolicySha256": "',b'"toPolicySha256": "0')),
        ('completion.json',lambda raw:raw+b'junk'),
        ('completion.json',lambda raw:raw.replace(b'"schemaVersion": 1',b'"schemaVersion": true')),
        ('completion.json',lambda raw:raw.replace(b'"manifestSha256": "',b'"manifestSha256": "0')),
        ('completion.json',lambda raw:raw.replace(b'"activePolicySha256": "',b'"activePolicySha256": "0')),
        ('completion.json',lambda raw:raw.replace(b'"rotationId": "',b'"rotationId": "0'))]
    for index,(name,mutate) in enumerate(cases):
        item=setup_rotation('binding-'+str(index));seed_prestate(item,True)
        filename=item['snapshot']+'/'+name;write(filename,mutate(pathlib.Path(filename).read_bytes()),0o600)
        report=readonly(lambda:rotate(item,'check'));assert report['snapshotState']=='conflict',(name,report)
        assert report['activePolicy']=='from'
    item=setup_rotation('raw-manifest');seed_prestate(item,True)
    manifest=item['snapshot']+'/manifest.json';raw=pathlib.Path(manifest).read_bytes()
    write(manifest,json.dumps(json.loads(raw)).encode(),0o600)
    assert readonly(lambda:rotate(item,'check'))['snapshotState']=='conflict','must hash raw manifest, not reconstructed JSON'
    for name in ('approval.json','policy.before.json','policy.after.json','manifest.json'):
        item=setup_rotation('missing-'+name);seed_prestate(item,True);os.unlink(item['snapshot']+'/'+name)
        assert readonly(lambda:rotate(item,'check'))['snapshotState']=='conflict'
    item=setup_rotation('unexpected');seed_prestate(item);write(item['snapshot']+'/.rotation-pending-retained',b'partial',0o600)
    assert readonly(lambda:rotate(item,'check'))['snapshotState']=='conflict'
    item=setup_rotation('unsafe-completion');seed_prestate(item);os.mkdir(item['snapshot']+'/completion.json',0o700)
    assert readonly(lambda:rotate(item,'check'))['snapshotState']=='unsafe'
    item=setup_rotation('single-use');seed_prestate(item)
    item['approval']['issuedAt']+=10;item['approval']['expiresAt']+=10;save_rotation(item)
    assert readonly(lambda:rotate(item,'check'))['snapshotState']=='conflict'
    readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'))
    # Partial evidence still has to obey bindings already observable on its own.
    for side in ('before','after'):
        item=setup_rotation('partial-conflict-'+side);os.mkdir(item['snapshot'],0o700)
        policy=copy.deepcopy(item['oldPolicy'] if side=='before' else item['newPolicy'])
        policy['approvedRevisions']=[item['approval']['targetRevision']] if side=='before' else item['oldPolicy']['approvedRevisions']
        raw=json.dumps(policy).encode();item['approval']['fromPolicySha256' if side=='before' else 'toPolicySha256']=p.sha(raw)
        save_rotation(item);write(item['snapshot']+'/policy.'+side+'.json',raw,0o600)
        assert readonly(lambda:rotate(item,'check'))['snapshotState']=='conflict'
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('rotation apply atomically replaces only policy, retains exact evidence, and cannot resume or reaffirm a consumed ID (ownership/lease doubles)', () => {
  const result = probe(filesystem + rotationFixture + rotationDoubles + String.raw`
try:
    item=setup_rotation('success');before=inventory();inode=os.stat(p.POLICY_PATH).st_ino
    report=rotate(item)
    assert report['status']=='completed' and report['activePolicySha256']==p.sha(item['after']) and not report['deploymentAuthorized']
    assert not report['ciProvenanceChecked'] and not report['liveRuntimeChecked'] and not report['candidateAuthorizationRenewed']
    assert all(report[key] is False for key in ('networkUsed','githubAuthenticated','bundleCodeExecuted','liveInventoryChecked'))
    assert pathlib.Path(p.POLICY_PATH).read_bytes()==item['after'] and os.stat(p.POLICY_PATH).st_ino!=inode
    assert set(os.listdir(item['snapshot']))=={'approval.json','policy.before.json','policy.after.json','manifest.json','completion.json'}
    for name,data in [('approval.json',item['raw']),('policy.before.json',item['before']),('policy.after.json',item['after'])]:
        assert pathlib.Path(item['snapshot']+'/'+name).read_bytes()==data
    manifest=pathlib.Path(item['snapshot']+'/manifest.json').read_bytes();completion=json.loads(pathlib.Path(item['snapshot']+'/completion.json').read_bytes())
    assert completion['manifestSha256']==p.sha(manifest) and completion['activePolicySha256']==p.sha(item['after'])
    policy_relative=str(pathlib.Path(p.POLICY_PATH).relative_to(root))
    for name,raw in before.items():
        if name!=policy_relative:assert inventory()[name]==raw,name
    assert readonly(lambda:rotate(item,'check'))['snapshotState']=='completion-recorded'
    assert readonly(lambda:rotate(item,'check'))['activePolicy']=='to'
    readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'))
    item['approval']['issuedAt']+=60;item['approval']['expiresAt']+=60;save_rotation(item)
    readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'))
    assert readonly(lambda:rotate(item,'check'))['snapshotState']=='conflict'
    assert list(pathlib.Path(root).rglob('__pycache__'))==[]
    item=setup_rotation('reservation-race');mkdir=os.mkdir;collisions=[]
    def raced(name,*args,**kwargs):
        if name==item['snapshot']:
            mkdir(name,0o700);collisions.append(name)
        return mkdir(name,*args,**kwargs)
    with patch.object(os,'mkdir',raced):rotation_denied(lambda:rotate(item),'rotation_id_consumed')
    assert collisions==[item['snapshot']] and os.listdir(item['snapshot'])==[]
    assert pathlib.Path(p.POLICY_PATH).read_bytes()==item['before']
    readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'))
    item=setup_rotation('report-output-fault')
    # Only process identity/environment and stdout are doubled; apply still does
    # real filesystem writes. Losing stdout after replacement is not a preswap failure.
    with patch.object(p.sys,'platform','linux'),patch.dict(os.environ,{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},clear=True),contextlib.ExitStack() as stack:
        for name in ('getuid','geteuid','getgid','getegid'):stack.enter_context(patch.object(os,name,return_value=0,create=True))
        with patch('builtins.print',side_effect=OSError('injected stdout failure')):
            report=rotation_denied(lambda:p.main(['--profile','policy-rotation','--apply','--approval',item['path'],
                '--approval-sha256',item['args'][1],'--bundle',item['bundle']]),'rotation_reconciliation_required',True)
        assert report['cause']=='report_output_failed' and pathlib.Path(p.POLICY_PATH).read_bytes()==item['after']
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('injected rotation failures retain single-use evidence across reservation, each publication, staging, swap, completion and final lease boundaries (ownership/lease doubles)', () => {
  const result = probe(filesystem + rotationFixture + rotationDoubles + String.raw`
try:
    cases=[('mkdir-before','mkdir',False,False),('mkdir-after','mkdir',True,False),
        ('reservation-fsync','reservation-sync',False,False),('staging-fsync','staging-fsync',False,False),
        ('preswap-read','preswap',False,False),('replace-before','replace',False,True),('replace-after','replace',True,True),
        ('policy-parent-fsync','policy-sync',False,True),('postverify','closure-3',False,True),
        ('final-check','closure-4',False,True),('lease-finalization','lease-exit',False,True)]
    for name in ('approval.json','policy.before.json','policy.after.json','manifest.json','completion.json'):
        for after in (False,True):cases.append((name+('-after' if after else '-before'),'publish-'+name,after,name=='completion.json'))
    for label,point,after,attempted in cases:
        item=setup_rotation(label);hit=[];counts={};originals={name:getattr(p,name) for name in
            ('rotation_publish_evidence','rotation_stage','rotation_inputs','replace_rotation_policy','sync_directory','verify_rotation_closure')}
        def fail():hit.append(point);raise OSError('injected syscall/publication failure, NOT power-loss evidence')
        def around(fn,args):
            if not after:fail()
            result=fn(*args);fail();return result
        with contextlib.ExitStack() as stack:
            if point=='mkdir':
                real=os.mkdir
                def mkdir(name,*args,**kwargs):
                    if name==item['snapshot']:
                        if not after:fail()
                        real(name,*args,**kwargs);fail()
                    return real(name,*args,**kwargs)
                stack.enter_context(patch.object(os,'mkdir',mkdir))
            elif point in ('reservation-sync','policy-sync'):
                def sync(name):
                    if name==(p.STATE_ROOT+'/trust-snapshots' if point=='reservation-sync' else os.path.dirname(p.POLICY_PATH)):fail()
                    return originals['sync_directory'](name)
                stack.enter_context(patch.object(p,'sync_directory',sync))
            elif point.startswith('publish-'):
                def publish(name,raw):
                    if os.path.basename(name)==point[len('publish-'):]:return around(originals['rotation_publish_evidence'],(name,raw))
                    return originals['rotation_publish_evidence'](name,raw)
                stack.enter_context(patch.object(p,'rotation_publish_evidence',publish))
            elif point=='staging-fsync':
                def stage(parent,raw):
                    if parent==os.path.dirname(p.POLICY_PATH):
                        with patch.object(os,'fsync',side_effect=lambda fd:fail()):return originals['rotation_stage'](parent,raw)
                    return originals['rotation_stage'](parent,raw)
                stack.enter_context(patch.object(p,'rotation_stage',stage))
            elif point=='preswap':
                def inputs(*args):
                    counts['inputs']=counts.get('inputs',0)+1
                    if counts['inputs']==2:fail()
                    return originals['rotation_inputs'](*args)
                stack.enter_context(patch.object(p,'rotation_inputs',inputs))
            elif point=='replace':stack.enter_context(patch.object(p,'replace_rotation_policy',side_effect=lambda name:around(originals['replace_rotation_policy'],(name,))))
            elif point.startswith('closure-'):
                def closure(policy):
                    counts['closure']=counts.get('closure',0)+1
                    if counts['closure']==int(point[-1]):fail()
                    return originals['verify_rotation_closure'](policy)
                stack.enter_context(patch.object(p,'verify_rotation_closure',closure))
            elif point=='lease-exit':stack.enter_context(patch.object(LeaseDouble,'__exit__',side_effect=lambda *_:fail()))
            stack.enter_context(patch.object(p,'publish',side_effect=AssertionError('rotation used resumable publish')))
            stack.enter_context(patch.object(p,'snapshot_prestate',side_effect=AssertionError('rotation used UUID prestate')))
            stack.enter_context(patch.object(os,'unlink',side_effect=AssertionError('rotation cleaned retained evidence')))
            report=rotation_denied(lambda:rotate(item),'rotation_reconciliation_required' if attempted else 'rotation_preswap_io_failed',attempted)
        assert hit==[point],(label,hit,report)
        swapped=attempted and not (point=='replace' and not after)
        assert pathlib.Path(p.POLICY_PATH).read_bytes()==(item['after'] if swapped else item['before']),label
        assert report['phase']==('swap-attempted' if attempted else ('reservation-attempted' if point in ('mkdir','reservation-sync') else 'reserved'))
        if os.path.lexists(item['snapshot']):
            before=inventory();readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'));assert inventory()==before
            observed=readonly(lambda:rotate(item,'check'))
            assert observed['activePolicy']==('to' if swapped else 'from'),(label,observed)
            if point in ('staging-fsync','preswap') or (point=='replace' and not after):
                assert list(pathlib.Path(os.path.dirname(p.POLICY_PATH)).glob('.rotation-pending-*')),label
        else:assert label=='mkdir-before','uncertain attempted IDs also need the external issuance/attempt ledger'
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('preswap reauthentication and final rechecks reject input, tool, evidence, registry, policy and clock drift (ownership/lease doubles; injected drift)', () => {
  const result = probe(filesystem + rotationFixture + rotationDoubles + String.raw`
try:
    for point,code in [('approval','approval_digest_mismatch'),('bundle','rotation_policy_mismatch'),
        ('policy','rotation_policy_mismatch'),('tool','rotation_closure_mismatch'),('https','rotation_closure_mismatch'),
        ('evidence','rotation_evidence_conflict'),('registry','rotation_registry_not_empty'),('clock','rotation_approval_not_current')]:
        item=setup_rotation('drift-'+point);stage=p.rotation_stage;clock=p.time.time;hit=[]
        def changed(parent,raw):
            temporary=stage(parent,raw)
            if parent==os.path.dirname(p.POLICY_PATH):
                hit.append(point)
                if point=='approval':write(item['path'],item['raw']+b' ',0o600)
                if point=='bundle':write(item['bundle']+'/production-policy.json',item['after']+b' ',0o600)
                if point=='policy':write(p.POLICY_PATH,item['before']+b' ',0o600)
                if point=='tool':write(p.TOOL_ROOT+'/'+p.TOOL_FILES[0],b'drift',0o755)
                if point=='https':write(item['oldPolicy']['toolchain']['executables']['gitRemoteHttps']['path'],b'drift',0o755)
                if point=='evidence':write(item['snapshot']+'/approval.json',item['raw']+b' ',0o600)
                if point=='registry':write(p.STATE_ROOT+'/records/.pending',b'preserved',0o600)
                if point=='clock':p.time.time=lambda:item['approval']['expiresAt']
            return temporary
        try:
            with patch.object(p,'rotation_stage',changed):rotation_denied(lambda:rotate(item),code)
        finally:p.time.time=clock
        assert hit==[point] and os.path.isdir(item['snapshot'])
        assert pathlib.Path(p.POLICY_PATH).read_bytes()==item['before']+(b' ' if point=='policy' else b'')
    # Time can cross expiry DURING closure hashing, after rotation_inputs passed.
    item=setup_rotation('last-freshness');verify=p.verify_rotation_closure;clock=p.time.time;calls=[]
    def expire(policy):
        verify(policy);calls.append(1)
        if len(calls)==2:p.time.time=lambda:item['approval']['expiresAt']
    try:
        with patch.object(p,'verify_rotation_closure',expire):rotation_denied(lambda:rotate(item),'rotation_approval_not_current')
    finally:p.time.time=clock
    assert len(calls)==2 and pathlib.Path(p.POLICY_PATH).read_bytes()==item['before']
    for point in ('policy','registry','tool','snapshot'):
        item=setup_rotation('final-'+point);publish=p.rotation_publish_evidence
        def changed(name,raw):
            publish(name,raw)
            if name.endswith('/completion.json'):
                if point=='policy':write(p.POLICY_PATH,item['before'],0o600)
                if point=='registry':write(p.STATE_ROOT+'/records/.late',b'preserved',0o600)
                if point=='tool':write(p.TOOL_ROOT+'/'+p.TOOL_FILES[0],b'late-drift',0o755)
                if point=='snapshot':write(item['snapshot']+'/policy.before.json',b'late-drift',0o600)
        with patch.object(p,'rotation_publish_evidence',changed):rotation_denied(lambda:rotate(item),'rotation_reconciliation_required',True)
        assert os.path.isfile(item['snapshot']+'/completion.json'),'historical receipt cannot override final failure'
finally:shutil.rmtree(root)
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

const nativeRotationOptions = {
  skip: process.env.PAYLOAD_REQUIRE_NATIVE_TRUST !== '1' && (process.platform !== 'linux' || process.getuid?.() !== 0),
};
function nativeRotationFixture() {
  assert.equal(process.platform, 'linux', 'required native rotation qualification cannot skip a non-Linux host');
  for (const method of ['getuid', 'geteuid', 'getgid', 'getegid']) assert.equal(process[method](), 0);
  const fixture = filesystem
    .replace(/^root=tempfile\.mkdtemp\(.+$/mu, "root=tempfile.mkdtemp(prefix='trust-rotation-',dir='/root')")
    .replace(/original_metadata=p\.file_metadata[\s\S]*?(?=def write\()/u, '');
  assert.doesNotMatch(fixture, /p\.(?:file_metadata|directory_metadata|identity|canonical_path|directories|sync_directory|rename_noreplace)\s*=|os\.(?:fsync|open|fchmod)\s*=/u);
  return fixture + rotationFixture;
}

test('native rotation directory flock excludes independent contenders and survives cooperative Node-child lifetime; unwrapped writer is explicitly NOT excluded', nativeRotationOptions, t => {
  const result = probe(nativeRotationFixture() + String.raw`
import subprocess,sys,fcntl
child=None
try:
    item=setup_rotation('lease',native=True);records=p.STATE_ROOT+'/records'
    contender="""import os,sys,fcntl
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
    try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:print('busy')
    else:print('acquired')
finally:os.close(fd)
"""
    def contend(expected):
        result=subprocess.run([sys.executable,'-I','-S','-B','-c',contender,records],capture_output=True,text=True,check=True,timeout=5)
        assert result.stdout.strip()==expected,result.stdout
    contend('acquired')
    with p.RotationLease() as lease:
        lease.verify(empty=True);contend('busy')
        readonly(lambda:rotation_denied(lambda:rotate(item,'check'),'rotation_lock_busy'))
        # Actual Node child, inert fixture (not the production registrar). The
        # parent and child both hold the SAME open-file description, before Node
        # starts. Closing the parent must not unlock the child's reference.
        script="""const fs=require('node:fs');const fd=Number(process.argv[1]);
const a=fs.fstatSync(fd,{bigint:true}),b=fs.lstatSync(process.argv[2],{bigint:true});
if(a.ino!==b.ino||a.dev!==b.dev)process.exit(3);
process.stdout.write('held\\n');process.stdin.once('data',()=>process.exit(0));process.stdin.resume();"""
        child=subprocess.Popen([` + JSON.stringify(process.execPath) + String.raw`,'-e',script,str(lease.fd),records],
            pass_fds=(lease.fd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        assert child.stdout.readline().strip()=='held'
        contend('busy')
    contend('busy')
    output,error=child.communicate('release',timeout=5);assert child.returncode==0,error;child=None
    contend('acquired')
    # A direct, unwrapped root writer ignores advisory flock. This is a positive
    # demonstration of the limitation, never claimed as enforcement.
    with p.RotationLease() as lease:
        subprocess.run([sys.executable,'-I','-S','-B','-c',
            "import os,sys;fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(fd,b'unwrapped');os.close(fd)",
            records+'/.unwrapped'],check=True,timeout=5)
        denied(lambda:lease.verify(empty=True),'rotation_registry_not_empty')
        assert pathlib.Path(records+'/.unwrapped').read_bytes()==b'unwrapped'
    os.unlink(records+'/.unwrapped')
    def replace_lease_path():
        with p.RotationLease() as lease:
            os.rename(records,records+'.retained');os.mkdir(records,0o700)
            denied(lambda:lease.verify(),'rotation_context_changed')
    denied(replace_lease_path,'rotation_context_changed')
    assert os.path.isdir(records+'.retained')
    os.rmdir(records);os.rename(records+'.retained',records);contend('acquired')
    os.chmod(records,0o755);denied(lambda:p.RotationLease().__enter__(),'unsafe_directory');os.chmod(records,0o700)
    os.symlink(item['path'],records+'/.linked')
    with p.RotationLease() as lease:denied(lambda:lease.verify(empty=True),'rotation_registry_not_empty')
    print(json.dumps({'kind':'native-rotation-lease-proof','checks':['independent-flock','node-child-lifetime',
        'unwrapped-writer-not-excluded','descriptor-path-drift','private-directory','all-registry-entries']}))
finally:
    if child is not None:child.kill();child.communicate(timeout=5)
    shutil.rmtree(root)
`, undefined, true);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'native-rotation-lease-proof', checks: ['independent-flock',
    'node-child-lifetime', 'unwrapped-writer-not-excluded', 'descriptor-path-drift', 'private-directory', 'all-registry-entries'] });
  t.diagnostic(result.stdout.trim());
});

test('native rotation CLI performs real atomic replacement under concurrent readers with root metadata, ordered fsync and read-only consumed inspection', nativeRotationOptions, t => {
  const result = probe(nativeRotationFixture() + String.raw`
import subprocess,sys
reader=None
try:
    item=setup_rotation('atomic',native=True);inode=os.stat(p.POLICY_PATH).st_ino;events=[]
    originals={name:getattr(p,name) for name in ('file_metadata','directory_metadata','read_protected','rotation_stage',
        'rotation_publish_evidence','replace_rotation_policy','sync_directory','RotationLease')}
    cli=['--profile','policy-rotation','--check','--approval',item['path'],'--approval-sha256',item['args'][1],'--bundle',item['bundle']]
    before=inventory();output=io.StringIO()
    with contextlib.redirect_stdout(output):assert readonly(lambda:p.main(cli))==0
    assert json.loads(output.getvalue())['eligible'] is True and inventory()==before
    reader_code="""import hashlib,json,select,sys
filename,old,new=sys.argv[1:];counts={old:0,new:0}
def sample():
    with open(filename,'rb') as stream:raw=stream.read()
    digest=hashlib.sha256(raw).hexdigest()
    assert digest in counts,'partial/missing/unexpected policy observed'
    counts[digest]+=1
sample();print('ready',flush=True)
while not select.select([sys.stdin],[],[],0)[0]:sample()
sys.stdin.read(1);sample();print(json.dumps(counts),flush=True)
"""
    reader=subprocess.Popen([sys.executable,'-I','-S','-B','-c',reader_code,p.POLICY_PATH,p.sha(item['before']),p.sha(item['after'])],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    assert reader.stdout.readline().strip()=='ready'
    def observe(frame,event,arg):
        if event=='call' and frame.f_code is p.rotation_publish_evidence.__code__:
            events.append(('publish',os.path.basename(frame.f_locals['filename'])))
        if event=='call' and frame.f_code is p.replace_rotation_policy.__code__:
            assert frame.f_back.f_locals['phase']=='swap-attempted'
            assert set(os.listdir(item['snapshot']))=={'approval.json','policy.before.json','policy.after.json','manifest.json'}
            assert p.read_protected(p.POLICY_PATH,0o600,p.MAX_JSON)==item['before']
            events.append(('replace',p.POLICY_PATH))
        if event=='c_return' and arg is os.mkdir and frame.f_code is p.provision_policy_rotation.__code__:
            events.append(('reserve',frame.f_locals['snapshot']))
        if event=='c_return' and arg is os.fsync:
            fd=frame.f_locals.get('fd',frame.f_locals.get('descriptor'))
            assert fd is not None,frame.f_code.co_name
            events.append(('fsync',os.readlink('/proc/self/fd/'+str(fd))))
        if event=='call' and frame.f_code is p.verify_rotation_closure.__code__:events.append(('closure','verify'))
    cli[2]='--apply';output=io.StringIO();sys.setprofile(observe)
    try:
        with contextlib.redirect_stdout(output):assert p.main(cli)==0
    finally:sys.setprofile(None)
    result,error=reader.communicate('x',timeout=5);assert reader.returncode==0,error;reader=None
    counts=json.loads(result);assert counts[p.sha(item['before'])]>=1 and counts[p.sha(item['after'])]>=1,counts
    report=json.loads(output.getvalue());assert report['status']=='completed' and not report['deploymentAuthorized']
    swap=events.index(('replace',p.POLICY_PATH));completion=events.index(('publish','completion.json'))
    reserve=events.index(('reserve',item['snapshot']));parent_sync=events.index(('fsync',p.STATE_ROOT+'/trust-snapshots'))
    assert reserve<parent_sync<events.index(('publish','approval.json'))<events.index(('publish','manifest.json'))<swap
    policy_sync=events.index(('fsync',os.path.dirname(p.POLICY_PATH)));assert swap<policy_sync<completion
    assert sum(event==('closure','verify') for event in events[:swap])==2
    assert sum(event==('closure','verify') for event in events[swap:completion])==1
    assert sum(event==('closure','verify') for event in events[completion:])==1
    assert any(event=='fsync' and name.startswith(os.path.dirname(p.POLICY_PATH)+'/.rotation-pending-') for event,name in events[:swap])
    assert any(event=='fsync' and name==item['snapshot'] for event,name in events[completion:])
    assert os.stat(p.POLICY_PATH).st_ino!=inode and p.read_protected(p.POLICY_PATH,0o600,p.MAX_JSON)==item['after']
    for name in [p.POLICY_PATH,*[item['snapshot']+'/'+name for name in os.listdir(item['snapshot'])]]:
        info=os.lstat(name);assert (info.st_uid,info.st_gid,info.st_nlink,stat.S_IMODE(info.st_mode))==(0,0,1,0o600)
    snapshot=os.lstat(item['snapshot']);assert (snapshot.st_uid,snapshot.st_gid,stat.S_IMODE(snapshot.st_mode))==(0,0,0o700)
    assert all(getattr(p,name) is original for name,original in originals.items())
    shutil.rmtree(item['bundle']);os.unlink(p.TOOL_ROOT+'/'+p.TOOL_FILES[0]);cli[2]='--check';output=io.StringIO()
    before=inventory()
    with contextlib.redirect_stdout(output):assert readonly(lambda:p.main(cli))==2
    observed=json.loads(output.getvalue());assert observed['snapshotState']=='completion-recorded' and observed['activePolicy']=='to'
    assert inventory()==before
    readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'))
    print(json.dumps({'kind':'native-rotation-atomic-proof','checks':['clean-cli','concurrent-readers-old-or-new',
        'reservation-parent-fsync','evidence-before-swap','staged-file-fsync','policy-parent-fsync','completion-fsync',
        'final-closure-check','root-metadata','consumed-read-only','no-resume']}))
finally:
    if reader is not None:reader.kill();reader.communicate(timeout=5)
    shutil.rmtree(root)
`, undefined, true);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'native-rotation-atomic-proof', checks: ['clean-cli',
    'concurrent-readers-old-or-new', 'reservation-parent-fsync', 'evidence-before-swap', 'staged-file-fsync',
    'policy-parent-fsync', 'completion-fsync', 'final-closure-check', 'root-metadata', 'consumed-read-only', 'no-resume'] });
  t.diagnostic(result.stdout.trim());
});

test('native rotation protected evidence rejects unsafe links/owners; injected I/O failures retain pre/post-swap evidence without retry', nativeRotationOptions, t => {
  const result = probe(nativeRotationFixture() + String.raw`
try:
    for point in ('reservation-fsync','staged-fsync','replace-before','policy-parent-fsync','completion-fsync','lease-path-after-swap'):
        item=setup_rotation(point,native=True);sync=p.sync_directory;replace=p.replace_rotation_policy;stage=p.rotation_stage;hit=[]
        def fail():hit.append(point);raise OSError('injected fault; not actual power loss')
        with contextlib.ExitStack() as stack:
            if point in ('reservation-fsync','policy-parent-fsync','completion-fsync'):
                def interrupted(name):
                    if (point=='reservation-fsync' and name==p.STATE_ROOT+'/trust-snapshots') or \
                       (point=='policy-parent-fsync' and name==os.path.dirname(p.POLICY_PATH)) or \
                       (point=='completion-fsync' and name==item['snapshot'] and os.path.exists(name+'/completion.json')):fail()
                    return sync(name)
                stack.enter_context(patch.object(p,'sync_directory',interrupted))
            elif point=='staged-fsync':
                def interrupted(parent,raw):
                    if parent==os.path.dirname(p.POLICY_PATH):
                        with patch.object(os,'fsync',side_effect=lambda fd:fail()):return stage(parent,raw)
                    return stage(parent,raw)
                stack.enter_context(patch.object(p,'rotation_stage',interrupted))
            elif point=='replace-before':stack.enter_context(patch.object(p,'replace_rotation_policy',side_effect=lambda name:fail()))
            elif point=='lease-path-after-swap':
                def interrupted(name):
                    replace(name);hit.append(point)
                    os.rename(p.STATE_ROOT+'/records',p.STATE_ROOT+'/records.retained');os.mkdir(p.STATE_ROOT+'/records',0o700)
                stack.enter_context(patch.object(p,'replace_rotation_policy',interrupted))
            attempted=point not in ('reservation-fsync','staged-fsync')
            rotation_denied(lambda:rotate(item),'rotation_reconciliation_required' if attempted else 'rotation_preswap_io_failed',attempted)
        assert hit==[point],hit
        active='to' if point in ('policy-parent-fsync','completion-fsync','lease-path-after-swap') else 'from'
        assert pathlib.Path(p.POLICY_PATH).read_bytes()==item['after' if active=='to' else 'before']
        assert os.path.isdir(item['snapshot'])
        before=inventory();readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'));assert inventory()==before
        observed=readonly(lambda:rotate(item,'check'));assert observed['activePolicy']==active
        expected='partial' if point=='reservation-fsync' else ('completion-recorded' if point=='completion-fsync' else 'prestate-valid')
        assert observed['snapshotState']==expected,(point,observed)
    for unsafe in ('symlink','hardlink','owner','group','mode'):
        item=setup_rotation('unsafe-'+unsafe,native=True);seed_prestate(item,True);filename=item['snapshot']+'/completion.json'
        if unsafe=='symlink':os.unlink(filename);os.symlink(item['path'],filename)
        if unsafe=='hardlink':os.link(filename,filename+'.linked')
        if unsafe=='owner':os.chown(filename,65534,0)
        if unsafe=='group':os.chown(filename,0,65534)
        if unsafe=='mode':os.chmod(filename,0o644)
        observed=readonly(lambda:rotate(item,'check'));assert observed['snapshotState']=='unsafe' and observed['activePolicy']=='from'
        readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'))
    item=setup_rotation('unsafe-active',native=True);seed_prestate(item);os.link(p.POLICY_PATH,p.POLICY_PATH+'.linked')
    observed=readonly(lambda:rotate(item,'check'));assert observed['activePolicy']=='unknown' and observed['observedPolicySha256'] is None
    item=setup_rotation('symlink-reservation',native=True);os.symlink(item['bundle'],item['snapshot'])
    readonly(lambda:rotation_denied(lambda:rotate(item),'rotation_id_consumed'))
    assert readonly(lambda:rotate(item,'check'))['snapshotState']=='unsafe'
    print(json.dumps({'kind':'native-rotation-fault-proof','faults':'injected-not-power-loss',
        'checks':['reservation-fsync','staged-fsync','replace-attempt-boundary','policy-parent-fsync','completion-fsync',
            'lease-after-swap','evidence-retained','no-reconciliation-on-retry','unsafe-completion','unsafe-active','symlink-consumed']}))
finally:shutil.rmtree(root)
`, undefined, true);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'native-rotation-fault-proof', faults: 'injected-not-power-loss',
    checks: ['reservation-fsync', 'staged-fsync', 'replace-attempt-boundary', 'policy-parent-fsync', 'completion-fsync',
      'lease-after-swap', 'evidence-retained', 'no-reconciliation-on-retry', 'unsafe-completion', 'unsafe-active', 'symlink-consumed'] });
  t.diagnostic(result.stdout.trim());
});
