import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
  .find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);

function probe(body) {
  if (!python) return { status: 0, stdout: '', stderr: '' };
  return spawnSync(python, ['-I', '-S', '-B', '-c', String.raw`
import importlib.util,json,os,stat,sys,tempfile,time
spec=importlib.util.spec_from_file_location('route',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
${body}
`, 'ops/payload-route-promotion.py'], { encoding: 'utf8' });
}

const fixture = String.raw`
key=b'k'*32
route=b'location = /editorial { return 308 /editorial/admin; }\n'
context={'commit':'b'*40,'release':'/releases/'+'b'*40,
 'image':'ghcr.io/ownerinc/ownerinc-portal-cms@sha256:'+'a'*64,
 'containerId':'c'*64,'authority':{'mode':'legacy','epoch':1},'routeReleased':False}
counter=0
def envelope(status,raw,reason='ready'):
 global counter
 counter+=1
 generation='generation-{}-{:010d}-{:032x}'.format(status,1700000000+counter,counter)
 body=m.generation_record(status,generation,m.sha256(raw),'request-42',context if status=='promoted' else None,reason,now=7)
 return m.STATE.sign_envelope(body,key)
def root_at(parent,name):
 root=os.path.join(parent,name);os.mkdir(root);os.chmod(root,0o700);return root
def seed_baseline(root):
 body=m.generation_record('inactive','baseline-inactive',m.BASELINE_ROUTE_SHA256,'request-42',reason='inactive',now=7)
 return m.publish_generation(root,m.BASELINE_ROUTE,m.STATE.sign_envelope(body,key),key)
`;

test('promotion contract accepts only committed Gate C identity plus exact private observation', () => {
  const result = probe(String.raw`
m.STATE.validate_install_binding=lambda value:value
image='ghcr.io/ownerinc/ownerinc-portal-cms@sha256:'+'a'*64
binding={'bindingVersion':4,'project':'ownerinc-portal-prod','candidate':{'commit':'b'*40,'images':{'cms':image}},'candidateRelease':'/releases/'+'b'*40}
body={'authority':{'mode':'legacy','epoch':1},'workerHold':True,'installIntent':{'stage':'floor_committed','binding':binding,
 'creation':{'containers':{'cms':{'id':'c'*64,'image':image,'releasePath':'/releases/'+'b'*40}}}}}
context=m.route_context(body);assert context['routeReleased'] is False
observation={**{name:context[name] for name in ('commit','release','image','containerId')},'containerImage':image,
 'containerStatus':'running','containerHealth':'healthy','readiness':'ready','readinessReason':'ready','authority':context['authority']}
assert m.validate_observation(context,observation)
for change,reason in [({'readiness':'unavailable'},'private_readiness_failed'),({'containerImage':image[:-1]+'e'},'release_container_divergence'),
 ({'authority':{'mode':'payload','epoch':2}},'authority_state_invalid')]:
 bad=dict(observation);bad.update(change)
 try:m.validate_observation(context,bad)
 except m.RouteError as error:assert str(error)==reason
 else:raise AssertionError(reason+' accepted')
`);
  assert.equal(result.status, 0, result.stderr);
});

test('every publication boundary leaves active old or a complete signed generation, never partial', () => {
  const result = probe(`${fixture}${String.raw`
with tempfile.TemporaryDirectory() as parent:
 for marker in m.PUBLICATION_BOUNDARIES:
  root=root_at(parent,'case-'+marker)
  baseline=envelope('unavailable',m.CLOSED_ROUTE,'baseline_closed')
  m.publish_generation(root,m.CLOSED_ROUTE,baseline,key)
  old=m.inspect_active(root,key)['generation']
  promoted=envelope('promoted',route)
  expected=promoted['body']['generation']
  def inject(boundary):
   if boundary==marker:raise OSError('injected private detail')
  try:m.publish_generation(root,route,promoted,key,hook=inject)
  except m.PublicationError:pass
  else:raise AssertionError('boundary not injected: '+marker)
  active=m.inspect_active(root,key)
  assert active['generation'] in (old,expected),(marker,active['generation'])
  if active['generation']==expected:assert active['receipt']['status']=='promoted'
  else:assert active['receipt']['status']=='unavailable'
  assert active['receipt']['routeConfigSha256']==m.sha256(active['route'])
  assert set(os.listdir(os.path.join(root,active['generation'])))=={'include.conf','receipt.json'}
`}`);
  assert.equal(result.status, 0, result.stderr);
});

test('swap ambiguity proves promoted or atomically installs a complete unavailable generation', () => {
  const result = probe(`${fixture}${String.raw`
class Lease:
 def __init__(self):self.calls=0
 def reaffirm(self):self.calls+=1
with tempfile.TemporaryDirectory() as parent:
 for apply_first,expected in ((False,'unavailable'),(True,'unavailable')):
  root=root_at(parent,'case-'+str(apply_first))
  seed_baseline(root)
  promoted=envelope('promoted',route);real_replace=os.replace
  def ambiguous(src,dst):
   if apply_first:real_replace(src,dst)
   raise OSError('ambiguous private detail')
  result=m.publish_promoted_fail_closed(root,route,promoted,key,'request-42',Lease(),replace=ambiguous)
  active=m.inspect_active(root,key)
  assert result['receipt']['status']==expected==active['receipt']['status']
  assert active['receipt']['routeConfigSha256']==m.sha256(active['route'])
  assert set(os.listdir(os.path.join(root,active['generation'])))=={'include.conf','receipt.json'}
`}`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ambiguous private detail|Temporary|\\|\//u);
});

test('post-swap parent fsync failure refuses promoted and durably activates a new unavailable generation', () => {
  const result = probe(`${fixture}${String.raw`
class Lease:
 def reaffirm(self):return True
with tempfile.TemporaryDirectory() as parent:
 root=root_at(parent,'state');seed_baseline(root)
 promoted=envelope('promoted',route);promoted_generation=promoted['body']['generation'];real_sync=m._fsync_directory;root_syncs=0
 def fail_promoted_parent(path):
  global root_syncs
  if path==root:
   root_syncs+=1
   if root_syncs==2:raise OSError('private fsync detail')
  return real_sync(path)
 m._fsync_directory=fail_promoted_parent
 active=m.publish_promoted_fail_closed(root,route,promoted,key,'request-42',Lease())
 assert active['receipt']['status']=='unavailable' and active['durability']=='committed'
 assert active['generation']!=promoted_generation
 assert m.inspect_active(root,key)['generation']==active['generation']
`}`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /private fsync detail|Temporary|\\|\//u);
});

test('unavailable never reports success when every post-swap parent fsync is indeterminate', () => {
  const result = probe(`${fixture}${String.raw`
with tempfile.TemporaryDirectory() as parent:
 root=root_at(parent,'state');real_sync=m._fsync_directory;root_syncs=0
 def fail_every_post_swap(path):
  global root_syncs
  if path==root:
   root_syncs+=1
   if root_syncs in (2,4):raise OSError('private fsync detail')
  return real_sync(path)
 m._fsync_directory=fail_every_post_swap
 try:m.publish_unavailable(root,key,'request-42',None)
 except m.PublicationError as error:
  assert str(error)=='route_durability_indeterminate' and error.durable is False
 else:raise AssertionError('indeterminate unavailable reported success')
`}`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /private fsync detail|Temporary|\\|\//u);
});

test('matching signed receipt is mandatory before a promoted generation can become active', () => {
  const result = probe(`${fixture}${String.raw`
with tempfile.TemporaryDirectory() as parent:
 root=root_at(parent,'state')
 baseline=envelope('unavailable',m.CLOSED_ROUTE,'baseline_closed');m.publish_generation(root,m.CLOSED_ROUTE,baseline,key)
 old=m.inspect_active(root,key)['generation']
 promoted=envelope('promoted',route);promoted['body']['routeConfigSha256']='0'*64
 try:m.publish_generation(root,route,promoted,key)
 except (m.RouteError,m.STATE.StateError):pass
 else:raise AssertionError('mismatched receipt accepted')
 assert m.inspect_active(root,key)['generation']==old
`}`);
  assert.equal(result.status, 0, result.stderr);
});

test('unavailable publication retries a pre-swap failure and verifies the closed generation', () => {
  const result = probe(`${fixture}${String.raw`
with tempfile.TemporaryDirectory() as parent:
 root=root_at(parent,'state');real=m.publish_generation;calls=[]
 def flaky(*args,**kwargs):
  calls.append(1)
  if len(calls)==1:raise m.PublicationError('route_publication_failed',args[2]['body']['generation'])
  return real(*args,**kwargs)
 m.publish_generation=flaky
 active=m.publish_unavailable(root,key,'request-42',None)
 assert len(calls)==2 and active['receipt']['status']=='unavailable'
 assert active['route']==m.CLOSED_ROUTE and active['receipt']['routeConfigSha256']==m.CLOSED_ROUTE_SHA256
`}`);
  assert.equal(result.status, 0, result.stderr);
});

test('empty persistent root initializes exact signed baseline, retries idempotently, then permits first promotion', () => {
  const result = probe(`${fixture}${String.raw`
class Lease:
 def reaffirm(self):return True
with tempfile.TemporaryDirectory() as parent:
 root=root_at(parent,'state');template=os.path.join(parent,'inactive.conf');open(template,'wb').write(m.BASELINE_ROUTE);os.chmod(template,0o600)
 first=m.initialize_route_state(root,template,key,'request-42',Lease())
 assert first['generation']=='baseline-inactive' and first['receipt']['status']=='inactive' and first['durability']=='committed'
 assert set(os.listdir(root))=={'baseline-inactive','active.conf'}
 second=m.initialize_route_state(root,template,key,'request-42',Lease())
 assert second['generation']==first['generation'] and second['receipt']==first['receipt'] and second['durability']=='committed'
 promoted=envelope('promoted',route)
 active=m.publish_promoted_fail_closed(root,route,promoted,key,'request-42',Lease())
 assert active['receipt']['status']=='promoted' and active['durability']=='committed'
`}`);
  assert.equal(result.status, 0, result.stderr);
});

test('tampered baseline is refused and never treated as first-promotion authority', () => {
  const result = probe(`${fixture}${String.raw`
class Lease:
 def reaffirm(self):return True
with tempfile.TemporaryDirectory() as parent:
 root=root_at(parent,'state');template=os.path.join(parent,'inactive.conf');open(template,'wb').write(m.BASELINE_ROUTE);os.chmod(template,0o600)
 m.initialize_route_state(root,template,key,'request-42',Lease())
 include=os.path.join(root,'baseline-inactive','include.conf');os.chmod(include,0o600);open(include,'wb').write(b'tampered');os.chmod(include,0o400)
 for operation in (
  lambda:m.initialize_route_state(root,template,key,'request-42',Lease()),
  lambda:m.publish_promoted_fail_closed(root,route,envelope('promoted',route),key,'request-42',Lease())):
  try:operation()
  except (m.RouteError,m.STATE.StateError):pass
  else:raise AssertionError('tampered baseline accepted')
`}`);
  assert.equal(result.status, 0, result.stderr);
});

test('Linux FD9 lease rejects unlocked, shared, contended, and replaced locks and retains exclusive lock', { skip: process.platform === 'win32' }, () => {
  const result = probe(String.raw`
import fcntl
def attempt(kind,should_pass):
 with tempfile.TemporaryDirectory() as root:
  path=os.path.realpath(os.path.join(root,'lease'));open(path,'wb').close();os.chmod(path,0o600)
  for name in list(os.environ):
   if name.startswith('DOCKER_'):del os.environ[name]
  os.environ['PORTAL_OPERATION_LOCK']=path;os.environ['PORTAL_OPERATION_LOCK_HELD']=path
  fd=os.open(path,os.O_RDONLY);other=None
  try:
   os.dup2(fd,9)
   if kind=='shared':fcntl.flock(9,fcntl.LOCK_SH|fcntl.LOCK_NB)
   elif kind in ('exclusive','replaced'):fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
   elif kind=='contended':
    other=os.open(path,os.O_RDONLY);fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
   if kind=='replaced':
    replacement=os.path.join(root,'replacement');open(replacement,'wb').close();os.chmod(replacement,0o600);os.replace(replacement,path)
   try:
    lease=m.OperationLease(path,trusted_uid=os.geteuid(),require_root=False);lease.reaffirm();passed=True
   except m.RouteError:passed=False
   assert passed is should_pass,(kind,passed)
  finally:
   if other is not None:os.close(other)
   os.close(fd)
for case,allowed in [('unlocked',False),('shared',False),('contended',False),('replaced',False),('exclusive',True)]:attempt(case,allowed)
`);
  assert.equal(result.status, 0, result.stderr);
});

test('Linux directory bind observes active.conf replacement as a new dentry/inode', { skip: process.platform === 'win32' }, t => {
  const available = spawnSync('unshare', ['--version'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') return t.skip('unshare is unavailable');
  assert.equal(available.status, 0, available.stderr);
  const root = mkdtempSync(path.join(os.tmpdir(), 'payload-route-mount-'));
  const source = path.join(root, 'source');
  const view = path.join(root, 'view');
  mkdirSync(source); mkdirSync(view);
  writeFileSync(path.join(source, 'active.conf'), 'old\n');
  try {
    const script = String.raw`set -eu
mount --bind "$1" "$2"
old_inode=$(stat -c %i "$2/active.conf")
printf 'new\n' > "$1/.active.next"
mv -f "$1/.active.next" "$1/active.conf"
new_inode=$(stat -c %i "$2/active.conf")
test "$old_inode" != "$new_inode"
test "$(cat "$2/active.conf")" = new
umount "$2"`;
    const result = spawnSync('unshare', ['--user', '--map-root-user', '--mount', 'sh', '-eu', '-c', script, 'sh', source, view], { encoding: 'utf8' });
    if (result.status !== 0 && /Operation not permitted|permission denied|not supported/iu.test(result.stderr)) {
      return t.skip('unprivileged Linux mount namespace is unavailable');
    }
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('controller structurally reaffirms exclusive FD9 around observation and atomic swap', () => {
  const source = readFileSync('ops/payload-route-promotion.py', 'utf8');
  assert.match(source, /fcntl\.flock\(probe, fcntl\.LOCK_SH \| fcntl\.LOCK_NB\)/u);
  assert.match(source, /fcntl\.flock\(9, fcntl\.LOCK_EX \| fcntl\.LOCK_NB\)/u);
  assert.match(source, /fd_info\.st_nlink != 1|fd_info\.st_uid != self\.trusted_uid/u);
  assert.match(source, /lease\.reaffirm\(\)[\s\S]*observer\(context\)[\s\S]*lease\.reaffirm\(\)/u);
  assert.match(source, /lease\.reaffirm\(\)[\s\S]*before_pointer_swap[\s\S]*replace\(pending_pointer[\s\S]*after_pointer_swap[\s\S]*lease\.reaffirm\(\)/u);
  assert.match(source, /_fsync_directory\(root\)[\s\S]*durable = True/u);
  assert.match(source, /STATE\.read_state\(runtime_dir\)/u);
  assert.match(source, /intent\.get\('stage'\) != 'floor_committed'/u);
  assert.doesNotMatch(source, /shell=True|stderr=subprocess\.PIPE/u);
  assert.doesNotMatch(source, /payloadToPortalSecret|portalToPayloadSecret|password|token/u);
});

test('recovery directly publishes and verifies a complete unavailable generation', () => {
  const source = readFileSync('ops/payload-route-promotion.py', 'utf8');
  const recovery = source.slice(source.indexOf('def recover('), source.indexOf('\ndef main('));
  assert.match(recovery, /publish_unavailable\(ROUTE_ROOT, key, correlation_id, lease\)/u);
  assert.match(recovery, /result\['receipt'\]\['status'\] != 'unavailable'/u);
  assert.match(recovery, /result\.get\('durability'\) != 'committed'/u);
  assert.doesNotMatch(recovery, /promote\(/u);
});

test('Gate D observability remains closed and excludes private values', () => {
  const runtime = readFileSync('ops/payload-control-runtime.py', 'utf8');
  const readiness = readFileSync('cms/src/app/editorial/ready/route.ts', 'utf8');
  const authority = readFileSync('api/owner-news/authority.js', 'utf8');
  for (const category of ['backup_failure', 'restore_failure', 'database_unavailable', 'storage_unavailable', 'release_container_divergence']) {
    assert.ok(runtime.includes(category) || readiness.includes(category), `missing ${category}`);
  }
  assert.match(readiness, /event: 'editorial_readiness'[\s\S]*status, reason, requestId/u);
  assert.doesNotMatch(readiness, /console\.error\([^\n]*(?:error|uploadDir|databaseURL)/u);
  assert.match(authority, /event: 'legacy_write_refused'[\s\S]*authorityMode:[\s\S]*authorityEpoch:/u);
});
