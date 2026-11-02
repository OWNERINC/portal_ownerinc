import assert from 'node:assert/strict';
import { hash } from '../../../scripts/integration/payload-functional-fixture.mjs';
import { runFunctionalCase } from './functional-matrix.mjs';

const checks=(...names)=>names.map(check=>({check,passed:true}));
const uuid=value=>{assert.match(value,/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);return value;};
const browserFetch=(page,pathname,body,method=body===undefined?'GET':'POST')=>page.evaluate(async ({pathname,body,method})=>{
  const response=await fetch(pathname,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,json:await response.json().catch(()=>null)};
},{pathname,body,method});

/** Synthetic admission is ONLY for this fresh, physically inspected lease. No
 * production Gate E, authenticated recovery, or preauthority PASS is implied. */
export async function runEditorialContracts({lease,report,client,accounts,sql,origin}) {
  assert.equal(lease.phase,'editorial');assert.equal(lease.config.phase,'editorial');
  assert.equal(report.targetBindings?.independentClusters,true);assert.equal(report.targetBindings?.freshBeforeDDL,true);
  assert.equal(await sql('portal',"SELECT mode||'|'||epoch FROM owner_news_authority WHERE singleton=true;"),'legacy|1');
  assert.equal(await sql('cms',"SELECT (coverage_version=1 AND sequence=0 AND write_barrier='open')::text FROM owner_news_mutation_head WHERE singleton=true;"),'true');
  const account=accounts.academy;
  assert.equal(await sql('portal',`UPDATE users SET permissions='{"manageKnowledge":true}'::jsonb WHERE uid=:'uid' RETURNING uid;`,{uid:account.uid}),account.uid);
  const binding=hash(`editorial-fixture-only:${lease.identity.runId}`);
  assert.equal(await sql('portal',`UPDATE owner_news_authority SET mode='payload',epoch=2,
    manifest_sha256=:'hash',seal_sha256=:'hash',release_digest='sha256:'||:'hash',image_digest='sha256:'||:'hash',
    activation_request_id='editorial-fixture-only',activation_observed_at=NOW()
    WHERE singleton=true AND mode='legacy' AND epoch=1 RETURNING epoch;`,{hash:binding}),'2');
  report.editorialAdmission={kind:'synthetic-fixture-only',productionGateE:false,protocol:'canonical-finalizer-fixture-empty-baseline'};
  const browser=await lease.playwright.chromium.launch({headless:true,
    ...(lease.config.browserExecutable?{executablePath:lease.config.browserExecutable}:{}),
    args:[`--ignore-certificate-errors-spki-list=${lease.tls.spki}`,'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE www.gstatic.com'],
    env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  const page=await context.newPage();page.setDefaultTimeout(20000);
  const timer=setTimeout(()=>void browser.close(),240000);
  let id,source,editPath,restored;
  const live=async()=>JSON.parse(await sql('cms',`SELECT row_to_json(t)::text FROM news_articles t WHERE id='${uuid(id)}';`));
  const version=async()=>JSON.parse(await sql('cms',`SELECT row_to_json(t)::text FROM _news_articles_v t WHERE parent_id='${uuid(id)}' AND latest=true;`));
  const reader=()=>client(`/api/announcements/${uuid(id)}?source=payload`,{headers:{Authorization:`Bearer ${accounts.viewer.token}`}});
  const compare=async(target,documentId,sourceVersionId)=>{
    const response=await browserFetch(page,`/editorial/api/news-restore-draft?${new URLSearchParams({target,documentId,sourceVersionId})}`);
    assert.equal(response.status,200);
    return {target,documentId,sourceVersionId,sourceRevisionToken:response.json.sourceRevisionToken,expectedHeadToken:response.json.expectedHeadToken};
  };
  const openSource=async()=>{
    await page.goto(`${origin}${editPath}/versions`);
    const link=page.locator(`a[href$="/versions/${source}"]`).first();await link.click();
    await page.getByRole('heading',{name:'Comparar revisão salva',exact:true}).waitFor();
    await page.getByRole('button',{name:'Restaurar como novo rascunho',exact:true}).waitFor();
  };
  const clickRestore=async()=>{
    await page.getByRole('button',{name:'Restaurar como novo rascunho',exact:true}).click();
    await page.getByRole('button',{name:'Restaurar rascunho',exact:true}).click();
  };
  try {
    await page.goto(`${origin}/login.html?next=%2Fcms.html`);
    await page.locator('#email').fill(account.email);await page.locator('#password').fill(account.password);
    await page.locator('#login-form button[type="submit"]').click();await page.waitForURL(`${origin}/cms.html`);
    await page.locator('#native-admin-entry-button').click();await page.waitForURL(`${origin}/editorial/admin`);
    await runFunctionalCase(report,'EDITORIAL-drafts',async()=>{
      const created=page.waitForResponse(r=>new URL(r.url()).pathname==='/editorial/api/news-articles' && r.request().method()==='POST');
      await page.goto(`${origin}/editorial/admin/collections/news-articles/create`);
      const response=await created;assert.equal(response.status(),201);id=uuid((await response.json()).doc.id);
      editPath=`/editorial/admin/collections/news-articles/${id}`;await page.waitForURL(`${origin}${editPath}`);
      // Seed a publishable body through the real authenticated native API; subsequent
      // autosave, checkpoint, publication and restore actions use native UI controls.
      assert.equal((await browserFetch(page,`/editorial/api/news-articles/${id}?draft=true`,{title:'Browser A',category:'Browser editorial',
        editorial:{version:1,kind:'article',summary:'Synthetic browser proof',author:'',source_label:'',source_date:null},
        body:[{blockType:'paragraph',text:'Browser A'}]},'PATCH')).status,200);
      await page.reload();const firstPublish=page.waitForResponse(r=>new URL(r.url()).pathname===`/editorial/api/news-articles/${id}` && r.request().method()==='PATCH' && r.status()===200);
      await page.getByRole('button',{name:/^Publicar(?: alterações)?$/u}).click();await firstPublish;
      source=uuid((await version()).id);
      const base=await live(),publicA=await reader();assert.equal(publicA.status,200);
      const autosaved=page.waitForResponse(r=>r.url().includes('autosave=true') && r.request().method()==='PATCH');
      await page.locator('#field-title').fill('Browser B');assert.equal((await autosaved).status(),200);
      assert.deepEqual(await live(),base);assert.deepEqual((await reader()).json,publicA.json);
      const checkpoint=page.waitForResponse(r=>r.url().includes('autosave=false') && r.request().method()==='PATCH');
      await page.getByRole('button',{name:'Salvar revisão do rascunho',exact:true}).click();assert.equal((await checkpoint).status(),200);
      const saved=await version();assert.equal(saved.autosave,false);assert.notEqual(saved.id,id);
      const published=page.waitForResponse(r=>new URL(r.url()).pathname===`/editorial/api/news-articles/${id}` && r.request().method()==='PATCH' && !r.url().includes('autosave=true'));
      await page.getByRole('button',{name:/^Publicar(?: alterações)?$/u}).click();assert.equal((await published).status(),200);
      assert.equal((await live()).title,'Browser B');assert.notDeepEqual((await reader()).json,publicA.json);
      return checks('ui_created_native_document','autosave_private_live_reader_unchanged','explicit_checkpoint_native_version','manual_publication_reader_changes');
    });
    await runFunctionalCase(report,'EDITORIAL-restore',async()=>{
      const before=await live(),publicB=(await reader()).json;
      await openSource();const completed=page.waitForResponse(r=>r.url().endsWith('/news-restore-draft') && r.request().method()==='POST');
      await clickRestore();const response=await completed;assert.equal(response.status(),200);restored=uuid((await response.json()).versionId);
      await page.waitForURL(`${origin}${editPath}`);assert.equal(await page.locator('#field-title').inputValue(),'Browser A');
      assert.deepEqual(await live(),before);assert.deepEqual((await reader()).json,publicB);
      assert.equal((await version()).id,restored);assert.notEqual(restored,source);
      const audit=JSON.parse(await sql('cms',`SELECT details::text FROM news_audit WHERE version_id='${restored}';`));
      assert.equal(audit.sourceVersionId,source);assert.equal(audit.saveKind,'restore');
      for(const headline of ['Browser Home A','Browser Home B']) {
        assert.equal((await browserFetch(page,'/editorial/api/globals/news-home',{eyebrow:'News',headline,summary:'Home proof',_status:'published'})).status,200);
        if(headline.endsWith('A')) report.editorialHomeSource=uuid(await sql('cms','SELECT id FROM _news_home_v WHERE latest=true;'));
      }
      const homeBefore=await sql('cms','SELECT row_to_json(t)::text FROM news_home t;');
      await page.goto(`${origin}/editorial/admin/globals/news-home/versions/${report.editorialHomeSource}`);
      const homeDone=page.waitForResponse(r=>r.url().endsWith('/news-restore-draft') && r.request().method()==='POST');
      await clickRestore();assert.equal((await homeDone).status(),200);
      assert.equal(await sql('cms','SELECT row_to_json(t)::text FROM news_home t;'),homeBefore);
      assert.equal((await browserFetch(page,`/editorial/api/globals/news-home/versions/${report.editorialHomeSource}`,{})).status,403);
      assert.equal((await browserFetch(page,`/editorial/api/news-articles/versions/${source}`,{})).status,403);
      delete report.editorialHomeSource;
      return checks('native_versions_navigation','restore_new_draft_live_unchanged','home_restore_live_unchanged','native_unsafe_restore_denied');
    });
    await runFunctionalCase(report,'EDITORIAL-conflict',async()=>{
      const input=await compare('news-articles',id,source);
      assert.equal((await browserFetch(page,`/editorial/api/news-articles/${id}?draft=true`,{title:'Concurrent draft'},'PATCH')).status,200);
      assert.equal((await browserFetch(page,'/editorial/api/news-restore-draft',input)).status,409);
      await openSource();const before=Number(await sql('cms',`SELECT count(*) FROM news_audit WHERE document_id='${id}' AND details->>'saveKind'='restore';`));
      // Forward the real request, then drop only its ACK; never fabricate a success.
      await page.route('**/editorial/api/news-restore-draft',async route=>{
        if(route.request().method()!=='POST')return route.continue();
        await route.fetch();await route.abort('failed');
      },{times:1});
      await clickRestore();await page.getByText(/Resposta não confirmada/).waitFor();
      await page.getByText(/A revisão mais recente foi restaurada da versão/).waitFor();
      assert.equal(Number(await sql('cms',`SELECT count(*) FROM news_audit WHERE document_id='${id}' AND details->>'saveKind'='restore';`)),before+1);
      return checks('stale_head_refused','lost_ack_reconciled_from_audit','single_committed_restore');
    });
    await runFunctionalCase(report,'EDITORIAL-revocation',async()=>{
      const cookie=(await context.cookies()).find(c=>c.name==='__Host-ownerinc-editorial');assert.ok(cookie);
      await sql('portal',`UPDATE users SET permissions='{"manageAcademy":true}'::jsonb WHERE uid=:'uid';`,{uid:account.uid});
      const denied=await browserFetch(page,`/editorial/api/news-articles/versions/${source}`);assert.equal(denied.status,403);
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await page.getByRole('button',{name:'Restaurar como novo rascunho',exact:true}).waitFor({state:'hidden'});
      await page.getByRole('table').waitFor({state:'hidden'});
      assert.equal(await page.getByText('Browser A',{exact:true}).count(),0);
      await sql('portal',`UPDATE users SET permissions='{"manageKnowledge":true}'::jsonb WHERE uid=:'uid';`,{uid:account.uid});
      assert.equal((await client('/api/cms/session',{method:'DELETE',body:{},headers:{Origin:origin,Cookie:`${cookie.name}=${cookie.value}`}})).status,204);
      assert.equal((await client(`/editorial/api/news-articles/versions/${source}`,{headers:{Cookie:`${cookie.name}=${cookie.value}`}})).status,401);
      return checks('fresh_permission_denial','display_cleared_on_renewal','revoked_cookie_history_denied');
    });
  } finally {clearTimeout(timer);await context.close();await browser.close();}
}
