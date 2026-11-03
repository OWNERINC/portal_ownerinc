#!/usr/bin/python3
"""Shared disposable-CI mechanics; never an operational recovery entrypoint."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
PG = 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
HISTORICAL = 'b573a3d900c823a700c167878717bb7534bef500'
OLDER = 'ce324b1b3d36fafb98270c9dfd8e62fed87d67a3'
BASE = 'node:24.12.0-alpine3.23@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8'
CLEAN = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'HOME': '/root'}
DEADLINE_KEYS = ('RECOVERY_CI_STARTED_MS','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT')
JOB_SECONDS, CLEANUP_SECONDS, MARGIN_SECONDS = 45*60, 6*60, 60


class Budget:
    def __init__(self, env, wall=time.time, monotonic=time.monotonic):
        self.wall,self.monotonic=wall,monotonic
        if not all(re.fullmatch(r'[1-9][0-9]*',env.get(k,'')) for k in DEADLINE_KEYS):
            raise RuntimeError('authenticated run-attempt deadline required')
        started=int(env['RECOVERY_CI_STARTED_MS'])/1000
        if started > wall() or len(env['RECOVERY_CI_STARTED_MS']) != 13:
            raise RuntimeError('invalid run start')
        self.deadline=started+JOB_SECONDS
        self.anchor=monotonic();self.remaining=self.deadline-wall()

    def available(self, cleanup=False):
        # Backward wall-clock movement cannot extend a previously admitted job.
        remaining=min(self.deadline-self.wall(),self.remaining-(self.monotonic()-self.anchor))
        return remaining-MARGIN_SECONDS-(0 if cleanup else CLEANUP_SECONDS)

    def window(self, cap, minimum=5, cleanup=False):
        remaining=self.available(cleanup)
        if not 0 < minimum <= cap or remaining < minimum:
            raise RuntimeError('insufficient shared execution/cleanup budget')
        return min(cap,remaining)


_budget = None
_cleanup = False


def budget():
    global _budget
    if _budget is None: _budget=Budget(os.environ)
    return _budget


def child_environment(env=None):
    return dict(CLEAN if env is None else env, **{k:os.environ[k] for k in DEADLINE_KEYS})


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode() + b'\n'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def guard():
    if (sys.platform != 'linux' or os.getuid() != 0 or os.getgid() != 0 or
            os.environ.get('PAYLOAD_REQUIRE_NATIVE_RECOVERY') != '1' or
            os.environ.get('GITHUB_ACTIONS') != 'true' or
            os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted'):
        raise RuntimeError('dedicated GitHub-hosted disposable root CI required')
    if any(Path(p).exists() for p in ('/etc/ownerinc', '/opt/ownerinc', '/var/lib/ownerinc')):
        raise RuntimeError('production-shaped host refused')
    budget().window(10,minimum=.1,cleanup=_cleanup)


def run(args, data=None, timeout=120, ok=True, env=None, minimum=5):
    # Diagnostics may include generated credentials. They never reach artifacts/stdout.
    minimum=1 if _cleanup else minimum
    window=budget().window(timeout,minimum,cleanup=_cleanup)
    window=min(window,budget().available(_cleanup)-10) # termination/reap is inside the same cutoff
    if window < minimum:
        raise RuntimeError('insufficient shared execution/cleanup budget')
    with subprocess.Popen(list(map(str, args)), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, env=child_environment(env), start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(data, timeout=window)
        except BaseException:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.communicate(timeout=budget().window(10,.01,cleanup=True))
            raise
        result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
    if ok and result.returncode:
        raise RuntimeError('fixture command failed: ' + Path(str(args[0])).name)
    if len(result.stdout) > 64 * 1024 * 1024 or len(result.stderr) > 4 * 1024 * 1024:
        raise RuntimeError('fixture output budget exceeded')
    return result.stdout if ok else result


def write(path, raw, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    path.chmod(mode)
    return path


def owned_cli_processes(root):
    scripts = {str(root / suffix) for suffix in (
        'usr/local/libexec/ownerinc-payload-prepare.py',
        'opt/ownerinc/lib/payload-preparation/ops/provision-payload-candidate-trust.py',
        'forced.py', 'witness.py')}
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != 0:
                continue
            argv = (entry / 'cmdline').read_bytes().split(b'\0')
            if any(os.fsdecode(arg) in scripts for arg in argv):
                fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                found.append((int(entry.name),int(fields[2]),fields[19]))
        except (FileNotFoundError,ProcessLookupError):
            pass
    return found


def reap_owned_clis(root):
    # An interrupted outer fixture may leave an authenticated nested supervisor
    # in its own process group. Scope by exact private executable paths, UID and
    # process-start identity; never by a broad command-name/prefix kill.
    groups = set()
    for pid, group, started in owned_cli_processes(root):
        try:
            fields = Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()
            if fields[19] != started or int(fields[2]) != group or group == os.getpgrp():
                raise RuntimeError('owned child identity/group changed')
            os.killpg(group,signal.SIGKILL); groups.add(group)
        except (FileNotFoundError,ProcessLookupError):
            pass
    deadline = time.monotonic() + budget().window(5,.01,cleanup=True)
    while owned_cli_processes(root):
        if time.monotonic() >= deadline:
            raise RuntimeError('owned child remained')
        time.sleep(.05)
    return len(groups)


# Compile against the runner's own Linux/glibc headers: no syscall numbers or
# Python statx/mount_attr layouts are guessed. Requires Linux 6.8 unique mount
# IDs and glibc 2.36 wrappers; missing support fails before attachment.
# Sources: man7.org/linux/man-pages/man2/{open_tree,move_mount,mount_setattr,statx}.2.html
MOUNT_API_SOURCE = r'''
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>
#ifndef STATX_MNT_ID_UNIQUE
#error Linux 6.8 statx headers required
#endif
int recovery_clone(int source) {
    int fd = open_tree(source, "", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH);
    if (fd < 0) return -1;
    struct mount_attr attributes = { .propagation = MS_PRIVATE };
    if (mount_setattr(fd, "", AT_EMPTY_PATH, &attributes, sizeof(attributes)) < 0) {
        int saved = errno; close(fd); errno = saved; return -1;
    }
    return fd;
}
int recovery_mount_ids(int fd, uint64_t *ordinary, uint64_t *unique) {
    struct statx info = {0};
    if (statx(fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_MNT_ID, &info) < 0) return -1;
    if (!(info.stx_mask & STATX_MNT_ID)) { errno = ENOTSUP; return -1; }
    *ordinary = info.stx_mnt_id;
    if (statx(fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_MNT_ID_UNIQUE, &info) < 0) return -1;
    if (!(info.stx_mask & STATX_MNT_ID_UNIQUE)) { errno = ENOTSUP; return -1; }
    *unique = info.stx_mnt_id;
    return 0;
}
int recovery_attach(int mount_fd, int target) {
    return move_mount(mount_fd, "", target, "", MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH);
}
'''


class MountAPI:
    def __init__(self, root):
        import ctypes
        self.ctypes=ctypes
        fd,filename=tempfile.mkstemp(prefix='.mount-api-',suffix='.so',dir=root)
        os.close(fd)
        run(['/usr/bin/cc','-x','c','-std=c11','-shared','-fPIC','-O2','-Wall','-Wextra','-Werror',
             '-o',filename,'-'],data=MOUNT_API_SOURCE.encode(),timeout=30)
        self.lib=ctypes.CDLL(filename,use_errno=True)
        self.lib.recovery_clone.argtypes=[ctypes.c_int];self.lib.recovery_clone.restype=ctypes.c_int
        self.lib.recovery_attach.argtypes=[ctypes.c_int,ctypes.c_int];self.lib.recovery_attach.restype=ctypes.c_int
        self.lib.recovery_mount_ids.argtypes=[ctypes.c_int,ctypes.POINTER(ctypes.c_uint64),ctypes.POINTER(ctypes.c_uint64)]
        self.lib.recovery_mount_ids.restype=ctypes.c_int

    def clone(self, source):
        result=self.lib.recovery_clone(source)
        if result<0: raise RuntimeError('detached mount creation unsupported or failed')
        return result

    def ids(self, fd):
        ordinary,unique=self.ctypes.c_uint64(),self.ctypes.c_uint64()
        if self.lib.recovery_mount_ids(fd,self.ctypes.byref(ordinary),self.ctypes.byref(unique))!=0 or not ordinary.value or not unique.value:
            raise RuntimeError('non-reused mount identity unavailable')
        return ordinary.value,unique.value

    def attach(self, mount_fd, target):
        if self.lib.recovery_attach(mount_fd,target)!=0: raise RuntimeError('owned mount attachment failed')


def durable_mount_receipts(root, records):
    fd,temporary=tempfile.mkstemp(prefix='.mount-receipt-',dir=root)
    try:
        with os.fdopen(fd,'wb') as stream:
            stream.write(canonical(records));stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,root/'owned-mounts.json')
        directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def boot_id():
    with open('/proc/sys/kernel/random/boot_id','rb') as stream: value=stream.read(38)
    if not re.fullmatch(rb'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\n',value):
        raise RuntimeError('kernel boot identity unavailable')
    return value.decode().strip()


class Owned:
    """Receipts before creation, ownership checked before delete, absence after."""
    def __init__(self, scope):
        guard()
        self.id = 'recovery-ci-' + scope + '-' + secrets.token_hex(6)
        self.root = Path(tempfile.mkdtemp(prefix=self.id + '-', dir='/root'))
        self.root.chmod(0o700)
        self.resources = []
        self.processes = []
        self.cleaned = False

    def docker(self, *args, **kwargs):
        return run(['/usr/bin/docker', *args], **kwargs)

    def receipt(self, kind, name):
        if not name.startswith(self.id):
            raise RuntimeError('foreign resource refused')
        self.resources.append((kind, name))
        write(self.root / 'owned-resources.json', canonical(self.resources))
        return name

    def network(self, suffix):
        name = self.receipt('network', self.id + '-' + suffix)
        self.docker('network', 'create', '--internal', '--label', 'recovery-ci-owner=' + self.id, name)
        return name

    def container(self, suffix, image, options=(), command=()):
        name = self.receipt('container', self.id + '-' + suffix)
        self.docker('create', '--name', name, '--label', 'recovery-ci-owner=' + self.id,
                    '--memory=768m', '--cpus=1.5', '--pids-limit=192', '--restart=no',
                    '--log-opt=max-size=2m', '--log-opt=max-file=1', *options, image, *command)
        return name

    def process(self, args, **kwargs):
        budget().window(30,30)
        process = subprocess.Popen(list(map(str, args)), env=child_environment(), start_new_session=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
        self.processes.append(process)
        records = [{'pid': p.pid, 'start': Path('/proc/' + str(p.pid) + '/stat').read_text().rsplit(')', 1)[1].split()[19]}
                   for p in self.processes if p.poll() is None]
        write(self.root / 'owned-processes.json', canonical(records))
        return process

    def mount_api(self):
        if not hasattr(self,'_mount_api'): self._mount_api=MountAPI(self.root)
        return self._mount_api

    def bind_mount(self, source, suffix, after_attach=None):
        if not re.fullmatch('[a-z0-9-]+',suffix): raise RuntimeError('invalid owned mount suffix')
        budget().window(30,10)
        R=load('cleanup_mounts',REPO/'ops/payload-production-b0-recovery.py')
        target=self.root/('mount-'+suffix);target.mkdir(mode=0o700)
        topology=R.LinuxMounts()
        api=self.mount_api();descriptors=[]
        try:
            source_fd,source_identity=R.LinuxMounts.open_path(str(source));descriptors.append(source_fd)
            target_fd,target_identity=R.LinuxMounts.open_path(str(target));descriptors.append(target_fd)
            topology.coordinates(str(target));coordinate=topology.coordinates(str(source));topology.reaffirm()
            mount_fd=api.clone(source_fd);descriptors.append(mount_fd)
            ordinary,unique=api.ids(mount_fd)
            record={'path':str(target),'source':str(source),'coordinate':list(coordinate),
                'namespace':topology.ns,'id':ordinary,'uniqueId':unique,'phase':'prepared',
                'bootId':boot_id(),
                'targetIdentity':list(target_identity[-1]),'sourceIdentity':list(source_identity[-1])}
            records_path=self.root/'owned-mounts.json'
            records=json.loads(records_path.read_bytes()) if records_path.exists() else []
            records.append(record)
            # CRITICAL ordering: durable exact kernel IDs exist BEFORE attach.
            # A crash earlier only closes/destroys an invisible detached clone.
            durable_mount_receipts(self.root,records)
            topology.reaffirm();budget().window(10,5)
            api.attach(mount_fd,target_fd)
            if after_attach: after_attach() # CI-only crash, before completion publication.
            current=R.LinuxMounts()
            row=next(r for r in current.rows if r['path']==str(target))
            if row['id']!=ordinary or api.ids(mount_fd)!=(ordinary,unique) or list(current.coordinates(str(target)))!=record['coordinate']:
                raise RuntimeError('created mount identity mismatch')
            record['phase']='attached';durable_mount_receipts(self.root,records)
        finally:
            for fd in reversed(descriptors): os.close(fd)
        return target

    def cleanup_mounts(self):
        filename=self.root/'owned-mounts.json'
        if not filename.exists(): return 0
        R=load('cleanup_mounts',REPO/'ops/payload-production-b0-recovery.py')
        records=json.loads(filename.read_bytes())
        for record in reversed(records):
            path=Path(record['path'])
            if path.parent != self.root or not re.fullmatch('mount-[a-z0-9-]+',path.name):
                raise RuntimeError('foreign mount cleanup target')
            topology=R.LinuxMounts()
            rows=[r for r in topology.rows if r['path']==str(path)]
            if not rows:
                if list(R.LinuxMounts.ancestry(str(path))[-1])!=record.get('targetIdentity'):
                    raise RuntimeError('owned mount target changed')
                continue
            if (len(rows)!=1 or rows[0]['id']!=record['id'] or type(record.get('uniqueId')) is not int or
                    record['uniqueId']<=0 or record.get('phase') not in ('prepared','attached') or
                    record.get('bootId')!=boot_id() or
                    json.loads(canonical(topology.ns))!=record['namespace'] or list(topology.coordinates(str(path)))!=record['coordinate']):
                raise RuntimeError('owned mount identity changed')
            fd,identity=R.LinuxMounts.open_path(str(path))
            try:
                if self.mount_api().ids(fd)!=(record['id'],record['uniqueId']) or list(identity[-1])!=record['sourceIdentity']:
                    raise RuntimeError('owned mount identity changed')
                topology.reaffirm()
            finally: os.close(fd)
            run(['/usr/bin/umount','--',path])
            if any(r['path']==str(path) for r in R.LinuxMounts().rows):
                raise RuntimeError('owned mount remained')
        return len(records)

    def cleanup(self):
        global _cleanup
        previous=_cleanup;_cleanup=True
        try: return self._cleanup_owned()
        finally: _cleanup=previous

    def _cleanup_owned(self):
        failures = []
        nested = reap_owned_clis(self.root)
        for process in reversed(self.processes):
            try:
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.wait(timeout=budget().window(10,.01,cleanup=True))
            except Exception:
                failures.append('process')
        for kind, name in reversed(self.resources):
            try:
                result = self.docker(kind, 'inspect', name, ok=False)
                if result.returncode == 0:
                    record = json.loads(result.stdout)[0]
                    labels = record.get('Config', {}).get('Labels') if kind in ('container', 'image') else record.get('Labels')
                    if (labels or {}).get('recovery-ci-owner') != self.id:
                        raise RuntimeError('ownership mismatch')
                    args = [kind, 'rm']
                    if kind == 'container':
                        args += ['--force', '--volumes']
                    self.docker(*args, name)
                    if self.docker(kind, 'inspect', name, ok=False).returncode == 0:
                        raise RuntimeError('resource remained')
                # A failed inspect is absence only when a live daemon confirms
                # its complete resource listing. Transport failure is not cleanup.
                listing = self.docker(kind, 'ls', *(['--all'] if kind == 'container' else []), '--format',
                    '{{.Repository}}:{{.Tag}}' if kind == 'image' else '{{.Names}}' if kind == 'container' else '{{.Name}}')
                if name in listing.decode().splitlines():
                    raise RuntimeError('resource remained in inventory')
            except Exception:
                failures.append(kind)
        if failures:
            raise RuntimeError('owned cleanup failed: ' + ','.join(failures))
        count = len(self.resources)+self.cleanup_mounts()
        shutil.rmtree(self.root)
        if self.root.exists():
            raise RuntimeError('private workspace remained')
        self.cleaned = True
        return {'ownedResourcesRemoved': count, 'childProcessesReaped': len(self.processes) + nested,
                'privateWorkspaceRemoved': True, 'verified': True}


def publish_report(name, report, cleanup):
    if cleanup.get('verified') is not True:
        raise RuntimeError('cleanup proof missing')
    report.update(cleanup=cleanup, exactProductionB0Qualified=False, liveRecoveryExecuted=False)
    destination = REPO / 'recovery-ci-reports'
    destination.mkdir(exist_ok=True)
    write(destination / (name + '.json'), canonical(report), 0o644)
    print(json.dumps({'fixture': name, 'passed': True, 'cleanupVerified': True}))


def cleanup_workspace(root):
    """The same identity-checked entry is used by emergency cleanup and its test."""
    guard()
    if root.parent!=Path('/root'):
        raise RuntimeError('foreign cleanup directory')
    info = root.lstat()
    if not root.is_dir() or root.is_symlink() or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError('unsafe cleanup receipt directory')
    receipts = root / 'owned-resources.json'
    resources = json.loads(receipts.read_bytes()) if receipts.exists() else []
    # The random owner is the root prefix before tempfile's final suffix.
    owner = root.name.rsplit('-', 1)[0]
    if not re.fullmatch(r'recovery-ci-(apps|postgres|witness|admin)-[0-9a-f]{12}', owner):
        raise RuntimeError('unknown cleanup namespace')
    owned = object.__new__(Owned)
    owned.id = owner; owned.root = root; owned.resources = resources; owned.processes = []
    for kind, name in resources:
        if kind not in ('container', 'network', 'image', 'volume') or not isinstance(name, str):
            raise RuntimeError('invalid resource receipt')
        if not (name.startswith(owner + '-') or kind == 'container' and re.fullmatch(r'ownerinc-b0-[0-9a-f]{24}-(api|cron)', name)):
            raise RuntimeError('foreign cleanup target')
    processes = root / 'owned-processes.json'
    for record in json.loads(processes.read_bytes()) if processes.exists() else []:
        stat_path = Path('/proc/' + str(record['pid']) + '/stat')
        if stat_path.exists():
            start = stat_path.read_text().rsplit(')', 1)[1].split()[19]
            if start != record['start'] or os.getpgid(record['pid']) != record['pid']:
                raise RuntimeError('process receipt changed')
            os.killpg(record['pid'], signal.SIGKILL)
    return owned.cleanup()


def emergency_cleanup():
    """Always-step fallback. A cleanup rescue cannot convert a failed test to PASS."""
    guard()
    cleaned = 0
    for root in Path('/root').glob('recovery-ci-*'):
        cleanup_workspace(root);cleaned += 1
    print(json.dumps({'emergencyCleanupVerified': True, 'rescuedWorkspaces': cleaned}))


def descendants():
    records={}
    for index,entry in enumerate(Path('/proc').iterdir()):
        if index>=32768: raise RuntimeError('process inventory bound exceeded')
        if not entry.name.isdigit(): continue
        try:
            fields=(entry/'stat').read_text().rsplit(')',1)[1].split()
            records[int(entry.name)]=(int(fields[1]),fields[19])
        except FileNotFoundError: continue
    owned={os.getpid()};changed=True
    while changed:
        before=len(owned)
        owned.update(pid for pid,(parent,_) in records.items() if parent in owned)
        changed=len(owned)!=before
    return {pid:records[pid][1] for pid in owned if pid!=os.getpid()}


def reap_descendants():
    end=time.monotonic()+budget().window(10,.01,cleanup=True)
    while True:
        children=descendants()
        for pid,started in children.items():
            try:
                current=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
                if current!=started: raise RuntimeError('descendant identity changed')
                os.kill(pid,signal.SIGKILL)
            except (FileNotFoundError,ProcessLookupError): pass
        while True:
            try:
                if os.waitpid(-1,os.WNOHANG)[0]==0: break
            except ChildProcessError: break
        if not descendants(): return
        if time.monotonic()>=end: raise RuntimeError('owned descendants remained')
        time.sleep(.02)


def supervise(args, cap, minimum, cleanup=False):
    global _cleanup
    _cleanup=cleanup
    guard()
    import ctypes
    if ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)!=0: # PR_SET_CHILD_SUBREAPER
        raise RuntimeError('subreaper unavailable')
    try:
        result=run(args,timeout=cap,minimum=minimum,ok=False,env=child_environment(os.environ))
    finally:
        # Includes session-detached grandchildren adopted after idle/crashed work.
        reap_descendants()
    return result


def process_proof():
    for code,expected in (("import os,time; p=os.fork(); os.setsid() if p==0 else None; time.sleep(120) if p==0 else os._exit(7)",7),
                          ("import os,time; p=os.fork(); os.setsid() if p==0 else None; time.sleep(120)",None)):
        try: result=supervise(['/usr/bin/python3','-I','-S','-c',code],1,.1)
        except subprocess.TimeoutExpired:
            # The crashed parent may leave its pipe held by the detached child.
            pass
        else:
            if result.returncode!=expected: raise RuntimeError('process proof outcome changed')
        if descendants(): raise RuntimeError('process proof orphan')
    print(json.dumps({'ownedDetachedDescendantsReaped':True,'idleAndCrashedWork':True}))


if __name__ == '__main__':
    try:
        if sys.argv[1:]==['--cleanup-inner']:
            _cleanup=True;emergency_cleanup()
        elif sys.argv[1:]==['--cleanup']:
            result=supervise(['/usr/bin/python3','-I','-S','-B',__file__,'--cleanup-inner'],360,.1,True)
            sys.stdout.buffer.write(result.stdout);raise SystemExit(result.returncode)
        elif sys.argv[1:]==['--process-proof']:
            process_proof()
        elif len(sys.argv)>5 and sys.argv[1]=='--supervise' and sys.argv[4]=='--':
            result=supervise(sys.argv[5:],float(sys.argv[2]),float(sys.argv[3]))
            sys.stdout.buffer.write(result.stdout)
            if result.returncode==0 and sys.argv[5:]==['/usr/bin/python3','-B','tests/fixtures/payload-production-recovery.py']:
                sys.stderr.buffer.write(result.stderr) # Offline unittest names/counts, including mandatory skip detection.
            # Only TAP of preparation or sanitized fixture stdout is forwarded.
            raise SystemExit(result.returncode)
        elif sys.argv[1:]==['--pull']:
            guard()
            for executable in ('sshd','ssh','openssl','docker'):
                location=Path('/usr/sbin' if executable=='sshd' else '/usr/bin')/executable
                if not os.access(location,os.X_OK): raise RuntimeError('native prerequisite missing')
            for commit in (HISTORICAL,OLDER):
                run(['/usr/bin/git','-c','safe.directory='+str(REPO),'-C',REPO,'cat-file','-e',commit+'^{commit}'],timeout=15)
            for image in (PG,BASE): run(['/usr/bin/docker','pull',image],timeout=240,minimum=30)
        else: raise SystemExit(2)
    except Exception:
        print('Native qualification supervision failed; private diagnostics withheld.',file=sys.stderr)
        raise SystemExit(1)
