import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const fixture = String.raw`
import sys,os,copy,importlib.util,json
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('fence_runtime',os.path.join(sys.argv[1],'ops','payload-control-runtime.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
context={k:'a'*64 for k in ('inventoryIdentity','stateSha256','installBindingSha256','sourceApprovalSha256','policySha256','recordSha256','nonce')}
context.update(sequence=3,pid=123,processStart=456,device=1,inode=2)
network_ids=dict(zip(r.FENCE_NETWORKS,('a'*64,'b'*64,'c'*64)))
containers=[]
for i,service in enumerate(('nginx','api','cron','postgres'),1):
 networks=[network_ids['ownerinc-portal-backend']]
 if service in ('api','cron'):networks.append(network_ids['ownerinc-portal-egress'])
 if service=='nginx':networks.append(network_ids['ownerinc_proxy'])
 volumes=[] if service=='nginx' else ['portalPostgres' if service=='postgres' else 'portalUploads']
 containers.append({'id':str(i)*64,'service':service,'imageId':'d'*64,'image':'fixture/'+service+'@sha256:'+'e'*64,
 'receiptSha256':'f'*64,'networks':networks,'volumeKeys':volumes,'status':'running' if service=='postgres' else 'exited',
 'running':service=='postgres','paused':False,'restarting':False,'dead':False,'oneOff':False,'projectMatches':True,
 'nginxNameMatches':True,'networkMode':'bridge','publishedPorts':False,'aliasesApproved':True})
networks=[{'name':name,'id':identity,'driver':'bridge','internal':name=='ownerinc-portal-backend','optionsApproved':True,
 'endpoints':([{'id':'4'*64,'relevant':True}] if name=='ownerinc-portal-backend' else
 [{'id':'6'*64,'relevant':True},{'id':'7'*64,'relevant':False}] if name=='ownerinc_proxy' else [])}
 for name,identity in network_ids.items()]
host=[{'id':c['id'],'portalProject':True,'portalNameClaim':True,'portalVolumeConsumer':bool(c['volumeKeys'])} for c in containers]
host.extend({'id':i*64,'portalProject':False,'portalNameClaim':False,'portalVolumeConsumer':False} for i in ('6','7'))
snapshot={'host':host,'containers':containers,'networks':networks}
database={'service':'postgres','containerId':'4'*64,'database':{'systemIdentifier':'123','databaseOid':'456','databaseName':'portal'},
 'clients':0,'activeQueries':0,'openTransactions':0,'preparedTransactions':0,'backgroundWriters':0,'backgroundCoverageComplete':True}
closure={'kind':'portal-public-closure-profile-v1','context':copy.deepcopy(context),'origin':'https://portal.example.test',
 'observerSha256':'8'*64,'nonDockerCoverageVerified':True,
 'routes':[{'route':route,'status':503,'bodySha256':'9'*64} for route in r.FENCE_ROUTES]}
external={'observerSha256':'8'*64,'independent':True,'nonce':context['nonce'],'started':110,'ended':140,
 'requests':[dict(item,origin=closure['origin'],method='GET',tlsVerified=True,redirected=False,transportError='none') for item in closure['routes']]}
observation={'kind':'portal-fence-observation-v1','mode':'destructive','context':copy.deepcopy(context),'started':100,'ended':150,
 'passes':[copy.deepcopy(snapshot),copy.deepcopy(snapshot)],'databases':[copy.deepcopy(database)],'external':external}
identity_fields=('id','service','imageId','image','receiptSha256','networks','volumeKeys')
topology={'kind':'portal-fence-topology-v1','context':copy.deepcopy(context),
 'containers':[{k:copy.deepcopy(c[k]) for k in identity_fields} for c in containers],
 'networks':[{'name':n['name'],'id':n['id'],'relevantEndpointIds':[ep['id'] for ep in n['endpoints'] if ep['relevant']]} for n in networks],
 'databases':[{k:copy.deepcopy(database[k]) for k in ('service','containerId','database')}]}
def check(value=observation,top=topology,public=closure,now=175):
 return r.check_portal_destructive_fence(value,context,top,public,now_monotonic=now)
def rejected(callback):
 try:callback()
 except (r.ControlError,r.STATE.StateError):pass
 else:raise AssertionError('malformed observation accepted')
def both(mutate):
 value=copy.deepcopy(observation)
 for item in value['passes']:mutate(item)
 return value
`;

function probe(code) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-S', '-B', '-c', fixture + code, path.resolve('.')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('pure fence matches fixed synthetic projections without authorizing effects or disclosing topology', () => {
  probe(String.raw`
before=copy.deepcopy(observation)
with patch.object(r,'Runtime',side_effect=AssertionError('constructor forbidden')),patch.object(r.subprocess,'run',side_effect=AssertionError('IO forbidden')),patch.object(r.STATE,'transition',side_effect=AssertionError('write forbidden')):
 result=check();assert result['observationsMatched'] and result['blockers']==[]
 assert check(r.STATE.canonical(observation))==result
 shuffled=copy.deepcopy(observation)
 for p in shuffled['passes']:
  p['containers'].reverse();p['host'].reverse();p['networks'].reverse()
  for c in p['containers']:c['networks'].reverse()
 assert check(shuffled)==result
assert observation==before
for key in ('destructiveOperationAuthorized','installationExecuted','deploymentAuthorized'):assert result[key] is False
encoded=json.dumps(result)
assert closure['origin'] not in encoded and 'ownerinc_proxy' not in encoded and 'containerId' not in encoded
assert not any('fence' in action for action in r.ACTION_SET)
assert 'fence_topology_unapproved' in check(top=None)['blockers']
assert 'fence_external_topology_unverified' in check(public=None)['blockers']
`);
});

test('writer states and a sentinel or absent ports cannot substitute for actual stopped nginx and bound writers', () => {
  probe(String.raw`
for status,flags in [('running',{'running':True}),('paused',{'paused':True}),('restarting',{'restarting':True}),('dead',{'dead':True})]:
 value=both(lambda p:p['containers'][0].update(status=status,**flags))
 assert 'fence_nginx_not_stopped' in check(value)['blockers']
for mutate,blocker in [
 (lambda p:p['containers'][1].update(running=True),'fence_writer_not_stopped'),
 (lambda p:p['containers'][1].update(oneOff=True),'fence_unaccounted_container'),
 (lambda p:p['containers'][1].update(networkMode='host'),'fence_alternative_ingress_detected'),
 (lambda p:p['containers'][1].update(networkMode='container'),'fence_alternative_ingress_detected'),
 (lambda p:p['containers'][1].update(publishedPorts=True),'fence_alternative_ingress_detected'),
 (lambda p:p['containers'][1]['networks'].append('c'*64),'fence_alternative_ingress_detected'),
 (lambda p:p['containers'][1].update(receiptSha256='0'*64),'fence_container_receipt_mismatch'),
 (lambda p:p['containers'].pop(0),'fence_nginx_identity_mismatch'),
 (lambda p:p['containers'][1].update(service='nginx'),'fence_unaccounted_container'),
 (lambda p:p['host'].append({'id':'0'*64,'portalProject':False,'portalNameClaim':False,'portalVolumeConsumer':True}),'fence_unaccounted_container')]:
 assert blocker in check(both(mutate))['blockers'],blocker
value=copy.deepcopy(observation);value['mode']='private-readiness'
assert 'fence_private_readiness_not_destructive' in check(value)['blockers']
value['sentinel']=True;rejected(lambda:check(value))
`);
});

test('network identities, endpoint relevance and exact two-pass context fail closed without rejecting unrelated proxy projects', () => {
  probe(String.raw`
assert check()['observationsMatched'] # Existing unrelated shared-proxy endpoint is permitted.
for mutate,blocker in [
 (lambda p:p['networks'][0].update(id='0'*64),'fence_network_identity_mismatch'),
 (lambda p:p['networks'][0].update(internal=False),'fence_network_identity_mismatch'),
 (lambda p:p['networks'][0]['endpoints'].append({'id':'0'*64,'relevant':False}),'fence_unapproved_endpoint'),
 (lambda p:p['networks'][2]['endpoints'][1].update(relevant=True),'fence_unapproved_endpoint'),
 (lambda p:p['containers'][1].update(aliasesApproved=False),'fence_alternative_ingress_detected')]:
 assert blocker in check(both(mutate))['blockers']
value=copy.deepcopy(observation);value['passes'][1]['containers'][1]['imageId']='0'*64
assert 'fence_context_changed' in check(value)['blockers']
for name in context:
 value=copy.deepcopy(observation);value['context'][name]=context[name]+1 if type(context[name]) is int else '0'*64
 assert 'fence_context_changed' in check(value)['blockers'],name
assert 'fence_observation_stale' in check(now=30101)['blockers']
assert 'fence_observation_stale' in check(now=140)['blockers']
`);
});

test('independent public GET evidence needs the exact approved closed contract and coverage', () => {
  probe(String.raw`
for field,item in [('status',200),('status',302),('status',0),('tlsVerified',False),('redirected',True),
 ('transportError','timeout'),('transportError','dns'),('transportError','tls'),('origin','https://wrong.example.test'),('bodySha256','0'*64)]:
 value=copy.deepcopy(observation);value['external']['requests'][0][field]=item
 assert 'fence_public_probe_mismatch' in check(value)['blockers'],field
for field,item in [('independent',False),('nonce','0'*64),('observerSha256','0'*64),('started',99),('ended',151)]:
 value=copy.deepcopy(observation);value['external'][field]=item
 assert 'fence_public_probe_mismatch' in check(value)['blockers']
value=copy.deepcopy(observation);value['external']=None
assert 'fence_public_probe_missing' in check(value)['blockers']
public=copy.deepcopy(closure);public['nonDockerCoverageVerified']=False
assert 'fence_external_topology_unverified' in check(public=public)['blockers']
public['routes'][0]['status']=200;rejected(lambda:check(public=public))
value=copy.deepcopy(observation);value['external']['requests'].pop()
assert 'fence_public_probe_mismatch' in check(value)['blockers']
`);
});

test('database observations require exact bound targets and complete zero-writer predicates', () => {
  probe(String.raw`
for field in ('clients','activeQueries','openTransactions','preparedTransactions','backgroundWriters'):
 value=copy.deepcopy(observation);value['databases'][0][field]=1
 assert 'fence_database_not_quiescent' in check(value)['blockers']
value=copy.deepcopy(observation);value['databases'][0]['backgroundCoverageComplete']=False
assert 'fence_background_writers_unverified' in check(value)['blockers']
for mutate in (lambda v:v['databases'][0].update(containerId='0'*64),
 lambda v:v['databases'][0]['database'].update(databaseOid='999'),lambda v:v.update(databases=[])):
 value=copy.deepcopy(observation);mutate(value)
 assert 'fence_database_identity_mismatch' in check(value)['blockers']
`);
});

test('strict shapes reject secret fields, duplicate records, malformed projections and collection limits', () => {
  probe(String.raw`
for mutate in (lambda v:v.update(password='SECRET'),lambda v:v['passes'][0]['containers'][0].update(Env=['SECRET']),
 lambda v:v['passes'][0]['networks'][0].update(IPAM={'IP':'10.0.0.1'}),
 lambda v:v['passes'][0]['containers'][0].update(aliases=['other-project']),
 lambda v:v['passes'][0]['host'].append(copy.deepcopy(v['passes'][0]['host'][0])),
 lambda v:v['passes'][0]['containers'][0].update(running=0),
 lambda v:v['external']['requests'][0].update(origin='https://user:SECRET@host'),
 lambda v:v['external']['requests'][0].update(method='POST')):
 value=copy.deepcopy(observation);mutate(value);rejected(lambda:check(value))
for field,maximum in (('host',512),('containers',64)):
 value=copy.deepcopy(observation);row=value['passes'][0][field][0]
 value['passes'][0][field]=[dict(row,id=format(i,'064x')) for i in range(maximum+1)]
 rejected(lambda:check(value))
value=copy.deepcopy(observation);value['passes'][0]['networks'][0]['endpoints']=[{'id':format(i,'064x'),'relevant':False} for i in range(257)]
rejected(lambda:check(value))
rejected(lambda:check(b' '*(4*1024*1024+1)))
`);
});
