import assert from 'node:assert/strict';
import test from 'node:test';
import { functionalBaseImages } from '../../scripts/integration/payload-functional-base-images.mjs';
import { assertImageEnvironment } from '../../scripts/integration/payload-functional-isolation.mjs';

test('exact public pinned PostgreSQL/Nginx Config.Env snapshots pass for each captured Linux platform',()=>{
  for(const [role,base] of Object.entries(functionalBaseImages)) {
    for(const [architecture,platform] of Object.entries(base.platforms)) {
      const meta={reference:base.reference,id:platform.configDigest,os:'linux',architecture};
      const config={Env:[...base.env],WorkingDir:'/'};
      const result=assertImageEnvironment(role,config,meta);
      assert.equal(Object.keys(result).length,base.env.length);
      if(role==='postgres') {
        assert.equal(result.GOSU_VERSION,'1.19');assert.equal(result.DOCKER_PG_LLVM_DEPS,'llvm21-dev \t\tclang21');
      } else assert.equal(result.ACME_VERSION,'0.4.1');
    }
  }
});

test('base environment exceptions are digest/platform/value-specific, not arbitrary inherited configuration',()=>{
  for(const [role,base] of Object.entries(functionalBaseImages)) {
    const meta={reference:base.reference,id:base.platforms.amd64.configDigest,os:'linux',architecture:'amd64'};
    const config={Env:[...base.env],WorkingDir:'/'};
    for(const changes of [{reference:'postgres:latest'},{id:'sha256:'+'a'.repeat(64)},{os:'windows'},{architecture:'unknown'},
      {architecture:'constructor',id:undefined},{architecture:'__proto__',id:undefined}]) {
      assert.throws(()=>assertImageEnvironment(role,config,{...meta,...changes}),{code:'functional_base_image_binding_mismatch'});
    }
    assert.throws(()=>assertImageEnvironment(role,config),{code:'functional_base_image_binding_mismatch'});
    for(const entry of base.env) {
      const key=entry.slice(0,entry.indexOf('='));
      assert.throws(()=>assertImageEnvironment(role,{...config,Env:base.env.filter(value=>value!==entry)},meta));
      assert.throws(()=>assertImageEnvironment(role,{...config,Env:base.env.map(value=>value===entry ? `${key}=different-unit-only` : value)},meta));
    }
    for(const entry of ['SMTP_PASSWORD=','SMTP_ADDRESS=external.invalid','FIREBASE_PROJECT_ID=production-project',
      'GOSU_UNKNOWN=1.19','DOCKER_PG_UNKNOWN_DEPS=anything','ACME_UNKNOWN=0.4.1','NODE_OPTIONS=--import=private']) {
      assert.throws(()=>assertImageEnvironment(role,{...config,Env:[...base.env,entry]},meta));
    }
  }
  assert.throws(()=>assertImageEnvironment('api',{Env:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','GOSU_VERSION=1.19'],WorkingDir:'/app'}));
});
