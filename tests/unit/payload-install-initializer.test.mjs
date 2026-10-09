import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { initializationRequest, legacySourceMaterial } from '../../scripts/integration/payload-preauthority-initialize.mjs';

// Real private inventory, manifests, HMAC journal/proofs, tar trees, Runtime
// constructor and ops commands. Docker/DB/health observations and proc-fd on
// Windows are explicit doubles; no Docker daemon, SQL or qualification PASS.
const observationModel = String.raw`
import io, stat, tarfile
class Model:
    def __init__(self,label):
        self.root = os.path.join(root,label); os.mkdir(self.root,0o700)
        self.runtime = os.path.join(self.root,'runtime'); os.mkdir(self.runtime,0o700)
        self.releases = os.path.join(self.root,'releases'); os.mkdir(self.releases,0o700)
        self.backups = os.path.join(self.root,'backups'); os.mkdir(self.backups,0o700)
        self.source = os.path.join(self.releases,source_hash[:40]); os.mkdir(self.source,0o700)
        self.release = os.path.join(self.releases,'a' * 40); os.mkdir(self.release,0o700)
        self.config = {'schemaVersion':2,'environmentFileOwner':{'uid':0,'gid':0},'project':project,
            'trustedSourceInventoryIdentities':[],
            'paths':{'root':self.root,'runtime':self.runtime,'releases':self.releases,
                     'currentRelease':os.path.join(self.root,'current-release'),
                     'lock':os.path.join(self.runtime,'deploy.lock'),
                     'admissionClosed':os.path.join(self.runtime,'deploy.lock.admission-closed'),
                     'backupRoots':[self.backups],'preRestoreBackupRoot':os.path.join(self.root,'protection'),
                     'environmentFile':os.path.join(self.runtime,'fixture.runtime.conf'),
                     'composeOverride':os.path.join(self.runtime,'compose.fixture.yaml'),
                     'payloadOverride':os.path.join(self.runtime,'compose.payload.production.yaml')},'volumes':{}}
        definitions = {'portalPostgres':('postgres_data',[('postgres','/var/lib/postgresql/data',True)]),
                       'portalUploads':('uploads_data',[('api','/app/uploads',True),('cron','/app/uploads',True)]),
                       'cmsPostgres':('cms_postgres_data',[('cms-postgres','/var/lib/postgresql/data',True)]),
                       'cmsUploads':('cms_uploads_data',[('cms','/var/lib/ownerinc-cms/media',True),('cms-worker','/var/lib/ownerinc-cms/media',False)])}
        for key,(compose_key,mounts) in definitions.items():
            self.config['volumes'][key] = {'name':project + '_' + compose_key,'composeKey':compose_key,
                'mounts':[{'service':s,'destination':d,'required':required} for s,d,required in mounts]}
        self.identity = R.INVENTORY.identity(R.INVENTORY.validate(self.config))
        def write(file,raw):
            with open(file,'wb') as stream: stream.write(raw)
            os.chmod(file,0o600)
        self.write = write
        write(os.path.join(self.runtime,'payload-control-inventory.json'),S.canonical(self.config) + b'\n')
        for key in ('lock','environmentFile','composeOverride','payloadOverride'):
            write(self.config['paths'][key],b'# explicit synthetic command-observation fixture\n')
        write(self.config['paths']['currentRelease'],(self.source + '\n').encode())
        write(os.path.join(self.source,'.image-env'),source_raw)
        write(os.path.join(self.release,'.image-env'),('API_IMAGE=' + images['api'] + '\nCRON_IMAGE=' + images['cron'] + '\nCMS_IMAGE=' + images['cms'] + '\nRELEASE_FORMAT=payload-v1\n').encode())
        for directory in (self.source,self.release):
            for name in ('docker-compose.yml','docker-compose.payload.yml'): write(os.path.join(directory,name),b'services: {}\n')
        self.request = os.path.join(self.runtime,'payload-initialize-request.json')
        self.request_body = {'schemaVersion':1,'purpose':'isolated-recovery-producer','commit':'a' * 40,'runId':'123','runAttempt':'1','images':images}
        write(self.request,S.canonical(self.request_body) + b'\n')
        S.initialize(self.runtime,self.identity)
        self.commands = []; self.granted = False; self.roles = False; self.native = False
        self.unsafe_roles = False; self.fail_command = None; self.volumes = {}; self.containers = {}
        for key in ('portalPostgres','portalUploads'): self.create_volume(key,{})
        for service in ('postgres','api','cron'): self.create_container(service,{},'running')
        self.tar_plain = self.tar(False); self.tar_gzip = self.tar(True)
        self.upload_hash = R._tar_tree(io.BytesIO(self.tar_plain))
    def tar(self,gzip):
        output = io.BytesIO()
        with tarfile.open(fileobj=output,mode='w:gz' if gzip else 'w') as archive:
            entry = tarfile.TarInfo('.'); entry.type = tarfile.DIRTYPE; entry.mode = 0o755; archive.addfile(entry)
            entry = tarfile.TarInfo('source.txt'); data = b'actual synthetic source bytes'; entry.size = len(data); entry.mode = 0o600
            archive.addfile(entry,io.BytesIO(data))
        return output.getvalue()
    def create_volume(self,key,labels):
        entry = self.config['volumes'][key]
        self.volumes[entry['name']] = {'Name':entry['name'],'Driver':'local','Scope':'local','Mountpoint':os.path.join(self.root,'mounts',key),
            'Options':None,'CreatedAt':'2026-10-09T12:00:00Z','Labels':{'com.docker.compose.project':project,'com.docker.compose.volume':entry['composeKey'],**labels}}
    def create_container(self,service,labels,state='created'):
        image = images.get(service,images['cms'] if service == 'cms' else 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777')
        mounts = []
        for entry in self.config['volumes'].values():
            for mount in entry['mounts']:
                if mount['service'] == service: mounts.append({'Type':'volume','Name':entry['name'],'Destination':mount['destination'],'RW':True})
        self.containers[service] = {'Id':hashlib.sha256((self.root + service).encode()).hexdigest(),
            'Created':'2026-10-09T12:00:00Z','Config':{'Image':image,'Labels':{'com.docker.compose.project':project,'com.docker.compose.service':service,**labels}},
            'Mounts':mounts,'State':{'Status':state,'Health':{'Status':'healthy'}}}
    def state(self): return S.read_state(self.runtime)[2]
    def psql(self,service,sql):
        if 'clientBackends' in sql: return {'clientBackends':0,'activeQueries':0,'openTransactions':0}
        if 'portalApiSessionPrivileges' in sql:
            return {'versions':S.PORTAL_MIGRATIONS,'authorityRows':1,'authority':{'mode':'legacy','epoch':1},
                    'portalApiSessionPrivileges':[True,True,True,True,False,False,False] if self.granted else [False] * 7,
                    'portalCronSessionPrivileges':[False] * 7}
        if 'protocolRelations' in sql:
            return {'migrations':S.CMS_MIGRATIONS,'protocolRelations':0,'protocolFunctions':0,'protocolTriggers':0,'newsRows':0}
        raise AssertionError('unmodeled SQL observation')
    def run(self,args,**kwargs):
        self.commands.append(args)
        if self.fail_command and self.fail_command(args): return SimpleNamespace(returncode=2,stdout=b'',stderr=b'')
        text = kwargs.get('text') or kwargs.get('encoding'); output = b''
        if args[:3] == ['docker','context','inspect']:
            output = b'"unix:///var/run/docker.sock"\n'
        elif args[:3] == ['docker','volume','ls']:
            output = ('\n'.join(self.volumes) + '\n').encode()
        elif args[:3] == ['docker','volume','inspect']:
            if args[3] not in self.volumes: return SimpleNamespace(returncode=1,stdout=b'',stderr=b'')
            output = json.dumps([self.volumes[args[3]]]).encode()
        elif args[:3] == ['docker','volume','create']:
            labels = dict(args[i + 1].split('=',1) for i,value in enumerate(args) if value == '--label')
            key = next(k for k,v in self.config['volumes'].items() if v['name'] == args[-1]); self.create_volume(key,labels)
            output = (args[-1] + '\n').encode()
        elif args[:2] == ['docker','ps']:
            output = ''.join(c['Id'][:12] + '\t' + project + '\t' + service + '\t' + c['State']['Status'] + '\t' + project + '-' + service + '-1\n'
                             for service,c in self.containers.items()).encode()
        elif args[:2] == ['docker','inspect']:
            value = next(c for c in self.containers.values() if c['Id'].startswith(args[-1]))
            if '--format' not in args: output = json.dumps([value]).encode()
            elif args[3] == '{{.Config.Image}}': output = (value['Config']['Image'] + '\n').encode()
            elif args[3] == '{{.State.Health.Status}}': output = b'healthy\n'
            else: output = (json.dumps(value['Config']['Labels']) + '\n' + json.dumps(value['Mounts']) + '\n').encode()
        elif args[:2] == ['docker','start']:
            # The explicit start is never allowed before both creator receipts
            # are returned by the real signed journal, including on retry.
            recorded = self.state()['installIntent']['creation']['containers']
            assert set(recorded) == {'cms-postgres','cms'}
            assert args[2] == recorded['cms-postgres']['id']
            next(c for c in self.containers.values() if c['Id'] == args[2])['State']['Status'] = 'running'
        elif args[:2] == ['docker','exec']:
            output = b'private synthetic PostgreSQL archive bytes' if 'pg_dump' in args[-1] else b''
        elif args[:2] == ['docker','run']: output = self.tar_gzip
        elif 'compose' in args:
            if 'stop' in args:
                for service in ('api','cron','cms','nginx'):
                    if service in self.containers: self.containers[service]['State']['Status'] = 'exited'
            elif 'up' in args and '--no-start' in args:
                assert '--no-deps' in args and '--no-recreate' in args and '--no-build' in args
                overlay = json.loads(open(os.path.join(self.runtime,'payload-initialize-compose.json'),encoding='utf-8').read())
                self.create_container(args[-1],overlay['services'][args[-1]]['labels'])
            elif 'migrate' in args and args[-1] == 'migrate': self.granted = True
            elif 'cms-provision' in args: self.roles = True
            elif '--verify-control' in args or '--verify-migrator' in args or '--verify-runtime' in args:
                if self.unsafe_roles or not self.roles: return SimpleNamespace(returncode=2,stdout='' if text else b'',stderr='' if text else b'')
            elif args[-1] == 'cms-migrate': self.native = True
            elif args[-1] == 'cms-preauthority-verify':
                assert self.native
                output = json.dumps({'phase':'preauthority','protocolStatus':'absent','coverageApplicability':'not-applicable',
                    'migrationNames':S.CMS_MIGRATIONS,'migrationFingerprint':hashlib.sha256(S.canonical(S.CMS_MIGRATIONS)).hexdigest(),
                    'nativeCatalogFingerprint':'8' * 64,'newsMutationRows':0,'ready':False,'admissionActivated':False,'cutoverCertified':False}).encode() + b'\n'
        else: raise AssertionError('unmodeled command ' + repr(args))
        destination = kwargs.get('stdout')
        if hasattr(destination,'write'): destination.write(output); output = None
        return SimpleNamespace(returncode=0,stdout=output.decode() if text and output is not None else output,stderr='' if text else b'')
    def context(self):
        stack = ExitStack(); stack.enter_context(patch.object(R,'HERE',self.runtime))
        environment = {'COMPOSE_PROJECT_NAME':project,'PORTAL_OPERATION_LOCK':self.config['paths']['lock'],
            'PORTAL_OPERATION_LOCK_HELD':self.config['paths']['lock'],'COMPOSE_ENV_FILE':self.config['paths']['environmentFile'],
            'COMPOSE_OVERRIDE':self.config['paths']['composeOverride']}
        stack.enter_context(patch.dict(os.environ,environment,clear=True))
        real_stat = os.stat
        def descriptor_stat(selected,*args,**kwargs):
            # Metadata seam only: no claim of an actual OS-exclusive lease.
            if selected == '/proc/{}/fd/9'.format(os.getpid()): return real_stat(self.config['paths']['lock'])
            return real_stat(selected,*args,**kwargs)
        stack.enter_context(patch.object(R.os,'stat',descriptor_stat))
        stack.enter_context(patch.object(R.subprocess,'run',self.run))
        stack.enter_context(patch.object(R.subprocess,'Popen',lambda *_a,**_k:SimpleNamespace(stdout=io.BytesIO(self.tar_plain),wait=lambda:0,kill=lambda:None)))
        stack.enter_context(patch.object(R,'_psql_json',self.psql))
        stack.enter_context(patch.object(R,'_database_identity',lambda service,database:portal if service == 'postgres' else cms))
        stack.enter_context(patch.object(R,'_data_fingerprint',lambda _service:'1' * 64))
        return stack
    def initialize(self):
        runtime = R.Runtime('initialize-isolated',self.release,self.request)
        runtime.run()
        return runtime
`;

const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
  .find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
async function fixture(t, body) {
  if (!python) return t.skip('Python 3 unavailable');
  if (body.includes('Model(') && process.platform !== 'win32' && process.getuid?.() !== 0) {
    return t.skip('actual ops constructor requires Linux root; Windows file metadata/proc lease seams are explicitly modeled');
  }
  const parent = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const root = await mkdtemp(path.join(parent, 'install-initializer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = String.raw`
import copy, hashlib, importlib.util, json, os, sys
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch
repo, root = sys.argv[1:]
spec = importlib.util.spec_from_file_location('initializer_runtime',os.path.join(repo,'ops','payload-control-runtime.py'))
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R); S = R.STATE
def expect(code, callback):
    try: callback()
    except (S.StateError,R.ControlError) as error: assert str(error) == code, (str(error),code)
    else: raise AssertionError('expected ' + code)
images = {name:'ghcr.io/ownerinc/ownerinc-portal-' + name + '@sha256:' + letter * 64
          for name,letter in [('api','a'),('cron','b'),('cms','c')]}
previous = {name:images[name] for name in ('api','cron')}
source_raw = ('API_IMAGE=' + images['api'] + '\nCRON_IMAGE=' + images['cron'] + '\n').encode()
source_hash = hashlib.sha256(source_raw).hexdigest()
candidate = {'schemaVersion':1,'purpose':'isolated-recovery-producer','commit':'a' * 40,
             'runId':'123','runAttempt':'1','images':images,'candidateSha256':'d' * 64,'sourceMaterialSha256':source_hash}
portal = {'systemIdentifier':'123456','databaseOid':'16384','databaseName':'portal'}
cms = {'systemIdentifier':'654321','databaseOid':'16385','databaseName':'ownerinc_cms'}
project = 'payload-preauth-123-1-abcdef1234-source'
def volume(key):
    return {'name':project + '_' + key,'driver':'local','mountpoint':os.path.join(root,'volumes',key),
            'fingerprint':hashlib.sha256(key.encode()).hexdigest()}
portal_target = {'database':portal,'volumes':{key:volume(key) for key in ('portalPostgres','portalUploads')}}
cms_target = {'database':cms,'volumes':{key:volume(key) for key in ('cmsPostgres','cmsUploads')}}
binding = {'bindingVersion':2,'candidate':candidate,'candidateRelease':os.path.join(root,'releases','a' * 40),
           'sourceRelease':os.path.join(root,'releases',source_hash[:40]),'previousImages':previous,
           'b0':{'directory':os.path.join(root,'backups','initial-b0'),'proofSha256':'e' * 64},
           'inventoryIdentity':'f' * 64,'lease':{'device':1,'inode':2},'portalTarget':portal_target}
proof = {'schemaVersion':1,'kind':'preauthority-legacy-source','phase':'preauthority','inventoryIdentity':'f' * 64,
         'authority':{'mode':'legacy','epoch':1},'protocol':{'status':'absent','coverage':'not-applicable'},
         'images':previous,'targetImages':images,'source':{'portal':portal,'cms':None},
         'migrations':{'portal':{'versions':S.PORTAL_MIGRATIONS,'fingerprint':hashlib.sha256(S.canonical(S.PORTAL_MIGRATIONS)).hexdigest()},'cms':None,'nativeCatalogFingerprint':None},
         'dataFingerprints':{'portalDatabase':'1' * 64,'portalUploads':'2' * 64,'cmsDatabase':None,'cmsUploads':None},
         'artifacts':[{'name':name,'sha256':'3' * 64,'size':1} for name in S.LEGACY_ARTIFACTS],
         'createdAtUtc':'2026-10-09T12:00:00Z'}
creation = {'nonce':'4' * 64,'volumes':{},'containers':{}}
def fresh(label):
    directory = os.path.join(root,label); os.mkdir(directory,0o700); S.initialize(directory,'f' * 64)
    S.transition(directory,lambda b:b.update({'admission':'closed','plannedReleaseImages':images,
                 'legacySourceProofSha256':'e' * 64,'latestProofSha256':'e' * 64}))
    return directory
def reserve(directory): return S.reserve_install(directory,binding,proof,'e' * 64,creation=creation)
def provisioned(directory):
    reserve(directory)
    for stage in S.INSTALL_STAGES[1:]:
        if stage == 'floor_commit_pending': break
        if stage == 'cms_resources_bound':
            for name, value in cms_target['volumes'].items(): S.record_install_creation(directory,binding,'volumes',name,value)
            for name in ('cms-postgres','cms'):
                S.record_install_creation(directory,binding,'containers',name,
                    {'id':hashlib.sha256(name.encode()).hexdigest(),'image':images['cms'],'fingerprint':'5' * 64})
        S.advance_install(directory,binding,stage,cms_target if stage == 'cms_resources_bound' else None)
` + observationModel + `\nMODEL_SOURCE = ${JSON.stringify(observationModel)}\n` + body;
  // Large replay/guard programs exceed Windows argv limits; execute the same
  // complete source from an exclusive private fixture file, never truncate it.
  const program = path.join(root, 'exercise.py');
  await writeFile(program, source, { flag: 'wx', mode: 0o600 });
  const result = spawnSync(python, ['-B', program, path.resolve('.'), root], {
    encoding: 'utf8', timeout: 90000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('initializer main attributes failures to the concrete phase and last signed milestone without changing admission or audit', async t => {
  await fixture(t, String.raw`
from contextlib import redirect_stderr
cases = [
    ('stop_writers','none',lambda args:'stop' in args),
    ('b0_database_capture','none',lambda args:args[:2]==['docker','exec'] and 'pg_dump' in args[-1]),
    ('b0_storage_capture','none',lambda args:args[:2]==['docker','run']),
    ('portal_grants_migrate','portal_grants_pending',lambda args:args[-1]=='migrate'),
    ('container_create','cms_resources_pending',lambda args:'up' in args and '--no-start' in args and args[-1]=='cms-postgres'),
    ('cms_provision','cms_provision_pending',lambda args:args[-1]=='cms-provision'),
    ('cms_control_bootstrap','cms_provision_pending',lambda args:args[-1]=='--bootstrap-control'),
    ('cms_migrate','cms_provision_pending',lambda args:args[-1]=='cms-migrate'),
]
for index,(phase,stage,fail_command) in enumerate(cases):
    model=Model('diagnostic-' + str(index)); model.fail_command=fail_command
    stderr=io.StringIO()
    with model.context(),redirect_stderr(stderr):
        assert R.main(['control','initialize-isolated',model.release,model.request])==2
    lines=stderr.getvalue().splitlines()
    assert lines==['initializer_command_failed','PREAUTHORITY_INITIALIZER_DIAGNOSTIC phase=' + phase +
        ' installStage=' + stage + ' commandExit=2 commandSignal=none privateStderr=none'],lines
    state=model.state()
    assert state['admission']=='closed' and state['workerHold'] is True
    assert (state['installIntent']['stage'] if state['installIntent'] else 'none')==stage
    assert model.root not in stderr.getvalue() and images['cms'] not in stderr.getvalue()
`);
});

test('explicit producer binding has no circular qualification fields and classic bindings remain strict', async t => {
  await fixture(t, String.raw`
S.validate_install_binding(binding)
classic = copy.deepcopy(binding); del classic['bindingVersion']
classic['candidate'] = {'commit':'a' * 40,'runId':'123','runAttempt':'1','images':images,
                        'candidateSha256':'d' * 64,'reportSha256':'5' * 64,'qualificationSha256':'6' * 64,'bundleSha256':'7' * 64}
S.validate_install_binding(classic)
for mutate in [lambda b:b.update({'bindingVersion':3}),lambda b:b['candidate'].update({'qualificationSha256':'0' * 64}),
               lambda b:b['candidate'].update({'purpose':'production'}),lambda b:b['candidate'].update({'commit':'invented'}),
               lambda b:b['candidate'].update({'sourceMaterialSha256':'0' * 64})]:
    wrong = copy.deepcopy(binding); mutate(wrong); expect('invalid_cold_state',lambda:S.validate_install_binding(wrong))
root1 = fresh('producer'); reserve(root1)
root2 = fresh('classic'); S.reserve_install(root2,classic,proof,'e' * 64)
assert S.read_state(root1)[2]['installIntent']['creation'] == creation
assert 'creation' not in S.read_state(root2)[2]['installIntent']
`);
});

test('floor pending commits only explicit observations and retains immutable install audit through later backup/restore state changes', async t => {
  await fixture(t, String.raw`
directory = fresh('floor'); provisioned(directory)
S.begin_install_floor(directory,binding,'8' * 64)
pending = S.read_state(directory)[2]
assert pending['cmsStatus'] == 'provisioned' and pending['installIntent']['stage'] == 'floor_commit_pending'
S.commit_install_floor(directory,binding)
committed = S.read_state(directory)[2]; audit = copy.deepcopy(committed['installIntent'])
assert committed['cmsStatus'] == 'migrated' and committed['admission'] == 'closed'
assert committed['releaseImages'] == images and committed['nativeCatalogFingerprint'] == '8' * 64
assert committed['plannedReleaseImages'] is None and not S.install_pending(committed)
S.transition(directory,lambda b:b.update({'latestProofSha256':'9' * 64,'admission':'open'}))
assert S.read_state(directory)[2]['installIntent'] == audit
for mutate,reason in [(lambda b:b.update({'installIntent':None}),'planned_release_mismatch'),
                      (lambda b:b['installIntent']['floor'].update({'nativeCatalogFingerprint':'0' * 64}),'planned_release_mismatch'),
                      (lambda b:b['installIntent']['creation'].update({'nonce':'0' * 64}),'restore_target_changed')]:
    expect(reason,lambda:S.transition(directory,mutate))
early = fresh('early'); reserve(early)
expect('invalid_cold_state',lambda:S.begin_install_floor(early,binding,'8' * 64))
`);
});

test('actual ops initializer executes B0 then normal grants, creator receipts, native roles/migrations and explicit floor with all writers held', async t => {
  await fixture(t, String.raw`
model = Model('complete')
with model.context():
    runtime = model.initialize()
    state = model.state()
    assert state['cmsStatus'] == 'migrated' and state['installIntent']['stage'] == 'floor_committed'
    assert state['admission'] == 'closed' and state['workerHold'] is True and state['restoreIntent'] is None
    assert state['authority'] == {'mode':'legacy','epoch':1}
    assert state['releaseImages'] == images and state['nativeCatalogFingerprint'] == '8' * 64
    assert open(model.config['paths']['currentRelease'],encoding='utf-8').read() == model.release + '\n'
    assert all(c['State']['Status'] != 'running' for s,c in model.containers.items() if s not in ('postgres','cms-postgres'))
    intent = state['installIntent']; body,digest = R._parse_proof(intent['binding']['b0']['directory'],runtime.key,payload=False)
    assert body['protocol'] == {'status':'absent','coverage':'not-applicable'} and body['source']['cms'] is None
    assert digest == state['legacySourceProofSha256']
    assert set(intent['creation']['volumes']) == {'cmsPostgres','cmsUploads'}
    assert set(intent['creation']['containers']) == {'cms-postgres','cms'}
    commands = model.commands
    capture = next(i for i,c in enumerate(commands) if any('pg_dump --format=custom' in arg for arg in c))
    grant = next(i for i,c in enumerate(commands) if 'run' in c and c[-1] == 'migrate')
    create = next(i for i,c in enumerate(commands) if c[:3] == ['docker','volume','create'])
    provision = next(i for i,c in enumerate(commands) if c[-1] == 'cms-provision')
    control = next(i for i,c in enumerate(commands) if c[-1] == '--bootstrap-control')
    migrate = next(i for i,c in enumerate(commands) if c[-1] == 'cms-migrate')
    assert capture < grant < create < provision < control < migrate
    assert any(c[-1] == '--verify-runtime' for c in commands) and any(c[-1] == '--verify-control' for c in commands)
    assert not any('qualification' in str(c) for c in commands)
    before = model.state()
    model.initialize()
    assert model.state() == before
`);
});

test('interrupted known intent retries normal grants and role provisioning without adopting unrecorded resources', async t => {
  await fixture(t, String.raw`
for phase, predicate, expected in [
    ('grants',lambda args:'compose' in args and args[-1] == 'migrate','portal_grants_pending'),
    ('provision',lambda args:'compose' in args and args[-1] == 'cms-provision','cms_provision_pending'),
    ('control',lambda args:args[-1] == '--bootstrap-control','cms_provision_pending'),
    ('native',lambda args:'compose' in args and args[-1] == 'cms-migrate','cms_provision_pending'),
]:
    model = Model('retry-' + phase); model.fail_command = predicate
    with model.context():
        expect('initializer_command_failed',model.initialize)
        assert model.state()['installIntent']['stage'] == expected
        assert model.state()['admission'] == 'closed'
        model.fail_command = None
        model.initialize()
        assert model.state()['installIntent']['stage'] == 'floor_committed'
model = Model('lost-receipt')
real_record = S.record_install_creation
with model.context(),patch.object(S,'record_install_creation',side_effect=S.StateError('private_state_write_failed')):
    expect('private_state_write_failed',model.initialize)
with model.context():
    state = model.state(); commands = len(model.commands)
    expect('restore_target_changed',model.initialize)
    assert model.state() == state
    assert not any('rm' in c or 'prune' in c for c in model.commands[commands:] if c[:2] == ['docker','volume'])
    assert len(model.volumes) == 3, 'unrecorded created volume is preserved'
`);
});

test('floor partial-pointer failures preserve pending intent and exact retry revalidates before commit, never already-current success', async t => {
  await fixture(t, String.raw`
model = Model('pointer-window'); real_observe = R.Runtime._initial_floor_observations
calls = []
def fail_after_pointer(runtime):
    result = real_observe(runtime)
    if runtime.state['installIntent']['stage'] == 'floor_commit_pending':
        calls.append('post-pointer'); raise R.ControlError('current_release_invalid')
    return result
with model.context(),patch.object(R.Runtime,'_initial_floor_observations',fail_after_pointer):
    expect('current_release_invalid',model.initialize)
assert calls == ['post-pointer']
pending = model.state(); assert pending['installIntent']['stage'] == 'floor_commit_pending'
assert pending['cmsStatus'] == 'provisioned' and pending['admission'] == 'closed'
assert open(model.config['paths']['currentRelease'],encoding='utf-8').read() == model.release + '\n'
with model.context():
    model.initialize()
    assert model.state()['installIntent']['stage'] == 'floor_committed'
`);
});

test('unsafe role observations fail before pointer changes, retaining provision-phase intent and admission fence', async t => {
  await fixture(t, String.raw`
model = Model('unsafe-roles'); model.unsafe_roles = True
with model.context():
    expect('native_catalog_verification_failed',model.initialize)
state = model.state()
assert state['admission'] == 'closed' and state['installIntent']['stage'] == 'cms_provision_pending'
assert open(model.config['paths']['currentRelease'],encoding='utf-8').read() == model.source + '\n'
`);
});

test('producer JSON and source identities are exact and content-bound, not synthetic qualification or production commit claims', () => {
  const images = Object.fromEntries(['api', 'cron', 'cms'].map((service, index) =>
    [service, `ghcr.io/ownerinc/ownerinc-portal-${service}@sha256:${String(index + 1).repeat(64)}`]));
  const raw = initializationRequest({ commit: 'a'.repeat(40), runId: '123', runAttempt: '1' }, images);
  const request = JSON.parse(raw);
  assert.deepEqual(Object.keys(request).sort(), ['commit', 'images', 'purpose', 'runAttempt', 'runId', 'schemaVersion']);
  assert.equal(request.purpose, 'isolated-recovery-producer');
  assert.equal(raw.endsWith('\n'), true);
  const source = legacySourceMaterial(images);
  assert.equal(source.releaseId, source.sha256.slice(0, 40));
  assert.equal(source.manifest, `API_IMAGE=${images.api}\nCRON_IMAGE=${images.cron}\n`);
  for (const runAttempt of ['0', '01', 'injected']) {
    assert.throws(() => initializationRequest({ commit: 'a'.repeat(40), runId: '123', runAttempt }, images));
  }
});

test('candidate/lease/physical mismatch and untrusted residue fail before effects without changing signed evidence', async t => {
  await fixture(t, String.raw`
for negative in ('candidate','lease','portal','cms-volume','owner','pointer','b0'):
    model = Model('reject-' + negative)
    model.fail_command = lambda args:args[-1] == 'cms-provision'
    with model.context(): expect('initializer_command_failed',model.initialize)
    model.fail_command = None
    before = model.state(); journal_files = sorted(os.listdir(os.path.join(model.runtime,'payload-control-state')))
    with model.context(),ExitStack() as stack:
        if negative == 'candidate':
            request = copy.deepcopy(model.request_body); request['runAttempt'] = '2'
            model.write(model.request,S.canonical(request) + b'\n')
            reason = 'planned_release_mismatch'
        elif negative == 'lease':
            actual_stat = R.os.stat
            def wrong_lease(selected,*args,**kwargs):
                value = actual_stat(selected,*args,**kwargs)
                if selected == '/proc/{}/fd/9'.format(os.getpid()): return SimpleNamespace(st_dev=value.st_dev,st_ino=value.st_ino + 1)
                return value
            stack.enter_context(patch.object(R.os,'stat',wrong_lease)); reason = 'operation_lease_inode_mismatch'
        elif negative == 'portal':
            stack.enter_context(patch.object(R,'_database_identity',lambda service,database:{**portal,'systemIdentifier':'11111'} if service == 'postgres' else cms))
            reason = 'restore_target_changed'
        elif negative == 'cms-volume':
            name = model.config['volumes']['cmsUploads']['name']; model.volumes[name]['CreatedAt'] = '2026-10-10T00:00:00Z'
            reason = 'restore_target_changed'
        elif negative == 'owner':
            stack.enter_context(patch.object(R,'_verify_environment_file',side_effect=R.ControlError('unsafe_environment_owner')))
            reason = 'unsafe_environment_owner'
        elif negative == 'pointer':
            model.write(model.config['paths']['currentRelease'],(model.release + '\n').encode())
            reason = 'current_release_invalid'
        else:
            artifact = os.path.join(before['installIntent']['binding']['b0']['directory'],'postgres.dump')
            with open(artifact,'ab') as stream: stream.write(b'tampered')
            reason = 'backup_artifact_mismatch'
        count = len(model.commands)
        expect(reason,model.initialize)
        assert model.state() == before
        assert sorted(os.listdir(os.path.join(model.runtime,'payload-control-state'))) == journal_files
        later = model.commands[count:]
        assert not any(('compose' in c and ('run' in c or 'create' in c or 'stop' in c)) or c[:3] == ['docker','volume','create'] for c in later)
`);
});

test('no protocol or News rows can be used to satisfy floorcommit and production namespace cannot initialize', async t => {
  await fixture(t, String.raw`
for flag,reason in [('protocolFunctions','unsupported_protocol_present_or_mixed'),('newsRows','unexpected_preauthority_news_rows')]:
    model = Model('protocol-' + flag); base_psql = model.psql
    def drift(service,sql):
        value = base_psql(service,sql)
        if service == 'cms-postgres' and 'protocolRelations' in sql: return {**value,flag:1}
        return value
    model.psql = drift
    with model.context(): expect(reason,model.initialize)
    assert model.state()['admission'] == 'closed' and model.state()['installIntent']['stage'] == 'cms_provision_pending'
    assert open(model.config['paths']['currentRelease'],encoding='utf-8').read() == model.source + '\n'
model = Model('production-denied')
with model.context():
    runtime = R.Runtime('initialize-isolated',model.release,model.request)
    runtime.inventory['document']['project'] = 'ownerinc-portal-prod'
    count = len(model.commands); before = model.state()
    expect('unsupported_compose_project',runtime.initialize_isolated)
    expect('release_not_preflighted',runtime.install_receiver_preflight)
    assert model.commands[count:] == [] and model.state() == before
`);
});

test('classic binding can use explicit floor path without being reinterpreted as a producer or losing its audit', async t => {
  await fixture(t, String.raw`
classic = copy.deepcopy(binding); del classic['bindingVersion']
classic['candidate'] = {'commit':'a' * 40,'runId':'123','runAttempt':'1','images':images,
                        'candidateSha256':'d' * 64,'reportSha256':'5' * 64,'qualificationSha256':'6' * 64,'bundleSha256':'7' * 64}
directory = fresh('old-binding-floor'); S.reserve_install(directory,classic,proof,'e' * 64)
for stage in S.INSTALL_STAGES[1:]:
    S.advance_install(directory,classic,stage,cms_target if stage == 'cms_resources_bound' else None)
S.begin_install_floor(directory,classic,'8' * 64); S.commit_install_floor(directory,classic)
terminal = S.read_state(directory)[2]
assert terminal['installIntent']['binding'] == classic and 'creation' not in terminal['installIntent']
assert terminal['installIntent']['stage'] == 'floor_committed' and terminal['admission'] == 'closed'
`);
});

test('real guard dispatch reaches the actual initializer/kernel and signed terminal (DB/Docker/proc observations explicitly doubled)', async t => {
  if (process.platform !== 'win32' && process.getuid?.() !== 0) return t.skip('guard fixture needs Linux root; Windows metadata/fd probe are explicitly doubled');
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  if (spawnSync(bash, ['--version'], { encoding: 'utf8' }).status !== 0) return t.skip('Bash unavailable');
  await fixture(t, String.raw`
import shutil, subprocess
model = Model('guard-dispatch')
snapshot = {key:({'bytesHex':value.hex()} if isinstance(value,bytes) else value)
            for key,value in model.__dict__.items() if not callable(value)}
metadata = os.path.join(root,'observations.json'); model.write(metadata,S.canonical(snapshot) + b'\n')
shim = os.path.join(root,'guard-observation-seam.py')
program = 'import copy,hashlib,importlib.util,json,os,sys,io,tarfile\nfrom contextlib import ExitStack\nfrom types import SimpleNamespace\nfrom unittest.mock import patch\n'
program += 'repo=' + repr(repo) + '\nroot=' + repr(root) + '\nimages=' + repr(images) + '\nportal=' + repr(portal) + '\ncms=' + repr(cms) + '\nproject=' + repr(project) + '\n'
program += 'source_raw=' + repr(source_raw) + '\nsource_hash=' + repr(source_hash) + '\n'
program += "spec=importlib.util.spec_from_file_location('guard_real_runtime',os.path.join(repo,'ops','payload-control-runtime.py'))\nR=importlib.util.module_from_spec(spec);spec.loader.exec_module(R);S=R.STATE\n"
program += MODEL_SOURCE
program += '\nmodel=Model.__new__(Model)\nmetadata=' + repr(metadata) + '\n'
program += "with open(metadata,encoding='utf-8') as stream: values=json.load(stream)\nmodel.__dict__.update({key:bytes.fromhex(value['bytesHex']) if isinstance(value,dict) and set(value)=={'bytesHex'} else value for key,value in values.items()})\n"
program += "assert len(sys.argv)==4\nassert sys.argv[1]=='initialize-isolated'\nassert os.path.normpath(sys.argv[2])==model.release and os.path.normpath(sys.argv[3])==model.request\n"
program += "with model.context(): status=R.main(['payload-control',sys.argv[1],model.release,model.request])\nsys.exit(status)\n"
model.write(shim,program.encode())
controller = os.path.join(model.runtime,'payload-control')
model.write(controller,('#!/usr/bin/env bash\nexec "' + sys.executable.replace('\\','/') + '" -B "' + shim.replace('\\','/') + '" "$@"\n').encode())
os.chmod(controller,0o700)
for name in ('payload-control-state.py','payload-control-runtime.py'):
    shutil.copyfile(os.path.join(repo,'ops',name),os.path.join(model.runtime,name))
guard_path = os.path.join(model.runtime,'payload-operations-guard')
guard = open(os.path.join(repo,'ops','payload-operations-guard.sh'),encoding='utf-8').read()
if os.name == 'nt': guard = guard.replace('/proc/$$/fd/9 -ef $PORTAL_OPERATION_LOCK','-f $PORTAL_OPERATION_LOCK')
model.write(guard_path,guard.encode()); os.chmod(guard_path,0o700)
def bash_path(value):
    value = value.replace('\\','/')
    return '/' + value[0].lower() + value[2:] if os.name == 'nt' else value
script = 'set -Eeuo pipefail; lock=$1; shift; exec 9<>"$lock"; '
if os.name != 'nt': script += 'flock -n 9; '
script += 'export PORTAL_OPERATION_LOCK="$lock" PORTAL_OPERATION_LOCK_HELD="$lock"; exec "$@"'
shell = 'C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else 'bash'
result = subprocess.run([shell,'-c',script,'explicit-guard-seam',bash_path(model.config['paths']['lock']),
                         bash_path(guard_path),'initialize-isolated',bash_path(model.release),bash_path(model.request)],
                        stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False)
assert result.returncode == 0, result.stderr.decode(errors='replace')
terminal = model.state()
assert terminal['installIntent']['stage'] == 'floor_committed' and terminal['cmsStatus'] == 'migrated'
assert terminal['admission'] == 'closed' and terminal['workerHold'] is True
assert open(model.config['paths']['currentRelease'],encoding='utf-8').read() == model.release + '\n'
`);
});

test('every signed initializer postmark has a recoverable exact append/head window with immutable receipts and terminal audit', async t => {
  await fixture(t, String.raw`
stages = list(S.INSTALL_TRANSITION_STAGES)
for stage in stages:
    model = Model('unheaded-' + stage); actual_replace = S._atomic_replace; crashed = []
    def interrupt_head(path,raw,mode):
        if path.endswith('current.json') and (S.parse_canonical(raw,'state_head_corrupt')['body'].get('installIntent') or {}).get('stage') == stage:
            crashed.append(stage); raise S.StateError('private_state_write_failed')
        return actual_replace(path,raw,mode)
    with model.context(),patch.object(S,'_atomic_replace',interrupt_head):
        expect('private_state_write_failed',model.initialize)
    assert crashed == [stage]
    with model.context():
        model.initialize()  # Runtime owns lease and validates/replays before repairing.
        assert model.state()['installIntent']['stage'] == 'floor_committed'
        assert model.state()['admission'] == 'closed' and model.state()['workerHold'] is True
for receipt in ('cmsPostgres','cmsUploads','cms-postgres','cms'):
    model = Model('unheaded-receipt-' + receipt); actual_replace = S._atomic_replace; crashed = []
    def interrupt_receipt(path,raw,mode):
        if path.endswith('current.json'):
            intent = S.parse_canonical(raw,'state_head_corrupt')['body'].get('installIntent')
            if intent and receipt in (intent.get('creation',{}).get('volumes',{}) | intent.get('creation',{}).get('containers',{})):
                crashed.append(receipt); raise S.StateError('private_state_write_failed')
        return actual_replace(path,raw,mode)
    with model.context(),patch.object(S,'_atomic_replace',interrupt_receipt):
        expect('private_state_write_failed',model.initialize)
    assert crashed == [receipt]
    with model.context():
        model.initialize()
        assert model.state()['installIntent']['stage'] == 'floor_committed'
`);
});

test('failure before each stage append and before pointer swap retains the previous signed boundary and exact retry', async t => {
  await fixture(t, String.raw`
for stage in S.INSTALL_TRANSITION_STAGES:
    model = Model('before-append-' + stage); actual_write = S._write_exclusive; crashed = []
    def interrupt_append(path,raw,mode):
        if os.path.basename(os.path.dirname(path)) == 'payload-control-state' and path.endswith('.json'):
            intent = S.parse_canonical(raw,'state_journal_corrupt')['body'].get('installIntent')
            if intent and intent['stage'] == stage:
                crashed.append(stage); raise S.StateError('private_state_write_failed')
        return actual_write(path,raw,mode)
    with model.context(),patch.object(S,'_write_exclusive',interrupt_append):
        expect('private_state_write_failed',model.initialize)
    assert crashed == [stage]
    before = model.state()
    assert before['admission'] == 'closed' and before['workerHold'] is True
    assert before['installIntent'] is None or before['installIntent']['stage'] != stage
    with model.context():
        model.initialize()
        assert model.state()['installIntent']['stage'] == 'floor_committed'
model = Model('before-pointer'); actual_replace = S._atomic_replace
def interrupt_pointer(path,raw,mode):
    if path == model.config['paths']['currentRelease']: raise S.StateError('private_state_write_failed')
    return actual_replace(path,raw,mode)
with model.context(),patch.object(S,'_atomic_replace',interrupt_pointer):
    expect('private_state_write_failed',model.initialize)
assert model.state()['installIntent']['stage'] == 'floor_commit_pending'
assert open(model.config['paths']['currentRelease'],encoding='utf-8').read() == model.source + '\n'
with model.context(): model.initialize()
assert model.state()['installIntent']['stage'] == 'floor_committed'
`);
});

test('floor prevalidation rejects source material, catalog, image, request and third-pointer drift before atomic swap', async t => {
  await fixture(t, String.raw`
for negative,reason in [('source','preauthority_source_recovery_proof_mismatch'),('catalog','native_catalog_verification_invalid'),
                        ('image','release_container_image_mismatch'),('request','planned_release_mismatch'),('third-pointer','current_release_invalid')]:
    model = Model('floor-reject-' + negative)
    with model.context(),patch.object(R.Runtime,'install_floor_commit',side_effect=R.ControlError('current_release_invalid')):
        expect('current_release_invalid',model.initialize)
    assert model.state()['installIntent']['stage'] == 'provisioned'
    if negative == 'third-pointer': S.begin_install_floor(model.runtime,model.state()['installIntent']['binding'],'8' * 64)
    before = model.state(); pointer = model.config['paths']['currentRelease']
    if negative == 'source':
        model.write(os.path.join(model.source,'.image-env'),('\n'.join(reversed(source_raw.decode().splitlines())) + '\n').encode())
    elif negative == 'image': model.containers['cms']['Config']['Image'] = images['cms'].replace('c' * 64,'0' * 64)
    elif negative == 'request':
        model.write(model.request,S.canonical({**model.request_body,'runAttempt':'2'}) + b'\n')
    elif negative == 'third-pointer':
        third = os.path.join(model.releases,'b' * 40); os.mkdir(third,0o700)
        model.write(os.path.join(third,'.image-env'),source_raw)
        model.write(pointer,(third + '\n').encode())
    original_pointer = open(pointer,'rb').read()
    with model.context(),ExitStack() as stack:
        if negative == 'catalog':
            actual_run = model.run
            def invalid_catalog(args,**kwargs):
                value = actual_run(args,**kwargs)
                if args[-1] == 'cms-preauthority-verify': value.stdout = '{"nativeCatalogFingerprint":"self-reported-only"}\n'
                return value
            stack.enter_context(patch.object(R.subprocess,'run',invalid_catalog))
        stack.enter_context(patch.object(S,'_atomic_replace',side_effect=AssertionError('prevalidation must finish before swap')))
        runtime = R.Runtime('install-floor-commit',model.release,None)
        expect(reason,runtime.run)
        assert model.state() == before and open(pointer,'rb').read() == original_pointer
`);
});

test('a remote or ambiguous root Docker context cannot authorize isolated initialization and does not close or write the journal', async t => {
  await fixture(t, String.raw`
for endpoint in ['tcp://127.0.0.1:2375','ssh://production','unix:///operator-selected.sock',{'Host':'unix:///var/run/docker.sock'}]:
    model = Model('daemon-' + hashlib.sha256(str(endpoint).encode()).hexdigest()[:8])
    before = model.state(); actual_run = model.run
    def wrong_context(args,**kwargs):
        value = actual_run(args,**kwargs)
        if args[:3] == ['docker','context','inspect']: value.stdout = json.dumps(endpoint).encode() + b'\n'
        return value
    with model.context(),patch.object(R.subprocess,'run',wrong_context):
        expect('docker_endpoint_override_forbidden',model.initialize)
    assert model.state() == before and before['installIntent'] is None and before['admission'] == 'open'
    assert not any('stop' in c or 'create' in c or 'run' in c for c in model.commands)
`);
});

test('partial resource retries still enforce image and writer observations before further physical writes', async t => {
  await fixture(t, String.raw`
for drift,reason in [('image','release_container_image_mismatch'),('paused','writers_not_quiescent'),('restarting','writers_not_quiescent')]:
    model = Model('before-create-' + drift)
    with model.context(),patch.object(R.Runtime,'_initialize_resources',side_effect=R.ControlError('restore_target_changed')):
        expect('restore_target_changed',model.initialize)
    before = model.state(); assert before['installIntent']['stage'] == 'cms_resources_pending'
    assert before['installIntent']['creation']['volumes'] == {}
    if drift == 'image': model.containers['api']['Config']['Image'] = images['api'].replace('a' * 64,'0' * 64)
    else: model.containers['api']['State']['Status'] = drift
    with model.context():
        count = len(model.commands)
        expect(reason,model.initialize)
        assert model.state() == before and len(model.volumes) == 2
        assert not any('create' in c or 'run' in c or 'start' in c for c in model.commands[count:])
`);
});

test('signed producer receipt/floor transition semantics apply equally to writes and replay before any repair', async t => {
  await fixture(t, String.raw`
def scenario(label,stage,mutate,reason):
    directory = fresh('pair-' + label); provisioned(directory)
    if stage in ('pending','terminal'): S.begin_install_floor(directory,binding,'8' * 64)
    if stage == 'terminal': S.commit_install_floor(directory,binding)
    key,state_dir,old,parent = S.read_state(directory)
    retained = {name:S._read_file(os.path.join(state_dir,name),0o600,True) for name in os.listdir(state_dir)}
    expect(reason,lambda:S.transition(directory,mutate))
    assert {name:S._read_file(os.path.join(state_dir,name),0o600,True) for name in os.listdir(state_dir)} == retained
    child = copy.deepcopy(old); mutate(child); child['sequence'] += 1; child['previousStateSha256'] = parent
    S.validate_state_body(child)  # Each body is legal; only the PAIR is illegal.
    raw = S.canonical(S.sign_envelope(child,key)) + b'\n'
    S._write_exclusive(os.path.join(state_dir,S._journal_name(child['sequence'])),raw,0o600)
    retained = {name:S._read_file(os.path.join(state_dir,name),0o600,True) for name in os.listdir(state_dir)}
    for repair in (False,True):
        with patch.object(S,'_atomic_replace',side_effect=AssertionError('illegal pair cannot repair')):
            expect(reason,lambda:S.read_state(directory,repair_head=repair))
        assert {name:S._read_file(os.path.join(state_dir,name),0o600,True) for name in os.listdir(state_dir)} == retained
def skip_floor(body):
    body['installIntent'].update({'stage':'floor_committed','floor':{'nativeCatalogFingerprint':'8' * 64,
        'sourceRelease':binding['sourceRelease'],'candidateRelease':binding['candidateRelease']}})
    body.update({'cmsStatus':'migrated','releaseImages':images,'plannedReleaseImages':None,'nativeCatalogFingerprint':'8' * 64})
def mutate_volume(body):
    body['installIntent']['creation']['volumes']['cmsUploads']['fingerprint'] = '0' * 64
    body['installIntent']['cmsTarget']['volumes']['cmsUploads']['fingerprint'] = '0' * 64
def finish_open(body):
    body['installIntent']['stage'] = 'floor_committed'
    body.update({'cmsStatus':'migrated','releaseImages':images,'plannedReleaseImages':None,'nativeCatalogFingerprint':'8' * 64,'admission':'open'})
def change_binding_type(body):
    classic = copy.deepcopy(binding); del classic['bindingVersion']
    classic['candidate'] = {'commit':'a' * 40,'runId':'123','runAttempt':'1','images':images,
        'candidateSha256':'d' * 64,'reportSha256':'5' * 64,'qualificationSha256':'6' * 64,'bundleSha256':'7' * 64}
    body['installIntent']['binding'] = classic; del body['installIntent']['creation']
for args in [
    ('skip-floor','provisioned',skip_floor,'invalid_cold_state'),
    ('mutable-nonce','provisioned',lambda b:b['installIntent']['creation'].update({'nonce':'0' * 64}),'restore_target_changed'),
    ('mutable-receipt','provisioned',mutate_volume,'restore_target_changed'),
    ('mutable-id','pending',lambda b:b['installIntent']['creation']['containers']['cms'].update({'id':'0' * 64}),'restore_target_changed'),
    ('pending-catalog','pending',lambda b:b['installIntent']['floor'].update({'nativeCatalogFingerprint':'0' * 64}),'planned_release_mismatch'),
    ('open-on-floor','pending',finish_open,'invalid_migrated_state'),
    ('reinterpreted-binding','terminal',change_binding_type,'planned_release_mismatch'),
    ('removed-terminal','terminal',lambda b:b.update({'installIntent':None}),'planned_release_mismatch'),
]: scenario(*args)
`);
});

test('actual terminal backup/restore commands transition their own fields and never rewrite immutable install intent', async t => {
  await fixture(t, String.raw`
model = Model('backup-restore-audit')
with model.context():
    runtime = model.initialize(); audit = copy.deepcopy(model.state()['installIntent'])
    backup = os.path.join(model.backups,'20261009-postfloor'); os.mkdir(backup,0o700)
    for name in ('postgres.dump','cms-postgres.dump'): model.write(os.path.join(backup,name),b'private synthetic PostgreSQL archive bytes')
    for name in ('uploads.tar.gz','cms-uploads.tar.gz'): model.write(os.path.join(backup,name),model.tar_gzip)
    model.write(os.path.join(backup,'release.images'),open(os.path.join(model.release,'.image-env'),'rb').read())
    model.write(os.path.join(backup,'backup.format'),b'payload-v1\n')
    runtime = R.Runtime('backup-metadata',model.release,os.path.join(backup,'operations-proof.json')); runtime.run()
    manifest_names = ['postgres.dump','uploads.tar.gz','cms-postgres.dump','cms-uploads.tar.gz','release.images','operations-proof.json','backup.format']
    model.write(os.path.join(backup,'manifest.sha256'),''.join(R._file_hash(os.path.join(backup,name))['sha256'] + '  ' + name + '\n' for name in manifest_names).encode())
    assert model.state()['installIntent'] == audit and model.state()['latestProofSha256'] != audit['binding']['b0']['proofSha256']
    for service in ('api','cron','cms'): model.containers[service]['State']['Status'] = 'running'
    runtime = R.Runtime('verify-release',model.release,None); runtime.run()
    runtime = R.Runtime('open-admission',model.release,None); runtime.run(); os.unlink(model.config['paths']['admissionClosed'])
    os.environ['PRE_RESTORE_BACKUP_DIR'] = model.config['paths']['preRestoreBackupRoot']
    runtime = R.Runtime('restore-preflight',model.release,backup); runtime.run()
    assert model.state()['restoreIntent']['stage'] == 'reserved' and model.state()['installIntent'] == audit
    runtime = R.Runtime('close-admission',model.release,None); runtime.run()
    model.write(model.config['paths']['admissionClosed'],b'')
    for service in ('api','cron','cms'): model.containers[service]['State']['Status'] = 'exited'
    for action in ('prepare-restore','portal-restore-intermediate','prepare-restore','verify-restored'):
        runtime = R.Runtime(action,model.release,backup); runtime.run()
        assert model.state()['installIntent'] == audit
    assert model.state()['restoreIntent'] is None and model.state()['admission'] == 'closed'
    # This exercises checks and signed checkpoint transitions, NOT actual pg_restore.
`);
});
