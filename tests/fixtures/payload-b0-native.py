"""Native root CLI/lease/trust/journal exercise; Docker/PG are explicit doubles.

Invoked only by the native test wrapper in a disposable /root directory. Never
use this fixture for operations or claim its synthetic dump is restore evidence.
Downstream container health/protocol observations are doubles too: reaching a
synthetic installed-private result does not qualify real private installation,
the protocol/readiness relationship, or either production recovery path.
"""
import copy
import fcntl
import gzip
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import time
import types

repo, root, model_file = map(pathlib.Path, sys.argv[1:])
assert sys.platform == 'linux' and os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0
assert root.parent == pathlib.Path('/root') and root.name.startswith('payload-b0-native-')
os.chmod(root, 0o700)
prefixes = {p: str(root) + p for p in ('/opt/ownerinc', '/etc/ownerinc', '/var/lib/ownerinc', '/usr/local/libexec')}


def redirect(raw):
    for old, new in prefixes.items():
        raw = raw.replace(old.encode(), new.encode())
    return raw


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, raw, mode=0o600, owner=(0, 0)):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    path.chmod(mode)
    os.chown(path, *owner)


def load(path):
    module = types.ModuleType('native_fixture_' + str(path))
    module.__file__ = str(path)
    exec(compile(pathlib.Path(path).read_bytes(), str(path), 'exec'), module.__dict__)
    return module


# Every subprocess launcher also refuses real production roots and networking.
audit = b'''
import sys as _audit_sys, os as _audit_os
def _fixture_audit(event, args):
    if event.startswith('socket.'):
        raise RuntimeError('native fixture cannot use network')
    if event == 'open' and isinstance(args[0], (str, bytes)):
        target = _audit_os.path.realpath(_audit_os.fsdecode(args[0]))
        for prefix in ('/opt/ownerinc', '/etc/ownerinc', '/var/lib/ownerinc', '/usr/local/libexec'):
            if target == prefix or target.startswith(prefix + '/'):
                raise RuntimeError('native fixture touched real production root')
_audit_sys.addaudithook(_fixture_audit)
'''
exec(audit)
source = load(repo / 'ops/prepare-cms-authenticated.py')
captured = {name: redirect((repo / name).read_bytes()) for name in source.FILES}
launcher = prefixes['/usr/local/libexec'] + '/ownerinc-payload-prepare.py'
prep = prefixes['/opt/ownerinc'] + '/lib/payload-preparation'
runtime_dir = prefixes['/opt/ownerinc'] + '/apps/portal-ownerinc-real/runtime'
model_path = str(root / 'docker-observations.json')
fault_path = str(root / 'interrupt-migration')
clock_path = str(root / 'clock.json')

# Reuse the explicit Docker observation model, not its filesystem/FD9 seams.
# In this fixture the actual Runtime constructor, proc FD9, writes, fsyncs,
# protected ancestry and authenticated child launcher all execute unchanged.
adapter = '\n' + model_file.read_text() + f'''
from types import SimpleNamespace
import io
S = STATE
project = 'ownerinc-portal-prod'
_fixture_model_path = {model_path!r}
_fixture_fault_path = {fault_path!r}
_fixture_clock_path = {clock_path!r}
if os.path.exists(_fixture_clock_path):
    _fixture_epoch = json.load(open(_fixture_clock_path))
    time = SimpleNamespace(**{{**vars(time), 'time': lambda: _fixture_epoch}})
    STATE.time = time
model = object.__new__(Model)
model.__dict__.update(json.load(open(_fixture_model_path)))
images = model.images
model.tar_plain = model.tar(False)
model.tar_gzip = model.tar(True)
model.fail_command = None
def _fixture_save():
    data = {{key:value for key,value in model.__dict__.items()
             if key not in ('tar_plain','tar_gzip','fail_command')}}
    with open(_fixture_model_path, 'w') as stream: json.dump(data, stream)
def _fixture_run(args, **kwargs):
    if args[:2] == ['docker','start'] or args[:2] == ['docker','stop']:
        container = next(c for c in model.containers.values() if c['Id'] == args[-1])
        assert container is model.containers['cms']
        container['State']['Status'] = 'running' if args[1] == 'start' else 'exited'
        model.commands.append(args)
        output = b''
    elif args[:3] == ['docker','inspect','--format'] and args[3] in ('{{{{.State.Status}}}}', '{{{{.State.Status}}}} {{{{.State.Health.Status}}}}'):
        container = next(c for c in model.containers.values() if c['Id'] == args[-1])
        output = container['State']['Status'].encode()
        if 'Health' in args[3]: output += b' healthy'
    else:
        if 'compose' in args and args[-1] == 'migrate' and os.path.exists(_fixture_fault_path):
            # Model an ambiguous migration start after the real pending append.
            model.commands.append(args); _fixture_save()
            return SimpleNamespace(returncode=2, stdout=b'', stderr=b'fixture interruption')
        try: return model.run(args, **kwargs)
        finally: _fixture_save()
    _fixture_save()
    return SimpleNamespace(returncode=0, stdout=output.decode() if kwargs.get('text') else output, stderr=b'')
def _fixture_popen(args, **kwargs):
    assert args[0] == 'docker' and 'tar' in args
    return SimpleNamespace(stdout=io.BytesIO(model.tar_plain), wait=lambda timeout=None:0, kill=lambda:None)
subprocess = SimpleNamespace(**{{**vars(subprocess), 'run':_fixture_run, 'Popen':_fixture_popen}})
_psql_json = model.psql
_database_identity = lambda service,database: {{'systemIdentifier':'123456','databaseOid':'16384' if database=='portal' else '16385','databaseName':database}}
_data_fingerprint = lambda *args,**kwargs:'1'*64
'''
captured['ops/payload-control-runtime.py'] += adapter.encode()
captured['ops/prepare-cms-authenticated.py'] = audit + captured['ops/prepare-cms-authenticated.py']
clock_seam = f'''
if os.path.exists({clock_path!r}):
    _fixture_epoch = json.load(open({clock_path!r}))
    time = types.SimpleNamespace(**{{**vars(time), 'time': lambda: _fixture_epoch}})
'''
captured['ops/prepare-cms-authenticated.py'] = captured['ops/prepare-cms-authenticated.py'].replace(
    b"if __name__ == '__main__':", clock_seam.encode() + b"\nif __name__ == '__main__':")
debug_file=str(root/'private-fixture-failure.txt')
marker=b'        # Neither imported validator exceptions nor paths/private bytes are public.'
assert captured['ops/prepare-cms-authenticated.py'].count(marker)==1
debug=f"        import traceback\n        with open({debug_file!r}, 'w') as _debug: traceback.print_exc(file=_debug)\n".encode()
captured['ops/prepare-cms-authenticated.py']=captured['ops/prepare-cms-authenticated.py'].replace(marker,debug+marker)
captured['ops/payload-receiver-admission.py'] = audit + captured['ops/payload-receiver-admission.py'].replace(
    b"if __name__ == '__main__':", b'import json, types\n' + clock_seam.encode() + b"\nif __name__ == '__main__':")
captured['ops/provision-payload-candidate-trust.py'] = audit + captured['ops/provision-payload-candidate-trust.py']
for name, raw in captured.items():
    write(launcher if name == 'ops/prepare-cms-authenticated.py' else prep + '/' + name,
          raw, 0o644 if name.endswith(('.yaml', '.yml')) else 0o755)
# Exercise the real root shell's fixed isolated interpreter/one-argument hop.
write(prefixes['/usr/local/libexec']+'/payload-receiver-admission.py',
      captured['ops/payload-receiver-admission.py'],0o755)
l = load(launcher)
p = load(prep + '/ops/provision-payload-candidate-trust.py')
tools = {name: redirect((repo / name).read_bytes()) for name in p.TOOL_FILES}
for name, raw in tools.items():
    write(p.TOOL_ROOT + '/' + name, raw, 0o755 if name.endswith('.py') else 0o644)
v = load(p.TOOL_ROOT + '/ops/payload-candidate-verifier.py')
executables = {'python': os.path.realpath(sys.executable), 'node': str(root / 'node'),
               'git': str(root / 'git'), 'gitRemoteHttps': p.TOOL_ROOT + '/bin/git-remote-https'}
for role, path in executables.items():
    if role != 'python':
        write(path, b'fixture-only executable identity, never executed\n', 0o755)
policy = {'schemaVersion': 1, 'kind': 'ownerinc-payload-candidate-policy-v1', 'environment': 'production',
          'repository': 'OWNERINC/portal_ownerinc', 'repositoryId': '123', 'workflow': '.github/workflows/ci.yml',
          'workflowId': '456', 'approvedRevisions': [{'commit': 'a'*40, 'workflowSha256': 'b'*64}],
          'toolchain': {'files': {name: sha(raw) for name, raw in tools.items()},
                       'executables': {role: {'path': path, 'sha256': sha(pathlib.Path(path).read_bytes())}
                                       for role, path in executables.items()}}}
write(p.POLICY_PATH, canonical(policy))
images = {name: 'ghcr.io/ownerinc/ownerinc-portal-' + name + '@sha256:' + 'c'*64 for name in ('api','cron','cms')}
entries = {'.ci-commit': b'a'*40+b'\n', '.ci-images': ('\n'.join(images.values())+'\n').encode(),
           'docker-compose.yml': b'services: {}\n', 'docker-compose.payload.yml': b'services: {}\n',
           'scripts/do-not-execute.py': b'raise AssertionError("candidate code execution")\n'}
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w') as archive:
    for name, data in entries.items():
        entry = tarfile.TarInfo(name); entry.size = len(data); archive.addfile(entry, io.BytesIO(data))
archive_raw = gzip.compress(buffer.getvalue(), mtime=0)
inv = l.load_authenticated(captured['ops/payload-control-inventory.py'], prep+'/ops/payload-control-inventory.py')
config = inv.production_inventory(l.HOST_ROOT,l.RUNTIME,l.RELEASES,l.HOST_ROOT+'/current-release',l.LOCK,
    prefixes['/opt/ownerinc']+'/backups/portal-ownerinc/daily',l.PRODUCTION_BACKUP,l.PRODUCTION_BACKUP+'/restore-protection',
    l.ENVIRONMENT,l.RUNTIME+'/compose.production.yaml',l.RUNTIME+'/compose.payload.production.yaml','portal')
for path in [l.RUNTIME,l.RELEASES,*config['paths']['backupRoots']]:
    pathlib.Path(path).mkdir(parents=True, exist_ok=True); os.chmod(path, 0o755)
source_release = l.RELEASES + '/' + '2'*40
compose = b'services: {}\n'
write(source_release+'/.image-env', ('API_IMAGE='+images['api']+'\nCRON_IMAGE='+images['cron']+'\n').encode())
write(source_release+'/docker-compose.yml', compose, 0o644)
write(l.RUNTIME+'/compose.production.yaml', compose, 0o644)
write(l.RUNTIME+'/compose.payload.production.yaml', b'services: {}\n', 0o644)
write(l.HOST_ROOT+'/current-release', (source_release+'\n').encode())
write(l.ENVIRONMENT,b'POSTGRES_DB=portal\nCMS_PORTAL_DATABASE_NAME=portal\n',owner=(1000,1000))
write(l.LOCK,b'fixture lease\n')
write(l.RUNTIME+'/payload-control-inventory.json', inv.canonical(config)+b'\n')
s = l.load_state_captured(captured, inv)
s.initialize(l.RUNTIME, inv.identity(config))

# Initialize only observation data. Subsequent invocations read/write it across
# real interpreter boundaries, independently of the real signed journal.
namespace = {'io': io, 'os': os, 'json': json, 'hashlib': hashlib, 'images': images,
             'project': config['project'], 'S': s, 'SimpleNamespace': types.SimpleNamespace}
exec(model_file.read_text(), namespace)
model = object.__new__(namespace['Model'])
model.__dict__.update(root=str(root),runtime=l.RUNTIME,config=config,images=images,commands=[],granted=False,
                      roles=False,native=False,unsafe_roles=False,volumes={},containers={})
for key in ('portalPostgres','portalUploads'): model.create_volume(key,{})
for service in ('postgres','api','cron'): model.create_container(service,{},'running')
write(model_path, canonical(model.__dict__))
approval = {'schemaVersion':1,'kind':'ownerinc-payload-preparation-approval-v1','environment':'production',
    'repository':'OWNERINC/portal_ownerinc','source':{'commit':'1'*40,'files':{n:sha(raw) for n,raw in captured.items()}},
    'hostBaseline':{'currentCommit':'2'*40,'legacyImages':{n:images[n] for n in ('api','cron')},
      'releaseComposeSha256':sha(compose),'runtimeComposeSha256':sha(compose),'releaseOverrideSha256':None,
      'inventoryIdentity':inv.identity(config),'installedPredecessors':{'commonReceiver':'6'*64,'receiverHelper':None,
        'productionWrapper':None,'operationsGuard':None,'cmsCandidate':None}},'admission':{}}
record = {'schemaVersion':2,'kind':'payload-candidate-admission-record-v2','environment':'production',
    'repository':'OWNERINC/portal_ownerinc','repositoryId':'123','workflow':'.github/workflows/ci.yml','workflowId':'456',
    'workflowSha256':'b'*64,'commit':'a'*40,'runId':'789','runAttempt':'1','images':images,
    'artifacts':{role:{'id':str(i+1),'digest':'sha256:'+'d'*64} for i,role in enumerate(v.ROLES)},
    'qualificationContract':v.PRODUCTION_CONTRACT,'sourceTreeSha':'e'*40,'archiveBytes':len(archive_raw),
    'archiveSha256':sha(archive_raw),'deploymentAuthorized':False,'policySha256':sha(canonical(policy)),
    'authorization':{'environment':'production','approvalSha256':l.approval_binding_digest(approval),
      'inventoryIdentity':inv.identity(config),'expiresAt':str(int(time.time())+120),'nonce':'9'*64}}
for field in ('candidateSha256','qualifiedManifestSha256','recoveryReportSha256','sourceArchiveSha256'): record[field]='f'*64
approval['admission'] = {'policySha256':record['policySha256'],'archiveSha256':record['archiveSha256'],'recordSha256':sha(canonical(record))}
write(l.APPROVAL,canonical(approval))
pathlib.Path(v.REGISTRY).mkdir(parents=True,mode=0o700)
write(v.REGISTRY+'/'+record['archiveSha256']+'.'+record['policySha256']+'.json',canonical(record))
receiver = l.load_authenticated(captured['ops/payload-receiver-admission.py'],prep+'/ops/payload-receiver-admission.py')
receipt_id = 'payload-abcdefgh'; receipt = receiver.INCOMING+'/'+receipt_id
pathlib.Path(receipt+'/release').mkdir(parents=True,mode=0o700);os.chmod(receipt,0o700)
write(receipt+'/candidate.tar.gz',archive_raw)
for name, data in entries.items(): write(receipt+'/release/'+name,data,0o644)
request = {key:record[key] for key in ('commit','runId','runAttempt','images','authorization')}
request.update(artifactIds={r:e['id'] for r,e in record['artifacts'].items()},
    artifactDigests={r:e['digest'] for r,e in record['artifacts'].items()},
    contentDigests={'candidate':record['candidateSha256'],'qualified':record['qualifiedManifestSha256'],'report':record['recoveryReportSha256']})
write(receipt+'/admission.json',canonical(v.verify_candidate(receipt+'/candidate.tar.gz',request)))


def cli(flag, selected=receipt_id, ok=True):
    result = subprocess.run(['/usr/bin/python3','-I','-S','-B',launcher,flag,selected],
        env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},capture_output=True,timeout=60,start_new_session=True)
    assert result.returncode == (0 if ok else 2), (flag,result.returncode,result.stdout,result.stderr,
        pathlib.Path(debug_file).read_text() if pathlib.Path(debug_file).exists() else 'no fixture traceback')
    return json.loads(result.stdout) if ok else result


def journal():
    return {p.name:p.read_bytes() for p in pathlib.Path(l.RUNTIME+'/payload-control-state').iterdir()}


def resume_fields(selected):
    return [selected['commit'],selected['runId'],selected['runAttempt'],
        *[selected['images'][service] for service in ('api','cron','cms')],
        *[selected['artifacts'][role]['id'] for role in ('candidate','qualified','report')],
        *[selected['artifacts'][role]['digest'] for role in ('candidate','qualified','report')],
        selected['candidateSha256'],selected['qualifiedManifestSha256'],selected['recoveryReportSha256'],
        *[selected['authorization'][key] for key in ('approvalSha256','inventoryIdentity','expiresAt','nonce')]]


def resume_command(fields=None, selected_receipt=receipt_id):
    return 'production:payload-resume-v3 '+selected_receipt+' '+' '.join(fields or resume_fields(record))


def transport(command, ok=False):
    result=subprocess.run(['/bin/bash','-p',prep+'/ops/payload-receiver-root.sh',command],
        env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},stdin=subprocess.DEVNULL,
        capture_output=True,timeout=60,start_new_session=True)
    assert result.returncode==(0 if ok else 2),(result.returncode,result.stdout,result.stderr,
        pathlib.Path(debug_file).read_text() if pathlib.Path(debug_file).exists() else 'no fixture traceback')
    return json.loads(result.stdout) if ok else result


def protected_snapshot():
    # Includes directory identities to expose publication even if bytes match.
    result={}
    for base in (l.RUNTIME,l.RELEASES,receiver.INCOMING,receiver.NONCES,v.REGISTRY):
        for path in [pathlib.Path(base),*pathlib.Path(base).rglob('*')]:
            info=path.lstat()
            result[str(path)]=(info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,
                info.st_mtime_ns,info.st_ctime_ns,path.read_bytes() if path.is_file() else None)
    return result


def provision(mode='--apply', digest=None, ok=True):
    result=subprocess.run(['/usr/bin/python3','-I','-S','-B',prep+'/ops/provision-payload-candidate-trust.py',
        '--profile','b0-acceptance',mode,'--approval',str(root/'decision.json'),
        '--approval-sha256',digest or sha(canonical(decision)),'--bundle',str(root/'evidence')],
        env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},capture_output=True,timeout=60)
    assert result.returncode == (0 if ok else 2),(result.returncode,result.stdout,result.stderr)


write(receipt+'/preflight.json',canonical(cli('--check-install-plan')))
pathlib.Path(receiver.NONCES).mkdir(parents=True,mode=0o700)
nonce_marker=receiver.NONCES+'/'+record['authorization']['nonce']
write(nonce_marker,(record['authorization']['expiresAt']+'\n').encode())
before=journal();cli('--apply-install',ok=False);assert journal()==before
held=cli('--capture-b0');assert held['status']=='held-reserved' and held['cmsStatus']=='cold'
reserved=journal();assert cli('--capture-b0')==held and journal()==reserved
commands=json.loads(pathlib.Path(model_path).read_bytes())['commands']
assert not any('migrate' in c or 'cms-provision' in c or 'up' in c for c in commands)
cli('--apply-install',ok=False);assert journal()==reserved
# Captured executable bytes are authenticated on every fresh invocation.
runtime_source=pathlib.Path(prep+'/ops/payload-control-runtime.py')
runtime_raw=runtime_source.read_bytes();write(runtime_source,runtime_raw+b'\n',0o755)
cli('--capture-b0',ok=False);assert journal()==reserved
write(runtime_source,runtime_raw,0o755)
# Receipt archive replacement cannot be authorized by an unchanged sidecar.
write(receipt+'/candidate.tar.gz',archive_raw+b'substitution')
cli('--capture-b0',ok=False);assert journal()==reserved
write(receipt+'/candidate.tar.gz',archive_raw)
# Actual inherited root child rejects a different receipt before Runtime starts.
with l.deployment_lease() as reaffirm:
    denied=subprocess.run(['/usr/bin/python3','-I','-S','-B',launcher,'--execute-capture','payload-ijklmnop'],
        env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},pass_fds=(9,),capture_output=True,timeout=60)
    assert denied.returncode==2 and journal()==reserved
    reaffirm()
# Real lease contention; capture must not change journal or take a new lease.
fd=os.open(l.LOCK,os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
try: cli('--capture-b0',ok=False);assert journal()==reserved
finally: os.close(fd)
# Same candidate under another receipt must not substitute its identity.
import shutil
other=receiver.INCOMING+'/payload-ijklmnop';shutil.copytree(receipt,other)
cli('--capture-b0','payload-ijklmnop',ok=False);assert journal()==reserved
proof=pathlib.Path(held['binding']['b0']['directory'])
original=(proof/'postgres.dump').read_bytes();write(proof/'postgres.dump',original+b'drift')
cli('--capture-b0',ok=False);assert journal()==reserved
write(proof/'postgres.dump',original)
# A physical writer drift is still rejected with unchanged signed artifacts.
observed=json.loads(pathlib.Path(model_path).read_bytes())
drift=copy.deepcopy(observed);drift['containers']['api']['State']['Status']='running'
write(model_path,canonical(drift));cli('--capture-b0',ok=False);assert journal()==reserved
write(model_path,canonical(observed))
evidence=b'{"syntheticTestOnly":true,"restoreQualified":false}\n';procedure=b'Synthetic native gate test, not operational qualification.\n'
write(root/'evidence/qualification-evidence.json',evidence);write(root/'evidence/procedure.md',procedure)
accepted_at=int(time.time())
decision={'schemaVersion':1,'kind':'production-exact-b0-acceptance-v1',
    **{k:held[k] for k in ('installBindingSha256','originStateSha256','receiptId','manifestSha256')},
    'qualificationEvidenceSha256':sha(evidence),'procedureRevision':sha(procedure),
    'acceptedAt':accepted_at,'expiresAt':accepted_at+3600,
    'authenticatedChannel':'independently-authenticated-admin-vps'}
write(root/'decision.json',canonical(decision))
provision(digest='0'*64,ok=False);assert not pathlib.Path(l.B0_ACCEPTANCE).exists()
wrong=copy.deepcopy(decision);wrong['originStateSha256']='0'*64
write(root/'decision.json',canonical(wrong));provision(digest=sha(canonical(wrong)),ok=False)
write(root/'decision.json',canonical(decision));provision('--check');assert not pathlib.Path(l.B0_ACCEPTANCE).exists()
provision();provision();assert journal()==reserved
observed=json.loads(pathlib.Path(model_path).read_bytes())
drift=copy.deepcopy(observed);drift['containers']['api']['State']['Status']='running'
write(model_path,canonical(drift));cli('--accept-b0',ok=False);assert journal()==reserved
write(model_path,canonical(observed))
accepted=cli('--accept-b0');assert accepted['accepted'] and accepted['stage']=='reserved'
state_dir=pathlib.Path(l.RUNTIME+'/payload-control-state')
logs=sorted(state_dir.glob('[0-9]*.json'))
write(state_dir/'current.json',logs[-2].read_bytes())
interrupted=journal()
cli('--accept-b0','payload-ijklmnop',ok=False);assert journal()==interrupted
# ALL original workflow inputs, including every image, must be checked through
# the real root/receiver/preparer chain before even repairing this lagging head.
fields=resume_fields(record);assert len(fields)==len(receiver.FIELDS)==19
before=protected_snapshot()
for index,field in enumerate(receiver.FIELDS):
    changed=list(fields)
    if field in ('run-id','run-attempt','expires-at') or field.endswith('-artifact-id'):
        changed[index]=str(int(changed[index])+100)
    else:changed[index]=changed[index][:-1]+('0' if changed[index][-1]!='0' else '1')
    receiver.parse_resume_request(resume_command(changed))
    transport(resume_command(changed))
    assert protected_snapshot()==before,('resume input mutated protected state',field)
assert journal()==interrupted
# An independently registered alternative archive/record with the SAME nonce
# cannot substitute for the record pinned by preparation approval, even when its
# own receipt sidecar and all its client selectors agree with each other.
alternate=copy.deepcopy(record)
alternate['images']={service:image[:-64]+'8'*64 for service,image in images.items()}
alternate['candidateSha256']='7'*64
alternate_entries=dict(entries)
alternate_entries['.ci-images']=('\n'.join(alternate['images'].values())+'\n').encode()
buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode='w') as archive:
    for name,data in alternate_entries.items():
        entry=tarfile.TarInfo(name);entry.size=len(data);archive.addfile(entry,io.BytesIO(data))
alternate_archive=gzip.compress(buffer.getvalue(),mtime=0)
alternate.update(archiveSha256=sha(alternate_archive),archiveBytes=len(alternate_archive))
write(v.REGISTRY+'/'+alternate['archiveSha256']+'.'+alternate['policySha256']+'.json',canonical(alternate))
alternate_id='payload-qrstuvwx';alternate_receipt=receiver.INCOMING+'/'+alternate_id
shutil.copytree(receipt,alternate_receipt)
write(alternate_receipt+'/candidate.tar.gz',alternate_archive)
for name,data in alternate_entries.items():write(alternate_receipt+'/release/'+name,data,0o644)
alternate_request=copy.deepcopy(request)
alternate_request['images']=alternate['images'];alternate_request['contentDigests']['candidate']=alternate['candidateSha256']
write(alternate_receipt+'/admission.json',canonical(v.verify_candidate(alternate_receipt+'/candidate.tar.gz',alternate_request)))
assert alternate['authorization']['nonce']==record['authorization']['nonce']
before=protected_snapshot()
transport(resume_command(resume_fields(alternate),alternate_id))
transport(resume_command(fields,alternate_id))
assert protected_snapshot()==before and journal()==interrupted
# Original receipt/archive substitution also fails before repair, without relying
# on a different receipt ID to provide the rejection.
admitted_raw=pathlib.Path(receipt+'/admission.json').read_bytes()
write(receipt+'/candidate.tar.gz',alternate_archive)
write(receipt+'/admission.json',pathlib.Path(alternate_receipt+'/admission.json').read_bytes())
before=protected_snapshot();transport(resume_command());assert protected_snapshot()==before
write(receipt+'/candidate.tar.gz',archive_raw);write(receipt+'/admission.json',admitted_raw)
# Retain the old exclusive OFD while installing a safe-looking root-owned lock.
# Acquiring the replacement must never authorize repair of the old signed lease.
old_lock=l.LOCK+'.held-original';fd=os.open(l.LOCK,os.O_RDWR)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
os.rename(l.LOCK,old_lock);write(l.LOCK,b'fixture lease\n')
try:
    probe=os.open(old_lock,os.O_RDWR)
    try:
        try:fcntl.flock(probe,fcntl.LOCK_SH|fcntl.LOCK_NB)
        except BlockingIOError:pass
        else:raise AssertionError('old exclusive lock was lost')
    finally:os.close(probe)
    replacement=os.open(l.LOCK,os.O_RDWR)
    try:
        assert os.fstat(replacement).st_ino!=os.fstat(fd).st_ino
        fcntl.flock(replacement,fcntl.LOCK_EX|fcntl.LOCK_NB)
    finally:os.close(replacement)
    before=protected_snapshot()
    cli('--accept-b0',ok=False);transport(resume_command())
    assert journal()==interrupted and protected_snapshot()==before
finally:
    os.unlink(l.LOCK);os.rename(old_lock,l.LOCK);os.close(fd)
cli('--accept-b0')  # exact receipt repairs only the unique fully signed append
accepted_journal=journal();cli('--accept-b0');assert journal()==accepted_journal
wrong=copy.deepcopy(decision);wrong['qualificationEvidenceSha256']='0'*64
write(root/'decision.json',canonical(wrong));provision(digest=sha(canonical(wrong)),ok=False)
write(root/'decision.json',canonical(decision))
# Expiry at the first durable checkpoint, then an ambiguous command-start
# interruption and fresh-interpreter exact resume after both expirations.
write(clock_path,canonical(decision['expiresAt']))
cli('--apply-install',ok=False);assert journal()==accepted_journal
write(clock_path,canonical(decision['acceptedAt']+1));write(fault_path,b'interrupt\n')
cli('--apply-install',ok=False)
assert s.read_state(l.RUNTIME)[2]['installIntent']['stage']=='portal_grants_pending'
logs=sorted(state_dir.glob('[0-9]*.json'))
write(state_dir/'current.json',logs[-2].read_bytes())
os.unlink(fault_path);write(clock_path,canonical(decision['expiresAt']+1))
os.unlink(nonce_marker)  # Model the receiver's normal expired-marker reaping.
finished=transport(resume_command(),ok=True);assert finished['status']=='installed-private'
assert not pathlib.Path(nonce_marker).exists()
body=s.read_state(l.RUNTIME)[2]
assert body['installIntent']['stage']=='floor_committed' and body['admission']=='closed' and body['workerHold'] is True
assert body['authority']=={'mode':'legacy','epoch':1}
final_journal=journal();cli('--accept-b0');cli('--apply-install');assert journal()==final_journal
print(json.dumps({'nativeGatePositive':True,'actualCli':True,'actualLease':True,'actualJournal':True,
                  'resumeFieldsRejected':19,'sameNonceCandidateRejected':True,'replacementLeaseRepairRejected':True,
                  'dockerPostgresSimulated':True,'downstreamReadinessSimulated':True,
                  'privateInstallationQualified':False,'restoreQualified':False}))
