#!/usr/bin/python3
"""Real ADMIN/provisioner processes, protected closure, FD9 and signed journal.

Docker/PG/application observations are explicit persisted doubles here. Separate
required native fixtures exercise real PG, historical images and OpenSSH. This
fixture never claims their composition is a qualified production host.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import time

spec = importlib.util.spec_from_file_location('ci', Path(__file__).with_name('payload-production-recovery-ci.py'))
C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)

# Appended BEFORE the relocated closure is hashed and independently provisioned
# within this fixture. No authorization/lease/HMAC/decision validators replaced.
ADAPTER = r'''
_fixture_root = __FIXTURE_ROOT__
_fixture_api = __FIXTURE_API__
_fixture_cutoff = __FIXTURE_STARTED__ / 1000 + 38*60
_fixture_monotonic = time.monotonic()
_fixture_remaining = _fixture_cutoff - time.time()
_fixture_real_init = ProductionHost.__init__
def _fixture_init(self,*args,**kwargs):
    _fixture_real_init(self,*args,**kwargs)
    self.pg='explicit-pg-double'
    original=self.s._atomic_replace
    def replace(path,raw,*a,**kw):
        if os.path.exists(_fixture_root+'/fault-head') and b'"stage":"database_restore_pending"' in raw:
            os.unlink(_fixture_root+'/fault-head');os._exit(93)
        return original(path,raw,*a,**kw)
    self.s._atomic_replace=replace
    original_advance=self.s.advance_production_recovery
    def advance(*a,**kw):
        result=original_advance(*a,**kw)
        if os.path.exists(_fixture_root+'/fault-checkpoint') and a[2]=='protection_verified':
            os.unlink(_fixture_root+'/fault-checkpoint');os._exit(94)
        return result
    self.s.advance_production_recovery=advance
    original_append=self.storage.Progress.append
    def append(progress,record):
        if os.path.exists(_fixture_root+'/fault-upload') and record['kind']=='complete':
            os.unlink(_fixture_root+'/fault-upload');os._exit(95)
        return original_append(progress,record)
    self.storage.Progress.append=append
ProductionHost.__init__=_fixture_init
def _fixture_boundary(self,**kwargs):
    self.authenticate()
    if getattr(self,'_b0_reaffirm',None):self._b0_reaffirm()
    with open(_fixture_root+'/boundaries','a') as out:
        out.write(json.dumps({'pid':os.getpid(),'start':open('/proc/self/stat').read().rsplit(')',1)[1].split()[19],
            'lease':[os.fstat(9).st_dev,os.fstat(9).st_ino]})+'\n');out.flush();os.fsync(out.fileno())
    return {'resources':[],'cms':None,'witnessSha256':'f'*64}
def _fixture_database(self):
    return json.load(open(_fixture_root+'/database.json'))
def _fixture_command(self,args,**kwargs):
    remaining=min(_fixture_cutoff-time.time(),_fixture_remaining-(time.monotonic()-_fixture_monotonic))
    require(remaining>=6,'fixture_deadline_exhausted')
    kwargs['timeout']=min(kwargs.get('timeout',120),remaining-1)
    if args[0]=='/usr/bin/tar':return bounded_command(args,**kwargs)
    if _fixture_api and args==['/usr/bin/docker','exec','-i',_fixture_api,'node','-e',API_PROBE]:
        return bounded_command(args,**kwargs)
    require(args[0]=='/usr/bin/docker' and 'pg_restore' in args)
    if '--schema-only' in args:return b'explicit synthetic archive schema\n'
    if '--single-transaction' in args:
        require('--clean' in args and '--if-exists' in args and '--exit-on-error' in args)
        with open(_fixture_root+'/restore-count','a') as out:out.write('restore\n');out.flush();os.fsync(out.fileno())
        with open(_fixture_root+'/database.json','wb') as out:
            out.write(open(_fixture_root+'/source-database.json','rb').read());out.flush();os.fsync(out.fileno())
        if os.path.exists(_fixture_root+'/fault-commit'):
            os.unlink(_fixture_root+'/fault-commit');os._exit(96)
    else:require('--file=/dev/null' in args)
    return b''
def _fixture_dump(self,database=None,schema=False,output=None):
    if schema:return b'explicit synthetic archive schema\n'
    output.write(b'explicit synthetic protective dump')
def _fixture_auth(self):
    return {'roles':['portal_api','portal_cron'],'transport':'explicit-double','hbaMethodsSha256':'a'*64}
ProductionHost.boundary=_fixture_boundary
ProductionHost.database_tuple=_fixture_database
ProductionHost.command=_fixture_command
ProductionHost.dump=_fixture_dump
ProductionHost.security=lambda self:self.profile['legacySecurity']['observation']
ProductionHost.quiet=lambda self,*a:None
ProductionHost.supported_layout=lambda self:None
ProductionHost.cms_observation=lambda self:None
ProductionHost.authenticate_previous_passwords=_fixture_auth
def _fixture_application(self):
    self.boundary(readiness=True)
    require(self.database_tuple()==self.load_contract()[0]['restored'])
    require(self.storage.tree(self.binding['portalTarget']['volumes']['portalUploads']['mountpoint'])==self.baseline()['uploads'])
    self.verify_protection(self.read_evidence(self.intent['recovery']['proofs']['protection']))
    if _fixture_api:self.verify_readiness_token(self.l.protected(READ_TOKEN,0o600,16384))
    return {'fixtureApplicationDouble':True,'admissionClosed':True}
ProductionHost.start_previous_application=_fixture_application
ProductionHost.verify_application=_fixture_application
if _fixture_api:
    ProductionHost.application_containers=lambda self:{'api':{'Id':_fixture_api,'State':{'Running':True}}}
'''


def setup_profile(namespace):
    l = namespace['l']; images = namespace['images']; root = namespace['root']
    # Create once before retained B0 scopes; retries only append to these files.
    for name in ('restore-count', 'boundaries'):
        with open(root / name, 'xb') as out:
            out.flush(); os.fsync(out.fileno())
    runtime = l.load_runtime_captured(namespace['captured'])
    database = {'systemIdentifier': '123456', 'databaseOid': '16384', 'databaseName': 'portal'}
    rows = []
    for role in runtime.LEGACY_SECURITY_ROLES:
        rows += [{'kind': 'role', 'name': role, 'login': True, 'superuser': False,
            'createDatabase': False, 'createRole': False, 'inherit': True, 'replication': False,
            'bypassRls': False, 'connectionLimit': -1, 'validUntil': None},
            {'kind': 'settings', 'role': role, 'present': False}]
    rows += [{'kind': 'guard', 'name': n, 'present': False} for n in ('externalRoleDependencies', 'outsidePublicObjects', 'largeObjects')]
    for kind, schema, name in (('database', '', 'portal'), ('schema', '', 'public'), ('table', 'public', 'cms_editor_sessions')):
        identity = {'objectType': kind, 'schema': schema, 'name': name, 'subname': ''}
        rows.append({'kind': 'object', **identity, 'owner': 'portal_admin', 'aclNull': True, 'unsupported': False})
        for role in runtime.LEGACY_SECURITY_ROLES:
            rows += [{'kind': 'effective', **identity, 'role': role, 'privilege': privilege,
                'allowed': (kind, privilege) in (('database', 'CONNECT'), ('schema', 'USAGE')), 'grantable': False}
                for privilege in runtime.LEGACY_SECURITY_PRIVILEGES[kind]]
    observation = runtime.validate_portal_legacy_security_observation({'schemaVersion': 1,
        'kind': 'portal-legacy-security-observation-v1', 'serverMajor': 16, 'database': database, 'records': rows})
    directory = Path(namespace['prefixes']['/etc/ownerinc']) / 'payload-preparation'
    Path(namespace['config']['paths']['preRestoreBackupRoot']).mkdir(parents=True, mode=0o700)
    profile = {'kind': 'production-b0-recovery-profile-v1', 'legacySecurity': {
        'kind': 'portal-legacy-security-profile-v1', 'sourceCommit': '2' * 40,
        'previousImages': {s: images[s] for s in ('api', 'cron')}, 'observation': observation},
        'cmsCatalogs': ['a' * 64] * 7, 'witness': {k: 'a' * 64 for k in ('profileSha256', 'sshSha256', 'configSha256', 'knownHostsSha256')},
        'readiness': {k: 'a' * 64 for k in ('apiEnvironmentSha256', 'cronEnvironmentSha256', 'egressRulesSha256', 'egressNetworkId', 'uploadSha256')},
        'topology': {'networks': [], 'sourceContainers': {s: 'a' * 64 for s in ('api', 'cron', 'nginx', 'postgres')},
                     'externalEndpoints': [], 'hostListenersSha256': 'a' * 64}}
    profile['witness']['routes'] = [{'route': p, 'status': 503, 'bodySha256': 'a' * 64} for p in ('/', '/api/ready', '/editorial/ready')]
    profile['readiness'].update(uid='recovery_reader', uploadPath='/uploads/11111111-1111-4111-8111-111111111111.webp')
    if namespace.get('fixture_api_config'):
        profile['readiness']['uploadSha256'] = namespace['fixture_api_config']['uploadSha256']
    for number, name in enumerate(('ownerinc-portal-backend', 'ownerinc-portal-egress', 'ownerinc_proxy'), 1):
        profile['topology']['networks'].append({'Id': str(number) * 64, 'Name': name, 'Driver': 'bridge', 'Internal': True, 'Options': {}, 'IPAM': {}})
    profile['readiness']['egressNetworkId'] = '2' * 64
    for name, section, field in (('recovery-witness.conf', 'witness', 'configSha256'),
            ('recovery-witness.known_hosts', 'witness', 'knownHostsSha256'),
            ('recovery-api.env', 'readiness', 'apiEnvironmentSha256'), ('recovery-cron.env', 'readiness', 'cronEnvironmentSha256')):
        raw = b'explicit native process fixture observation double\n'
        C.write(directory / name, raw); profile[section][field] = C.sha(raw)
    raw = C.canonical(profile); C.write(directory / 'production-recovery-profile.json', raw)
    namespace['approval']['hostBaseline']['recoveryProfileSha256'] = C.sha(raw)
    desired = {'identity': database, **{k: 'a' * 64 for k in ('layoutSha256', 'securitySha256', 'rolesSha256', 'databaseAclSha256')},
        'catalogSha256': C.sha(b'explicit synthetic archive schema\n'), 'dataSha256': '1' * 64}
    for name in ('database.json', 'source-database.json'):
        C.write(root / name, C.canonical(desired))
    for volume in namespace['model'].volumes.values():
        Path(volume['Mountpoint']).mkdir(parents=True)
    import io
    uploads = Path(namespace['model'].volumes[namespace['config']['volumes']['portalUploads']['name']]['Mountpoint'])
    with tarfile.open(fileobj=io.BytesIO(namespace['model'].tar(True))) as stream:
        stream.extractall(uploads, filter='data')
    os.chmod(uploads, 0o755); os.utime(uploads, ns=(0, 0))
    namespace['fixture_uploads'] = uploads


def main():
    owned = C.Owned('admin'); report = None
    try:
        mode = sys.argv[1]
        assert mode in ('commit', 'head', 'upload', 'expiry', 'credential')
        api_config = None
        if mode == 'credential':
            config_path = Path(sys.argv[2])
            assert config_path.parent.parent == Path('/root') and config_path.parent.name.startswith('recovery-ci-apps-')
            info = config_path.lstat(); assert info.st_uid == 0 and info.st_mode & 0o777 == 0o600
            api_config = json.loads(config_path.read_bytes())
            assert set(api_config) == {'apiId','expired','valid','wrongUid','uploadSha256'}
            assert re.fullmatch('[0-9a-f]{64}',api_config['apiId'])
        root = owned.root
        initializer = (C.REPO / 'tests/unit/payload-install-initializer.test.mjs').read_text()
        model = re.search(r'const observationModel = String.raw`([\s\S]*?)`;', initializer).group(1)
        model_file = C.write(root / 'model.py', model.encode())
        previous = (C.REPO / 'tests/fixtures/payload-b0-native.py').read_text()
        marker = "write(receipt+'/preflight.json',canonical(cli('--check-install-plan')))"
        assert previous.count(marker) == 1
        prelude = previous.split(marker)[0]
        prelude = prelude.replace("root.name.startswith('payload-b0-native-')", "root.name.startswith('recovery-ci-admin-')")
        insertion = "for name, raw in captured.items():"
        assert prelude.count(insertion) == 1
        adapter = ADAPTER.replace('__FIXTURE_ROOT__', repr(str(root))).replace('__FIXTURE_API__', repr(api_config['apiId'] if api_config else None)).replace('__FIXTURE_STARTED__',os.environ.get('RECOVERY_CI_STARTED_MS','0')).encode()
        prelude = prelude.replace(insertion, "captured['ops/payload-production-b0-recovery.py'] += fixture_adapter\n" + insertion)
        # Interruption after actual credential rename and before its HMAC receipt.
        fault_receipt = "host.event('readiness-credential-receipt',value)"
        inject = "\n".join([
            "_credential_source=captured['ops/provision-payload-candidate-trust.py']",
            "assert _credential_source.count(" + repr(fault_receipt.encode()) + ")==1",
            "captured['ops/provision-payload-candidate-trust.py']=_credential_source.replace(" + repr(fault_receipt.encode()) + "," +
            repr(("\n                if os.path.exists(" + repr(str(root / 'fault-credential')) + "): os.unlink(" + repr(str(root / 'fault-credential')) + "); os._exit(97)\n                " + fault_receipt).encode()) + ")",
        ])
        prelude = prelude.replace(insertion, inject + '\n' + insertion)
        before_record = "record = {'schemaVersion':2"
        assert prelude.count(before_record) == 1
        prelude = prelude.replace(before_record, 'fixture_setup_profile(globals())\n' + before_record)
        old_argv = sys.argv
        sys.argv = [str(__file__), str(C.REPO), str(root), str(model_file)]
        ns = {'fixture_adapter': adapter, 'fixture_setup_profile': setup_profile, 'fixture_api_config':api_config}
        try:
            exec(compile(prelude, 'explicit-b0-native-setup', 'exec'), ns)
        finally:
            sys.argv = old_argv
        l, s, cli = ns['l'], ns['s'], ns['cli']
        receipt = ns['receipt']; receiver = ns['receiver']; journal = ns['journal']
        C.write(receipt + '/preflight.json', C.canonical(cli('--check-install-plan')))
        Path(receiver.NONCES).mkdir(parents=True, mode=0o700)
        C.write(receiver.NONCES + '/' + ns['record']['authorization']['nonce'],
                (ns['record']['authorization']['expiresAt'] + '\n').encode())
        held = cli('--capture-b0')
        assert held['binding']['recoveryGateVersion'] == 1
        baseline = cli('--capture-b0-recovery-baseline')
        frozen = journal(); assert cli('--capture-b0-recovery-baseline') == baseline and journal() == frozen
        # Protected source/ownership tamper fails in a fresh parent before append.
        helper = Path(ns['prep']) / 'ops/payload-production-b0-recovery.py'
        raw = helper.read_bytes(); C.write(helper, raw + b'\n', 0o755)
        cli('--capture-b0-recovery-baseline', ok=False); assert journal() == frozen
        C.write(helper, raw, 0o755); helper.chmod(0o777)
        cli('--capture-b0-recovery-baseline', ok=False); assert journal() == frozen
        helper.chmod(0o755)
        import fcntl
        fd = os.open(l.LOCK, os.O_RDWR); fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            cli('--capture-b0-recovery-baseline', ok=False); assert journal() == frozen
        finally:
            os.close(fd)
        no_fd = C.run(['/usr/bin/python3', '-I', '-S', '-B', ns['launcher'], '--execute-b0-recovery', ns['receipt_id']], ok=False,
            env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
        assert no_fd.returncode == 2 and journal() == frozen
        key, _, body, head = s.read_state(l.RUNTIME)
        proof_path = Path(l.RUNTIME) / ('payload-b0-recovery-' + ns['receipt_id']) / 'baseline.json'
        body_baseline = s.verify_envelope(s.parse_canonical(proof_path.read_bytes(), 'fixture'), key, lambda v: v, 'fixture')
        measurements = {'kind': 'production-b0-recovery-clone-measurements-v1',
            'manifestSha256': body_baseline['manifestSha256'], 'archiveSchemaSha256': body_baseline['archiveSchemaSha256'],
            'uploadsSha256': s.value_sha256(body_baseline['uploads']),
            **{k: v for k, v in body_baseline['database'].items() if k != 'identity'}}
        evidence = C.canonical({'fixtureOnly': True, 'productionRecovery': measurements})
        procedure = b'Native ADMIN process fixture with explicit database/application/witness observations; not production clone qualification.\n'
        C.write(root / 'evidence/qualification-evidence.json', evidence); C.write(root / 'evidence/procedure.md', procedure)
        now = int(time.time())
        decision = {'schemaVersion': 1, 'kind': 'production-exact-b0-acceptance-v1',
            **{k: held[k] for k in ('installBindingSha256', 'receiptId', 'manifestSha256')},
            'originStateSha256': head, 'qualificationEvidenceSha256': C.sha(evidence), 'procedureRevision': C.sha(procedure),
            'acceptedAt': now, 'expiresAt': now + 3600, 'authenticatedChannel': 'independently-authenticated-admin-vps'}
        ns['decision'] = decision; C.write(root / 'decision.json', C.canonical(decision))
        ns['provision'](digest='0' * 64, ok=False)
        ns['provision']('--check'); assert not Path(l.B0_ACCEPTANCE).exists()
        ns['provision'](); cli('--accept-b0')
        accepted = copy.deepcopy(s.read_state(l.RUNTIME)[2]['installIntent'])
        cli('--capture-b0-recovery-baseline', ok=False)
        inspected = cli('--check-b0-recovery')
        assert inspected['destructiveOperationAuthorized'] is False
        C.write(root / 'incident/recovery-contract.json', C.canonical(inspected['contract']))
        initial_token = api_config['expired'].encode() + b'\n' if api_config else b'a' * 40 + b'.' + b'b' * 40 + b'.' + b'c' * 80 + b'\n'
        C.write(root / 'incident/recovery-read-token', initial_token)
        incident = {'schemaVersion': 1, 'kind': 'production-exact-b0-recovery-approval-v1',
            'purpose': 'restore-previous-legacy-prefloor-held', 'recoveryPlanSha256': inspected['recoveryPlanSha256'],
            'approvedAt': now, 'expiresAt': now + 3600, 'authenticatedChannel': 'independently-authenticated-admin-vps'}
        incident_raw = C.canonical(incident); C.write(root / 'incident.json', incident_raw)
        def provision(digest, apply=False):
            return C.run(['/usr/bin/python3', '-I', '-S', '-B', ns['prep'] + '/ops/provision-payload-candidate-trust.py',
                '--profile', 'b0-recovery', '--apply' if apply else '--check', '--approval', root / 'incident.json',
                '--approval-sha256', digest, '--bundle', root / 'incident'], ok=False,
                env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
        frozen = journal(); cli('--recover-b0', ok=False); assert journal() == frozen
        assert provision('0' * 64, True).returncode == 2 and journal() == frozen
        assert provision(C.sha(incident_raw)).returncode == 0
        assert not Path(ns['prefixes']['/etc/ownerinc'] + '/payload-preparation/production-b0-recovery.json').exists()
        assert provision(C.sha(incident_raw), True).returncode == 0
        # Expiry before first reservation is fail closed without journal writes.
        C.write(ns['clock_path'], C.canonical(now + 3600))
        cli('--recover-b0', ok=False); assert journal() == frozen
        Path(ns['clock_path']).unlink()
        database = json.loads((root / 'database.json').read_bytes()); database['dataSha256'] = 'b' * 64
        C.write(root / 'database.json', C.canonical(database))
        C.write(ns['fixture_uploads'] / 'source.txt', b'committed fixture mutation')
        if mode != 'credential':
            fault = {'commit': 'fault-commit', 'head': 'fault-head', 'upload': 'fault-upload', 'expiry': 'fault-checkpoint'}[mode]
            C.write(root / fault, b'one injected interruption')
        cli('--recover-b0', ok=False)
        frozen = journal()
        C.write(ns['clock_path'], C.canonical(now + 7200))
        cli('--recover-b0', 'payload-ijklmnop', ok=False); assert journal() == frozen
        # Replaced pathname while original OFD remains exclusively held.
        fd = os.open(l.LOCK, os.O_RDWR); fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old_lock = l.LOCK + '.original'; os.rename(l.LOCK, old_lock); C.write(l.LOCK, b'replacement')
        try:
            cli('--recover-b0', ok=False); assert journal() == frozen
        finally:
            os.unlink(l.LOCK); os.rename(old_lock, l.LOCK); os.close(fd)
        if mode == 'expiry':
            cli('--recover-b0', ok=False)
            assert s.read_state(l.RUNTIME)[2]['installIntent']['recovery']['stage'] == 'protection_verified'
            assert (root / 'restore-count').read_bytes() == b''
            terminal = 'protection_verified_expired_held'
        else:
            if mode == 'head':
                cli('--check-b0-recovery', ok=False); assert journal() == frozen
            if mode == 'credential':
                state = s.read_state(l.RUNTIME)[2]
                assert state['installIntent']['recovery']['stage'] == 'legacy_start_pending'
                lineage = copy.deepcopy(state['installIntent']['recovery']['binding'])
                effects = (root / 'restore-count').read_bytes()
                progress = {p: p.read_bytes() for p in Path(ns['config']['paths']['preRestoreBackupRoot']).rglob('*') if p.is_file() and 'uploads-progress' in str(p)}
                token_path = Path(ns['prefixes']['/etc/ownerinc']) / 'payload-preparation/recovery-read-token'
                immutable_paths = [token_path.with_name('production-b0-recovery.json'),token_path.with_name('production-b0-recovery-contract.json')]
                immutable = {p:p.read_bytes() for p in immutable_paths}
                refresh = {'kind':'production-b0-readiness-credential-v1','purpose':'refresh-fixed-readiness-identity',
                    'decisionSha256':C.sha(incident_raw),'contractSha256':inspected['plan']['contractSha256'],
                    'recoveryBindingSha256':s.value_sha256(lineage),
                    'profileSha256':C.sha(token_path.with_name('production-recovery-profile.json').read_bytes()),
                    'previousTokenSha256':C.sha(initial_token),'tokenSha256':C.sha(api_config['valid'].encode()+b'\n')}
                def refresh_cli(request, selected, apply=True):
                    raw=C.canonical(request)
                    C.write(root/'refresh.json',raw);C.write(root/'credential/recovery-read-token',selected.encode()+b'\n')
                    return C.run(['/usr/bin/python3','-I','-S','-B',ns['prep']+'/ops/provision-payload-candidate-trust.py',
                        '--profile','b0-readiness-credential','--apply' if apply else '--check','--approval',root/'refresh.json',
                        '--approval-sha256',C.sha(raw),'--bundle',root/'credential'],ok=False,
                        env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
                for field in ('contractSha256','recoveryBindingSha256','decisionSha256','profileSha256'):
                    assert refresh_cli(dict(refresh,**{field:'0'*64}),api_config['valid']).returncode==2
                    assert journal()==frozen and token_path.read_bytes()==initial_token
                wrong=dict(refresh,tokenSha256=C.sha(api_config['wrongUid'].encode()+b'\n'))
                assert refresh_cli(wrong,api_config['wrongUid']).returncode==2
                assert journal()==frozen and token_path.read_bytes()==initial_token
                assert refresh_cli(refresh,api_config['valid'],False).returncode==0
                assert journal()==frozen and token_path.read_bytes()==initial_token
                C.write(root/'fault-credential',b'after atomic replace')
                assert refresh_cli(refresh,api_config['valid']).returncode!=0
                assert token_path.read_bytes()==api_config['valid'].encode()+b'\n'
                assert refresh_cli(refresh,api_config['valid']).returncode==0
                refreshed=journal()
                assert refresh_cli(refresh,api_config['valid']).returncode==0 and journal()==refreshed
                assert {p:p.read_bytes() for p in immutable}==immutable
                assert (root/'restore-count').read_bytes()==effects
                assert {p:p.read_bytes() for p in progress}==progress
                assert s.read_state(l.RUNTIME)[2]['installIntent']['recovery']['binding']==lineage
            result = cli('--recover-b0')
            assert result['status'] == 'legacy_ready_held' and result['admissionClosed'] and result['workerHeld']
            done = journal(); assert cli('--recover-b0') == result and journal() == done
            final = s.read_state(l.RUNTIME)[2]
            assert {k: v for k, v in final['installIntent'].items() if k != 'recovery'} == accepted
            assert final['admission'] == 'closed' and final['workerHold'] is True
            assert (root / 'restore-count').read_text().splitlines() == ['restore']
            terminal = 'legacy_ready_held'
        boundaries = [json.loads(line) for line in (root / 'boundaries').read_text().splitlines()]
        assert len({(b['pid'], b['start']) for b in boundaries}) >= 4
        assert len({tuple(b['lease']) for b in boundaries}) == 1
        report = {'kind': 'authenticated-recovery-admin-ci-v1', 'case': mode, 'terminal': terminal,
            'actualAdminCli': True, 'actualProvisionerCli': True, 'actualProtectedClosure': True,
            'actualLeaseFd9': True, 'actualHmacJournal': True, 'freshProcesses': True,
            'replacedLeaseRejected': True, 'wrongReceiptRejected': True, 'expiryBeforeReservationRejected': True,
            'protectedSourceTamperRejected': True, 'dockerPostgresApplicationWitnessDoubles': True,
            'actualApiCredentialRefresh':mode=='credential','credentialRenameGapReconciled':mode=='credential',
            'productionHostCompositionQualified': False,
            'sourceClosure': {'capturedFiles': {n: C.sha(raw) for n, raw in ns['captured'].items()},
                'sourceFiles': {n: C.sha((C.REPO / n).read_bytes()) for n in ns['captured']},
                'adaptations': ['protected-root-relocation', 'persisted-docker-pg-observation-doubles',
                    'clock-and-interruption-injection', 'synthetic-application-and-witness-observations'],
                'adapterSha256': C.sha(adapter), 'reusedSetupSha256': C.sha(previous.encode())}}
    finally:
        cleanup = owned.cleanup()
    C.publish_report('admin-' + mode, report, cleanup)


if __name__ == '__main__':
    main()
