import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const python = process.platform === 'win32' ? 'python' : 'python3';
const bashPath = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`);
const request = `production:payload-v1 ${'a'.repeat(40)} 1 1 ${['api', 'cron', 'cms'].map(s => `ghcr.io/ownerinc/ownerinc-portal-${s}@sha256:${'b'.repeat(64)}`).join(' ')} 11 12 13`;

test('actual production wrapper uses only fixed sudo for Payload; legacy SHA delegation remains unprivileged (transport doubles)', async t => {
  const root = await mkdtemp(path.join(process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir(), 'receiver-wrapper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sudo = path.join(root, 'sudo');
  const legacy = path.join(root, 'legacy');
  await writeFile(sudo, '#!/bin/bash\nprintf "sudo\\n"; printf "<%s>\\n" "$@"\n', { mode: 0o755 });
  await writeFile(legacy, '#!/bin/bash\nprintf "legacy:<%s>:<%s>\\n" "$DEPLOY_RECEIVER_ROLE" "$SSH_ORIGINAL_COMMAND"\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 });
  const source = await readFile('ops/deploy-from-production-ci.sh', 'utf8');
  assert.match(source, /exec \/usr\/bin\/sudo -n -- \/usr\/local\/libexec\/ownerinc-payload-receive "\$SSH_ORIGINAL_COMMAND"/u);
  const script = path.join(root, 'wrapper');
  await writeFile(script, source.replace('/usr/bin/sudo', `'${bashPath(sudo)}'`).replace('exec /usr/local/libexec/ownerinc-portal-deploy ', `exec '${bashPath(legacy)}' `));
  const run = (command, args = []) => spawnSync(bash, [bashPath(script), ...args], { encoding: 'utf8', env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, timeout: 10000 });
  const payload = run(request);
  assert.equal(payload.status, 0, payload.stderr);
  assert.equal(payload.stdout, `sudo\n<-n>\n<-->\n</usr/local/libexec/ownerinc-payload-receive>\n<${request}>\n`);
  const injection = `${request}; echo NEVER_EXECUTE`;
  assert.ok(run(injection).stdout.endsWith(`<${injection}>\n`), 'one opaque argument, never shell expansion');
  assert.equal(run(request, ['extra']).status, 2);
  for (const command of ['staging:payload-v1 x', 'unknown:payload-v1 x']) assert.equal(run(command).status, 2);
  for (const command of ['a'.repeat(40), `production:${'a'.repeat(40)}`]) {
    const result = run(command, ['legacy-argument']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `legacy:<production>:<production:${'a'.repeat(40)}>\n<legacy-argument>\n`);
  }
});

test('root launcher rejects extra args and clears environment before fixed isolated helper (UID/interpreter transport doubles)', async t => {
  const root = await mkdtemp(path.join(process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir(), 'receiver-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile('ops/payload-receiver-root.sh', 'utf8');
  assert.match(source, /^#!\/bin\/bash -p\n/u);
  assert.match(source, /\$UID != 0 \|\| \$EUID != 0 \|\| \$# != 1/u);
  assert.match(source, /\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin LANG=C LC_ALL=C/u);
  assert.match(source, /\/usr\/bin\/python3 -I -S \/usr\/local\/libexec\/payload-receiver-admission.py payload "\$1"/u);
  const interpreter = path.join(root, 'python');
  await writeFile(interpreter, '#!/bin/bash\nprintf "secret=<%s> pythonpath=<%s>\\n" "${PRIVATE_SECRET:-}" "${PYTHONPATH:-}"\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 });
  const script = path.join(root, 'launcher');
  await writeFile(script, source.replace('$UID != 0 || $EUID != 0 || ', '').replace('/usr/bin/python3', `'${bashPath(interpreter)}'`));
  const run = args => spawnSync(bash, ['-p', bashPath(script), ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PRIVATE_SECRET: 'not-forwarded', PYTHONPATH: 'not-forwarded' } });
  assert.equal(run([]).status, 2);
  assert.equal(run([request, 'extra']).status, 2);
  const result = run([request]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `secret=<> pythonpath=<>\n<-I>\n<-S>\n</usr/local/libexec/payload-receiver-admission.py>\n<payload>\n<${request}>\n`);
});

test('actual helper rejects malformed privileged requests before filesystem/stream effects', () => {
  const helper = path.resolve('ops/payload-receiver-admission.py');
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', `
import importlib.util
spec=importlib.util.spec_from_file_location('receiver',${JSON.stringify(helper)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert m.INCOMING == '/var/lib/ownerinc/payload-candidate/incoming'
def forbidden(*args,**kwargs):raise AssertionError('effect before parse')
m.protected_directory=forbidden;m.tempfile.mkdtemp=forbidden
request=${JSON.stringify(request)}
for raw in [request+';id',request+' extra',request.replace('production:','staging:'),request.replace('production:','unknown:'),request+'\\n',request.replace(' 12 ',' 11 '), '']:
    try:m.payload_request(raw,object())
    except m.ReceiverError as error:assert str(error)=='invalid_request'
    else:raise AssertionError('accepted malformed request')
`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('actual installer root-chain algorithm refuses unsafe existing components without repair (stat/mkdir doubles)', async () => {
  const installer = await readFile('ops/prepare-cms-infrastructure.sh', 'utf8');
  const code = installer.split('receiver_privilege_paths() {')[1].split("<<'PY'\n")[1].split('\nPY\n')[0];
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', `
import os,posixpath,stat,sys,types
from unittest.mock import patch
code=${JSON.stringify(code)}
incoming='/var/lib/ownerinc/payload-candidate/incoming'
files=['/usr/local/libexec/root','/usr/local/libexec/wrapper','/etc/sudoers.d/rule','/bundle/root','/bundle/wrapper']
base={p:types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0,st_gid=0,st_nlink=1) for p in ['/', '/var','/var/lib','/usr','/usr/local','/usr/local/libexec','/etc','/etc/sudoers.d','/bundle']}
for p in files[-2:]:base[p]=types.SimpleNamespace(st_mode=stat.S_IFREG|0o755,st_uid=0,st_gid=0,st_nlink=1)
def run(mode,override=None):
    tree=dict(base);tree.update(override or {});effects=[]
    def lstat(p):
        if p not in tree:raise FileNotFoundError(p)
        return tree[p]
    def mkdir(p,mode):
        effects.append(('mkdir',p));tree[p]=types.SimpleNamespace(st_mode=stat.S_IFDIR|mode,st_uid=0,st_gid=0,st_nlink=1)
    def chown(p,*_):effects.append(('chown',p))
    with patch.object(os,'path',posixpath),patch.object(os,'lstat',lstat),patch.object(os,'mkdir',mkdir),patch.object(os,'chown',chown,create=True),patch.object(sys,'argv',['-',mode,incoming,*files]):
        try:exec(code,{});ok=True
        except SystemExit:ok=False
    return ok,effects
assert run('check')==(True,[])
ok,effects=run('create');assert ok and len(effects)==6
for mode,uid,gid in [(stat.S_IFLNK|0o777,0,0),(stat.S_IFDIR|0o777,0,0),(stat.S_IFDIR|0o700,1000,1000),(stat.S_IFDIR|0o700,0,1000)]:
    bad=types.SimpleNamespace(st_mode=mode,st_uid=uid,st_gid=gid,st_nlink=1)
    for action in ['check','create']:
        assert run(action,{'/var/lib':bad})==(False,[])
assert run('check',{'/var/lib/ownerinc':types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0,st_gid=0,st_nlink=1), '/var/lib/ownerinc/payload-candidate':types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0,st_gid=0,st_nlink=1), incoming:types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0,st_gid=0,st_nlink=1)})==(False,[])
`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
