import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { functionalCases,newFunctionalReport,finishFunctionalReport,runFunctionalCase } from '../../cms/tests/integration/functional-matrix.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const records=item=>item.requiredChecks.map(check=>({check,passed:true}));

test('declared inventory has unique IDs, typed phases, explicit preconditions and evidence',()=>{
  assert.equal(new Set(functionalCases.map(item=>item.scenarioId)).size,functionalCases.length);
  assert.equal(functionalCases.filter(item=>item.implemented).length,8);
  for(const item of functionalCases) {
    assert.ok(item.preconditions.length);assert.ok(item.expected.length);assert.ok(item.evidence.length);
    if(item.implemented) assert.ok(item.requiredChecks.length>1);
    else assert.ok(item.dependency);
  }
});

test('no execution, empty run, partial slice and deferred native cases never make complete PASS',async()=>{
  const report=newFunctionalReport('synthetic-unit-only');
  assert.equal(finishFunctionalReport(report),2);assert.equal(report.status,'INCOMPLETE');
  for(const item of functionalCases.filter(item=>item.implemented)) await runFunctionalCase(report,item.scenarioId,async()=>records(item));
  assert.equal(finishFunctionalReport(report),2);
  assert.equal(report.preauthorityComplete,true);assert.equal(report.acceptanceComplete,false);
  assert.equal(report.cases.find(item=>item.scenarioId==='NEWS-01').status,'INCOMPLETE');
  assert.equal(report.cases.find(item=>item.scenarioId==='NEWS-01').reason,'gate4_verified_native_writer_and_durable_authority_admission');
  const empty=newFunctionalReport(null);empty.cases=[];assert.equal(finishFunctionalReport(empty),1);
});

test('heading/existence only and missing evidence are rejected; no permissive catch PASS',async()=>{
  for(const observations of [[],[{check:'heading_visible',passed:true}],
    [{check:'ui_v2_issuance_ack',passed:true,httpStatus:200}],records(functionalCases[1]).map(value=>({...value,cookie:'secret'}))]) {
    const report=newFunctionalReport(null);
    await assert.rejects(runFunctionalCase(report,'CMS-02',async()=>observations),/functional_case_failed/);
    assert.equal(report.cases[1].status,'FAIL');assert.equal(finishFunctionalReport(report),1);
    assert.doesNotMatch(JSON.stringify(report),/cookie":"secret/);
  }
});

test('execution exceptions are fixed reasons and never persist tokens, body or provider diagnostics',async()=>{
  const report=newFunctionalReport(null);
  await assert.rejects(runFunctionalCase(report,'CMS-05',async()=>{throw new Error('Bearer raw-secret postgresql://production.invalid; cookie=private');}),/functional_case_failed/);
  assert.equal(report.cases.find(item=>item.scenarioId==='CMS-05').reason,'acceptance_assertion_failed');
  assert.doesNotMatch(JSON.stringify(report),/raw-secret|production.invalid|cookie=private/);
});

test('report tampering, duplicate rows and fake SKIP/PASS cannot authorize incomplete coverage',()=>{
  for(const mutate of [report=>{report.cases[0]=report.cases[1];},report=>{report.cases[0].status='SKIP';},
    report=>{report.cases.find(item=>!item.implemented).status='PASS';},
    report=>{for(const item of report.cases){item.implemented=true;item.status='PASS';}}]) {
    const report=newFunctionalReport(null);mutate(report);assert.equal(finishFunctionalReport(report),1);assert.equal(report.acceptanceComplete,false);
  }
});

test('case cannot be rerun or assigned to a deferred writer interface',async()=>{
  const report=newFunctionalReport(null),item=functionalCases[0];
  await runFunctionalCase(report,item.scenarioId,async()=>records(item));
  await assert.rejects(runFunctionalCase(report,item.scenarioId,async()=>records(item)),/functional_case_contract_invalid/);
  await assert.rejects(runFunctionalCase(report,'NEWS-01',async()=>[{check:'fake_writer',passed:true}]),/functional_case_contract_invalid/);
});

test('matrix CLI is service-free with incomplete exit 2, exact arguments and no env/credential echo',()=>{
  const result=spawnSync(process.execPath,['scripts/test-payload-integration.mjs','--matrix'],{cwd:root,encoding:'utf8',timeout:10000,
    env:{...process.env,DATABASE_URL:'postgresql://private-secret@production.invalid/live'}});
  assert.equal(result.status,2,result.stderr);const report=JSON.parse(result.stdout);
  assert.equal(report.status,'INCOMPLETE');assert.equal(report.acceptanceComplete,false);
  assert.equal(report.cases.filter(item=>item.status!=='INCOMPLETE').length,0);
  assert.doesNotMatch(result.stdout,/private-secret|production.invalid/);
  const extra=spawnSync(process.execPath,['scripts/test-payload-integration.mjs','--matrix','--execute'],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(extra.status,1);assert.match(extra.stderr,/unsupported_argument/);
});

test('real first-slice source has no request fulfills, bypass cookie/actor or authority UPDATE',async()=>{
  const browser=await readFile('cms/tests/integration/functional-preauthority.mjs','utf8');
  assert.doesNotMatch(browser,/\.route\(|\.fulfill\(|\.addCookies\(|portalActor\s*:|canManageNews\s*:\s*true/);
  assert.match(browser,/browserLogin/);assert.match(browser,/accounts\.academy\.uid/);assert.match(browser,/waitForResponse/);
  for(const filename of ['scripts/integration/payload-functional-run.mjs','scripts/integration/payload-functional-fixture.mjs',
    'scripts/integration/payload-functional-http.mjs','cms/tests/integration/functional-preauthority.mjs']) {
    const source=await readFile(filename,'utf8');
    assert.doesNotMatch(source,/UPDATE\s+owner_news_authority|SET\s+mode\s*=|freeze-legacy|activate-payload|overrideAccess\s*:\s*true/);
  }
});
