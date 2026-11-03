#!/usr/bin/env python3
"""Offline recovery contracts. Native storage cases use real Linux fsync/metadata.

No production adapter bypass exists: doubles below live solely in this fixture.
"""
import ast
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]


def load(name,filename):
    spec = importlib.util.spec_from_file_location(name,REPO/'ops'/filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


S = load('recovery_state','payload-control-state.py')
R = load('production_recovery','payload-production-b0-recovery.py')
U = load('recovery_storage','payload-recovery-storage.py')
W = load('recovery_witness','payload-recovery-witness.py')


def tuple_value(letter='a'):
    return {'identity':{'systemIdentifier':'123456','databaseOid':'16384','databaseName':'portal_qualified'},
        **{k:letter*64 for k in ('catalogSha256','layoutSha256','dataSha256','securitySha256','rolesSha256','databaseAclSha256')}}


def install_material(root):
    images = {n:'ghcr.io/ownerinc/ownerinc-portal-'+n+'@sha256:'+'a'*64 for n in ('api','cron','cms')}
    previous = {n:images[n].replace('a'*64,'d'*64) for n in ('api','cron')}
    database = tuple_value()['identity']
    def volume(n): return {'name':n,'driver':'local','mountpoint':str(root/'volumes'/n),'fingerprint':hashlib.sha256(n.encode()).hexdigest()}
    candidate = {'commit':'a'*40,'runId':'123','runAttempt':'1','images':images,
        'candidateSha256':'1'*64,'reportSha256':'2'*64,'qualificationSha256':'3'*64,'bundleSha256':'4'*64,
        'authorization':{'environment':'production','approvalSha256':'a'*64,'inventoryIdentity':'6'*64,
                         'expiresAt':'1999999999','nonce':'b'*64}}
    binding = {'bindingVersion':4,'b0GateVersion':1,'recoveryGateVersion':1,'preparationClosureSha256':'a'*64,
        'receiptId':'payload-abcdefgh','sourceCommit':'b'*40,'project':'ownerinc-portal-prod',
        'candidate':candidate,'candidateRelease':str(root/'releases'/('a'*40)),
        'sourceRelease':str(root/'releases'/('b'*40)),'previousImages':previous,
        'b0':{'directory':str(root/'backup'/'b0'),'proofSha256':'5'*64},'inventoryIdentity':'6'*64,
        'lease':{'device':1,'inode':2},'portalTarget':{'database':database,'volumes':{n:volume(n) for n in ('portalPostgres','portalUploads')}},
        'authority':{n:'a'*64 for n in ('sourceApprovalSha256','policySha256','recordSha256')},
        'sharedCluster':{'service':'postgres','volume':'portalPostgres','databases':{
            'portal':{'name':'portal_qualified','owner':'portal_admin'},'cms':{'name':'ownerinc_cms','owner':'cms_admin'}}}}
    proof = {'schemaVersion':1,'kind':'preauthority-legacy-source','phase':'preauthority','authority':{'mode':'legacy','epoch':1},
        'protocol':{'status':'absent','coverage':'not-applicable'},'inventoryIdentity':'6'*64,'images':previous,'targetImages':images,
        'source':{'portal':database,'cms':None},'migrations':{'portal':{'versions':S.PORTAL_MIGRATIONS,
        'fingerprint':S.value_sha256(S.PORTAL_MIGRATIONS)},'cms':None,'nativeCatalogFingerprint':None},
        'dataFingerprints':{'portalDatabase':'7'*64,'portalUploads':'8'*64,'cmsDatabase':None,'cmsUploads':None},
        'artifacts':[{'name':n,'sha256':'9'*64,'size':1} for n in S.LEGACY_ARTIFACTS],'createdAtUtc':'2026-10-09T12:00:00Z'}
    return binding, proof


def reserve_material(root, binding, proof, key=None):
    digest = binding['b0']['proofSha256']
    S.initialize(str(root),binding['inventoryIdentity'],trusted_key=key)
    S.transition(str(root),lambda b:b.update(admission='closed',plannedReleaseImages=binding['candidate']['images'],
        latestProofSha256=digest,legacySourceProofSha256=digest))
    S.reserve_install(str(root),binding,proof,digest,S.production_install_creation(binding,'b'*64),'1999999999',lambda:1999999998)


def reserved(root):
    binding, proof = install_material(root)
    reserve_material(root,binding,proof)
    return binding


def accepted(root):
    binding = reserved(root)
    S.bind_recovery_baseline(str(root),binding,{'proofSha256':'a'*64,'manifestSha256':'b'*64,
        'originStateSha256':S.read_state(str(root))[3]})
    decision = {'schemaVersion':1,'kind':'production-exact-b0-acceptance-v1','installBindingSha256':S.value_sha256(binding),
        'originStateSha256':S.read_state(str(root))[3],'receiptId':binding['receiptId'],'manifestSha256':'b'*64,
        'qualificationEvidenceSha256':'c'*64,'procedureRevision':'d'*64,'acceptedAt':2000000000,'expiresAt':2000003600,
        'authenticatedChannel':'independently-authenticated-admin-vps'}
    with patch.object(S.time,'time',return_value=2000000001):
        S.accept_b0(str(root),binding,decision,hashlib.sha256(S.canonical(decision)+b'\n').hexdigest())
    return binding


def recovery_decision(plan):
    return {'schemaVersion':1,'kind':'production-exact-b0-recovery-approval-v1','purpose':'restore-previous-legacy-prefloor-held',
        'recoveryPlanSha256':S.value_sha256(plan),'approvedAt':2000000000,'expiresAt':2000003600,
        'authenticatedChannel':'independently-authenticated-admin-vps'}


@contextmanager
def portable_retained_metadata(runtime, root):
    """Real sandbox metadata/IO; synthetic protected ownership and outer ancestry.

    Only shared ancestors ABOVE root have frozen directory-content observations.
    No in-sandbox size/link/time/inode field is masked. Windows descriptor stat
    uses the actual open path for its incompatible file-ID representation. The
    production modules' OS observations are local proxies, not writer doubles.
    """
    fields = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
    outer = {str(p):os.lstat(p) for p in root.parents}
    paths, streams, opens, syncs = {}, [], [], []
    def observed(info, path=None):
        value = {k:getattr(info,k) for k in fields}
        value.update(st_uid=0,st_gid=0,st_mode=stat.S_IFMT(info.st_mode) | (0o700 if stat.S_ISDIR(info.st_mode) else 0o600))
        if str(path) in outer:
            value.update({k:getattr(outer[str(path)],k) for k in ('st_nlink','st_size','st_mtime_ns','st_ctime_ns')})
        return SimpleNamespace(**value)
    def open_reader(path, flags, *args):
        assert not flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)
        fd = os.open(path,flags,*args); paths[fd]=path; opens.append((path,fd)); return fd
    def fdopen(fd, *args):
        stream=os.fdopen(fd,*args); streams.append(stream); return stream
    proxy = SimpleNamespace(**vars(os))
    proxy.lstat=lambda path:observed(os.lstat(path),path)
    proxy.fstat=lambda fd:observed(os.lstat(paths[fd]) if os.name=='nt' else os.fstat(fd))
    proxy.open=open_reader; proxy.fdopen=fdopen
    proxy.O_NOFOLLOW=getattr(os,'O_NOFOLLOW',0); proxy.O_NONBLOCK=getattr(os,'O_NONBLOCK',0)
    def sync(path):
        syncs.append(path)
        if os.name=='nt':
            # Directory fsync is Linux-only. File writes/flush/fsync remain real.
            assert Path(path).is_dir()
        else:real_sync(path)
    real_sync=U.sync
    with patch.object(runtime,'os',proxy),patch.object(runtime.INVENTORY,'os',proxy),patch.object(U,'sync',sync):
        yield streams, opens, syncs


class Contracts(unittest.TestCase):
    def test_admin_bookkeeping_preexists_and_records_zero_then_one_restore_across_resume(self):
        path=Path(__file__).with_name('payload-production-recovery-admin.py')
        spec=importlib.util.spec_from_file_location('portable_admin_bookkeeping',path)
        admin=importlib.util.module_from_spec(spec);spec.loader.exec_module(admin)
        tree=ast.parse(path.read_bytes());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
        assertions=[n for n in ast.walk(main) if isinstance(n,ast.Assert) and 'restore-count' in ast.unparse(n)]
        self.assertEqual(len(assertions),3) # expiry zero, credential refresh unchanged, final exactly once
        expiry=next(n for n in assertions if any(isinstance(v,ast.Constant) and v.value==b'' for v in ast.walk(n)))
        once=next(n for n in assertions if any(isinstance(v,ast.List) for v in ast.walk(n)))
        unchanged=next(n for n in assertions if any(isinstance(v,ast.Name) and v.id=='effects' for v in ast.walk(n)))
        def verify(node,**scope):exec(compile(ast.Module(body=[node],type_ignores=[]),'actual-native-counter-assertion','exec'),scope)
        class SetupReachedRuntime(Exception):pass
        def reached(*args):raise SetupReachedRuntime()
        with tempfile.TemporaryDirectory(prefix='recovery-bookkeeping-') as d, ExitStack() as opened:
            root=Path(d);namespace={'l':SimpleNamespace(load_runtime_captured=reached),'images':{},'root':root,'captured':{}}
            with self.assertRaises(SetupReachedRuntime):admin.setup_profile(namespace)
            self.assertEqual((root/'restore-count').read_bytes(),b'');self.assertEqual((root/'boundaries').read_bytes(),b'')
            verify(expiry,root=root)
            desired=tuple_value();previous=dict(desired,dataSha256='b'*64)
            (root/'source-database.json').write_bytes(R.canonical(desired));(root/'database.json').write_bytes(R.canonical(previous))
            (root/'archive.dump').write_bytes(b'explicit persisted restore observation double')
            fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
            identity=lambda:tuple(getattr(os.lstat(root),field) for field in fields)
            frozen=identity()
            # Execute the actual persisted adapter functions only. /proc and FD9
            # are explicit observations, with no native ADMIN/service execution.
            adapter=ast.parse(admin.ADAPTER)
            functions=[n for n in adapter.body if isinstance(n,ast.FunctionDef) and n.name in
                ('_fixture_boundary','_fixture_database','_fixture_command')]
            self.assertEqual(len(functions),3)
            proxy=SimpleNamespace(**vars(os));proxy.fstat=lambda fd:SimpleNamespace(st_dev=1,st_ino=2) if fd==9 else os.fstat(fd)
            def fixture_open(path,*args,**kwargs):
                if path=='/proc/self/stat':return opened.enter_context(io.StringIO('99 (fixture) '+' '.join(['S']*19+['1234'])))
                # Own even the adapter's bare read handles until this test ends.
                return opened.enter_context(open(path,*args,**kwargs))
            scope={'_fixture_root':str(root),'_fixture_api':None,'_fixture_cutoff':R.time.time()+10000,
                '_fixture_remaining':10000,'_fixture_monotonic':R.time.monotonic(),'time':R.time,
                'require':R.require,'json':json,'os':proxy,'open':fixture_open,
                'bounded_command':lambda *a,**kw:self.fail('offline adapter attempted a command')}
            exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-admin-bookkeeping-adapter','exec'),scope)
            h=object.__new__(R.ProductionHost);h.pg='fixture';h.dbname=desired['identity']['databaseName']
            h._b0_reaffirm=lambda:self.assertEqual(identity(),frozen,'bookkeeping changed its protected root')
            h.boundary=lambda:scope['_fixture_boundary'](h)
            h.database_tuple=lambda:scope['_fixture_database'](h)
            h.command=lambda *args,**kwargs:scope['_fixture_command'](h,*args,**kwargs)
            h.quiet=h.supported_layout=h.authenticate_previous_passwords=lambda:None
            h.authenticate=lambda:R.require(False,'recovery_approval_expired')
            with (root/'archive.dump').open('rb') as stream:
                with self.assertRaisesRegex(R.RecoveryError,'recovery_approval_expired'):h.restore_database(stream,previous,desired)
                verify(expiry,root=root);self.assertEqual((root/'boundaries').read_bytes(),b'')
                h.authenticate=lambda:None
                h.restore_database(stream,previous,desired);effects=(root/'restore-count').read_bytes()
                history=(root/'boundaries').read_bytes();self.assertTrue(history)
                verify(once,root=root)
                h.restore_database(stream,previous,desired)
                verify(once,root=root);verify(unchanged,root=root,effects=effects)
                self.assertTrue((root/'boundaries').read_bytes().startswith(history))
                self.assertGreater(len((root/'boundaries').read_bytes()),len(history))
            with self.assertRaises(FileExistsError):admin.setup_profile(namespace)
            verify(once,root=root);verify(unchanged,root=root,effects=effects)
            self.assertEqual(identity(),frozen)
            with self.assertRaises(AssertionError):verify(expiry,root=root)
            with (root/'restore-count').open('ab') as out:out.write(b'restore\n')
            with self.assertRaises(AssertionError):verify(once,root=root)
            with self.assertRaises(AssertionError):verify(unchanged,root=root,effects=effects)

    def test_real_retained_b0_and_fixed_sibling_recovery_writers(self):
        runtime=load('retained_recovery_runtime','payload-control-runtime.py')
        with tempfile.TemporaryDirectory(prefix='recovery-retained-') as d:
            root=Path(d); state_root=root/'runtime'; backup=root/'backup'; directory=backup/'b0'; protection=root/'protection'
            for path in (state_root,directory,protection,root/'releases'):
                path.mkdir(parents=True,mode=0o700)
            inventory=runtime.INVENTORY.production_inventory(str(root),str(state_root),str(root/'releases'),
                str(root/'current-release'),str(state_root/'deploy.lock'),str(root/'daily'),str(backup),str(protection),
                str(root/'env'),str(root/'compose'),str(root/'payload'),'portal_qualified')
            binding,proof=install_material(root); identity=runtime.INVENTORY.identity(inventory)
            binding['inventoryIdentity']=proof['inventoryIdentity']=identity
            binding['candidate']['authorization']['inventoryIdentity']=identity
            key=b'K'*32
            (directory/'postgres.dump').write_bytes(b'offline archive bytes, not a PostgreSQL restore qualification\n'*1000)
            with tarfile.open(directory/'uploads.tar.gz','w:gz') as archive:
                entry=tarfile.TarInfo('.');entry.type=tarfile.DIRTYPE;entry.mode=0o700;archive.addfile(entry)
                data=b'actual upload bytes';entry=tarfile.TarInfo('source.txt');entry.size=len(data);entry.mode=0o600
                archive.addfile(entry,io.BytesIO(data))
            proof['dataFingerprints']['portalUploads']=runtime._archive_tree(str(directory/'uploads.tar.gz'))
            proof['artifacts']=[{'name':n,'sha256':R.sha((directory/n).read_bytes()),'size':(directory/n).stat().st_size}
                for n in S.LEGACY_ARTIFACTS]
            manifest=''.join(a['sha256']+'  '+a['name']+'\n' for a in proof['artifacts']).encode()
            (directory/'manifest.sha256').write_bytes(manifest)
            raw=S.canonical(S.sign_envelope(proof,key))+b'\n';(directory/'preauthority-proof.json').write_bytes(raw)
            binding['b0']['proofSha256']=R.sha(raw)
            for path in directory.iterdir():path.chmod(0o600)
            reserve_material(state_root,binding,proof,key)
            h=object.__new__(R.ProductionHost);h.r=runtime;h.s=S;h.storage=U;h.root=str(state_root);h.inventory=inventory
            h.base=str(state_root/('payload-b0-recovery-'+binding['receiptId']));h.baseline_path=os.path.join(h.base,'baseline.json')
            def host_read(path,owner,modes,cap):
                value=S._read_file(path,modes[0],private_owner=True);self.assertLessEqual(len(value),cap);return value
            h.l=SimpleNamespace(host_read=host_read);h.reload()
            # The actual baseline/event/evidence/progress writers below run in one
            # uninterrupted real artifacts() scope, never a BytesIO replacement.
            protected=[root,backup,directory,*directory.iterdir()]
            fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
            frozen={p:runtime._b0_identity(os.lstat(p)) for p in protected}
            original={p:p.read_bytes() for p in directory.iterdir()}
            journal_before=(state_root/'payload-control-state'/'current.json').read_bytes()
            with portable_retained_metadata(runtime,root) as (readers,opens,syncs),patch.object(S.time,'time',return_value=2000000001):
                with h.artifacts() as artifacts:
                    held=dict(artifacts['streams']);fds={n:stream.fileno() for n,stream in held.items()}
                    self.assertEqual(len(opens),4);self.assertEqual(list(held.values()),readers)
                    self.assertEqual(artifacts['proof'],proof);self.assertEqual(artifacts['manifest'],manifest)
                    def checked(writer, action):
                        value=action()
                        for path,before in frozen.items():
                            after=runtime._b0_identity(os.lstat(path))
                            self.assertEqual(before,after,{'writer':writer,'path':str(path),
                                'changedFields':[k for k,a,b in zip(fields,before,after) if a!=b]})
                        self.assertEqual({n:stream.fileno() for n,stream in held.items()},fds)
                        self.assertFalse(any(stream.closed for stream in held.values()));self.assertEqual(len(opens),4)
                        self.assertIs(h._b0_reaffirm,artifacts['reaffirm']);h._b0_reaffirm()
                        return value
                    checked('baseline-directory',lambda:os.mkdir(h.base,0o700))
                    baseline={'kind':'production-b0-recovery-baseline-v1','installBindingSha256':R.value_hash(binding),
                        'originStateSha256':h.head,'manifestSha256':R.sha(manifest),'database':tuple_value(),
                        'uploads':U.archive_manifest(held['uploads.tar.gz'])}
                    digest=checked('signed-baseline',lambda:h.signed_write(h.baseline_path,baseline))
                    checked('baseline-journal-and-head',lambda:S.bind_recovery_baseline(h.root,binding,{
                        'proofSha256':digest,'manifestSha256':baseline['manifestSha256'],'originStateSha256':h.head}))
                    h.reload();self.assertEqual(h.baseline(),baseline)
                    self.assertEqual(checked('baseline-idempotent-retry',lambda:h.signed_write(h.baseline_path,baseline)),digest)
                    decision={'schemaVersion':1,'kind':'production-exact-b0-acceptance-v1','installBindingSha256':S.value_sha256(binding),
                        'originStateSha256':h.head,'receiptId':binding['receiptId'],'manifestSha256':R.sha(manifest),
                        'qualificationEvidenceSha256':'c'*64,'procedureRevision':'d'*64,'acceptedAt':2000000000,'expiresAt':2000003600,
                        'authenticatedChannel':'independently-authenticated-admin-vps'}
                    checked('acceptance-journal-and-head',lambda:S.accept_b0(h.root,binding,decision,R.sha(R.canonical(decision)+b'\n')))
                    h.reload();plan=R.make_plan(h.body,h.head,'f'*64);approval=recovery_decision(plan)
                    decision_raw=R.canonical(approval)+b'\n'
                    h.l.protected=lambda path,*args:decision_raw if path==R.DECISION else self.fail('unexpected protected input')
                    checked('reservation-journal-and-head',lambda:S.begin_production_recovery(h.root,binding,plan,approval,R.sha(decision_raw)))
                    h.reload()
                    def advance(stage,proof=None):S.advance_production_recovery(h.root,binding,stage,proof);h.reload()
                    checked('quiesce-journal-and-head',lambda:advance('quiesce_pending'))
                    evidence=checked('signed-evidence',lambda:h.evidence('quiescence',{'resources':[]}))
                    self.assertEqual(h.read_evidence(evidence),{'resources':[]})
                    checked('quiesced-journal-and-head',lambda:advance('quiesced',('quiescence',evidence)))
                    checked('capture-journal-and-head',lambda:advance('protection_capture_pending'))
                    value={'attempt':0,'originStateSha256':h.head}
                    event=checked('signed-event-and-journal-and-head',lambda:h.event('capture-attempt',value))
                    self.assertEqual(h.signed_read(os.path.join(h.recovery_directory(),event+'.json')),value)
                    progress_path=os.path.join(h.recovery_directory(),'uploads-progress')
                    progress=checked('progress-directory',lambda:U.Progress(progress_path,S,key,R.value_hash(h.intent['recovery']['binding'])))
                    for record in ({'kind':'intent','index':0,'operation':'materialize'},{'kind':'complete','index':0}):
                        checked('signed-progress-append',lambda:progress.append(record))
                    resumed=checked('signed-progress-resume',lambda:U.Progress(progress_path,S,key,progress.binding))
                    self.assertEqual(resumed.records,progress.records)
                    self.assertEqual(resumed.previous,progress.previous)
                    self.assertNotEqual((state_root/'payload-control-state'/'current.json').read_bytes(),journal_before)
                    checked('final-explicit-reaffirm',artifacts['reaffirm'])
                self.assertTrue(all(stream.closed for stream in held.values()));self.assertIsNone(h._b0_reaffirm)
                self.assertEqual({p:p.read_bytes() for p in original},original);self.assertTrue(syncs)
                self.assertEqual({p:runtime._b0_identity(os.lstat(p)) for p in protected},frozen)
                with self.assertRaisesRegex(InterruptedError,'retained caller'):
                    with h.artifacts() as again:
                        second=list(again['streams'].values());again['reaffirm']()
                        raise InterruptedError('retained caller')
                self.assertTrue(all(stream.closed for stream in second));self.assertIsNone(h._b0_reaffirm)

    def test_absolute_ci_deadline_slow_failed_children_and_cleanup(self):
        spec=importlib.util.spec_from_file_location('portable_ci',REPO/'tests/fixtures/payload-production-recovery-ci.py')
        ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)
        now=[1800000000.0];mono=[0.0]
        env={'RECOVERY_CI_STARTED_MS':'1800000000000','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'2'}
        budget=ci.Budget(env,lambda:now[0],lambda:mono[0]);ci._budget=budget
        def spend(seconds): now[0]+=seconds;mono[0]+=seconds
        spawn=[];kills=[];waits=[]
        class Child:
            pid=99
            returncode=0
            def __init__(self,*a,**kw):spawn.append(kw);self.calls=0
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def communicate(self,data=None,timeout=None):
                self.calls+=1;waits.append(timeout)
                if self.calls==1:
                    spend(timeout)
                    raise ci.subprocess.TimeoutExpired('simulated slow child',timeout)
                spend(10);self.returncode=-9;return b'',b''
        with patch.dict(ci.os.environ,env),patch.object(ci.subprocess,'Popen',Child),patch.object(ci.os,'killpg',lambda *a:kills.append(a),create=True),patch.object(ci.signal,'SIGKILL',9,create=True):
            with self.assertRaises(ci.subprocess.TimeoutExpired):ci.run(['slow'],timeout=4000)
            self.assertEqual(waits,[2270,10]);self.assertEqual(len(kills),1)
            self.assertEqual(spawn[0]['env']['GITHUB_RUN_ATTEMPT'],'2')
            with self.assertRaisesRegex(RuntimeError,'insufficient'):ci.run(['late'],timeout=30)
            self.assertEqual(len(spawn),1)
            ci._cleanup=True
            class Cleanup(Child):
                def communicate(self,data=None,timeout=None):
                    spend(120);return b'cleanup verified',b''
            with patch.object(ci.subprocess,'Popen',Cleanup):
                self.assertEqual(ci.run(['cleanup'],timeout=300),b'cleanup verified')
            self.assertEqual(budget.deadline,1800002700)
            self.assertEqual(budget.available(True),240)
            # A failed child still leaves the same original cleanup cutoff.
            class Failed(Cleanup):returncode=7
            with patch.object(ci.subprocess,'Popen',Failed),self.assertRaisesRegex(RuntimeError,'fixture command failed'):
                ci.run(['failed-cleanup'],timeout=200)
            self.assertEqual(budget.available(True),120)
            now[0]-=100 # Clock correction does not renew the monotonic allowance.
            self.assertEqual(budget.available(True),120)
            spend(121)
            with self.assertRaisesRegex(RuntimeError,'insufficient'):ci.run(['too-late'],timeout=5)
        for missing in env:
            with self.assertRaises(RuntimeError):ci.Budget({k:v for k,v in env.items() if k!=missing})

    def test_mountinfo_aliases_descendants_escapes_and_ambiguity(self):
        raw = b'1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 /protected /srv/alias\\040space rw - ext4 /dev/root rw\n'
        topology=object.__new__(R.LinuxMounts);topology.rows=R.LinuxMounts.parse(raw);topology.paths={}
        # Explicit stat observations; no native mount/OS calls in portable tests.
        topology.ancestry=lambda p:[(2049,1),(2049,2)]
        with patch.object(R.os,'major',lambda dev:8,create=True),patch.object(R.os,'minor',lambda dev:1,create=True):
            self.assertTrue(topology.overlap('/srv/alias space','/protected'))
            self.assertTrue(topology.overlap('/srv/alias space/child','/protected'))
            self.assertTrue(topology.overlap('/srv','/protected/child'))
            self.assertFalse(topology.overlap('/srv/alias space-sibling','/protected'))
        for malformed in (raw+raw,raw.replace(b'8:1',b'invalid'),raw.replace(b'/srv/alias\\040space',b'/')):
            with self.assertRaises(R.RecoveryError):R.LinuxMounts.parse(malformed)
        changed=object.__new__(R.LinuxMounts);changed.ns='old';changed.namespace=lambda:'new'
        with self.assertRaisesRegex(R.RecoveryError,'recovery_mount_topology_changed'):changed.reaffirm()

    def test_owned_mount_cleanup_refuses_identity_replacement(self):
        spec=importlib.util.spec_from_file_location('portable_mount_ci',REPO/'tests/fixtures/payload-production-recovery-ci.py')
        ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)
        with tempfile.TemporaryDirectory() as directory:
            owned=object.__new__(ci.Owned);owned.root=Path(directory)
            path=str(owned.root/'mount-probe');commands=[];rows=[{'path':path,'id':7}]
            topology=SimpleNamespace(rows=rows,ns=[[1,2],[['123','456']]],coordinates=lambda p:('8:1','/protected'),reaffirm=lambda:None)
            record={'path':path,'id':7,'uniqueId':70,'phase':'prepared','bootId':'boot',
                'sourceIdentity':[2049,2],'targetIdentity':[2049,3],
                'namespace':topology.ns,'coordinate':['8:1','/protected']}
            class Mounts:
                def __new__(cls):return topology
                @staticmethod
                def open_path(path):return 999,[(2049,2)]
                @staticmethod
                def ancestry(path):return [(2049,3)]
            owned.mount_api=lambda:SimpleNamespace(ids=lambda fd:(7,70))
            with patch.object(ci,'load',lambda *a:SimpleNamespace(LinuxMounts=Mounts)),patch.object(ci,'run',lambda *a,**kw:commands.append(a)),patch.object(ci,'boot_id',lambda:'boot'),patch.object(ci.os,'close',lambda fd:None):
                for change in ({'id':8},{'id':None},{'uniqueId':None},{'uniqueId':71},{'bootId':'reboot'},{'namespace':[]},{'coordinate':['8:1','/foreign']}):
                    (owned.root/'owned-mounts.json').write_bytes(ci.canonical([dict(record,**change)]))
                    with self.assertRaisesRegex(RuntimeError,'owned mount identity changed'):owned.cleanup_mounts()
                    self.assertEqual(commands,[])
                (owned.root/'owned-mounts.json').write_bytes(ci.canonical([record]))
                def unmount(args):commands.append(args);rows.clear()
                with patch.object(ci,'run',unmount):self.assertEqual(owned.cleanup_mounts(),1)
                self.assertEqual(commands,[['/usr/bin/umount','--',Path(path)]])

    def test_detached_mount_identity_is_published_before_attach_and_survives_completion_gap(self):
        spec=importlib.util.spec_from_file_location('portable_acquire_ci',REPO/'tests/fixtures/payload-production-recovery-ci.py')
        ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)
        with tempfile.TemporaryDirectory() as directory:
            owned=object.__new__(ci.Owned);owned.root=Path(directory)
            events=[];rows=[]
            topology=SimpleNamespace(rows=rows,ns=[[1,2],[]],coordinates=lambda p:('8:1','/protected'),reaffirm=lambda:None)
            class Mounts:
                def __new__(cls):return topology
                @staticmethod
                def open_path(path):return (101,[(2049,2)]) if path=='/source' else (102,[(2049,3)])
            def persist(root,records):
                events.append(('receipt',copy.deepcopy(records)))
                (root/'owned-mounts.json').write_bytes(ci.canonical(records))
            def attach(mount_fd,target_fd):
                records=json.loads((owned.root/'owned-mounts.json').read_bytes())
                self.assertEqual((records[0]['id'],records[0]['uniqueId'],records[0]['phase']),(7,70,'prepared'))
                events.append(('attach',mount_fd,target_fd));rows.append({'path':records[0]['path'],'id':7})
            owned.mount_api=lambda:SimpleNamespace(clone=lambda fd:103,ids=lambda fd:(7,70),attach=attach)
            def crash():raise RuntimeError('simulated killed acquisition child')
            with patch.object(ci,'load',lambda *a:SimpleNamespace(LinuxMounts=Mounts)),patch.object(ci,'durable_mount_receipts',persist),patch.object(ci,'boot_id',lambda:'boot'),patch.object(ci,'budget',lambda:SimpleNamespace(window=lambda *a:30)),patch.object(ci.os,'close',lambda fd:events.append(('close',fd))):
                with self.assertRaisesRegex(RuntimeError,'simulated killed'):owned.bind_mount('/source','gap',after_attach=crash)
            self.assertEqual(events[0][0],'receipt');self.assertEqual(events[1],('attach',103,102))
            self.assertEqual(events[2:],[('close',103),('close',102),('close',101)])
            self.assertEqual(json.loads((owned.root/'owned-mounts.json').read_bytes())[0]['phase'],'prepared')

    def test_effective_retained_mounts_and_container_identity_changes_refuse(self):
        container={'Id':'a'*64,'Created':'created','Config':{},'HostConfig':{'Privileged':False},
            'GraphDriver':{'Name':'overlay2'},'State':{'Running':True,'Pid':123,'StartedAt':'original'},
            'Mounts':[{'Type':'bind','Source':'/now-unrelated','Destination':'/foreign','RW':False}]}
        raw=b'1 0 0:99 / / rw - overlay overlay rw\n2 1 8:1 /protected /foreign ro - ext4 /dev/root rw\n'
        effective=object.__new__(R.ContainerMounts);effective.container=container;effective.root=999;effective.paths={}
        effective.rows=R.LinuxMounts.parse(raw)
        closes=[];effective.close=lambda:closes.append(True);effective.reaffirm=lambda:None
        topology=SimpleNamespace(regions=lambda path:[('8:1','/protected')])
        with patch.object(R,'ContainerMounts',lambda c:effective),patch.object(R.LinuxMounts,'open_path',lambda *a:(998,[(2049,4)])),patch.object(R.os,'close',lambda fd:None),patch.object(R.os,'major',lambda dev:8,create=True),patch.object(R.os,'minor',lambda dev:1,create=True):
            with self.assertRaisesRegex(R.RecoveryError,'recovery_foreign_consumer'):
                R.verify_effective_container_mounts(container,topology,['/protected'],lambda _: [container])
            self.assertEqual(len(closes),1)
            effective.rows[1]['root']='/unrelated'
            R.verify_effective_container_mounts(container,topology,['/protected'],lambda _: [container])
            for changed in ({'Pid':124},{'StartedAt':'restarted'},{'Running':False}):
                newer=copy.deepcopy(container);newer['State'].update(changed)
                with self.assertRaisesRegex(R.RecoveryError,'recovery_effective_mount_changed'):
                    R.verify_effective_container_mounts(container,topology,['/protected'],lambda _: [newer])
            effective.rows[1]['fs']='unqualified'
            with self.assertRaisesRegex(R.RecoveryError,'recovery_effective_mount_unprovable'):
                R.verify_effective_container_mounts(container,topology,['/protected'],lambda _: [container])
            self.assertEqual(len(closes),6)

    def test_effective_pid_start_namespace_and_mount_table_are_reaffirmed(self):
        effective=object.__new__(R.ContainerMounts)
        effective.pid=123;effective.proc=10;effective.start=b'99';effective.cgroup=b'group';effective.raw=b'mounts'
        effective.ns_identity=(1,2);effective.root_identity=(1,3);effective.paths={}
        fields=[b'S']*20;fields[19]=b'99'
        values={'stat':b'123 (name) '+b' '.join(fields),'cgroup':b'group','mountinfo':b'mounts'}
        effective.read=lambda name,cap:values[name]
        identities={'/proc/123':(1,1),'ns/mnt':(1,2),'root':(1,3)}
        def info(pair):return SimpleNamespace(st_dev=pair[0],st_ino=pair[1])
        with patch.object(R.os,'fstat',lambda fd:info((1,1))),patch.object(R.os,'stat',lambda name,**kw:info(identities[name])):
            effective.reaffirm()
            for name in values:
                saved=values[name];values[name]=saved.replace(b'99',b'98') if name=='stat' else b'changed'
                with self.assertRaisesRegex(R.RecoveryError,'recovery_effective_mount_changed'):effective.reaffirm()
                values[name]=saved
            for name in identities:
                saved=identities[name];identities[name]=(2,2)
                with self.assertRaisesRegex(R.RecoveryError,'recovery_effective_mount_changed'):effective.reaffirm()
                identities[name]=saved

    def test_foreign_mounts_and_namespaces_rejected_before_resource_exclusion(self):
        # This existing test isolates container discovery/namespace decisions.
        # Kernel alias resolution is exercised separately, and by native CI.
        lexical=SimpleNamespace(regions=lambda p:[],reaffirm=lambda:None,
            overlap=lambda a,b:R.path_contains(R.linux_path(a),R.linux_path(b)) or R.path_contains(R.linux_path(b),R.linux_path(a)))
        patched=patch.object(R,'LinuxMounts',lambda:lexical);patched.start();self.addCleanup(patched.stop)
        project='fixture-project'; target='/var/lib/docker/volumes/portal_uploads/_data'
        protected={'Id':'a'*64,'Name':'/postgres','Config':{'Labels':{'com.docker.compose.project':project}},
            'HostConfig':{'NetworkMode':'bridge'},'Mounts':[]}
        def foreign(source=None,readonly=False):
            return {'Id':'b'*64,'Name':'/foreign','Config':{'Labels':{}},
                'HostConfig':{'NetworkMode':'none','RestartPolicy':{'Name':'always'}},
                'State':{'Running':True},'Mounts':[] if source is None else
                    [{'Type':'bind','Source':source,'Destination':'/elsewhere','RW':not readonly}]}
        for source in (target,target+'/child','/var/lib/docker/volumes','/',target+'/../_data','//var/lib/docker/volumes/portal_uploads/_data'):
            for readonly in (False,True):
                for running in (False,True):
                    with self.subTest(source=source,readonly=readonly,running=running):
                        other=foreign(source,readonly);other['State']['Running']=running
                        with self.assertRaisesRegex(R.RecoveryError,'recovery_foreign_consumer'):
                            R.reject_foreign_resource_access([other,protected],project,{'portal_uploads'},[target])
        with self.assertRaisesRegex(R.RecoveryError,'recovery_effective_mount_unprovable'):
            R.reject_foreign_resource_access([foreign(target+'-sibling'),protected],project,{'portal_uploads'},[target])
        for field in ('NetworkMode','PidMode','IpcMode'):
            for selector in ('postgres','a'*64,'a'*12):
                other=foreign();other['HostConfig'][field]='container:'+selector
                with self.assertRaisesRegex(R.RecoveryError,'recovery_foreign_namespace'):
                    R.reject_foreign_resource_access([other,protected],project,{'portal_uploads'},[target])
        other=foreign('/var/lib/docker/volumes/alias/_data')
        other['Mounts'][0].update(Type='volume',Name='alias')
        backing=R.volume_backing_paths({'Driver':'local','Scope':'local','Mountpoint':'/var/lib/docker/volumes/alias/_data',
            'Options':{'type':'none','o':'bind','device':target}})
        with self.assertRaisesRegex(R.RecoveryError,'recovery_foreign_consumer'):
            R.reject_foreign_resource_access([other,protected],project,{'portal_uploads'},[target],volume_sources={'alias':backing})
        # Exercise placement in resources(): no listener/network observation can
        # conceal this unrelated, networkless bind writer before the filter.
        h=object.__new__(R.ProductionHost);expected={'name':'portal_uploads','mountpoint':target}
        h.binding={'portalTarget':{'volumes':{'portalUploads':expected}}}
        h.inventory={'project':project,'volumes':{'cmsUploads':{'name':'cms'}}}
        h.intent={'creation':{'volumes':{},'containers':{}}}
        h.r=SimpleNamespace(_volume_info=lambda name:expected,_volume_receipt=lambda raw:expected)
        h.command=lambda args:('a'*64+'\n'+'b'*64+'\n').encode()
        def docker(*args):
            if args[0]=='context':return 'unix:///var/run/docker.sock'
            if args[0]=='inspect':return [foreign(target),protected]
            if args[:2]==('volume','inspect'):return [{'Name':'portal_uploads','Driver':'local','Scope':'local','Mountpoint':target}]
            raise AssertionError('filter reached later topology checks')
        h.docker_json=docker
        with self.assertRaisesRegex(R.RecoveryError,'recovery_foreign_consumer'):h.resources()

    def test_unsupported_classes_deny_before_restore_even_if_previous_tuple_matches(self):
        for kind in R.UNSUPPORTED_CLASSES:
            h=object.__new__(R.ProductionHost);calls=[]
            h.sql=lambda query:dict.fromkeys(R.UNSUPPORTED_CLASSES,0)|{kind:1}
            h.boundary=lambda:None;h.quiet=lambda:None
            h.database_tuple=lambda:tuple_value('b')
            h.command=lambda *a,**k:calls.append(a)
            with self.subTest(kind=kind),self.assertRaisesRegex(R.RecoveryError,'recovery_object_class_unsupported'):
                h.restore_database(io.BytesIO(),tuple_value('b'),tuple_value())
            self.assertEqual(calls,[])

    def test_readiness_refresh_closed_lineage_and_pending_credential_can_expire(self):
        old=b'a'*40+b'.'+b'b'*40+b'.'+b'c'*80+b'\n'
        new=old.replace(b'c',b'd');next_token=old.replace(b'c',b'e')
        for invalid in (old.strip(),old+b'\n',b'a'*120+b'\n',old.replace(b'.',b'/'),b'x'*16385):
            with self.assertRaises(R.RecoveryError):R.readiness_token(invalid)
        h=object.__new__(R.ProductionHost);h.s=S;h.profile_raw=b'profile';current=[old];verified=[];events={}
        recovery={'stage':'legacy_start_pending','binding':{'plan':{'contractSha256':'f'*64}},'events':[]}
        h.intent={'recovery':recovery};h.inspect=lambda:None;h.decision_digest=lambda:R.sha(b'decision')
        h.load_contract=lambda:({},'f'*64);h.recovery_directory=lambda **kw:'/evidence'
        h.l=SimpleNamespace(protected=lambda p,*a:b'decision' if p==R.DECISION else current[0])
        h.signed_read=lambda p:events[Path(p).name.removesuffix('.json')]
        h.verify_readiness_token=lambda token:verified.append(token)
        request={'kind':'production-b0-readiness-credential-v1','purpose':'refresh-fixed-readiness-identity',
            'decisionSha256':h.decision_digest(),'contractSha256':'f'*64,'recoveryBindingSha256':R.value_hash(recovery['binding']),
            'profileSha256':R.sha(h.profile_raw),'previousTokenSha256':R.sha(old),'tokenSha256':R.sha(new)}
        raw=R.canonical(request)+b'\n';value,previous,intended,completed=h.credential_refresh(raw,new)
        self.assertEqual((previous,intended,completed),(old,False,False));self.assertEqual(verified,[new])
        for field in ('decisionSha256','contractSha256','recoveryBindingSha256','profileSha256','previousTokenSha256','tokenSha256'):
            count=len(verified)
            with self.subTest(field=field),self.assertRaises(R.RecoveryError):
                h.credential_refresh(R.canonical(dict(request,**{field:'0'*64}))+b'\n',new)
            self.assertEqual(len(verified),count)
        with self.assertRaises(R.RecoveryError):h.credential_refresh(R.canonical(dict(request,uid='foreign'))+b'\n',new)
        digest=R.value_hash(value);events[digest]=value
        recovery['events'].append({'kind':'readiness-credential-intent','sha256':digest})
        # Lost completion after publication accepts only the exact intended hash.
        current[0]=new
        self.assertEqual(h.credential_refresh(raw,new)[2:],(True,False))
        # A now-expired pending candidate must not permanently block a separately
        # authenticated refresh from the actual installed credential.
        next_request=dict(request,previousTokenSha256=R.sha(new),tokenSha256=R.sha(next_token))
        self.assertEqual(h.credential_refresh(R.canonical(next_request)+b'\n',next_token)[2:],(False,False))
        def invalid_identity(token):raise R.RecoveryError('recovery_application_probe_failed')
        h.verify_readiness_token=invalid_identity
        with self.assertRaisesRegex(R.RecoveryError,'recovery_application_probe_failed'):h.credential_refresh(raw,new)
        self.assertEqual(current[0],new)

    def test_private_start_create_receipt_and_start_gaps_reconcile(self):
        for gap in ('create','start'):
            with self.subTest(gap=gap):
                events=[];containers={};calls=[];crashed=[False]
                h=object.__new__(R.ProductionHost)
                h.binding={'previousImages':{s:'ghcr.io/ownerinc/ownerinc-portal-'+s+'@sha256:'+'a'*64 for s in ('api','cron')},
                    'portalTarget':{'volumes':{'portalUploads':{'name':'uploads'}}}}
                h.profile={'readiness':{'apiEnvironmentSha256':'b'*64,'cronEnvironmentSha256':'c'*64,'egressNetworkId':'e'*64},
                    'topology':{'networks':[{'Name':'ownerinc-portal-backend','Id':'d'*64}]}}
                h.profile_raw=b'profile';h.decision_digest=lambda:'f'*64
                h.environments=lambda:{s:({'NODE_ENV':'production','DATABASE_URL':'postgresql://fixture'},'fixture') for s in ('api','cron')}
                h.container_events=lambda kind,service:[v for k,v in events if k==kind and v['service']==service]
                h.event=lambda kind,value:events.append((kind,copy.deepcopy(value)))
                h.boundary=lambda **kw:None
                h.verify_application=lambda:{'containers':sorted(h.application_containers())}
                def command(args,**kw):
                    if args[1]=='ps':return ('\n'.join(c['Id'] for c in containers.values())+'\n').encode() if containers else b''
                    if args[1]=='create':
                        service=args[args.index('--name')+1].rsplit('-',1)[1];spec=h.application_spec(service)
                        assert {'service':service,'effect':'create','spec':spec} in h.container_events('container-intent',service)
                        assert service not in containers
                        containers[service]={'Id':('1' if service=='api' else '2')*64,'Created':'fixture','Name':'/'+spec['name'],
                            'Config':{'Image':spec['image'],'Entrypoint':['node'],'Cmd':['index.js'],'WorkingDir':'/app',
                            'Env':['NODE_ENV=production','DATABASE_URL=postgresql://fixture'],
                            'Labels':{'io.ownerinc.b0-recovery':'f'*64,'io.ownerinc.b0-service':service}},
                            'HostConfig':{'ReadonlyRootfs':True,'Privileged':False,'PortBindings':{},'RestartPolicy':{'Name':'no'},
                                'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],'Devices':[],'Binds':None,'VolumesFrom':None},
                            'Mounts':[{'Name':'uploads','Destination':'/app/uploads','RW':False}],
                            'NetworkSettings':{'Networks':{n:{'NetworkID':n} for n in spec['networks']}},
                            'State':{'Running':False,'Status':'created'}}
                        calls.append(('create',service))
                    elif args[1]=='start':
                        service=next(s for s,c in containers.items() if c['Id']==args[2]);c=containers[service]
                        assert h.container_events('container-receipt',service)
                        assert {'service':service,'effect':'start','id':c['Id']} in h.container_events('container-intent',service)
                        c['State']={'Running':True,'Status':'running'};calls.append(('start',service))
                    else:raise AssertionError(args)
                    if args[1]==gap and not crashed[0]:crashed[0]=True;raise InterruptedError('effect gap')
                    return b''
                h.command=command
                h.docker_json=lambda *args:[c for c in containers.values() if c['Id'] in args[1:]]
                with self.assertRaises(InterruptedError):h.start_previous_application()
                result=h.start_previous_application()
                self.assertEqual(result,{'containers':['api','cron']})
                self.assertEqual(calls,[('create','api'),('start','api'),('create','cron'),('start','cron')])
                h.start_previous_application();self.assertEqual(len(calls),4)
                containers['api']['HostConfig']['PortBindings']={'3000/tcp':[{'HostPort':'3000'}]}
                with self.assertRaises(R.RecoveryError):h.application_containers()

    def test_clone_correspondence_cannot_be_a_pass_or_data_only_assertion(self):
        baseline={'manifestSha256':'a'*64,'archiveSchemaSha256':'b'*64,'uploads':{},'database':tuple_value()}
        evidence={'kind':'production-b0-recovery-clone-measurements-v1','manifestSha256':'a'*64,
            'archiveSchemaSha256':'b'*64,'uploadsSha256':R.value_hash({}),
            **{k:baseline['database'][k] for k in baseline['database'] if k!='identity'}}
        R.validate_clone_measurements(evidence,baseline,baseline['database'])
        for field in evidence:
            with self.subTest(field=field),self.assertRaises(R.RecoveryError):
                R.validate_clone_measurements(dict(evidence,**{field:'f'*64}),baseline,baseline['database'])
        with self.assertRaises(R.RecoveryError):R.validate_clone_measurements({'status':'PASS'},baseline)

    def test_executor_all_checkpoints_resume_with_original_evidence(self):
        for interrupted in S.PRODUCTION_RECOVERY_STAGES[1:]:
            with self.subTest(interrupted=interrupted), tempfile.TemporaryDirectory() as d:
                binding=accepted(Path(d));body,head=S.read_state(d)[2:]
                plan=R.make_plan(body,head,'f'*64);decision=recovery_decision(plan)
                desired=tuple_value();previous=dict(desired,dataSha256='b'*64)
                effects={'database':0,'uploads':0,'start':0,'capture':0}; current=[previous];evidence={}
                class Host(R.ProductionHost):
                    def __init__(self):
                        self.root=d;self.s=S;self.binding=binding;self.pg='fixture';self.dbname='portal_qualified'
                        self.reload()
                        self.storage=SimpleNamespace(Progress=lambda *a:None,archive_manifest=lambda *a:{},
                            restore=self.uploads)
                    def uploads(self,*args):effects['uploads']+=1;return 'a'*64
                    def reload(self):
                        self.key,_,self.body,self.head=S.read_state(d);self.intent=self.body['installIntent']
                    def inspect(self,*a):return plan
                    def load_contract(self,*a):return {'restored':desired},'f'*64
                    def boundary(self,**kw):return {'resources':[]}
                    def quiet(self):pass
                    def supported_layout(self):pass
                    def authenticate_previous_passwords(self):pass
                    def database_tuple(self):return current[0]
                    def command(self,*a,**kw):effects['database']+=1;current[0]=desired
                    def evidence(self,kind,value):
                        digest=R.value_hash({'kind':kind,'value':value});evidence[digest]=value;return digest
                    def read_evidence(self,digest):return evidence[digest]
                    def protection(self):
                        effects['capture']+=1
                        return {'previousDatabase':previous,'previousUploads':{}}
                    def verify_protection(self,value):self.assert_protection(value)
                    def assert_protection(self,value):assert value['previousDatabase']==previous
                    def baseline(self):return {'uploads':{}}
                    def recovery_directory(self):return d
                    def start_previous_application(self):
                        # Dedicated start reconciles an existing receipted process.
                        effects['start']=1;return {'ready':True}
                    def verify_application(self):return {'ready':True}
                    @contextmanager
                    def artifacts(self):yield {'streams':{'postgres.dump':io.BytesIO(b'fixture'),'uploads.tar.gz':io.BytesIO(b'fixture')}}
                advance=S.advance_production_recovery
                def crash(*args,**kwargs):
                    result=advance(*args,**kwargs)
                    if args[2]==interrupted:raise InterruptedError('checkpoint')
                    return result
                contract=Path(d)/'contract';contract.write_bytes(b'fixture')
                with patch.object(R,'CONTRACT',str(contract)),patch.object(S.time,'time',return_value=2000000001):
                    with patch.object(S,'advance_production_recovery',side_effect=crash),self.assertRaises(InterruptedError):
                        Host().execute(R.canonical(decision)+b'\n')
                    original=S.read_state(d)[2]['installIntent']
                    result=Host().execute(R.canonical(decision)+b'\n')
                self.assertEqual(result['status'],'legacy_ready_held')
                self.assertEqual(effects,{'database':1,'uploads':1,'start':1,'capture':1})
                final=S.read_state(d)[2]['installIntent']
                self.assertEqual({k:v for k,v in original.items() if k!='recovery'},
                                 {k:v for k,v in final.items() if k!='recovery'})

    def test_restored_first_and_unknown_tuple(self):
        target = tuple_value(); previous = dict(target,dataSha256='b'*64)
        self.assertEqual(R.classify_database(target,target,target),'restored')
        self.assertEqual(R.classify_database(previous,target,previous),'previous')
        for field in set(target)-{'identity'}:
            with self.subTest(field=field), self.assertRaises(R.RecoveryError):
                R.classify_database(dict(previous,**{field:'c'*64}),target,previous)
        with self.assertRaises(R.RecoveryError):
            R.classify_database(dict(previous,identity=dict(previous['identity'],databaseOid='99999')),target,previous)

    def test_restore_effect_count_and_previous_backend_guard(self):
        h = object.__new__(R.ProductionHost)
        target = tuple_value(); previous = dict(target,dataSha256='b'*64)
        h.pg='fixture'; h.dbname='portal_qualified'; effects=[]; current=[target]
        h.boundary=lambda:None; h.quiet=lambda:None; h.database_tuple=lambda:current[0]
        h.supported_layout=lambda:None
        h.authenticate_previous_passwords=lambda:None
        def command(argv,**kw):
            effects.append(argv); current[0]=target
        h.command=command
        h.restore_database(io.BytesIO(b'archive'),target,target)
        self.assertEqual(effects,[])
        current[0]=previous;h.restore_database(io.BytesIO(b'archive'),previous,target)
        self.assertEqual(len(effects),1)
        self.assertIn('--single-transaction',effects[0]); self.assertIn('--clean',effects[0])
        h.restore_database(io.BytesIO(b'archive'),previous,target)
        self.assertEqual(len(effects),1)
        current[0]=previous
        h.quiet=lambda: R.require(False,'recovery_database_busy')
        with self.assertRaises(R.RecoveryError):h.restore_database(io.BytesIO(),previous,target)
        self.assertEqual(len(effects),1)

    def test_baseline_before_accept_and_no_retrofit(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); b=reserved(root)
            old=S.read_state(d)
            with self.assertRaises(S.StateError):S.advance_install(d,b,'portal_grants_pending')
            self.assertEqual(old,S.read_state(d))
            ref={'proofSha256':'a'*64,'manifestSha256':'b'*64,'originStateSha256':old[3]}
            S.bind_recovery_baseline(d,b,ref)
            snapshot=S.read_state(d);S.bind_recovery_baseline(d,b,ref);self.assertEqual(snapshot,S.read_state(d))
            with self.assertRaises(S.StateError):S.bind_recovery_baseline(d,b,dict(ref,proofSha256='c'*64))
            with self.assertRaises(S.StateError):S.transition(d,lambda x:x['installIntent']['binding'].pop('recoveryGateVersion'))

    def test_signed_progress_expiry_replay_and_immutability(self):
        with tempfile.TemporaryDirectory() as d:
            b=accepted(Path(d)); body,head=S.read_state(d)[2:]
            plan=R.make_plan(body,head,'f'*64); decision=recovery_decision(plan)
            digest=R.sha(S.canonical(decision)+b'\n')
            with patch.object(S.time,'time',return_value=2000003600), self.assertRaises(S.StateError):
                S.begin_production_recovery(d,b,plan,decision,digest)
            with patch.object(S.time,'time',return_value=2000000001):
                S.begin_production_recovery(d,b,plan,decision,digest)
            with self.assertRaises(S.StateError):S.advance_production_recovery(d,b,'protection_verified',('protection','1'*64))
            for stage,proof in [('quiesce_pending',None),('quiesced',('quiescence','1'*64)),('protection_capture_pending',None),
                                ('protection_verified',('protection','2'*64))]:
                S.advance_production_recovery(d,b,stage,proof)
            with patch.object(S.time,'time',return_value=2000003600), self.assertRaises(S.StateError):
                S.advance_production_recovery(d,b,'database_restore_pending')
            # Crash after signed append before head: fresh module, expired clock,
            # exact unique child repair, no renewal or backdating.
            with patch.object(S.time,'time',return_value=2000003599), patch.object(S,'_atomic_replace',side_effect=OSError('crash')):
                with self.assertRaises(OSError):S.advance_production_recovery(d,b,'database_restore_pending')
            fresh=load('fresh_recovery_state','payload-control-state.py')
            with patch.object(fresh.time,'time',return_value=2000007200):
                fresh.read_state(d,repair_head=True)
                for stage,proof in [('database_restored',('database','3'*64)),('uploads_restore_pending',None),
                    ('uploads_restored',('uploads','4'*64)),('data_verified_readiness_pending',None),
                    ('legacy_start_pending',None),('legacy_ready_held',('application','5'*64))]:
                    fresh.advance_production_recovery(d,b,stage,proof)
            final=fresh.read_state(d)
            self.assertEqual(final[2]['installIntent']['stage'],'reserved')
            self.assertEqual(final[2]['admission'],'closed');self.assertIs(final[2]['workerHold'],True)
            for change in [lambda x:x['installIntent'].pop('recovery'),lambda x:x.update(admission='open'),
                lambda x:x['installIntent'].pop('b0RecoveryBaseline'),lambda x:x['installIntent']['recovery']['proofs'].update(database='f'*64)]:
                with self.assertRaises(fresh.StateError):fresh.transition(d,change)
            self.assertEqual(final,fresh.read_state(d))
            binding_before=copy.deepcopy(final[2]['installIntent']['recovery']['binding'])
            with patch.object(fresh.time,'time',return_value=2000010000):
                for kind in ('readiness-credential-intent','readiness-credential-receipt'):
                    fresh.advance_production_recovery(d,b,'legacy_ready_held',event={'kind':kind,'sha256':'6'*64})
            renewed=fresh.read_state(d)[2]
            self.assertEqual(renewed['installIntent']['recovery']['binding'],binding_before)
            self.assertEqual(renewed['installIntent']['recovery']['proofs'],final[2]['installIntent']['recovery']['proofs'])
            self.assertEqual(renewed['admission'],'closed')

    def test_approval_and_acyclic_plan(self):
        with tempfile.TemporaryDirectory() as d:
            accepted(Path(d));body,head=S.read_state(d)[2:];plan=R.make_plan(body,head,'f'*64)
            decision=recovery_decision(plan)
            S.validate_production_recovery_decision(decision,plan)
            for k,v in [('kind','production-exact-b0-acceptance-v1'),('approvedAt',True),('expiresAt',2000003601),
                        ('authenticatedChannel','root'),('command','pg_restore')]:
                with self.assertRaises(S.StateError):S.validate_production_recovery_decision(dict(decision,**{k:v}),plan)
            self.assertNotEqual(R.value_hash(decision),R.sha(R.canonical(decision)+b'\n'))
            self.assertEqual(plan,R.make_plan(body,head,'f'*64))
            for stage in ('floor_commit_pending','floor_committed'):
                changed=copy.deepcopy(body['installIntent']);changed['stage']=stage
                with self.assertRaises(S.StateError):S.validate_production_recovery_plan(dict(plan,originInstallStage=stage),changed)

    def test_all_cms_prefix_tables_are_source_derived_and_observed(self):
        files=sorted((REPO/'cms/src/migrations').glob('*.json'))
        self.assertEqual(len(files),6)
        for index,p in enumerate(files,1):
            tables={n.removeprefix('public.') for n in json.loads(p.read_text())['tables']}
            self.assertEqual(tables,R.CMS_PREFIXES[index],p.name)
            rows={t:0 for t in tables};rows['payload_migrations']=index
            profile={'cmsCatalogs':['a'*64]*7}
            with self.assertRaisesRegex(R.RecoveryError,'recovery_native_history_unprovable'):
                R.cms_prefix(S.CMS_MIGRATIONS[:index],tables,rows,'a'*64,profile,S.CMS_MIGRATIONS)
            for table in tables-{'payload_migrations'}:
                with self.assertRaises(R.RecoveryError):R.cms_prefix(S.CMS_MIGRATIONS[:index],tables,dict(rows,**{table:1}),'a'*64,profile,S.CMS_MIGRATIONS)
            with self.assertRaises(R.RecoveryError):R.cms_prefix(S.CMS_MIGRATIONS[:index],tables-{'news_media'},rows,'a'*64,profile,S.CMS_MIGRATIONS)
        self.assertEqual(R.cms_prefix([],[],{},'a'*64,profile,S.CMS_MIGRATIONS),0)
        self.assertEqual(R.cms_prefix([],['payload_migrations'],{'payload_migrations':0},'a'*64,profile,S.CMS_MIGRATIONS),0)

    def test_allow_cms_never_skips_history_eligibility(self):
        for allow in (False,True):
            h=object.__new__(R.ProductionHost);effects=[]
            h.authenticate=lambda:None;h.resources=lambda *a:[];h.quiet=lambda:None
            h.sql=lambda q:0 if 'authority_transitions' in q else 1
            def refuse():raise R.RecoveryError('recovery_native_history_unprovable')
            h.cms_observation=refuse;h.witness=lambda:effects.append('witness')
            with self.assertRaisesRegex(R.RecoveryError,'recovery_native_history_unprovable'):
                h.boundary(allow_cms=allow)
            self.assertEqual(effects,[])

    def test_witness_closed_response_contract_not_transport_or_502(self):
        profile={'kind':'production-b0-witness-profile-v1','routes':[{'route':p,'status':503,'bodySha256':R.sha(b'held')} for p in W.ROUTES]}
        raw=W.canonical(profile)+b'\n'
        request={'kind':'production-b0-witness-request-v1','nonce':'a'*64,'contextSha256':'b'*64,'profileSha256':R.sha(raw)}
        response=W.respond(W.canonical(request)+b'\n',raw,lambda _: (503,b'held'))
        self.assertEqual(response['nonce'],request['nonce'])
        for status,body in [(502,b'held'),(200,b'held'),(503,b'other'),(301,b'held')]:
            with self.assertRaises(ValueError):W.respond(W.canonical(request)+b'\n',raw,lambda _:(status,body))
        for change in ({'command':'whoami'},{'profileSha256':'c'*64},{'nonce':False}):
            with self.assertRaises(ValueError):W.respond(W.canonical(dict(request,**change))+b'\n',raw,lambda _:(503,b'held'))


@unittest.skipUnless(os.name == 'posix','requires native Linux metadata/fsync; not simulated on Windows')
class NativeStorage(unittest.TestCase):
    def test_every_effect_interruption_and_rename_gap(self):
        # Each failed completion represents death AFTER the actual filesystem
        # effect, before its durable completion. Reopen signed progress each time.
        for interrupted in range(32):
            with self.subTest(interrupted=interrupted), tempfile.TemporaryDirectory() as d:
                parent=Path(d);root=parent/'target';source=parent/'source';root.mkdir();source.mkdir()
                (root/'conflict').write_bytes(b'old file');(root/'gone').mkdir();(root/'gone'/'child').write_bytes(b'old')
                (source/'conflict').mkdir();(source/'conflict'/'new').write_bytes(b'new'*4000)
                (source/'plain').write_bytes(b'content')
                for path in sorted(source.rglob('*'),key=lambda p:-len(p.parts))+[source]:os.utime(path,ns=(1700000000000000000,)*2)
                previous=U.tree(str(root));desired=U.tree(str(source))
                stream=io.BytesIO()
                with tarfile.open(fileobj=stream,mode='w:gz',format=tarfile.PAX_FORMAT) as tar:tar.add(source,arcname='.')
                self.assertEqual(U.archive_manifest(stream),desired)
                journal=str(parent/'progress');stage=str(parent/'staging');key=b'x'*32
                progress=U.Progress(journal,S,key,'a'*64);append=progress.append
                def crash(record):
                    if record['kind']=='complete' and record['index']==interrupted:raise InterruptedError('crash')
                    append(record)
                progress.append=crash
                try:U.restore(str(root),stream,previous,desired,progress,stage,lambda:None)
                except InterruptedError:pass
                progress=U.Progress(journal,S,key,'a'*64)
                U.restore(str(root),stream,previous,desired,progress,stage,lambda:None)
                self.assertEqual(U.tree(str(root)),desired)
                before=list(progress.records)
                U.restore(str(root),stream,previous,desired,progress,stage,lambda:None)
                self.assertEqual(progress.records,before)

    def test_partial_temporary_prefix_and_tampering(self):
        with tempfile.TemporaryDirectory() as d:
            archive=io.BytesIO()
            content=b'0123456789'*3000
            with tarfile.open(fileobj=archive,mode='w:gz') as tar:
                member=tarfile.TarInfo('file');member.size=len(content);tar.addfile(member,io.BytesIO(content))
            path=str(Path(d)/'partial');Path(path).write_bytes(content[:105]);os.chmod(path,0o600)
            expected={'kind':'file','size':len(content),'sha256':R.sha(content)}
            U.materialize(archive,'file',path,expected);self.assertEqual(Path(path).read_bytes(),content)
            Path(path).write_bytes(b'foreign')
            with self.assertRaises(U.StorageError):U.materialize(archive,'file',path,expected)
            self.assertEqual(Path(path).read_bytes(),b'foreign')


if __name__ == '__main__':
    unittest.main(verbosity=2)
