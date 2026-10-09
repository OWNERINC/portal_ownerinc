import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createCommandDiagnostic, sanitizeCommandDiagnostic } from '../../scripts/integration/payload-preauthority-diagnostics.mjs';

test('actual adapter observes before stop, rejects drift before ALL starts and resumes only signed IDs with journal/audit unchanged', async t => {
  const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']).find(c => spawnSync(c, ['--version']).status === 0);
  if (!python) return t.skip('Python 3 unavailable');
  const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const directory = await mkdtemp(path.join(base, 'coordinator-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const program = String.raw`
import contextlib,copy,hashlib,importlib.util,io,json,os,sys
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('R',os.path.join(sys.argv[1],'ops','payload-control-runtime.py'))
R=importlib.util.module_from_spec(spec);spec.loader.exec_module(R);S=R.STATE
images={s:'ghcr.io/ownerinc/ownerinc-portal-'+s+'@sha256:'+'a'*64 for s in ('api','cron','cms')}
scope={'pid':101,'started':'200','device':1,'inode':9}
def expect(code,fn):
    try: fn()
    except (R.ControlError,S.StateError) as error: assert str(error)==code,(str(error),code)
    else: raise AssertionError('accepted '+code)
def exercise(version):
    runtime_dir=os.path.join(sys.argv[2],'runtime-'+str(version));os.mkdir(runtime_dir)
    S.initialize(runtime_dir,'b'*64)
    def migrate(body):
        body['cmsStatus']='migrated';body['releaseImages']=images;body['nativeCatalogFingerprint']='c'*64
        body['latestProofSha256']='d'*64
    S.transition(runtime_dir,migrate)
    if version==1:
        # Construct a separate historical v1 journal, not a downgrade transition.
        key,state_dir,state,_=S.read_state(runtime_dir)
        state.pop('installIntent');state['schemaVersion']=1;state['sequence']=0;state['previousStateSha256']=None
        for name in os.listdir(state_dir): os.unlink(os.path.join(state_dir,name))
        raw=S.canonical(S.sign_envelope(S.validate_state_body(state),key))+b'\n'
        S._write_exclusive(os.path.join(state_dir,S._journal_name(0)),raw,0o600)
        S._write_exclusive(os.path.join(state_dir,'current.json'),raw,0o600)
    containers={}
    for index,service in enumerate(('nginx','api','cron','cms')):
        containers[service]={'Id':str(index+1)*64,'Image':'sha256:'+'e'*64,'Created':'synthetic-fixed-creation',
            'Config':{'Image':images.get(service,'nginx:immutable'), 'Labels':{'com.docker.compose.project':'fixture',
                'com.docker.compose.service':service,'com.docker.compose.oneoff':'False'},'Healthcheck':{'Test':['synthetic']}},
            'Mounts':[{'Type':'volume','Name':'synthetic-'+service}],
            'State':{'Status':'running','Running':True,'Paused':False,'Restarting':False,'Health':{'Status':'healthy'}}}
    calls=[];fail_start=False
    def inventory(): return [{'id':v['Id'][:12],'service':s,'state':v['State']['Status'],'name':'fixture-'+s} for s,v in containers.items()]
    def command(args,**kwargs):
        calls.append(args)
        assert args[:2] in (['docker','inspect'],['docker','start']),args
        if args[1]=='inspect':
            values=[v for v in containers.values() if v['Id'].startswith(args[2])]
            return SimpleNamespace(returncode=0,stdout=json.dumps(values).encode())
        if fail_start:
            kwargs['stderr'].write(b'private-tool-output:credentials-and-paths')
            return SimpleNamespace(returncode=1,stdout=b'')
        selected=next(v for v in containers.values() if v['Id']==args[2])
        selected['State']['Status']='running';selected['State']['Running']=True
        return SimpleNamespace(returncode=0,stdout=b'')
    def runtime(action,evidence=None):
        selected=R.Runtime.__new__(R.Runtime);selected.action=action;selected.evidence=evidence
        selected.runtime_dir=runtime_dir;selected.release_path='/synthetic/release'
        selected.inventory={'identity':'b'*64,'document':{'project':'fixture'}}
        selected.key,selected.state_dir,selected.state,selected.state_parent_hash=S.read_state(runtime_dir)
        return selected
    def state_change(fn): S.transition(runtime_dir,fn)
    with contextlib.ExitStack() as stack:
        # Explicit metadata/transport doubles; state/HMAC/replay and runtime
        # observe/validate/start ordering below are actual implementation.
        stack.enter_context(patch.object(R.Runtime,'_writer_scope',lambda _self:copy.deepcopy(scope)))
        stack.enter_context(patch.object(R.Runtime,'_admission_closed',lambda self: S.verify_admission(self.runtime_dir,'closed')))
        stack.enter_context(patch.object(R,'_release',lambda *_a,**_k:(images,True)))
        stack.enter_context(patch.object(R,'_verify_release_images',lambda *_a:None))
        stack.enter_context(patch.object(R,'_container_inventory',inventory))
        stack.enter_context(patch.object(R,'_check_container_shape',lambda *_a,**_k:inventory()))
        stack.enter_context(patch.object(R.subprocess,'run',command))
        output=io.StringIO()
        with contextlib.redirect_stdout(output): runtime('observe-writers').run()
        ticket=output.getvalue().strip()
        original=copy.deepcopy(containers)
        state_change(lambda b:b.update({'admission':'closed'}))
        for v in containers.values(): v['State'].update({'Status':'exited','Running':False})
        state_change(lambda b:b.update({'latestProofSha256':'f'*64}))
        state_before=copy.deepcopy(S.read_state(runtime_dir)[2]);state_path=os.path.join(runtime_dir,'payload-control-state')
        journal_before={n:open(os.path.join(state_path,n),'rb').read() for n in os.listdir(state_path)}
        baseline=copy.deepcopy(containers)
        changes=[('id',lambda:containers['cms'].update({'Id':'9'*64}),'writer_identity_mismatch'),
            ('label',lambda:containers['cms']['Config']['Labels'].update({'com.docker.compose.oneoff':'True'}),'writer_identity_mismatch'),
            ('image',lambda:containers['cms']['Config'].update({'Image':'wrong-image'}),'writer_identity_mismatch'),
            ('mount',lambda:containers['cms'].update({'Mounts':[]}),'writer_identity_mismatch'),
            ('state',lambda:containers['cms']['State'].update({'Status':'paused'}),'writer_state_invalid'),
            ('missing',lambda:containers.pop('cms'),'writer_identity_mismatch'),
            ('worker',lambda:containers.update({'cms-worker':{'Id':'9'*64,'State':{'Status':'running'}}}),'worker_admission_forbidden')]
        for _,mutate,reason in changes:
            containers.clear();containers.update(copy.deepcopy(baseline));calls.clear();mutate()
            expect(reason,lambda:runtime('resume-writers',ticket).run())
            assert not any(c[1]=='start' for c in calls),calls
        containers.clear();containers.update(copy.deepcopy(baseline));calls.clear()
        tampered=json.loads(ticket);tampered['body']['containers']['api']['id']='9'*64
        expect('signature_invalid',lambda:runtime('resume-writers',S.canonical(tampered).decode()).run())
        scope['started']='changed-process'
        expect('writer_ticket_invalid',lambda:runtime('resume-writers',ticket).run())
        scope['started']='200';assert not any(c[1]=='start' for c in calls)
        with patch.object(R,'_check_container_shape',lambda *_a:inventory()+[inventory()[-1]]):
            expect('writer_identity_mismatch',lambda:runtime('resume-writers',ticket).run())
        assert not any(c[1]=='start' for c in calls),'ambiguous service must refuse before ALL starts'
        # Readiness starts only original API/CMS/Nginx, never cron or a missing service.
        runtime('resume-readiness-writers',ticket).run()
        assert containers['cron']['State']['Status']=='exited'
        assert [c[2] for c in calls if c[1]=='start']==[original[s]['Id'] for s in ('api','cms','nginx')]
        calls.clear();runtime('resume-writers',ticket).run()
        assert [c[2] for c in calls if c[1]=='start']==[original['cron']['Id']]
        assert all(v['State']['Status']=='running' for v in containers.values())
        assert S.read_state(runtime_dir)[2]==state_before
        assert {n:open(os.path.join(state_path,n),'rb').read() for n in os.listdir(state_path)}==journal_before
        containers.clear();containers.update(copy.deepcopy(baseline));calls.clear();fail_start=True
        expect('writer_start_command_failed',lambda:runtime('resume-writers',ticket).run())
        assert S.read_state(runtime_dir)[2]==state_before
        files=[n for n in os.listdir(runtime_dir) if n.startswith('payload-writer-command-')]
        assert len(files)==1
        assert b'private-tool-output' in open(os.path.join(runtime_dir,files[0]),'rb').read()
        # Post-start health failure must remain closed and never advance journal.
        fail_start=False;containers['cms']['State']['Health']['Status']='unhealthy'
        expect('writer_health_invalid',lambda:runtime('resume-writers',ticket).run())
        assert S.read_state(runtime_dir)[2]==state_before
        containers['cms']['State']['Health']['Status']='starting';calls.clear()
        with patch.object(R.time,'sleep',lambda _seconds:None):
            expect('writer_readiness_timeout',lambda:runtime('resume-writers',ticket).run())
        assert len([c for c in calls if c==['docker','inspect',containers['cms']['Id']]])==180
        assert {n:open(os.path.join(state_path,n),'rb').read() for n in os.listdir(state_path)}==journal_before
for version in (1,2): exercise(version)
print('actual-writer-resume-v1-v2-pass')
`;
  const file = path.join(directory, 'exercise.py');
  await writeFile(file, program, { mode: 0o600, flag: 'wx' });
  const result = spawnSync(python, ['-B', file, path.resolve('.'), directory], { encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /actual-writer-resume-v1-v2-pass/u);
});

test('coordinator resume attribution is finite, exact and never classifies arbitrary tool or cleanup output', () => {
  for (const step of ['resume_writers', 'restore_start_readiness', 'guard_observe_writers']) {
    const prefix = `PAYLOAD_COORDINATOR_STEP step=${step}\n`;
    const suffix = `PAYLOAD_COORDINATOR_FAILURE step=${step} status=2\n`;
    const parse = body => createCommandDiagnostic({ substep: 'payload_coordinator_backup', status: 2,
      stderr: prefix + body + suffix + 'private-cleanup-output\n', coordinatorCommandContext: 'payload-coordinator:backup' });
    const known = parse('writer_start_command_failed\n');
    assert.equal(known.coordinatorStep, step);
    assert.equal(known.controlErrorIdentifier, 'writer_start_command_failed');
    assert.deepEqual(sanitizeCommandDiagnostic(known), known);
    for (const body of ['private-tool-output\n', 'writer_start_command_failed\nprivate-tool-output\n', 'private-tool-output\nwriter_start_command_failed\n']) {
      const opaque = parse(body);
      assert.equal(opaque.controlErrorIdentifier, null);
      assert.doesNotMatch(JSON.stringify(opaque), /private-/u);
    }
  }
});
