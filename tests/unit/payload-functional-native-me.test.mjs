import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCookieLessNativeMe,assertRevokedNativeMe,probeCookieLessNativeMe } from '../../cms/tests/integration/functional-preauthority.mjs';

test('pinned real Payload me handler returns legitimate 200 user:null and does no DB work with no user (request double)',async()=>{
  const {meHandler}=await import('../../cms/node_modules/payload/dist/auth/endpoints/me.js');
  let dbCalls=0;
  const forbidden=()=>{dbCalls++;throw new Error('unexpected database work');};
  const req={user:null,headers:new Headers(),query:{},searchParams:new URLSearchParams(),
    routeParams:{collection:'portal-editors'},t:()=> 'Account',
    payload:{config:{cors:[],auth:{jwtOrder:['Bearer']}},collections:{'portal-editors':{config:{slug:'portal-editors',auth:{removeTokenFromResponses:true},hooks:{}}}},
      findByID:forbidden,find:forbidden,create:forbidden,update:forbidden,db:new Proxy({}, {get:()=>forbidden})}};
  const response=await meHandler(req);
  assertCookieLessNativeMe({status:response.status,json:await response.json()});
  assert.equal(dbCalls,0);
});

test('cookie-less native oracle rejects authenticated 200 leaks, malformed shapes and unexpected codes',()=>{
  assertCookieLessNativeMe({status:200,json:{user:null}});
  for(const json of [{user:{id:'private'}},{user:null,actor:{uid:'private'}},{user:null,token:'private'},
    {user:null,collection:'portal-editors'},{user:null,error:'editorial_session_invalid'}, {},null,[]]) {
    assert.throws(()=>assertCookieLessNativeMe({status:200,json}));
  }
  for(const status of [201,204,302,401,403,404,500,503]) {
    assert.throws(()=>assertCookieLessNativeMe({status,json:{user:null}}));
  }
});

test('revoked-cookie native replay requires the distinct 401 error contract, never 200 null or another status',()=>{
  assertRevokedNativeMe({status:401,json:{error:'editorial_session_invalid'}});
  for(const status of [200,201,204,302,403,404,500,503]) {
    assert.throws(()=>assertRevokedNativeMe({status,json:{error:'editorial_session_invalid'}}));
  }
  for(const json of [{user:null},{error:'editorial_permission_denied'},{error:'editorial_unavailable'},
    {error:'editorial_session_invalid',user:{id:'private'}}]) {
    assert.throws(()=>assertRevokedNativeMe({status:401,json}));
  }
});

test('cookie-less HTTP probe binds unchanged DB row/sequence inventories and refuses any Cookie (transport/SQL doubles)',async()=>{
  const observations=[];
  const sql=async(store,statement)=>{
    assert.match(statement,/^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
    assert.match(statement,/c\.relkind IN \('r','p','S'\)/);assert.match(statement,/\\gexec/);
    assert.doesNotMatch(statement,/INSERT|UPDATE|DELETE/);
    observations.push(store);return store==='cms' ? 'native-existing-row' : 'session-existing-row';
  };
  await probeCookieLessNativeMe({sql,headers:{Authorization:'Bearer synthetic-viewer-unit-only'},
    client:async(pathname,options)=>{
      assert.equal(pathname,'/editorial/api/portal-editors/me');assert.equal(Object.hasOwn(options.headers,'Cookie'),false);
      return {status:200,json:{user:null,message:'Account'}};
    }});
  assert.deepEqual(observations,['cms','portal','cms','portal']);
  let reads=0;
  await assert.rejects(probeCookieLessNativeMe({sql:async()=>String(++reads),client:async()=>({status:200,json:{user:null}})}));
  await assert.rejects(probeCookieLessNativeMe({sql,headers:{cookie:'synthetic-unit-only'},client:async()=>{throw new Error('must not contact');}}));
});
