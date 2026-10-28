import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const fixture = String.raw`
import sys,os,posixpath,copy,json,hashlib,importlib.util,re
from unittest.mock import patch
repo=sys.argv[1]
spec=importlib.util.spec_from_file_location('legacy_security_runtime',os.path.join(repo,'ops','payload-control-runtime.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r);s=r.STATE;inv=r.INVENTORY
# POSIX path modeling only; no filesystem, PostgreSQL or host collector is used.
os.path=posixpath
root='/opt/portal'
inventory=inv.production_inventory(root,root+'/runtime',root+'/releases',root+'/current-release',root+'/runtime/deploy.lock',
 '/backups/daily','/backups/production','/backups/protection','/etc/portal/env',root+'/runtime/compose',root+'/runtime/payload','portal')
images={k:'ghcr.io/ownerinc/ownerinc-portal-'+k+'@sha256:'+'a'*64 for k in ('api','cron','cms')}
authority={k:'a'*64 for k in ('sourceApprovalSha256','policySha256','recordSha256')}
record={'commit':'a'*40,'runId':'1','runAttempt':'1','images':images,'candidateSha256':'b'*64,
 'recoveryReportSha256':'c'*64,'qualifiedManifestSha256':'d'*64,'archiveSha256':'e'*64,'policySha256':'a'*64}
database={'systemIdentifier':'123','databaseOid':'456','databaseName':'portal'}
binding={'bindingVersion':4,'authority':dict(authority),'sourceCommit':'b'*40,'project':'ownerinc-portal-prod',
 'candidate':s.production_candidate(record),'candidateRelease':root+'/releases/'+'a'*40,
 'sourceRelease':root+'/releases/'+'b'*40,'previousImages':{k:images[k] for k in ('api','cron')},
 'b0':{'directory':'/backups/production/b0','proofSha256':'f'*64},'inventoryIdentity':inv.identity(inventory),
  'lease':{'device':1,'inode':2},'sharedCluster':copy.deepcopy(inventory['databaseCluster']),
  'portalTarget':{'database':database,'volumes':{k:{'name':k,'driver':'local',
 'mountpoint':'/volumes/'+k,'fingerprint':'0'*64} for k in ('portalPostgres','portalUploads')}}}
approval={'hostBaseline':{'currentCommit':'b'*40,'legacyImages':binding['previousImages'],'inventoryIdentity':inv.identity(inventory)},
 'admission':{'policySha256':'a'*64,'recordSha256':'a'*64,'archiveSha256':'e'*64}}
body={'schemaVersion':2,'phase':'preauthority','cmsStatus':'cold','authority':{'mode':'legacy','epoch':1},
 'workerHold':True,'admission':'closed','sequence':1,'previousStateSha256':'1'*64,'restoreIntent':None,
  'installIntent':{'binding':binding,'stage':'reserved','cmsTarget':None,'authorizationFreshAtReservation':True,
  'creation':{'receiptVersion':2,'fingerprintAlgorithm':'shared-cluster-container-mounts-v2',
   'resourceLifecycle':{'preexisting':['postgres','portalPostgres','portalUploads'],'created':['cmsUploads']},
   'nonce':'2'*64,'volumes':{},'containers':{}}},
 'latestProofSha256':'f'*64,'legacySourceProofSha256':'f'*64,'releaseImages':None,'plannedReleaseImages':images,
 'rollbackTargetImages':None,'nativeCatalogFingerprint':None,'inventoryIdentity':inv.identity(inventory)}
rows=[]
for role in r.LEGACY_SECURITY_ROLES:
 rows.append({'kind':'role','name':role,'login':True,'superuser':False,'createDatabase':False,'createRole':False,
 'inherit':True,'replication':False,'bypassRls':False,'connectionLimit':-1,'validUntil':None})
 rows.append({'kind':'settings','role':role,'present':False})
for name in ('externalRoleDependencies','outsidePublicObjects','largeObjects'):
 rows.append({'kind':'guard','name':name,'present':False})
def add_object(kind,schema,name,subname='',aclNull=True):
 identity={'objectType':kind,'schema':schema,'name':name,'subname':subname}
 rows.append({'kind':'object',**identity,'owner':'portal_owner','aclNull':aclNull,'unsupported':False})
 for role in r.LEGACY_SECURITY_ROLES:
  for privilege in r.LEGACY_SECURITY_PRIVILEGES.get(kind,()):
   allowed=(kind=='database' and privilege=='CONNECT') or (kind=='schema' and privilege=='USAGE')
   rows.append({'kind':'effective',**identity,'role':role,'privilege':privilege,'allowed':allowed,'grantable':False})
 return identity
add_object('database','','portal');add_object('schema','','public')
session=add_object('table','public','cms_editor_sessions')
add_object('column','public','cms_editor_sessions','id')
add_object('table','public','user_import_jobs');column=add_object('column','public','user_import_jobs','expires_at',False)
sequence=add_object('sequence','public','user_import_jobs_seq')
rows.append({'kind':'sequenceDependency','schema':'public','name':'user_import_jobs_seq',
 'tableSchema':'public','table':'user_import_jobs','column':'expires_at','dependency':'a'})
add_object('routine','public','fixture_function','')
default=add_object('default','public','portal_owner','r',False)
rows.append({'kind':'acl',**column,'grantor':'portal_owner','grantee':'portal_cron','privilege':'SELECT','grantable':False})
rows.append({'kind':'acl',**default,'grantor':'portal_owner','grantee':'PUBLIC','privilege':'SELECT','grantable':False})
for row in rows:
 if row['kind']=='effective' and row.get('objectType')=='column' and row['name']=='user_import_jobs' and row['role']=='portal_cron' and row['privilege']=='SELECT':row['allowed']=True
observation={'schemaVersion':1,'kind':'portal-legacy-security-observation-v1','serverMajor':16,'database':database,'records':rows}
profile={'kind':'portal-legacy-security-profile-v1','sourceCommit':binding['sourceCommit'],
 'previousImages':copy.deepcopy(binding['previousImages']),'observation':copy.deepcopy(observation)}
def check(value=observation,expected=profile):
 return r.check_portal_legacy_security_baseline(value,body,approval,record,inventory,authority,expected)
def rejected(callback):
 try:callback()
 except (r.ControlError,s.StateError,inv.InventoryError):pass
 else:raise AssertionError('unexpected acceptance')
`;

function probe(code) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-S', '-B', '-c', fixture + code, path.resolve('.')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('legacy security SQL is fixed catalog-only PG16 with preaggregation refusal gates and no dispatcher', () => {
  probe(String.raw`
sql=r.portal_legacy_security_observation_sql();lower=sql.lower()
column_calls=re.findall(r'pg_catalog\.has_column_privilege\([^)]*\)',sql)
assert column_calls==[
 'pg_catalog.has_column_privilege(o.role_oid,o.oid,o.subid::smallint,o.privilege)',
 "pg_catalog.has_column_privilege(o.role_oid,o.oid,o.subid::smallint,o.privilege||' WITH GRANT OPTION')",
],column_calls # PG16 requires int2 attnum; UNION widens subid to int4.
assert sql==r.portal_legacy_security_observation_sql()
assert 'repeatable read read only' in lower and 'set local search_path = pg_catalog' in lower
assert "statement_timeout = '20s'" in lower and "lock_timeout = '2s'" in lower
assert lower.count('limit 20001')==2 and 'bytes+count*2+1024<=4194304' in lower
assert lower.index('budget as materialized')<lower.index('jsonb_agg')
assert 'accepted as materialized' in lower and "'portal-legacy-security-observation-refused'" in lower
assert "current_database()='portal'" not in lower and "::integer/10000=16" in lower
for text in ('rolpassword','pg_authid','setconfig','rolconfig','dblink','postgres_fdw','pg_get_functiondef'):
 assert text not in lower,text
for text in ('admin_option','inherit_option','set_option','pg_default_acl','aclexplode','acldefault',
 'has_column_privilege','has_sequence_privilege','with grant option','pg_shdepend','pg_trigger','pg_rewrite','relrowsecurity'):
 assert text in lower,text
assert sql.strip().endswith('ROLLBACK;')
assert re.search(r'^\s*(?:ALTER|CREATE|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|CALL|DO)\b',sql,re.I|re.M) is None
assert not any('legacy-security' in action for action in r.ACTION_SET)
try:r.portal_legacy_security_observation_sql('other_database')
except TypeError:pass
else:raise AssertionError('caller selector accepted')
`);
});

test('pure validator canonicalizes fixture observations and exact profile matching never authorizes recovery', () => {
  probe(String.raw`
original=copy.deepcopy(observation)
with patch.object(r,'_psql_json',side_effect=AssertionError('SQL execution forbidden')), \
 patch.object(r.subprocess,'run',side_effect=AssertionError('process forbidden')), \
 patch.object(s,'transition',side_effect=AssertionError('write forbidden')):
 result=check();assert result['profileMatches'] is True
 reversed_observation=copy.deepcopy(observation);reversed_observation['records'].reverse()
 assert check(reversed_observation)==result
 assert check(s.canonical(observation))==result
assert observation==original
assert result['observationSha256']==hashlib.sha256(s.canonical(r.validate_portal_legacy_security_observation(observation))).hexdigest()
configured=copy.deepcopy(observation);configured['database']['databaseName']='portal_test'
for row in configured['records']:
 if row['kind'] in ('object','acl','effective') and row.get('objectType')=='database':row['name']='portal_test'
assert r.validate_portal_legacy_security_observation(configured,'portal_test')['database']['databaseName']=='portal_test'
rejected(lambda:r.validate_portal_legacy_security_observation(configured,'portal'))
for key in ('credentialVerified','clusterRoleMutationAuthorized','rollbackAuthorized','installationExecuted','deploymentAuthorized'):
 assert result[key] is False
assert 'legacy_capability_profile_unapproved' in check(expected=None)['blockers']
assert 'legacy_security_pg16_qualification_required' in result['blockers']
assert 'records' not in result and 'legacy_credentials_unverified' in result['blockers']
`);
});

test('strict shapes, duplicates, completeness, secret fields and both size bounds fail closed', () => {
  probe(String.raw`
for mutate in (lambda o:o.update(password='SECRET'),lambda o:o.update(serverMajor=17),
 lambda o:o.update(schemaVersion=True),lambda o:o['records'].append(copy.deepcopy(o['records'][0])),
 lambda o:o['records'].pop(0),lambda o:o['records'][0].update(rolpassword='SECRET'),
 lambda o:o['records'][1].update(values=['postgres://SECRET']),
 lambda o:o['records'][0].update(validUntil='postgres://SECRET'),
 lambda o:o['records'][0].update(login=1)):
 wrong=copy.deepcopy(observation);mutate(wrong);rejected(lambda:r.validate_portal_legacy_security_observation(wrong))
for kind in ('effective','sequenceDependency','guard','settings'):
 wrong=copy.deepcopy(observation);wrong['records'].remove(next(row for row in wrong['records'] if row['kind']==kind))
 rejected(lambda:r.validate_portal_legacy_security_observation(wrong))
with patch.object(r,'LEGACY_SECURITY_MAX_RECORDS',len(rows)-1):rejected(lambda:check())
with patch.object(r,'LEGACY_SECURITY_MAX_BYTES',100):rejected(lambda:check())
rejected(lambda:r.validate_portal_legacy_security_observation(b'{"kind":"portal-legacy-security-observation-refused"}'))
rejected(lambda:r.validate_portal_legacy_security_observation(b'{"kind":1,"kind":2}'))
`);
});

test('ACL null/default, PUBLIC grants, column/sequence and ownership changes are not accepted as a superset', () => {
  probe(String.raw`
for select,field,replacement in (
 (lambda row:row['kind']=='object' and row['objectType']=='table','aclNull',False),
 (lambda row:row['kind']=='acl' and row['objectType']=='default','privilege','UPDATE'),
 (lambda row:row['kind']=='acl' and row['objectType']=='column','grantee','PUBLIC'),
 (lambda row:row['kind']=='effective' and row['objectType']=='sequence','allowed',True),
 (lambda row:row['kind']=='object' and row['objectType']=='table','owner','unexpected_owner')):
 wrong=copy.deepcopy(observation);next(row for row in wrong['records'] if select(row))[field]=replacement
 result=check(wrong);assert result['profileMatches'] is False
 assert 'legacy_capability_profile_mismatch' in result['blockers']
wrong=copy.deepcopy(observation)
for row in wrong['records']:
 if row['kind']=='effective' and row['objectType']=='table' and row['name']=='cms_editor_sessions' and row['role']=='portal_api' and row['privilege'] in ('SELECT','INSERT','UPDATE','DELETE'):row['allowed']=True
assert 'legacy_session_capability_mismatch' in check(wrong)['blockers']
wrong=copy.deepcopy(observation)
next(row for row in wrong['records'] if row['kind']=='effective' and row['allowed']).update(grantable=True)
assert 'legacy_runtime_grant_options_unsupported' in check(wrong)['blockers']
wrong=copy.deepcopy(observation)
next(row for row in wrong['records'] if row['kind']=='effective' and row['objectType']=='column' and row['name']=='cms_editor_sessions').update(allowed=True)
assert 'legacy_session_capability_mismatch' in check(wrong)['blockers']
`);
});

test('owner grant options without ordinary privileges remain observable but block legacy recovery', () => {
  probe(String.raw`
wrong=copy.deepcopy(observation)
next(row for row in wrong['records'] if row['kind']=='object' and row['objectType']=='table' and row['name']=='cms_editor_sessions').update(owner='portal_api',aclNull=False)
next(row for row in wrong['records'] if row['kind']=='effective' and row['objectType']=='table' and row['name']=='cms_editor_sessions' and row['role']=='portal_api' and row['privilege']=='SELECT').update(allowed=False,grantable=True)
for expected in (profile,dict(profile,observation=wrong)):
 result=check(wrong,expected)
 assert result['profileMatches'] is (expected is not profile)
 assert 'legacy_runtime_role_ownership_unsupported' in result['blockers']
 assert 'legacy_runtime_grant_options_unsupported' in result['blockers']
 for flag in ('credentialVerified','clusterRoleMutationAuthorized','rollbackAuthorized','installationExecuted','deploymentAuthorized'):assert result[flag] is False
`);
});

test('unsafe role attributes, memberships, shared dependencies, settings and mechanisms remain blockers even in a matching profile', () => {
  probe(String.raw`
cases=[(lambda o:o['records'][0].update(superuser=True),'legacy_runtime_role_attributes_unsafe'),
 (lambda o:o['records'][1].update(present=True),'legacy_role_settings_unsupported'),
 (lambda o:o['records'].append({'kind':'membership','role':'portal_api','member':'other_role','grantor':'owner',
 'admin':False,'inherit':True,'set':True}),'legacy_runtime_role_membership_unsupported'),
 (lambda o:next(row for row in o['records'] if row['kind']=='guard' and row['name']=='externalRoleDependencies').update(present=True),'legacy_shared_role_dependencies'),
 (lambda o:next(row for row in o['records'] if row['kind']=='object').update(owner='portal_api'),'legacy_runtime_role_ownership_unsupported'),
 (lambda o:next(row for row in o['records'] if row['kind']=='object').update(unsupported=True),'legacy_security_mechanism_unsupported')]
for mutate,blocker in cases:
 wrong=copy.deepcopy(observation);mutate(wrong);expected=dict(profile,observation=wrong)
 result=check(wrong,expected);assert result['profileMatches'] is True and blocker in result['blockers']
`);
});

test('authenticated context correspondence and pregrant-only classification cannot be bypassed by profiles', () => {
  probe(String.raw`
for field in authority:
 saved=authority[field];authority[field]='0'*64
 rejected(lambda:check());authority[field]=saved
saved=body['legacySourceProofSha256'];body['legacySourceProofSha256']='0'*64
rejected(lambda:check());body['legacySourceProofSha256']=saved
saved=approval['hostBaseline']['currentCommit'];approval['hostBaseline']['currentCommit']='c'*40
rejected(lambda:check());approval['hostBaseline']['currentCommit']=saved
wrong=copy.deepcopy(observation);wrong['database']['databaseOid']='999';rejected(lambda:check(wrong))
for field,value in (('sourceCommit','c'*40),('previousImages',dict(binding['previousImages'],api=images['api'].replace('a'*64,'b'*64)))):
 wrong=copy.deepcopy(profile);wrong[field]=value
 assert 'legacy_capability_profile_mismatch' in check(expected=wrong)['blockers']
body['installIntent']['stage']='portal_grants_pending'
result=check();assert result['profileMatches'] and 'legacy_baseline_not_pregrant' in result['blockers']
assert result['rollbackAuthorized'] is False
`);
});
