import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve('.');
const python = process.platform === 'win32' ? 'python' : 'python3';
const fixture = path.join(repo, 'tests/fixtures/payload-preparation-inherited-group.py');
const preparation = readFileSync(new URL('./payload-preparation-authentication.test.mjs', import.meta.url), 'utf8');
const declaration = "test('inherited runtime-like group leaves no nested child after timeout or output overflow', {\n" +
  "  skip: process.platform !== 'linux',\n}, () => {\n";
const start = preparation.indexOf(declaration);
const end = preparation.indexOf('\n});', start);
const body = preparation.slice(start + declaration.length, end);
const canary = 'PRIVATE_CANARY /root/private-path pid=123456 Traceback secret-output';

function proof(scenario, overrides = {}) {
  return { kind: 'preparation-inherited-reaper-v1', scenario, passed: true,
    cleanupVerified: true, workloadObserved: true, leaderSignaled: true,
    descendantsReaped: true, rescueUsed: false, ...overrides };
}

function childResult(scenario, overrides = {}) {
  return { status: 0, signal: null, stderr: '', stdout: JSON.stringify(proof(scenario)) + '\n', ...overrides };
}

function exerciseWiring(first, second = scenario => childResult(scenario)) {
  const calls = [];
  let failure;
  const spawn = (command, args, options) => {
    const scenario = calls.length === 0 ? 'timeout' : 'overflow';
    calls.push(scenario);
    assert.equal(command, python);
    assert.deepEqual(args, ['-I', '-S', '-B', fixture, scenario]);
    assert.deepEqual(options, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 });
    return (calls.length === 1 ? first : second)(scenario);
  };
  try {
    new Function('spawnSync', 'python', 'path', 'repo', 'assert', body)(spawn, python, path, repo, assert);
  } catch (error) { failure = error; }
  assert.deepEqual(calls, ['timeout', 'overflow']);
  return failure;
}

test('inherited-group wiring retains its literal Linux declaration and one assertion for both workloads', () => {
  assert.ok(start >= 0 && end > start);
  assert.equal((preparation.match(/^test\(/gmu) ?? []).length, 31);
  const names = [...preparation.matchAll(/^test\('([^'\r\n]+)'/gmu)].map(match => match[1]);
  assert.equal(names[15], 'inherited runtime-like group leaves no nested child after timeout or output overflow');
  assert.equal((body.match(/spawnSync\(/gu) ?? []).length, 1);
  assert.equal((body.match(/assert\./gu) ?? []).length, 1);
  assert.doesNotMatch(body, /t\.test|test\(|process\.kill|pidfile|Atomics|detached/u);
  assert.equal(exerciseWiring(scenario => childResult(scenario)), undefined);
});

test('actual preparation body attempts overflow after every private or malformed timeout result', () => {
  const malformed = [
    () => { throw new Error(canary); },
    scenario => childResult(scenario, { error: new Error(canary) }),
    scenario => childResult(scenario, { signal: 'SIGKILL' }),
    scenario => childResult(scenario, { signal: undefined }),
    scenario => childResult(scenario, { status: 1 }),
    scenario => childResult(scenario, { status: '0' }),
    scenario => childResult(scenario, { stderr: canary }),
    scenario => childResult(scenario, { stdout: canary }),
    scenario => childResult(scenario, { stdout: Buffer.from(JSON.stringify(proof(scenario))) }),
    scenario => childResult(scenario, { stdout: ' '.repeat(1025) + JSON.stringify(proof(scenario)) }),
    scenario => childResult(scenario, { stdout: JSON.stringify(proof(scenario, { secret: canary })) }),
    scenario => childResult(scenario, { stdout: JSON.stringify(proof(scenario, { kind: canary })) }),
    scenario => childResult(scenario, { stdout: '{"kind":' + JSON.stringify(canary) + ',' +
      JSON.stringify(proof(scenario)).slice(1) + '\n' }),
    scenario => childResult(scenario, { stdout: JSON.stringify(proof('overflow')) }),
    ...['passed', 'cleanupVerified', 'workloadObserved', 'leaderSignaled', 'descendantsReaped'].flatMap(key =>
      [false, 1, 'true', null].map(value => scenario => childResult(scenario,
        { stdout: JSON.stringify(proof(scenario, { [key]: value })) }))),
    scenario => childResult(scenario, { stdout: JSON.stringify(proof(scenario, { rescueUsed: true })) }),
    ...['null', '[]', '{}', 'true'].map(stdout => scenario => childResult(scenario, { stdout })),
  ];
  for (const first of malformed) {
    const failure = exerciseWiring(first);
    assert.equal(failure?.code, 'ERR_ASSERTION');
    assert.match(failure.message, /^inherited-group proof failed \(private diagnostics withheld\)(?:\n|$)/u);
    assert.deepEqual(failure.actual, [false, true]);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_CANARY|private-path|123456|Traceback|secret-output/u);
  }
  const both = exerciseWiring(() => { throw new Error(canary); }, () => { throw new Error(canary); });
  assert.deepEqual(both.actual, [false, false]);
  const second = exerciseWiring(scenario => childResult(scenario), scenario => childResult(scenario, { status: 1 }));
  assert.deepEqual(second.actual, [true, false]);
});

// Only this Python interpreter is launched. The helper's real state machine is
// exercised with fake process/syscall/clock/record operations, even on Linux.
const portableProgram = String.raw`
import contextlib,ctypes,io,json,os,pathlib,signal,stat,subprocess,sys,tempfile,time,types,unittest
from unittest.mock import Mock,patch
raw=pathlib.Path(sys.argv[1]).read_bytes()
m=types.ModuleType('inherited_fixture');m.__file__=sys.argv[1]
def forbidden(*args,**kwargs):
    raise AssertionError('unexpected import side effect')
with contextlib.ExitStack() as stack:
    for target,name in ((subprocess,'Popen'),(tempfile,'mkdtemp'),(os,'open'),(os,'kill'),
                        (os,'waitpid'),(ctypes,'CDLL'),(signal,'signal'),(pathlib.Path,'resolve')):
        stack.enter_context(patch.object(target,name,side_effect=forbidden,create=True))
    stack.enter_context(patch('builtins.open',side_effect=forbidden))
    exec(compile(raw,'<inherited-fixture>','exec'),m.__dict__)

PRIVATE='PRIVATE_CANARY /root/private-path pid=123456 Traceback secret-output'
ECHILD=ChildProcessError

def records(scenario='timeout',runtime=201,sleeper=202):
    return {role:json.dumps({'kind':'inherited-creation-v1','scenario':scenario,'role':role,
                            'pid':pid,'parent':parent,'group':200}).encode()
            for role,pid,parent in (('runtime',runtime,200),('sleeper',sleeper,runtime))}

class Leader:
    pid=200
    def __init__(self,ops):
        self.ops=ops;self.collected=False;self.live=True
        self.status=-m.KILL;self.wait_error=None;self.delay=1;self.kill_error=None
    def wait(self,timeout):
        o=self.ops;o.events.append(('leader-wait',o.now,timeout))
        if timeout<=0: o.violation('unbounded leader wait')
        if self.wait_error is not None:
            error=self.wait_error
            if callable(error): return error(timeout)
            o.now+=timeout
            raise error(PRIVATE)
        if self.delay>timeout:
            o.now+=timeout
            raise subprocess.TimeoutExpired('private',timeout)
        o.now+=self.delay;self.delay=0;self.collected=True;self.live=False
        return self.status
    def poll(self):
        self.ops.events.append(('leader-poll',self.ops.now))
        if self.collected: self.ops.violation('post-collection leader poll')
        return None if self.live else self.status
    def kill(self):
        self.ops.events.append(('leader-kill',self.ops.now))
        if self.collected: self.ops.violation('post-collection leader kill')
        if self.kill_error: raise self.kill_error(PRIVATE)
        self.live=False;self.wait_error=None;self.delay=0;self.status=-m.KILL

class Ops:
    def __init__(self,scenario='timeout'):
        self.now=40.;self.events=[];self.violations=[];self.leader=Leader(self);self.records=records(scenario)
        self.waits=[(201,9),(202,9),ECHILD];self.fallback=ECHILD
        self.exact={};self.inventories=[];self.inventory=[];self.reaped=set()
        self.prepare_delay=0;self.record_delay=0;self.close_delay=0
        self.prepare_error=None;self.close_error=None;self.inventory_error=None
        self.clock_calls=[];self.record_reads=0;self.spawned=False;self.signal_hook=None
    def monotonic(self):
        self.clock_calls.append(self.now);return self.now
    def violation(self,message):
        self.violations.append(message);raise AssertionError(message)
    def sleep(self,delay):
        if not 0<delay<=.01000001: self.violation('uncapped sleep')
        self.events.append(('sleep',self.now,delay));self.now+=delay
    def own_pid(self): return 100
    def enable_subreaper(self): self.events.append(('subreaper',self.now))
    def prepare(self):
        self.events.append(('prepare',self.now));self.now+=self.prepare_delay
        if self.prepare_error: raise self.prepare_error(PRIVATE)
    def spawn_leader(self,scenario,**settings):
        self.events.append(('spawn',self.now,scenario,settings));self.spawned=True
        return self.leader
    def read_records(self):
        self.events.append(('records',self.now));self.record_reads+=1;self.now+=self.record_delay
        if isinstance(self.records,BaseException): raise self.records
        return self.records
    def waitpid(self,pid):
        if self.spawned and not self.leader.collected:
            self.violation('adopted wait stole Popen ownership')
        if pid!=-1 and pid in self.reaped:
            self.violation('probe after reap')
        self.events.append(('waitpid',self.now,pid))
        if pid==-1:
            item=self.waits.pop(0) if self.waits else self.fallback
        else:
            entries=self.exact.get(pid,[(0,0)])
            item=entries.pop(0) if len(entries)>1 else entries[0]
        if isinstance(item,type) and issubclass(item,BaseException): raise item(PRIVATE)
        if callable(item): item=item(self,pid)
        if item[0]: self.reaped.add(item[0])
        return item
    def was_killed(self,status): return status==9
    def children(self):
        self.events.append(('children',self.now))
        if self.inventory_error: raise self.inventory_error(PRIVATE)
        return self.inventories.pop(0) if self.inventories else self.inventory
    def kill(self,pid):
        if pid in self.reaped: self.violation('signal after reap')
        if self.events[-1][0]!='waitpid' or self.events[-1][2]!=pid:
            self.violation('signal without exact owned wait')
        self.events.append(('kill',self.now,pid))
        if self.signal_hook: self.signal_hook(pid)
    def close(self):
        self.events.append(('close',self.now));self.now+=self.close_delay
        if self.close_error: raise self.close_error(PRIVATE)

class ReaperTests(unittest.TestCase):
    def run_case(self,ops,scenario='timeout'):
        result=m.run_scenario(scenario,ops)
        self.assertEqual(set(result),set(m.projection(scenario)))
        self.assertEqual(result['kind'],m.KIND);self.assertEqual(result['scenario'],scenario)
        for key in result:
            if key not in ('kind','scenario'): self.assertIs(type(result[key]),bool)
        self.assertNotIn(PRIVATE,json.dumps(result))
        self.assertLessEqual(ops.now,52.000001)
        self.assertEqual(ops.violations,[])
        return result
    def refused(self,ops):
        result=self.run_case(ops);self.assertFalse(result['passed']);return result
    def test_both_workloads_require_waits_and_no_rescue(self):
        for scenario in m.SCENARIOS:
            with self.subTest(scenario=scenario):
                o=Ops(scenario);r=self.run_case(o,scenario)
                expected=m.projection(scenario)
                for key in ('passed','cleanupVerified','workloadObserved','leaderSignaled','descendantsReaped'):
                    expected[key]=True
                self.assertEqual(r,expected)
                self.assertEqual([e[0] for e in o.events if e[0] in ('subreaper','spawn','leader-wait','waitpid')],
                                 ['subreaper','spawn','leader-wait','waitpid','waitpid','waitpid'])
                settings=next(e[3] for e in o.events if e[0]=='spawn')
                self.assertEqual(settings,dict(start_new_session=True,stdin=subprocess.DEVNULL,
                                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
                self.assertFalse(any(e[0] in ('kill','leader-kill','leader-poll','children') for e in o.events))
                self.assertEqual(o.reaped,{201,202})
    def test_missing_malformed_duplicate_and_foreign_receipts(self):
        mutations=[{}, {'runtime':records()['runtime']}, {'runtime':b'{}','sleeper':b'{}'},
                   {'runtime':b'x'*513,'sleeper':records()['sleeper']},
                   {'runtime':b'{"pid":201,"pid":201}','sleeper':records()['sleeper']},
                   {'runtime':PRIVATE.encode(),'sleeper':records()['sleeper']},
                   records(runtime=200),records(sleeper=201),records(runtime=100)]
        for field,value in [('scenario','overflow'),('kind',PRIVATE),('role','sleeper'),('group',999),
                            ('parent',999),('pid',True),('pid',0),('pid',-1),('pid',2147483648),('extra',PRIVATE)]:
            changed=records();item=json.loads(changed['runtime']);item[field]=value
            changed['runtime']=json.dumps(item).encode();mutations.append(changed)
        changed=records();item=json.loads(changed['sleeper']);item['parent']=200
        changed['sleeper']=json.dumps(item).encode();mutations.append(changed)
        for changed in mutations:
            with self.subTest(record=mutations.index(changed)):
                o=Ops();o.records=changed;r=self.refused(o)
                self.assertFalse(r['workloadObserved']);self.assertTrue(r['rescueUsed'])
                self.assertTrue(r['cleanupVerified'])
                self.assertFalse(any(e[0]=='kill' for e in o.events))
    def test_wrong_leader_and_descendant_outcomes(self):
        for status in (0,1,-15):
            o=Ops();o.leader.status=status;r=self.refused(o)
            self.assertFalse(r['leaderSignaled']);self.assertFalse(r['descendantsReaped'])
        for waits in ([(201,0),(202,9),ECHILD],[(201,15),(202,9),ECHILD],
                      [(999,9),(201,9),(202,9),ECHILD],[(201,9),ECHILD],
                      [ECHILD],[(201,9),(201,9),(202,9),ECHILD]):
            o=Ops();o.waits=list(waits);r=self.refused(o)
            self.assertFalse(r['descendantsReaped']);self.assertTrue(r['cleanupVerified'])
    def test_zero_and_unreaped_zombies_never_prove_success(self):
        o=Ops();o.waits=[];o.fallback=(0,0);r=self.refused(o)
        self.assertFalse(r['cleanupVerified']);self.assertFalse(r['descendantsReaped'])
        self.assertAlmostEqual(o.now,51.95)
        # A zombie-like pending child qualifies only when an actual wait returns it.
        o=Ops();o.waits=[(0,0),(201,9),(0,0),(202,9),ECHILD]
        self.assertTrue(self.run_case(o)['passed'])
    def test_exact_owned_zero_wait_authorizes_rescue_and_failure_stays_sticky(self):
        o=Ops();o.records={};o.waits=[(0,0)];o.inventory=[201]
        def killed(pid):
            self.assertEqual(pid,201);o.waits.extend([(201,9),ECHILD])
        o.signal_hook=killed;r=self.refused(o)
        self.assertTrue(r['rescueUsed']);self.assertTrue(r['cleanupVerified'])
        self.assertEqual([e[2] for e in o.events if e[0]=='kill'],[201])
        self.assertFalse(r['workloadObserved']);self.assertFalse(r['descendantsReaped'])
        # Rescue authority comes from the current child inventory and owned wait,
        # not the expected identities in even well-formed creation receipts.
        o=Ops();o.waits=[(0,0)];o.fallback=(0,0);o.inventory=[303]
        o.signal_hook=lambda pid:o.waits.extend([(pid,9),ECHILD])
        r=self.refused(o);self.assertTrue(r['cleanupVerified'])
        self.assertEqual([e[2] for e in o.events if e[0]=='kill'],[303])
    def test_reaped_echild_and_ownership_errors_never_authorize_signals(self):
        for owned in ((201,9),ECHILD,PermissionError):
            o=Ops();o.records={};o.waits=[(0,0),ECHILD];o.inventory=[201];o.exact[201]=[owned]
            r=self.refused(o);self.assertTrue(r['cleanupVerified'])
            self.assertFalse(any(e[0]=='kill' for e in o.events))
        # Even a stale inventory must not cause a second exact wait on a retired PID.
        o=Ops();o.records={};o.waits=[(201,9),(0,0),(0,0),ECHILD];o.inventory=[201,202]
        o.exact[202]=[ECHILD];self.refused(o)
        self.assertEqual([e[2] for e in o.events if e[0]=='waitpid' and e[2]!=-1],[202])
        self.assertFalse(any(e[0]=='kill' for e in o.events))
    def test_new_adoptions_are_discovered_and_collected(self):
        o=Ops();o.records={};o.waits=[(0,0)];o.inventories=[[201],[202]]
        def killed(pid):
            o.waits.extend([(pid,9),(0,0)] if pid==201 else [(pid,9),ECHILD])
        o.signal_hook=killed;r=self.refused(o)
        self.assertTrue(r['cleanupVerified'])
        self.assertEqual([e[2] for e in o.events if e[0]=='kill'],[201,202])
        self.assertEqual(o.reaped,{201,202})
    def test_popen_exclusively_owns_outstanding_leader_during_rescue(self):
        o=Ops();o.leader.wait_error=subprocess.TimeoutExpired
        # TimeoutExpired needs its real two-argument constructor.
        def timed_out(timeout):
            o.now+=timeout;raise subprocess.TimeoutExpired('private',timeout)
        o.leader.wait_error=timed_out
        r=self.refused(o);self.assertTrue(r['cleanupVerified']);self.assertFalse(r['leaderSignaled'])
        events=[e[0] for e in o.events]
        self.assertLess(events.index('leader-kill'),events.index('waitpid'))
        self.assertEqual(events.count('leader-kill'),1)
        self.assertEqual([e[2] for e in o.events if e[0]=='waitpid'],[-1,-1,-1])
    def test_persistent_wait_discovery_and_leader_errors_exhaust_one_budget(self):
        for kind in ('wait','inventory','exact','leader'):
            o=Ops();o.records={}
            if kind=='leader':
                o.leader.delay=60;o.leader.kill_error=PermissionError
            else:
                o.waits=[];o.fallback=PermissionError if kind=='wait' else (0,0)
                if kind=='inventory': o.inventory_error=PermissionError
                if kind=='exact': o.inventory=[201];o.exact[201]=[PermissionError]
            r=self.refused(o);self.assertFalse(r['cleanupVerified']);self.assertTrue(r['rescueUsed'])
            self.assertAlmostEqual(o.now,51.95)
            self.assertFalse(any(e[0]=='kill' for e in o.events))
            if kind=='leader': self.assertFalse(any(e[0]=='waitpid' for e in o.events))
    def test_interruptions_refuse_and_cleanup_remains_bounded(self):
        for error in (KeyboardInterrupt,InterruptedError,SystemExit):
            o=Ops();o.waits=[error,(201,9),(202,9),ECHILD]
            r=self.refused(o);self.assertTrue(r['cleanupVerified']);self.assertTrue(r['rescueUsed'])
            o=Ops();o.records={};o.waits=[];o.fallback=error
            r=self.refused(o);self.assertFalse(r['cleanupVerified']);self.assertAlmostEqual(o.now,51.95)
        o=Ops();o.prepare_error=InterruptedError;o.waits=[ECHILD]
        r=self.refused(o);self.assertTrue(r['cleanupVerified']);self.assertFalse(o.spawned)
    def test_fixed_leader_observation_and_cleanup_cutoffs_never_renew(self):
        o=Ops();o.prepare_delay=4;o.leader.delay=.5;o.waits=[];o.fallback=(0,0)
        self.refused(o)
        self.assertEqual(next(e[2] for e in o.events if e[0]=='leader-wait'),1)
        self.assertAlmostEqual(next(e[1] for e in o.events if e[0]=='children'),46.5)
        self.assertAlmostEqual(o.now,51.95)
        o=Ops();o.leader.delay=4.99;o.waits=[];o.fallback=(0,0)
        self.refused(o)
        self.assertLessEqual(next(e[1] for e in o.events if e[0]=='children'),47)
        o=Ops();o.prepare_delay=5
        r=self.refused(o);self.assertFalse(o.spawned)
        o=Ops();o.record_delay=2.01
        r=self.refused(o);self.assertFalse(r['descendantsReaped'])
        # A completed wait remains retired even if its return crosses the
        # observation cutoff; cleanup must not probe that numerical PID again.
        o=Ops();o.inventory=[201,202]
        def late_wait(ops,pid):
            ops.now=43.01;return (201,9)
        o.waits=[late_wait,(0,0)];o.fallback=(0,0)
        o.signal_hook=lambda pid:o.waits.extend([(pid,9),ECHILD])
        r=self.refused(o);self.assertTrue(r['cleanupVerified'])
        self.assertEqual([e[2] for e in o.events if e[0]=='kill'],[202])
        o=Ops();o.waits=[];o.fallback=(0,0);o.close_delay=.04
        r=self.refused(o);self.assertLess(o.now,52)
    def test_cleanup_or_identity_failures_cannot_become_pass(self):
        o=Ops();o.close_error=PermissionError;r=self.refused(o)
        self.assertFalse(r['cleanupVerified']);self.assertFalse(r['rescueUsed'])
        for children in ([True],[0],[-1],[100],[201,201],list(range(1000,1130))):
            o=Ops();o.records={};o.waits=[(0,0),ECHILD];o.inventory=children
            self.refused(o);self.assertFalse(any(e[0]=='kill' for e in o.events))
    def test_source_generated_programs_and_native_adapter_are_grounded(self):
        compile(m.LEADER_SOURCE,'<leader>','exec');compile(m.SLEEPER_SOURCE,'<sleeper>','exec')
        for scenario in m.SCENARIOS:
            code=m.workload_source(scenario);compile(code,'<runtime>','exec')
            self.assertIn('time.sleep(.1)',code);self.assertIn('subprocess.Popen',code)
        self.assertIn('time.sleep(60)',m.workload_source('timeout'))
        self.assertIn('while True: os.write(1,b"x"*8192)',m.workload_source('overflow'))
        self.assertIn("],1024,1,group_mode='inherit')",m.LEADER_SOURCE)
        native=m.NativeOperations();native.root=pathlib.Path('private-root')
        settings=dict(start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        with patch.object(m.subprocess,'Popen') as spawn:
            native.spawn_leader('overflow',**settings)
        args,kwargs=spawn.call_args
        self.assertEqual(kwargs,dict(shell=False,close_fds=True,**settings))
        self.assertEqual(args[0][:6],[sys.executable,'-I','-S','-B','-c',m.LEADER_SOURCE])
        self.assertEqual(pathlib.Path(args[0][6]),pathlib.Path(sys.argv[1]).resolve().parents[2]/'ops'/'prepare-cms-authenticated.py')
        self.assertEqual(args[0][7],m.workload_source('overflow'))
        lib=Mock();lib.prctl.return_value=0
        with patch.object(m.sys,'platform','linux'),patch.object(ctypes,'CDLL',return_value=lib):
            native.enable_subreaper()
        lib.prctl.assert_called_once_with(36,1,0,0,0)
        with patch.object(m.os,'waitpid',return_value=(201,9),create=True) as waited, \
             patch.object(m.os,'WNOHANG',1,create=True):
            self.assertEqual(native.waitpid(201),(201,9))
        waited.assert_called_once_with(201,1)
        with patch.object(m.os,'kill') as killed,patch.object(m.signal,'SIGKILL',9,create=True):
            native.kill(201)
        killed.assert_called_once_with(201,9)
        with patch.object(m.os,'WIFSIGNALED',return_value=True,create=True) as signaled, \
             patch.object(m.os,'WTERMSIG',return_value=9,create=True) as termsig, \
             patch.object(m.signal,'SIGKILL',9,create=True):
            self.assertTrue(native.was_killed(9))
        signaled.assert_called_once_with(9);termsig.assert_called_once_with(9)
    def test_native_receipt_and_inventory_reads_are_bounded_and_private(self):
        native=m.NativeOperations();native.root=pathlib.Path('private-root')
        info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=42,st_nlink=1,st_size=200)
        class Stream(io.BytesIO):
            def fileno(self): return 7
        with contextlib.ExitStack() as stack:
            opened=stack.enter_context(patch.object(m.os,'open',return_value=7))
            stack.enter_context(patch.object(m.os,'fdopen',side_effect=lambda *a:Stream(records()['runtime'])))
            meta=stack.enter_context(patch.object(m.os,'fstat',return_value=info))
            stack.enter_context(patch.object(m.os,'getuid',return_value=42,create=True))
            stack.enter_context(patch.object(m.os,'O_NOFOLLOW',0x20000,create=True))
            stack.enter_context(patch.object(m.os,'O_NONBLOCK',0x800,create=True))
            self.assertEqual(set(native.read_records()),set(m.ROLES))
            for call in opened.call_args_list:
                self.assertEqual(call.args[1],os.O_RDONLY|0x20000|0x800)
            for key,value in [('st_mode',stat.S_IFLNK|0o600),('st_mode',stat.S_IFREG|0o644),
                              ('st_uid',99),('st_nlink',2),('st_size',513),('st_size',0)]:
                bad=types.SimpleNamespace(**vars(info));setattr(bad,key,value);meta.return_value=bad
                with self.assertRaises(ValueError): native.read_records()
        for raw in (b'x'*4097,b'1 '*129,b'not-a-pid'):
            with patch('builtins.open',return_value=io.BytesIO(raw)):
                with self.assertRaises(ValueError): native.children()
        with patch('builtins.open',return_value=io.BytesIO(b'201 202 ')):
            self.assertEqual(native.children(),[201,202])
    def test_cli_emits_only_fixed_schema_on_success_failure_and_exceptions(self):
        for scenario in m.SCENARIOS:
            success=m.projection(scenario)
            for key in ('passed','cleanupVerified','workloadObserved','leaderSignaled','descendantsReaped'):
                success[key]=True
            for value,exit_code in ((success,0),(m.projection(scenario),1),
                                   (dict(success,private=PRIVATE),1),(dict(success,scenario=PRIVATE),1),
                                   (dict(success,passed=PRIVATE),1),(dict(success,rescueUsed=True),1)):
                output=io.StringIO();errors=io.StringIO()
                with patch.object(m,'run_scenario',return_value=value),contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
                    self.assertEqual(m.main([scenario]),exit_code)
                parsed=json.loads(output.getvalue());self.assertEqual(set(parsed),set(success))
                self.assertLess(len(output.getvalue()),512);self.assertEqual(errors.getvalue(),'')
                self.assertNotIn(PRIVATE,output.getvalue())
            for error in (RuntimeError,KeyboardInterrupt,SystemExit):
                output=io.StringIO()
                with patch.object(m,'run_scenario',side_effect=error(PRIVATE)),contextlib.redirect_stdout(output):
                    self.assertEqual(m.main([scenario]),1)
                self.assertEqual(json.loads(output.getvalue()),m.projection(scenario))
        for argv in ([],[PRIVATE],['timeout','overflow']):
            output=io.StringIO()
            with patch.object(m,'run_scenario',side_effect=forbidden),contextlib.redirect_stdout(output):
                self.assertEqual(m.main(argv),2)
            self.assertEqual(output.getvalue(),'')

suite=unittest.defaultTestLoader.loadTestsFromTestCase(ReaperTests)
result=unittest.TextTestRunner(stream=io.StringIO()).run(suite)
# Deliberately expose only fixed test-method IDs, never unittest diagnostics.
print(json.dumps({'tests':result.testsRun,'passed':result.wasSuccessful(),
                  'failures':[case._testMethodName for case,_ in result.failures],
                  'errors':[case._testMethodName for case,_ in result.errors]},separators=(',',':')))
`;

test('portable Python doubles exercise the actual inherited reaper state machine and syscall boundaries', () => {
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', portableProgram, fixture],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 4096 });
  assert.equal(result.error, undefined, 'portable reaper interpreter failed');
  assert.equal(result.signal, null, 'portable reaper interpreter interrupted');
  assert.equal(result.status, 0, 'portable reaper checks failed (private diagnostics withheld)');
  assert.equal(result.stderr, '', 'portable reaper emitted private diagnostics');
  assert.doesNotMatch(result.stdout, /PRIVATE_CANARY|private-path|123456|Traceback|secret-output/u);
  assert.deepEqual(JSON.parse(result.stdout), { tests: 15, passed: true, failures: [], errors: [] });
});

test('invalid helper CLI arguments never initialize native operations or expose caller text', () => {
  for (const args of [[], [canary], ['timeout', 'overflow']]) {
    const result = spawnSync(python, ['-I', '-S', '-B', fixture, ...args],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
