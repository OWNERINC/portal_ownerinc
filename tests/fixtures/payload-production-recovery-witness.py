#!/usr/bin/python3
"""Real forced OpenSSH and HTTPS loopback fixture. No external-closure claim."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import sys
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('ci', Path(__file__).with_name('payload-production-recovery-ci.py'))
C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    owned = C.Owned('witness')
    server = thread = None
    report = None
    try:
        root = owned.root
        R = C.load('recovery_witness_transport', C.REPO / 'ops/payload-production-b0-recovery.py')
        L = C.load('recovery_witness_launcher', C.REPO / 'ops/prepare-cms-authenticated.py')
        S = C.load('recovery_witness_state', C.REPO / 'ops/payload-control-state.py')
        body = b'fixture-closed\n'
        mode = {'status': 503, 'body': body, 'redirect': False, 'requests': 0}
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                assert self.path in R.ROUTES
                mode['requests'] += 1
                self.send_response(mode['status'])
                if mode['redirect']:
                    self.send_header('Location', '/elsewhere')
                self.send_header('Content-Length', str(len(mode['body'])))
                self.end_headers(); self.wfile.write(mode['body'])
            def log_message(self, *args):
                pass
        C.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
               '-keyout', root / 'tls.key', '-out', root / 'tls.crt', '-subj', '/CN=localhost',
               '-addext', 'subjectAltName=DNS:localhost'])
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.daemon_threads = True
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(root / 'tls.crt', root / 'tls.key')
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        routes = [{'route': p, 'status': 503, 'bodySha256': C.sha(body)} for p in R.ROUTES]
        profile = C.canonical({'kind': 'production-b0-witness-profile-v1', 'routes': routes})
        C.write(root / 'profile.json', profile, 0o644)
        # Only deployment constants are adapted. Parser, budgets, canonicalization,
        # closed-response matching and HTTPS verification remain the actual helper.
        original = (C.REPO / 'ops/payload-recovery-witness.py').read_bytes()
        adapted = original
        changes = {
            b"PROFILE = '/etc/ownerinc/payload-witness/profile.json'": ('PROFILE = ' + repr(str(root / 'profile.json'))).encode(),
            b"ORIGIN = 'portal.ownerinc.com.br'": b"ORIGIN = 'localhost'",
            b'HTTPSConnection(ORIGIN,443,': ('HTTPSConnection(ORIGIN,' + str(server.server_port) + ',').encode(),
            b'ssl.create_default_context()': ('ssl.create_default_context(cafile=' + repr(str(root / 'tls.crt')) + ')').encode(),
        }
        for old, new in changes.items():
            assert adapted.count(old) == 1
            adapted = adapted.replace(old, new)
        helper = C.write(root / 'witness.py', adapted, 0o755)
        # Adversarial remote response modes still traverse the real pinned SSH
        # transport. Normal mode invokes the actual forced helper in a new process.
        C.write(root/'deadline.json',C.canonical({k:os.environ[k] for k in C.DEADLINE_KEYS}))
        wrapper = C.write(root / 'forced.py', ('''import importlib.util,json,os,pathlib,sys
root=pathlib.Path(__file__).parent
os.environ.update(json.loads((root/'deadline.json').read_bytes()))
spec=importlib.util.spec_from_file_location('witness_ci_budget',__CI_UTILITY__)
C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
request=sys.stdin.buffer.read(4097)
mode=(root/'mode').read_text()
result=C.run(['/usr/bin/python3','-I','-S','-B',str(root/'witness.py')],data=request,ok=False,env={'PATH':'/usr/bin:/bin','SSH_ORIGINAL_COMMAND':os.environ.get('SSH_ORIGINAL_COMMAND','')},timeout=20)
if result.returncode:sys.exit(2)
raw=result.stdout
if mode=='replay':raw=(root/'last-response').read_bytes()
elif mode=='mismatch':
 value=json.loads(raw);value['contextSha256']='0'*64
 raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\\n').encode()
elif mode=='overflow':raw=b'x'*8192
else:(root/'last-response').write_bytes(raw)
sys.stdout.buffer.write(raw)
''').replace('__CI_UTILITY__',repr(str(C.REPO/'tests/fixtures/payload-production-recovery-ci.py'))).encode(), 0o755)
        C.write(root / 'mode', b'normal')
        for name in ('host', 'client', 'wrong'):
            C.run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', root / name])
        command = '/usr/bin/python3 -I -S -B ' + str(wrapper)
        C.write(root / 'authorized_keys', ('restrict,command="' + command + '" ' + (root / 'client.pub').read_text()).encode())
        port = free_port()
        C.write(root / 'sshd.conf', (f'''Port {port}
ListenAddress 127.0.0.1
HostKey {root}/host
PidFile {root}/sshd.pid
AuthorizedKeysFile {root}/authorized_keys
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
StrictModes yes
AllowUsers root
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
X11Forwarding no
PermitTTY no
PermitUserEnvironment no
LogLevel ERROR
''').encode())
        Path('/run/sshd').mkdir(mode=0o755, exist_ok=True)
        C.run(['/usr/sbin/sshd', '-t', '-f', root / 'sshd.conf'])
        daemon = owned.process(['/usr/bin/prlimit','--as=536870912','--nofile=256','--cpu=60','--',
            '/usr/sbin/sshd', '-D', '-e', '-f', root / 'sshd.conf'])
        deadline = time.monotonic() + C.budget().window(10)
        while True:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.2):
                    break
            except OSError:
                assert daemon.poll() is None and time.monotonic() < deadline
                time.sleep(.05)
        R.SSH_CONFIG = str(root / 'client.conf'); R.KNOWN_HOSTS = str(root / 'known_hosts')
        C.write(R.SSH_CONFIG, (f'''Host ownerinc-payload-fence-witness
  HostName 127.0.0.1
  Port {port}
  User root
  IdentityFile {root}/client
  IdentitiesOnly yes
  IdentityAgent none
''').encode())
        def pin(name):
            key = ' '.join((root / (name + '.pub')).read_text().split()[:2])
            C.write(R.KNOWN_HOSTS, ('ownerinc-payload-fence-witness ' + key + '\n').encode())
        pin('host')
        fd = os.open(root / 'lease', os.O_CREAT | os.O_RDWR, 0o600)
        if fd != 9:
            os.dup2(fd, 9); os.close(fd)
        import fcntl
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
        host = object.__new__(R.ProductionHost)
        def bounded(args,**kwargs):
            kwargs['timeout']=C.budget().window(kwargs.get('timeout',120))
            return R.bounded_command(args,**kwargs)
        host.command=bounded
        host.l = L; host.s = S; host.head = 'a' * 64; host.binding = {'fixture': True}
        host.profile = {'witness': {'routes': routes, 'profileSha256': C.sha(profile),
            'sshSha256': C.sha(Path('/usr/bin/ssh').read_bytes()),
            'configSha256': C.sha(Path(R.SSH_CONFIG).read_bytes()),
            'knownHostsSha256': C.sha(Path(R.KNOWN_HOSTS).read_bytes())}}
        assert len(host.witness()) == 64 and mode['requests'] == 3
        failures = []
        def denied(name):
            try:
                host.witness()
            except (R.RecoveryError, S.StateError):
                failures.append(name)
            else:
                raise AssertionError('witness negative accepted: ' + name)
        for value in ('replay', 'mismatch', 'overflow'):
            C.write(root / 'mode', value.encode()); denied(value)
        C.write(root / 'mode', b'normal')
        pin('wrong'); host.profile['witness']['knownHostsSha256'] = C.sha(Path(R.KNOWN_HOSTS).read_bytes())
        denied('wrong-host-key')
        pin('host'); host.profile['witness']['knownHostsSha256'] = C.sha(Path(R.KNOWN_HOSTS).read_bytes())
        host.profile['witness']['profileSha256'] = '0' * 64; denied('profile-mismatch')
        host.profile['witness']['profileSha256'] = C.sha(profile)
        mode['status'] = 502; denied('upstream-502'); mode['status'] = 503
        mode['body'] = b'wrong'; denied('body-mismatch'); mode['body'] = body
        mode['redirect'] = True; denied('redirect'); mode['redirect'] = False
        requested_command = C.run(['/usr/bin/ssh', '-F', R.SSH_CONFIG, '-oBatchMode=yes',
            '-oStrictHostKeyChecking=yes', '-oHostKeyAlias=ownerinc-payload-fence-witness',
            '-oUserKnownHostsFile=' + R.KNOWN_HOSTS, 'ownerinc-payload-fence-witness', 'id'], ok=False)
        assert requested_command.returncode != 0
        assert len(host.witness()) == 64
        daemon.terminate(); daemon.wait(timeout=C.budget().window(10)); denied('transport-failure')
        os.close(9)
        report = {'kind': 'recovery-forced-ssh-ci-v1', 'actualOpenSsh': True, 'actualHttps': True,
            'actualForcedHelper': True, 'callerCommandRejected': True, 'negatives': failures,
            'sourceClosure': {'originalSha256': C.sha(original), 'adaptedSha256': C.sha(adapted),
                'forcedWrapperSha256':C.sha(wrapper.read_bytes()),'fixtureSha256':C.sha(Path(__file__).read_bytes()),
                'adaptations': ['profile-path', 'loopback-origin-port', 'fixture-ca']},
            'externalProductionClosureQualified': False, 'scope': 'loopback-transport-only'}
    finally:
        if server:
            server.shutdown(); server.server_close()
        if thread:
            thread.join(timeout=5)
            assert not thread.is_alive()
        cleanup = owned.cleanup()
    C.publish_report('witness', report, cleanup)


if __name__ == '__main__':
    main()
