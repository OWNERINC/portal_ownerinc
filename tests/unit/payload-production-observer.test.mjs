import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve('.');
const observerPath = path.join(repo, 'ops', 'payload-production-observer.py');
const python = process.platform === 'win32' ? 'python' : 'python3';
const setup = String.raw`
import copy,hashlib,importlib.machinery,json,os,sys,types
path=sys.argv[1]
m=importlib.machinery.SourceFileLoader('payload_production_observer',path).load_module()
request={'schemaVersion':1,'kind':'payload-production-context-request-v1','operation':'collect-context','nonce':'a'*64,'approvalSha256':'b'*64}
context={'approvalSha256':'b'*64,'sourceCommit':'c'*40,'inventoryIdentity':'d'*64,'stateSha256':'e'*64,'stateSequence':0,'pid':123,'processStart':456,'leaseDevice':7,'leaseInode':8}
response={'schemaVersion':1,'kind':'payload-production-context-observation-v1','operation':'collect-context','nonce':'a'*64,'context':context,'sourceAuthenticated':True,'inventoryAuthenticated':True,'stateAuthenticated':True,'leaseVerified':True,'destructiveOperationAuthorized':False,'installationExecuted':False,'deploymentAuthorized':False,'productionAuthorized':False}
def denied(fn):
 try:fn()
 except Exception:return
 raise AssertionError('unexpected acceptance')
`;

function probe(code) {
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', setup + code, observerPath], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('strict JSON accepts only bounded canonical UTF-8 with unique keys', () => {
  probe(String.raw`
raw=m.canonical({'message':'caf\u00e9','schemaVersion':1})+b'\n'
assert raw==b'{"message":"caf\\u00e9","schemaVersion":1}\n'
assert m.strict_json(raw)=={'message':'caf\u00e9','schemaVersion':1}
for invalid in (b'',b'{}',b'{ }\n',b'{"x":1,"x":1}\n',b'{"x":NaN}\n',b'{"message":"caf\xc3\xa9"}\n'):
 denied(lambda invalid=invalid:m.strict_json(invalid))
denied(lambda:m.strict_json(b'{}\n',2))
value=0
for _ in range(32):value=[value]
denied(lambda:m.strict_json(m.canonical(value)+b'\n'))
`);
});

test('request schema is closed and rejects every caller-selected field', () => {
  probe(String.raw`
assert m.validate_request(copy.deepcopy(request))==request
mutations=[
 lambda v:v.__setitem__('schemaVersion',True),lambda v:v.__setitem__('schemaVersion',2),
 lambda v:v.__setitem__('kind','other'),lambda v:v.__setitem__('operation','security'),
 lambda v:v.__setitem__('nonce','A'*64),lambda v:v.__setitem__('approvalSha256','short'),
 lambda v:v.__setitem__('path','/tmp/caller-selected'),lambda v:v.__setitem__('sql','select 1'),
 lambda v:v.__setitem__('role','postgres'),lambda v:v.__setitem__('command',['sh'])]
for mutate in mutations:
 value=copy.deepcopy(request);mutate(value);denied(lambda value=value:m.validate_request(value))
for field in request:
 value=copy.deepcopy(request);del value[field];denied(lambda value=value:m.validate_request(value))
`);
});

test('response schema is exact, typed, non-authorizing, and request-bound', () => {
  probe(String.raw`
assert m.validate_response(copy.deepcopy(response),'a'*64,'b'*64)==response
for field in response:
 value=copy.deepcopy(response);del value[field];denied(lambda value=value:m.validate_response(value,'a'*64,'b'*64))
for field in context:
 value=copy.deepcopy(response);del value['context'][field];denied(lambda value=value:m.validate_response(value,'a'*64,'b'*64))
value=copy.deepcopy(response);value['extra']=False;denied(lambda:m.validate_response(value,'a'*64,'b'*64))
value=copy.deepcopy(response);value['context']['extra']='secret';denied(lambda:m.validate_response(value,'a'*64,'b'*64))
for field in ('sourceAuthenticated','inventoryAuthenticated','stateAuthenticated','leaseVerified'):
 value=copy.deepcopy(response);value[field]=False;denied(lambda value=value:m.validate_response(value,'a'*64,'b'*64))
for field in ('destructiveOperationAuthorized','installationExecuted','deploymentAuthorized','productionAuthorized'):
 value=copy.deepcopy(response);value[field]=True;denied(lambda value=value:m.validate_response(value,'a'*64,'b'*64))
for field in ('stateSequence','pid','processStart','leaseDevice','leaseInode'):
 value=copy.deepcopy(response);value['context'][field]=True;denied(lambda value=value:m.validate_response(value,'a'*64,'b'*64))
for field,bad in [('sourceCommit','C'*40),('inventoryIdentity','short'),('stateSha256','short'),('stateSequence',-1),('pid',0),('processStart',0),('leaseDevice',-1),('leaseInode',0)]:
 value=copy.deepcopy(response);value['context'][field]=bad;denied(lambda value=value:m.validate_response(value,'a'*64,'b'*64))
denied(lambda:m.validate_response(response,'f'*64,'b'*64))
denied(lambda:m.validate_response(response,'a'*64,'f'*64))
`);
});

test('process start parses Linux stat field 22 after the final comm parenthesis', () => {
  probe(String.raw`
fields=['S']+['0']*18+['987654']
class Reader:
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,maximum):assert maximum==4097;return ('42 (worker ) name) '+' '.join(fields)+'\n').encode()
m.open=lambda filename,mode:Reader()
assert m.process_start_ticks()==987654
for raw in (b'',b'42 malformed',b'42 (worker) '+b' '.join([b'S']+[b'0']*19),b'42 (worker) '+b' '.join([b'S']+[b'0']*18+[b'-1'])):
 class BadReader(Reader):
  def read(self,maximum):return raw
 m.open=lambda filename,mode:BadReader()
 denied(m.process_start_ticks)
`);
});

test('collection projects authenticated context without leaking state material', () => {
  probe(String.raw`
secret='SYNTHETIC_PRIVATE_STATE_SECRET'
body={'sequence':4,'private':secret,'nested':{'dsn':'not-projected'}}
class State:
 @staticmethod
 def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
class Inventory:
 @staticmethod
 def identity(value):assert value=={'fixed':'inventory'};return 'd'*64
runtime=types.SimpleNamespace(STATE=State,INVENTORY=Inventory)
class Launcher:
 def __init__(self):self.checks=0
 def context_material(self,digest):assert digest=='b'*64;return ({'hostBaseline':{'currentCommit':'c'*40}},'captured',None,None,'b'*64)
 def inspect_install_host(self,approval,captured):return runtime,{'fixed':'inventory'},body,None
 def verify_inherited_lease(self):self.checks+=1
launcher=Launcher()
m.os.fstat=lambda fd:types.SimpleNamespace(st_dev=7,st_ino=8)
m.os.getpid=lambda:123
m.process_start_ticks=lambda:456
result=m.collect_context(copy.deepcopy(request),launcher)
assert launcher.checks==2
assert set(result)==set(response) and set(result['context'])==set(context)
assert result['context']['stateSha256']==hashlib.sha256(State.canonical(body)).hexdigest()
assert secret not in json.dumps(result) and 'dsn' not in json.dumps(result)
assert result['destructiveOperationAuthorized'] is False
assert result['installationExecuted'] is False
assert result['deploymentAuthorized'] is False
assert result['productionAuthorized'] is False
`);
});

test('source has no effectful integration or caller-selected path mechanism', () => {
  const source = readFileSync(observerPath, 'utf8');
  for (const forbidden of ['subprocess', 'socket', 'psycopg', 'docker', 'pg_authid', 'environ', 'eval', 'exec(']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(source, /open\([^\n]*['"](?:w|a|x|r\+|w\+|a\+|x\+)b?['"]/);
  assert.equal(source.includes('/usr/local/libexec/ownerinc-payload-prepare.py'), true);
  assert.equal(source.includes('argparse'), false);
});

test('CLI failures expose only the fixed denial', () => {
  const result = spawnSync(python, ['-I', '-S', '-B', observerPath, 'other'], {
    encoding: 'utf8',
    input: '{"private":"must-not-echo"}\n',
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Production context collection denied.\n');
  assert.equal(result.stderr.includes('Traceback'), false);
  assert.equal(result.stderr.includes('must-not-echo'), false);
});
