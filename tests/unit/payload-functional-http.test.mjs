import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { httpsFixtureClient,inspectEditorialCookie,createSyntheticAccounts } from '../../scripts/integration/payload-functional-http.mjs';
import { fixtureIdentity } from '../../scripts/integration/payload-functional-fixture.mjs';

const origin='https://127.0.0.1:19443';
function transport({status=200,json={status:'ready'},stall=false,large=false}={}) {
  const observed=[];
  const request=(url,options,callback)=>{
    observed.push({url,options});
    const req=new EventEmitter();req.destroy=()=>queueMicrotask(()=>req.emit('error',new Error('private transport diagnostics')));
    req.end=data=>{
      observed.at(-1).input=data;
      if(stall) return;
      const response=new EventEmitter();response.statusCode=status;response.headers={'content-type':'application/json'};
      response.destroy=()=>{};
      callback(response);
      queueMicrotask(()=>{
        response.emit('data',large ? Buffer.alloc(1024*1024+1) : Buffer.from(JSON.stringify(json)));
        if(!large) response.emit('end');
      });
    };
    return req;
  };
  return {request,observed};
}

test('bounded Node18 TLS client verifies fixture CA, binds only loopback and never follows redirects',async()=>{
  const fake=transport({status:302,json:null});
  const client=httpsFixtureClient(origin,'synthetic-ca-unit-double',fake.request);
  const response=await client('/api/cms/v2/session',{method:'POST',body:{},headers:{Origin:origin}});
  assert.equal(response.status,302);assert.equal(fake.observed.length,1);
  assert.equal(fake.observed[0].url.origin,origin);assert.equal(fake.observed[0].options.rejectUnauthorized,true);
  assert.equal(fake.observed[0].options.ca,'synthetic-ca-unit-double');
  assert.equal(fake.observed[0].options.headers.Origin,origin);
  for(const value of ['https://production.invalid','http://127.0.0.1:19443','https://127.0.0.1:19443/path','https://user@127.0.0.1:19443'])
    assert.throws(()=>httpsFixtureClient(value,'ca',fake.request),{code:'functional_https_origin_invalid'});
  for(const pathname of ['//production.invalid/path','relative','/\nprivate']) await assert.rejects(client(pathname),{code:'functional_http_path_invalid'});
  await assert.rejects(client('/api/ready',{method:'PUT'}),{code:'functional_http_request_invalid'});
});

test('HTTP timeout/output cap produce safe failure, not empty valid response',async()=>{
  const stalled=transport({stall:true});
  await assert.rejects(httpsFixtureClient(origin,'ca',stalled.request)('/api/ready',{timeout:10}),/functional_https_transport_failed/);
  const oversized=transport({large:true});
  await assert.rejects(httpsFixtureClient(origin,'ca',oversized.request)('/api/ready'),/functional_http_output_limit/);
});

test('cookie inspection refuses Domain, unsafe cookies and changed lifetime without persisting raw value',()=>{
  const cookie='__Host-ownerinc-editorial=synthetic-unit-only; Path=/; Secure; HttpOnly; SameSite=Lax';
  const response=changes=>({headers:{'set-cookie':[cookie]},json:{expiresAt:new Date(Date.now()+7200000).toISOString()},...changes});
  assert.equal(inspectEditorialCookie(response(),origin).cookie.httpOnly,true);
  for(const value of [cookie+'; Domain=127.0.0.1',cookie.replace('; Secure',''),cookie.replace('HttpOnly','unsafe'),
    cookie.replace('Path=/;','Path=/editorial;'),cookie.replace('SameSite=Lax','SameSite=None')]) {
    assert.throws(()=>inspectEditorialCookie(response({headers:{'set-cookie':[value]}}),origin),{code:'functional_cookie_policy_mismatch'});
  }
  assert.throws(()=>inspectEditorialCookie(response({json:{expiresAt:new Date(Date.now()+3600000).toISOString()}}),origin),{code:'functional_session_lifetime_mismatch'});
});

test('real account fixture support checks persisted email verification/token identity before profile seed (transport double)',async()=>{
  const identity=fixtureIdentity('134cfd81-7f0d-47ca-a4fb-c9cabd069c0f');
  const calls=[],seeded=[];let index=0;
  const token=uid=>['synthetic',Buffer.from(JSON.stringify({aud:identity.firebaseProject,iss:`https://securetoken.google.com/${identity.firebaseProject}`,
    sub:uid,email_verified:true})).toString('base64url'),'synthetic'].join('.');
  const client=async(pathname,options)=>{
    calls.push({pathname,options});
    if(pathname.includes(':signUp')) return {status:200,json:{localId:`unit-uid-${++index}`}};
    if(pathname.includes(':update')) return {status:200,json:{}};
    if(pathname.includes(':signInWithPassword')) return {status:200,json:{localId:`unit-uid-${index}`,idToken:token(`unit-uid-${index}`)}};
    return {status:200,json:{users:[{localId:`unit-uid-${index}`,emailVerified:true}]}};
  };
  const sql=async(store,statement,bindings)=>{seeded.push({store,statement,bindings});return bindings.uid;};
  const accounts=await createSyntheticAccounts(client,identity,sql);
  assert.deepEqual(Object.keys(accounts),['academy','benefits','viewer']);assert.equal(seeded.length,3);
  assert.equal(calls.length,12);assert.ok(calls.every(value=>value.pathname.startsWith('/identitytoolkit.googleapis.com/')));
  assert.equal(seeded[2].bindings.role,'viewer');assert.equal(seeded[2].bindings.permissions,'{}');
  assert.doesNotMatch(seeded.map(value=>value.statement).join(' '),/owner_news_authority|news_articles/);
  let touched=false;
  const unverified=async(pathname,options)=>{
    const value=await client(pathname,options);
    if(pathname.includes(':lookup')) value.json.users[0].emailVerified=false;
    return value;
  };
  await assert.rejects(createSyntheticAccounts(unverified,identity,async()=>{touched=true;}),{code:'functional_emulator_lookup_failed'});
  assert.equal(touched,false);
});
