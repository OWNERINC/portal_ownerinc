#!/usr/bin/python3
"""Test-local surviving reaper. Native qualification belongs to Linux CI only."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time


KIND = 'preparation-inherited-reaper-v1'
SCENARIOS = ('timeout', 'overflow')
ROLES = ('runtime', 'sleeper')
KILL = getattr(signal, 'SIGKILL', 9)  # Linux's SIGKILL, also usable by portable doubles.
RECORD_LIMIT = 512
CHILD_LIMIT = 128

# Each process records its own creation before starting its workload. These
# private receipts qualify wait results; they never authorize cleanup signals.
RECORD_SOURCE = r'''
import json,os,sys
def record(role):
    value={'kind':'inherited-creation-v1','scenario':sys.argv[2],'role':role,
           'pid':os.getpid(),'parent':os.getppid(),'group':os.getpgrp()}
    fd=os.open(os.path.join(sys.argv[1],role+'.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream:
        stream.write(json.dumps(value,separators=(',',':')))
'''
SLEEPER_SOURCE = RECORD_SOURCE + "\nimport time\nrecord('sleeper')\ntime.sleep(60)\n"


def workload_source(scenario):
    if scenario not in SCENARIOS:
        raise ValueError('invalid scenario')
    return (RECORD_SOURCE + "\nimport subprocess,time\nrecord('runtime')\n"
            + 'p=subprocess.Popen([sys.executable,"-I","-S","-B","-c",'
            + repr(SLEEPER_SOURCE) + ',sys.argv[1],sys.argv[2]])\ntime.sleep(.1)\n'
            + ('time.sleep(60)\n' if scenario == 'timeout'
               else 'while True: os.write(1,b"x"*8192)\n'))


LEADER_SOURCE = r'''
import importlib.util,sys
spec=importlib.util.spec_from_file_location('bounded_inherited',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
code,root,scenario=sys.argv[2:]
m.run_bounded_subprocess([sys.executable,'-I','-S','-B','-c',code,root,scenario],1024,1,group_mode='inherit')
'''


def projection(scenario):
    return {'kind': KIND, 'scenario': scenario, 'passed': False,
            'cleanupVerified': False, 'workloadObserved': False,
            'leaderSignaled': False, 'descendantsReaped': False, 'rescueUsed': False}


def positive_identity(value):
    return type(value) is int and 0 < value <= 2147483647


def unique_fields(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate field')
        value[key] = item
    return value


def creation_identities(records, scenario, leader, owner):
    if (type(records) is not dict or set(records) != set(ROLES)
            or not positive_identity(leader) or not positive_identity(owner) or leader == owner):
        raise ValueError('invalid creation records')
    values = {}
    for role in ROLES:
        raw = records[role]
        if type(raw) is not bytes or not 0 < len(raw) <= RECORD_LIMIT:
            raise ValueError('invalid creation record')
        value = json.loads(raw, object_pairs_hook=unique_fields)
        if (type(value) is not dict
                or set(value) != {'kind', 'scenario', 'role', 'pid', 'parent', 'group'}
                or value['kind'] != 'inherited-creation-v1' or value['scenario'] != scenario
                or value['role'] != role
                or not all(positive_identity(value[key]) for key in ('pid', 'parent', 'group'))
                or value['group'] != leader):
            raise ValueError('invalid creation record')
        values[role] = value
    runtime, sleeper = (values[role] for role in ROLES)
    if (len({owner, leader, runtime['pid'], sleeper['pid']}) != 4
            or runtime['parent'] != leader or sleeper['parent'] != runtime['pid']):
        raise ValueError('foreign creation record')
    return {runtime['pid'], sleeper['pid']}


class NativeOperations:
    """Small syscall adapter; constructing or importing it has no native effects."""
    def __init__(self):
        self.root = None
        self.handlers = {}

    monotonic = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)
    own_pid = staticmethod(os.getpid)

    def enable_subreaper(self):
        if sys.platform != 'linux':
            raise RuntimeError('Linux required')
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise RuntimeError('subreaper unavailable')

    def prepare(self):
        def interrupted(_number, _frame):
            raise InterruptedError('fixture interrupted')
        for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            self.handlers[number] = signal.signal(number, interrupted)
        self.root = Path(tempfile.mkdtemp(prefix='payload-inherited-reaper-'))

    def spawn_leader(self, scenario, **settings):
        source = Path(__file__).resolve().parents[2] / 'ops' / 'prepare-cms-authenticated.py'
        return subprocess.Popen([sys.executable, '-I', '-S', '-B', '-c', LEADER_SOURCE,
                                 str(source), workload_source(scenario), str(self.root), scenario],
                                shell=False, close_fds=True, **settings)

    def read_records(self):
        records = {}
        for role in ROLES:
            fd = os.open(self.root / (role + '.json'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                        or info.st_uid != os.getuid() or info.st_nlink != 1
                        or not 0 < info.st_size <= RECORD_LIMIT):
                    raise ValueError('invalid private record')
                records[role] = stream.read(RECORD_LIMIT + 1)
        return records

    def waitpid(self, pid):
        return os.waitpid(pid, os.WNOHANG)

    def was_killed(self, status):
        return os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL

    def children(self):
        # This fixture is single-threaded; this is its own direct-child inventory.
        with open('/proc/self/task/' + str(os.getpid()) + '/children', 'rb') as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise ValueError('child inventory too large')
        fields = raw.split()
        if len(fields) > CHILD_LIMIT or any(not field.isdigit() for field in fields):
            raise ValueError('invalid child inventory')
        return [int(field) for field in fields]

    def kill(self, pid):
        os.kill(pid, signal.SIGKILL)

    def close(self):
        failed = False
        if self.root is not None:
            for role in ROLES:
                try:
                    (self.root / (role + '.json')).unlink()
                except FileNotFoundError:
                    pass
                except BaseException:
                    failed = True
            try:
                self.root.rmdir()
            except BaseException:
                failed = True
        for number, previous in self.handlers.items():
            try:
                signal.signal(number, previous)
            except BaseException:
                failed = True
        if failed:
            raise RuntimeError('private cleanup failed')


def remaining(ops, cutoff):
    value = cutoff - ops.monotonic()
    if value <= 0:
        raise TimeoutError('fixture deadline')
    return value


def pause(ops, cutoff):
    delay = min(.01, max(0, cutoff - ops.monotonic()))
    if delay:
        ops.sleep(delay)


def rescue(ops, leader, collected, retired, cutoff):
    """Called only after sticky failure. No receipt PID or cached PGID authority."""
    while leader is not None and not collected and ops.monotonic() < cutoff:
        try:
            # The Popen object remains the sole waiter/identity owner of A.
            if leader.poll() is None:
                remaining(ops, cutoff)
                leader.kill()
            leader.wait(timeout=min(.05, remaining(ops, cutoff)))
            collected = True
            retired.add(leader.pid)
        except BaseException:
            try:
                pause(ops, cutoff)
            except BaseException:
                pass
    if leader is not None and not collected:
        return False
    while ops.monotonic() < cutoff:
        try:
            try:
                child, _status = ops.waitpid(-1)
            except ChildProcessError:
                return ops.monotonic() < cutoff
            if child:
                if not positive_identity(child) or child in retired:
                    raise ValueError('invalid wait identity')
                retired.add(child)
            else:
                remaining(ops, cutoff)
                children = ops.children()
                if (type(children) is not list or len(children) > CHILD_LIMIT
                        or any(not positive_identity(pid) or pid == ops.own_pid() for pid in children)
                        or len(set(children)) != len(children)):
                    raise ValueError('invalid owned children')
                for pid in children:
                    remaining(ops, cutoff)
                    if pid in retired:
                        continue
                    try:
                        owned, _status = ops.waitpid(pid)
                    except ChildProcessError:
                        retired.add(pid)
                        continue
                    if owned == pid:
                        retired.add(pid)
                    elif owned == 0:
                        remaining(ops, cutoff)
                        # With no other waiter, exit after this zero leaves a
                        # waitable child pinning its identity until our next wait.
                        ops.kill(pid)
                    else:
                        raise ValueError('invalid owned wait')
        except BaseException:
            pass
        # Also bound error/repeated-adoption loops, without renewing the budget.
        try:
            pause(ops, cutoff)
        except BaseException:
            pass
    return False


def run_scenario(scenario, operations=None):
    if scenario not in SCENARIOS:
        raise ValueError('invalid scenario')
    ops = NativeOperations() if operations is None else operations
    entry = ops.monotonic()
    deadline, leader_cutoff = entry + 12, entry + 5
    result = projection(scenario)
    leader, collected, empty, failed = None, False, False, False
    retired = set()
    try:
        ops.enable_subreaper()
        ops.prepare()
        remaining(ops, leader_cutoff)
        leader = ops.spawn_leader(scenario, start_new_session=True,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        leader_status = leader.wait(timeout=remaining(ops, leader_cutoff))
        collected = True
        retired.add(leader.pid)
        collected_at = ops.monotonic()
        remaining(ops, leader_cutoff)
        result['leaderSignaled'] = leader_status == -KILL
        if not result['leaderSignaled']:
            raise ValueError('unexpected leader outcome')
        observation_cutoff = min(collected_at + 2, entry + 7)
        expected = creation_identities(ops.read_records(), scenario, leader.pid, ops.own_pid())
        result['workloadObserved'] = True
        received = set()
        while True:
            remaining(ops, observation_cutoff)
            try:
                child, status = ops.waitpid(-1)
            except ChildProcessError:
                remaining(ops, observation_cutoff)
                empty = True
                if received != expected:
                    raise ValueError('missing descendant waits')
                result['descendantsReaped'] = True
                break
            if child == 0:
                remaining(ops, observation_cutoff)
                pause(ops, observation_cutoff)
                continue
            if positive_identity(child):
                retired.add(child)
            remaining(ops, observation_cutoff)
            if child not in expected or child in received or not ops.was_killed(status):
                raise ValueError('unexpected descendant wait')
            received.add(child)
    except BaseException:
        failed = True

    if failed:
        # This bit is sticky before rescue can kill anything. Later ECHILD only
        # proves cleanup, never the original inherited-group termination.
        result['rescueUsed'] = True
        try:
            empty = rescue(ops, leader, collected, retired, deadline - .05)
        except BaseException:
            empty = False
    try:
        remaining(ops, deadline)
        ops.close()
        remaining(ops, deadline)
        result['cleanupVerified'] = empty
    except BaseException:
        failed = True
    result['passed'] = (not failed and result['cleanupVerified'] and result['workloadObserved']
                        and result['leaderSignaled'] and result['descendantsReaped']
                        and not result['rescueUsed'])
    return result


def main(argv):
    if len(argv) != 1 or argv[0] not in SCENARIOS:
        return 2
    scenario = argv[0]
    result = projection(scenario)
    try:
        value = run_scenario(scenario)
        if (type(value) is dict and set(value) == set(result) and value['kind'] == KIND
                and value['scenario'] == scenario
                and all(type(value[key]) is bool for key in result if key not in ('kind', 'scenario'))):
            result = value
    except BaseException:
        pass
    passed = (all(result[key] for key in ('passed', 'cleanupVerified', 'workloadObserved',
                                        'leaderSignaled', 'descendantsReaped')) and not result['rescueUsed'])
    result['passed'] = passed
    print(json.dumps(result, separators=(',', ':')))
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
