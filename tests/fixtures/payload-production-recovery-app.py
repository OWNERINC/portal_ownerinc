#!/usr/bin/python3
"""Historical images + actual fixed recovery probes on disposable internal networks.

The Firebase HTTPS peer is a local cryptographic fixture, not real Firebase and
not an emulator exception to production guards. No production digest is invented.
Local image IDs are only component-test inputs, never production admission pins.
"""
import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import tarfile
import time
import types

spec = importlib.util.spec_from_file_location('ci', Path(__file__).with_name('payload-production-recovery-ci.py'))
C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)

AUTH_SERVER = r"""const https=require('https'),fs=require('fs');
const cert=fs.readFileSync('/fixture/signing.crt','utf8');
https.createServer({key:fs.readFileSync('/fixture/tls.key'),cert:fs.readFileSync('/fixture/tls.crt')},(req,res)=>{
 let input='',size=0;req.on('data',b=>{size+=b.length;if(size>16384)req.destroy();else input+=b});
 req.on('end',()=>{let body;
 if(req.method==='GET'&&req.url==='/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com')body={'fixture-key':cert};
 else if(req.method==='POST'&&req.url==='/token')body={access_token:'fixture-access-token',token_type:'Bearer',expires_in:3600};
 else if(req.method==='POST'&&req.url==='/v1/projects/demo-recovery-ci/accounts:lookup'){
   const value=JSON.parse(input);if(!Array.isArray(value.localId)||value.localId.length!==1||!['recovery_reader','foreign_reader'].includes(value.localId[0])){res.writeHead(400);return res.end('{}')}
   body={users:[{localId:value.localId[0],email:'reader@example.invalid',emailVerified:true,disabled:false,validSince:'1',createdAt:'1000'}]};
 }else{res.writeHead(403);return res.end('{}')}
 res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public, max-age=60'});res.end(JSON.stringify(body));
 });
}).listen(443,'0.0.0.0');
"""


def token(root, uid='recovery_reader', expired=False):
    encode = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b'=')
    now = int(time.time())
    header = encode(C.canonical({'alg': 'RS256', 'kid': 'fixture-key', 'typ': 'JWT'}).strip())
    payload = encode(C.canonical({'iss': 'https://securetoken.google.com/demo-recovery-ci',
        'aud': 'demo-recovery-ci', 'sub': uid, 'iat': now - 7200 if expired else now, 'exp': now - 3600 if expired else now + 3600,
        'auth_time': now - 7200 if expired else now, 'email': 'reader@example.invalid', 'email_verified': True,
        'firebase': {'sign_in_provider': 'password', 'identities': {'email': ['reader@example.invalid']}}}).strip())
    message = header + b'.' + payload
    signature = C.run(['/usr/bin/openssl', 'dgst', '-sha256', '-sign', root / 'signing.key'], data=message)
    return (message + b'.' + encode(signature)).decode()


def main():
    owned = C.Owned('apps'); report = None
    try:
        root = owned.root
        archive = C.run(['/usr/bin/git', '-c', 'safe.directory=' + str(C.REPO), '-C', C.REPO,
                         'archive', '--format=tar', C.HISTORICAL, 'api', 'cron'])
        source = root / 'historical'; source.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            stream.extractall(source, filter='data')
        images = {}; build_inputs = {}
        for service in ('api', 'cron'):
            dockerfile = source / service / 'Dockerfile'
            assert dockerfile.read_text().splitlines()[0] == 'FROM ' + C.BASE
            image = owned.receipt('image', owned.id + '-' + service + ':fixture')
            context = source / 'api' if service == 'api' else source
            C.run(['/usr/bin/docker', 'build', '--memory=2g', '--cpu-period=100000', '--cpu-quota=200000',
                   '--label', 'recovery-ci-owner=' + owned.id, '--label', 'org.opencontainers.image.revision=' + C.HISTORICAL,
                   '--tag', image, '--file', dockerfile, context], timeout=900,
                  env=dict(C.CLEAN, DOCKER_BUILDKIT='0'))
            record = json.loads(owned.docker('image', 'inspect', image))[0]
            assert record['Id'].startswith('sha256:') and len(record['Id']) == 71
            images[service] = record['Id']
            build_inputs[service] = {'sourceCommit': C.HISTORICAL, 'sourceArchiveSha256': C.sha(archive),
                'dockerfileSha256': C.sha(dockerfile.read_bytes()),
                'lockSha256': C.sha((source / service / 'package-lock.json').read_bytes()),
                'baseImage': C.BASE, 'localImageId': record['Id'], 'published': False}
        backend = owned.network('backend'); egress = owned.network('auth-only')
        for name, subject, extensions in (
                ('tls', 'fixture', 'subjectAltName=DNS:www.googleapis.com,DNS:oauth2.googleapis.com,DNS:identitytoolkit.googleapis.com'),
                ('signing', 'fixture-signing', 'subjectAltName=DNS:fixture.invalid')):
            C.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                '-keyout', root / (name + '.key'), '-out', root / (name + '.crt'), '-subj', '/CN=' + subject,
                '-addext', extensions])
        C.write(root / 'auth.js', AUTH_SERVER.encode(), 0o644)
        auth = owned.container('auth', C.BASE, options=('--network', egress,
            '--network-alias', 'www.googleapis.com', '--network-alias', 'oauth2.googleapis.com',
            '--network-alias', 'identitytoolkit.googleapis.com', '--read-only', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--mount', 'type=bind,src=' + str(root) + ',dst=/fixture,readonly'),
            command=('node', '/fixture/auth.js'))
        owned.docker('start', auth)
        password = secrets.token_hex(24)
        pg_env = C.write(root / 'pg.env', ('POSTGRES_PASSWORD=' + password + '\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust\n').encode())
        pg = owned.container('pg', C.PG, options=('--network', backend, '--network-alias', 'postgres', '--env-file', str(pg_env),
            '--label','com.docker.compose.project='+owned.id))
        owned.docker('start', pg)
        deadline = time.monotonic() + 60
        while owned.docker('exec', pg, 'pg_isready', '-U', 'postgres', ok=False).returncode:
            assert time.monotonic() < deadline
            time.sleep(.2)
        def sql(query, database='postgres'):
            return owned.docker('exec', '-i', pg, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
                                '-U', 'postgres', '-d', database, data=query.encode())
        # A minimal read-only fixture schema, explicitly not a production B0 clone.
        sql("CREATE ROLE portal_admin LOGIN SUPERUSER; CREATE ROLE portal_api LOGIN PASSWORD '" + password +
            "'; CREATE ROLE portal_cron LOGIN PASSWORD '" + password + "'; CREATE DATABASE portal_fixture OWNER portal_admin;")
        sql("SET ROLE portal_admin; CREATE TABLE job_titles(id uuid PRIMARY KEY,name text,active boolean,page_access jsonb); "
            "CREATE TABLE users(uid text PRIMARY KEY,email text,name text,role text,permissions jsonb,job_title_id uuid,firebase_enable_pending boolean); "
            "INSERT INTO users VALUES('recovery_reader','reader@example.invalid','Fixture Reader','viewer','{}',NULL,false); "
            "INSERT INTO users VALUES('foreign_reader','foreign@example.invalid','Other Reader','viewer','{}',NULL,false); "
            "GRANT CONNECT ON DATABASE portal_fixture TO portal_api,portal_cron; GRANT USAGE ON SCHEMA public TO portal_api,portal_cron; "
            "GRANT SELECT ON users,job_titles TO portal_api; "
            "ALTER ROLE portal_api SET default_transaction_read_only=on; ALTER ROLE portal_cron SET default_transaction_read_only=on;", 'portal_fixture')
        volume = owned.receipt('volume', owned.id + '-uploads')
        owned.docker('volume', 'create', '--label', 'recovery-ci-owner=' + owned.id, volume)
        mount = Path(json.loads(owned.docker('volume', 'inspect', volume))[0]['Mountpoint'])
        (mount/'alias-child').mkdir()
        upload = '/uploads/11111111-1111-4111-8111-111111111111.webp'
        content = b'RIFF-fixture-read-only-upload-WEBP'
        C.write(mount / Path(upload).name, content, 0o644)
        C.write(mount / 'fixture-ca.pem', (root / 'tls.crt').read_bytes(), 0o644)
        private_key = (root / 'signing.key').read_text().replace('\n', '\\n')
        environments = {}
        for service in ('api', 'cron'):
            values = {'NODE_ENV': 'production', 'RUN_MIGRATIONS': 'false',
                'DATABASE_URL': 'postgresql://portal_' + service + ':' + password + '@postgres:5432/portal_fixture',
                'BULK_IMPORT_WORKER_SECRET': secrets.token_hex(32), 'BULK_IMPORT_API_URL': 'http://127.0.0.1:9',
                'SMTP_ADDRESS': '127.0.0.1', 'SMTP_PORT': '9', 'SMTP_USERNAME': 'fixture', 'SMTP_PASSWORD': secrets.token_hex(24),
                'MAILER_SENDER_EMAIL': 'fixture@example.invalid', 'FIREBASE_PROJECT_ID': 'demo-recovery-ci',
                'FIREBASE_CLIENT_EMAIL': 'fixture@demo-recovery-ci.iam.gserviceaccount.com', 'FIREBASE_PRIVATE_KEY': private_key,
                'NODE_EXTRA_CA_CERTS': '/app/uploads/fixture-ca.pem'}
            if service == 'cron':
                values['CRON_BOOTSTRAP_ONLY'] = 'true'
            environments[service] = C.write(root / (service + '.env'), ('\n'.join(k + '=' + v for k, v in values.items()) + '\n').encode())
        original = (C.REPO / 'ops/payload-production-b0-recovery.py').read_bytes()
        # A fixed network namespace adaptation only; the environment validation,
        # create/receipt/start logic and actual DB/API probe programs are unchanged.
        adapted = original.replace(b'ownerinc-portal-backend', backend.encode())
        module = types.ModuleType('recovery_app_component'); module.__file__ = str(root / 'recovery.py')
        exec(compile(adapted, module.__file__, 'exec'), module.__dict__); R = module
        R.ENV_FILES = {s: str(p) for s, p in environments.items()}
        R.READ_TOKEN = str(C.write(root / 'read-token', token(root).encode() + b'\n'))
        L = C.load('recovery_app_launcher', C.REPO / 'ops/prepare-cms-authenticated.py')
        runtime = C.load('recovery_app_runtime', C.REPO / 'ops/payload-control-runtime.py')
        storage = C.load('recovery_app_storage', C.REPO / 'ops/payload-recovery-storage.py')
        fd = os.open(root / 'lease', os.O_CREAT | os.O_RDWR, 0o600)
        if fd != 9:
            os.dup2(fd, 9); os.close(fd)
        import fcntl
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
        h = object.__new__(R.ProductionHost); h.l = L; h.r = runtime; h.storage = storage
        def bounded(args,**kwargs):
            kwargs['timeout']=C.budget().window(kwargs.get('timeout',120))
            return R.bounded_command(args,**kwargs)
        h.command=bounded
        h.pg = pg; h.dbname = 'portal_fixture'
        networks = [json.loads(owned.docker('network', 'inspect', n))[0] for n in (backend, egress)]
        h.profile = {'readiness': {s + 'EnvironmentSha256': C.sha(p.read_bytes()) for s, p in environments.items()},
            'topology': {'networks': [{'Id': n['Id'], 'Name': n['Name']} for n in networks]}}
        h.profile['readiness'].update(egressNetworkId=networks[1]['Id'], uid='recovery_reader',
                                     uploadPath=upload, uploadSha256=C.sha(content))
        h.profile_raw = C.canonical(h.profile)
        h.binding = {'previousImages': images, 'portalTarget': {'database': h.sql(R.IDENTITY_SQL),
            'volumes': {'portalUploads': {'name': volume, 'mountpoint': str(mount)}}}}
        h.intent = {'recovery': {'proofs': {'protection': 'component-only'}}}
        decision = secrets.token_hex(32); h.decision_digest = lambda: decision
        events = []
        def event(kind, value):
            # Component-only receipt persistence; ADMIN/HMAC coverage is separate.
            events.append((kind, copy.deepcopy(value)))
            C.write(root / 'application-receipts.json', C.canonical(events))
        h.event = event
        h.container_events = lambda kind, service: [v for k, v in events if k == kind and v['service'] == service]
        expected_tree = storage.tree(str(mount))
        # Component fence is actual, but cannot certify the production topology.
        def boundary(**kwargs):
            for network in networks:
                actual = json.loads(owned.docker('network', 'inspect', network['Id']))[0]
                assert actual['Internal'] is True
            for container in h.application_containers().values():
                assert not container['HostConfig']['PortBindings']
                assert container['HostConfig']['Memory'] == 768 * 1024 ** 2
                assert container['HostConfig']['PidsLimit'] == 192
            assert storage.tree(str(mount)) == expected_tree
        h.boundary = boundary
        before = sql('SELECT row_to_json(u) FROM users u ORDER BY uid;', 'portal_fixture')
        h.database_tuple = lambda: {'readOnlyRowsSha256': C.sha(sql('SELECT row_to_json(u) FROM users u ORDER BY uid;', 'portal_fixture'))}
        expected_db = h.database_tuple()
        h.load_contract = lambda: ({'restored': expected_db}, 'component-only')
        h.baseline = lambda: {'uploads': expected_tree}
        h.read_evidence = lambda digest: {'component': digest}
        h.verify_protection = lambda value: boundary()
        real_command = h.command
        starts = []; creates = []
        def command(args, **kwargs):
            if args[:2] == ['/usr/bin/docker', 'create']:
                name = args[args.index('--name') + 1]
                # The actual deterministic recovery name is owned by its decision.
                owned.resources.append(('container', name))
                C.write(root / 'owned-resources.json', C.canonical(owned.resources))
                args = args[:2] + ['--memory=768m', '--cpus=1.5', '--pids-limit=192',
                    '--label', 'recovery-ci-owner=' + owned.id, '--log-opt=max-size=2m', '--log-opt=max-file=1'] + args[2:]
                creates.append(name)
            value = real_command(args, **kwargs)
            if args[:2] == ['/usr/bin/docker', 'start']:
                starts.append(args[2])
                # Wait only for the fixed local endpoint/bootstrap, no ready claim.
                deadline = time.monotonic() + C.budget().window(30)
                service = next(s for s, c in h.application_containers().items() if c['Id'] == args[2])
                while True:
                    if service == 'api':
                        check = owned.docker('exec', args[2], 'node', '-e',
                            "require('http').get('http://127.0.0.1:3000/api/ready',r=>process.exit(r.statusCode===200?0:2)).on('error',()=>process.exit(2))", ok=False)
                        ready = check.returncode == 0
                    else:
                        ready = b'"event":"bootstrap_ready"' in owned.docker('logs', '--tail', '20', args[2])
                    if ready:
                        break
                    assert time.monotonic() < deadline
                    time.sleep(.2)
            return value
        h.command = command
        h.authenticate_previous_passwords()
        result = h.start_previous_application()
        assert result['databaseAuthenticated'] and result['api']['authenticatedRead'] and result['cronBootstrapOnly']
        h.start_previous_application()
        assert len(creates) == len(starts) == 2
        negatives = []
        for service, container in h.application_containers().items():
            incorrect = 'postgresql://portal_' + service + ':wrong@postgres:5432/portal_fixture'
            failed = owned.docker('exec', '-e', 'DATABASE_URL=' + incorrect, container['Id'], 'node', '-e', R.DB_PROBE, ok=False)
            assert failed.returncode != 0; negatives.append(service + '-password')
        request = dict(h.profile['readiness']); request = {k: request[k] for k in ('uid', 'uploadPath', 'uploadSha256')}
        request['token'] = Path(R.READ_TOKEN).read_text().strip()[:-8] + 'AAAAAAAA'
        api = h.application_containers()['api']['Id']
        assert owned.docker('exec', '-i', api, 'node', '-e', R.API_PROBE, data=C.canonical(request), ok=False).returncode != 0
        negatives.append('invalid-signature')
        # A real expired bearer strands only readiness. The fresh authenticated
        # ADMIN/provisioner chain refreshes the fixed identity, after expiry of
        # the incident authorization, with zero repeated restore effects.
        config = C.write(root/'admin-api.json',C.canonical({'apiId':api,'expired':token(root,expired=True),
            'valid':token(root),'wrongUid':token(root,uid='foreign_reader'),'uploadSha256':C.sha(content)}))
        native = C.run(['/usr/bin/python3','-I','-S','-B',C.REPO/'tests/fixtures/payload-production-recovery-admin.py',
            'credential',config],timeout=360,env=dict(C.CLEAN,PAYLOAD_REQUIRE_NATIVE_RECOVERY='1',
                GITHUB_ACTIONS='true',RUNNER_ENVIRONMENT='github-hosted'))
        assert json.loads(native)=={'fixture':'admin-credential','passed':True,'cleanupVerified':True}
        assert len(creates)==len(starts)==2
        # Real foreign networkless bind and container:postgres namespace shapes.
        foreign = owned.container('foreign-bind',C.BASE,options=('--network','none','--read-only','--cap-drop=ALL',
            '--mount','type=bind,src='+str(mount)+',dst=/foreign'),command=('node','-e','setInterval(()=>{},1000)'))
        owned.docker('start',foreign)
        actual=json.loads(owned.docker('inspect',pg,foreign,*[c['Id'] for c in h.application_containers().values()]))
        try:R.reject_foreign_resource_access(actual,owned.id,{volume},[str(mount)],decision)
        except R.RecoveryError as error:assert str(error)=='recovery_foreign_consumer'
        else:raise AssertionError('real foreign bind consumer accepted')
        owned.docker('rm','--force',foreign)
        alias = owned.receipt('volume',owned.id+'-alias')
        owned.docker('volume','create','--label','recovery-ci-owner='+owned.id,'--opt','type=none',
            '--opt','o=bind','--opt','device='+str(mount),alias)
        alias_container = owned.container('foreign-alias',C.BASE,options=('--network','none','--read-only','--cap-drop=ALL',
            '--mount','type=volume,src='+alias+',dst=/foreign,readonly'),command=('node','-e','setInterval(()=>{},1000)'))
        owned.docker('start',alias_container)
        alias_sources=R.volume_backing_paths(json.loads(owned.docker('volume','inspect',alias))[0])
        actual=json.loads(owned.docker('inspect',pg,alias_container))
        try:R.reject_foreign_resource_access(actual,owned.id,{volume},[str(mount)],decision,{alias:alias_sources})
        except R.RecoveryError as error:assert str(error)=='recovery_foreign_consumer'
        else:raise AssertionError('real read-only bind-volume alias accepted')
        owned.docker('rm','--force',alias_container)
        namespace = owned.container('foreign-namespace',C.BASE,options=('--network','container:'+pg,'--read-only','--cap-drop=ALL'),
            command=('node','-e','setInterval(()=>{},1000)'))
        owned.docker('start',namespace)
        actual=json.loads(owned.docker('inspect',pg,namespace))
        try:R.reject_foreign_resource_access(actual,owned.id,{volume},[str(mount)],decision)
        except R.RecoveryError as error:assert str(error)=='recovery_foreign_namespace'
        else:raise AssertionError('real foreign namespace accepted')
        owned.docker('rm','--force',namespace)
        # Kernel bind aliases outside the fixture peer's mounted directory.
        # Exercise ProductionHost.resources(), including its real docker ps -a,
        # inspect and volume discovery, rather than passing handpicked containers.
        aliases=C.Owned('apps')
        mount_cases=[]
        retained_cases=[]
        try:
            alias_root=aliases.bind_mount(mount,'uploads')
            expected=runtime._volume_receipt(json.loads(owned.docker('volume','inspect',volume))[0])
            fence=object.__new__(R.ProductionHost)
            fence.binding={'portalTarget':{'volumes':{'portalUploads':expected}}}
            fence.inventory={'project':owned.id,'volumes':{'cmsUploads':{'name':owned.id+'-unused-cms'}}}
            fence.intent={'creation':{'volumes':{},'containers':{}}}
            fence.decision_digest=lambda:decision
            def volume_info(selected):
                return runtime._volume_receipt(json.loads(owned.docker('volume','inspect',selected))[0])
            fence.r=types.SimpleNamespace(_volume_info=volume_info,_volume_receipt=runtime._volume_receipt,_strict_json=runtime._strict_json)
            effects=[]
            def read_only_command(args,**kwargs):
                if args[1] not in ('ps','context','inspect','volume'): effects.append(args[1]);raise AssertionError('unexpected effect')
                return C.run(args,**kwargs)
            fence.command=read_only_command
            for child,readonly,running in ((False,False,True),(True,False,True),(False,True,True),(True,True,False)):
                path=alias_root/'alias-child' if child else alias_root
                other=aliases.container('host-alias-'+str(len(mount_cases)),C.BASE,
                    options=('--network','none','--mount','type=bind,src='+str(path)+',dst=/foreign'+(',readonly' if readonly else '')),
                    command=('node','-e','setInterval(()=>{},1000)'))
                if running: aliases.docker('start',other)
                try:fence.resources(readiness=True)
                except R.RecoveryError as error:assert str(error)=='recovery_foreign_consumer'
                else:raise AssertionError('kernel bind alias escaped actual discovery')
                assert effects==[]
                mount_cases.append({'descendant':child,'readOnly':readonly,'running':running})
                aliases.docker('rm','--force',other)
            # A live container retains its effective bind after the original
            # host Source has disappeared or now resolves to unrelated content.
            for rebind,readonly in ((False,False),(False,True),(True,True)):
                retained=C.Owned('apps')
                try:
                    original_alias=retained.bind_mount(mount,'retained')
                    other=retained.container('retained',C.BASE,options=('--network','none',
                        '--mount','type=bind,src='+str(original_alias)+',dst=/foreign'+(',readonly' if readonly else '')),
                        command=('node','-e','setInterval(()=>{},1000)'))
                    retained.docker('start',other)
                    retained.cleanup_mounts() # Only the HOST alias is removed.
                    if rebind:
                        # Retire the already-unmounted fixture receipt, then
                        # create a separately receipted unrelated replacement.
                        (retained.root/'owned-mounts.json').unlink();original_alias.rmdir()
                        unrelated=retained.root/'unrelated';unrelated.mkdir()
                        assert retained.bind_mount(unrelated,'retained')==original_alias
                    host_topology=R.LinuxMounts()
                    assert not host_topology.overlap(str(original_alias),str(mount))
                    # Prove this container is still reading the original backing
                    # before actual resource discovery attempts any filtering.
                    observed=retained.docker('exec',other,'node','-e',
                        "process.stdout.write(require('fs').readFileSync('/foreign/"+Path(upload).name+"'))")
                    assert observed==content
                    try:fence.resources(readiness=True)
                    except R.RecoveryError as error:assert str(error)=='recovery_foreign_consumer'
                    else:raise AssertionError('live retained bind escaped effective namespace discovery')
                    assert effects==[]
                    retained_cases.append({'hostRebound':rebind,'readOnly':readonly,'network':'none'})
                finally:retained.cleanup()
            # Foreign symlink ancestry must refuse, not silently resolve.
            link=aliases.root/'symlink';link.symlink_to(mount,target_is_directory=True)
            try:R.LinuxMounts().coordinates(str(link/'alias-child'))
            except R.RecoveryError as error:assert str(error)=='recovery_foreign_symlink'
            else:raise AssertionError('foreign symlink followed')
            link.unlink()
        finally:
            alias_cleanup=aliases.cleanup()
        assert alias_cleanup['verified']
        # Kill the acquiring child after attach, BEFORE its completion receipt.
        # Both normal cleanup and the exact emergency per-workspace path must
        # use the pre-attach IDs, including the non-reused identity.
        mount_gap=[]
        ci_path=str(C.REPO/'tests/fixtures/payload-production-recovery-ci.py')
        child_env=dict(C.CLEAN,PAYLOAD_REQUIRE_NATIVE_RECOVERY='1',GITHUB_ACTIONS='true',RUNNER_ENVIRONMENT='github-hosted')
        for emergency in (False,True):
            gap=C.Owned('apps')
            try:
                prefix="import importlib.util,os,signal;from pathlib import Path;spec=importlib.util.spec_from_file_location('ci',"+repr(ci_path)+");C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C);C.guard();"
                code=prefix+"o=object.__new__(C.Owned);o.root=Path("+repr(str(gap.root))+");o.bind_mount("+repr(str(mount))+",'gap',after_attach=lambda:os.kill(os.getpid(),signal.SIGKILL))"
                result=C.run(['/usr/bin/python3','-I','-S','-B','-c',code],timeout=60,ok=False,env=child_env)
                assert result.returncode==-9
                records=json.loads((gap.root/'owned-mounts.json').read_bytes())
                assert len(records)==1 and records[0]['phase']=='prepared' and records[0]['id']>0 and records[0]['uniqueId']>0
                if emergency:
                    cleanup_code=prefix+"C._cleanup=True;assert C.cleanup_workspace(Path("+repr(str(gap.root))+"))['verified']"
                    C.run(['/usr/bin/python3','-I','-S','-B','-c',cleanup_code],timeout=60,env=child_env)
                else:assert gap.cleanup()['verified']
                assert not gap.root.exists()
                mount_gap.append('emergency' if emergency else 'normal')
            finally:
                if gap.root.exists():gap.cleanup()
        replacement=C.Owned('apps')
        try:
            target=replacement.bind_mount(mount,'replacement')
            old_records=json.loads((replacement.root/'owned-mounts.json').read_bytes())
            replacement.cleanup_mounts()
            (replacement.root/'owned-mounts.json').unlink();target.rmdir()
            # Same source and path, different independently acquired mount. The
            # old receipt must not adopt it even though coordinates match.
            replacement.bind_mount(mount,'replacement')
            new_records=json.loads((replacement.root/'owned-mounts.json').read_bytes())
            assert old_records[0]['uniqueId']!=new_records[0]['uniqueId']
            C.durable_mount_receipts(replacement.root,old_records)
            try:
                try:replacement.cleanup_mounts()
                except RuntimeError as error:assert str(error)=='owned mount identity changed'
                else:raise AssertionError('replacement mount adopted from old receipt')
                replacement_code=prefix+"C._cleanup=True\ntry:C.cleanup_workspace(Path("+repr(str(replacement.root))+"))\nexcept RuntimeError as error:assert str(error)=='owned mount identity changed'\nelse:raise AssertionError('emergency cleanup adopted replacement')"
                C.run(['/usr/bin/python3','-I','-S','-B','-c',replacement_code],timeout=60,env=child_env)
                assert any(r['path']==str(target) for r in R.LinuxMounts().rows)
            finally:
                # Restore only the replacement's genuine PRE-ATTACH receipt,
                # saved before simulating a stale receipt. No observed adoption.
                C.durable_mount_receipts(replacement.root,new_records)
        finally:replacement.cleanup()
        assert sql('SELECT row_to_json(u) FROM users u ORDER BY uid;', 'portal_fixture') == before
        assert storage.tree(str(mount)) == expected_tree
        os.close(9)
        report = {'kind': 'historical-recovery-app-ci-v1', 'historicalInputs': build_inputs,
            'supersededDocumentedBaseline': C.OLDER, 'selectedObservedBaseline': C.HISTORICAL,
            'actualHistoricalImages': True, 'fixedDbProbe': True, 'fixedApiProbe': True,
            'actualPrivateCreateReceiptStart': True, 'reentryCreateCount': len(creates),
            'authenticatedReader': True, 'readOnlyUploads': True, 'cronBootstrapOnly': True,
            'realApiAuthenticatedCredentialRefresh':True,'realForeignMountAndNamespaceRejected':True,
            'realReadOnlyBindVolumeAliasRejected':True,
            'actualResourcesHostBindAliases':mount_cases,'hostBindAliasEffects':len(effects),'ownedMountCleanupVerified':True,
            'effectiveRetainedBinds':retained_cases,'mountAttachCrashCleanup':mount_gap,'replacementMountRefused':True,
            'replacementCleanupRefusals':['normal','emergency'],
            'mountApiSourceSha256':C.sha(C.MOUNT_API_SOURCE.encode()),
            'negativePasswords': negatives, 'internalNetworks': True,
            'sourceClosure': {'originalSha256': C.sha(original), 'adaptedSha256': C.sha(adapted),
                'fixtureSha256':C.sha(Path(__file__).read_bytes()),
                'adaptations': ['fixed-backend-network-namespace', 'local-image-ids-component-only', 'creation-resource-caps']},
            'firebaseVerification': 'real-admin-sdk-with-local-signed-https-peer', 'realFirebaseQualified': False,
            'productionAdmissionQualified': False, 'scheduledWorkerQualified': False}
    finally:
        cleanup = owned.cleanup()
    C.publish_report('application', report, cleanup)


if __name__ == '__main__':
    main()
