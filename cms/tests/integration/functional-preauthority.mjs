import assert from 'node:assert/strict';
import { hash } from '../../../scripts/integration/payload-functional-fixture.mjs';
import { inspectEditorialCookie } from '../../../scripts/integration/payload-functional-http.mjs';
import { runFunctionalCase } from './functional-matrix.mjs';

const evidence = (check,httpStatus) => ({ check,passed:true,...(httpStatus === undefined ? {} : {httpStatus}) });
const bearer = account => ({Authorization:`Bearer ${account.token}`});

export function assertCookieLessNativeMe(response) {
  // Payload's actual me handler is 200 with user:null when both strategies have
  // no cookie. This is NOT the error-marker contract for a revoked cookie.
  assert.equal(response.status,200);
  assert.ok(response.json && !Array.isArray(response.json));
  assert.equal(response.json.user,null);
  assert.ok(Object.keys(response.json).every(key=>key==='user' || key==='message'));
  if(Object.hasOwn(response.json,'message')) assert.equal(typeof response.json.message,'string');
}

export function assertRevokedNativeMe(response) {
  assert.equal(response.status,401);
  assert.deepEqual(response.json,{error:'editorial_session_invalid'});
}

async function nativeIdentityState(sql) {
  // Read-only snapshots cover every public table/sequence, not just a zero count
  // for the viewer. Existing identities and sessions cannot be edited either.
  const snapshot=`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT format('SELECT %L || COALESCE(json_agg(row_to_json(t) ORDER BY row_to_json(t)::text COLLATE "C")::text, ''[]'') FROM %I.%I t;',
  n.nspname||'.'||c.relname||':',n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p','S') ORDER BY c.relname;
\\gexec
COMMIT;`;
  return hash(JSON.stringify([
    await sql('cms',snapshot),await sql('portal',snapshot),
  ]));
}

export async function probeCookieLessNativeMe({client,sql,headers={}}) {
  assert.equal(Object.keys(headers).some(key=>key.toLowerCase()==='cookie'),false);
  const before=await nativeIdentityState(sql);
  const response=await client('/editorial/api/portal-editors/me',{headers});
  assertCookieLessNativeMe(response);
  assert.equal(await nativeIdentityState(sql),before);
  return response;
}

export async function runSessionContracts({ report,client,accounts,sql,origin }) {
  let currentCookie;
  const account = accounts.benefits;
  await runFunctionalCase(report,'CMS-05',async () => {
    const before = await sql('portal',`SELECT count(*) FROM cms_editor_sessions WHERE user_uid=:'uid';`,{uid:account.uid});
    for (const originValue of [null,'https://not-authorized.example.invalid']) {
      const response = await client('/api/cms/v2/session',{method:'POST',body:{},headers:{...bearer(account),...(originValue ? {Origin:originValue} : {})}});
      assert.equal(response.status,403);
    }
    assert.equal(await sql('portal',`SELECT count(*) FROM cms_editor_sessions WHERE user_uid=:'uid';`,{uid:account.uid}),before);
    const issue = cookie => client('/api/cms/v2/session',{method:'POST',body:{},headers:{...bearer(account),Origin:origin,...(cookie ? {Cookie:cookie.pair} : {})}});
    const issued = await issue(); assert.equal(issued.status,201);
    assert.equal(issued.json.actor.uid,account.uid); assert.equal(issued.json.actor.version,2);
    assert.equal(issued.json.actor.capabilities.manageBenefits,true); assert.equal(issued.json.actor.capabilities.manageKnowledge,false);
    const first = inspectEditorialCookie(issued,origin);
    const stored = await sql('portal',`SELECT count(*)=1 AND bool_and(token_hash=:'hash' AND length(token_hash)=64
      AND expires_at>NOW() AND revoked_at IS NULL) FROM cms_editor_sessions WHERE user_uid=:'uid' AND revoked_at IS NULL;`,
    {uid:account.uid,hash:hash(first.cookie.value)});
    assert.equal(stored,'t');
    const columns = await sql('portal',`SELECT string_agg(column_name,',' ORDER BY ordinal_position) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='cms_editor_sessions';`);
    assert.equal(columns,'token_hash,user_uid,expires_at,revoked_at,created_at');
    const replacement = await issue(first); assert.equal(replacement.status,201);
    currentCookie = inspectEditorialCookie(replacement,origin); assert.notEqual(currentCookie.pair,first.pair);
    assert.equal((await client('/api/cms/v2/session',{headers:{Cookie:first.pair}})).status,401);
    assert.equal((await client('/api/cms/v2/session',{headers:{Cookie:currentCookie.pair}})).status,200);
    assert.equal(await sql('portal',`SELECT revoked_at IS NOT NULL FROM cms_editor_sessions WHERE token_hash=:'hash' AND user_uid=:'uid';`,
      {uid:account.uid,hash:hash(first.cookie.value)}),'t');
    return [evidence('origin_denials_no_session_write',403),evidence('real_emulator_session_issued',201),
      evidence('cookie_attributes_two_hour_lifetime'),evidence('database_hash_only'),evidence('distinct_rotation_old_cookie_denied',401)];
  });

  await runFunctionalCase(report,'AUTH-expiry-permission',async () => {
    assert.ok(currentCookie);
    // Only this run's synthetic profile/session is changed; never authority or an actor body.
    assert.equal(await sql('portal',`UPDATE users SET permissions='{"manageReminders":true}'::jsonb WHERE uid=:'uid' RETURNING uid;`,{uid:account.uid}),account.uid);
    const reloaded = await client('/api/cms/v2/session',{headers:{Cookie:currentCookie.pair}});
    assert.equal(reloaded.status,200); assert.equal(reloaded.json.actor.capabilities.manageBenefits,false);
    assert.equal(reloaded.json.actor.capabilities.manageReminders,true);
    assert.equal(await sql('portal',`UPDATE cms_editor_sessions SET expires_at=NOW()-INTERVAL '1 second'
      WHERE user_uid=:'uid' AND token_hash=:'hash' AND revoked_at IS NULL RETURNING (revoked_at IS NULL)::text;`,
      {uid:account.uid,hash:hash(currentCookie.cookie.value)}),'true');
    assert.equal((await client('/api/cms/v2/session',{headers:{Cookie:currentCookie.pair}})).status,401);
    const issued = await client('/api/cms/v2/session',{method:'POST',body:{},headers:{...bearer(account),Origin:origin}});
    assert.equal(issued.status,201); const fresh = inspectEditorialCookie(issued,origin);
    const deleted = await client('/api/cms/v2/session',{method:'DELETE',body:{},headers:{Cookie:fresh.pair,Origin:origin}});
    assert.equal(deleted.status,204);
    assert.equal(await sql('portal',`SELECT (expires_at>NOW() AND revoked_at IS NOT NULL)::text FROM cms_editor_sessions
      WHERE user_uid=:'uid' AND token_hash=:'hash';`,{uid:account.uid,hash:hash(fresh.cookie.value)}),'true');
    assert.equal((await client('/api/cms/v2/session',{headers:{Cookie:fresh.pair}})).status,401);
    assert.equal(await sql('portal',`UPDATE users SET permissions='{"manageBenefits":true}'::jsonb WHERE uid=:'uid' RETURNING uid;`,{uid:account.uid}),account.uid);
    return [evidence('permission_reloaded_from_real_database',200),evidence('expired_unrevoked_cookie_denied',401),
      evidence('revoke_confirmed',204),evidence('revoked_unexpired_cookie_denied',401)];
  });
}

export function attachFunctionalBrowserEvents(context,origin) {
  const state = { sequence:0,pageErrors:0,externalRequests:0,unexpectedWrites:0,expectedDeniedWrites:[],authTransitions:[],requests:[],responses:[],policyProbeActive:false };
  const trackPaths = new Set(['/api/cms/v2/session','/api/cms/session','/api/users/me','/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword']);
  const byRequest = new WeakMap();
  context.on('page',page => page.on('pageerror',() => { state.pageErrors++; }));
  context.on('request',request => {
    let url; try { url=new URL(request.url()); } catch { state.externalRequests++; return; }
    if (!['data:','blob:'].includes(url.protocol) && url.origin !== origin && url.origin !== 'https://www.gstatic.com') state.externalRequests++;
    if (url.origin !== origin) return;
    if (['POST','PATCH','PUT','DELETE'].includes(request.method()) &&
      /^\/editorial\/api\/(?:news-|globals\/news-home|legacy-news-|payload-jobs)/.test(url.pathname)) {
      if (state.policyProbeActive && request.method()==='POST' && url.pathname==='/editorial/api/news-articles') {
        const probe={sequence:++state.sequence,path:url.pathname,method:request.method(),status:null};
        state.expectedDeniedWrites.push(probe); byRequest.set(request,probe);
      } else state.unexpectedWrites++;
    }
    if (!trackPaths.has(url.pathname)) return;
    const item = { sequence:++state.sequence,path:url.pathname,method:request.method() };
    byRequest.set(request,item); state.requests.push(item);
  });
  context.on('response',response => {
    const request = byRequest.get(response.request());
    if (request) {request.status=response.status();state.responses.push({...request,sequence:++state.sequence,status:response.status()});}
  });
  return state;
}

async function browserIdentity(page) {
  return page.evaluate(async () => {
    const {auth}=await import('/js/firebase-config.js');
    await auth.authStateReady(); return auth.currentUser?.uid || null;
  });
}

async function browserFetch(page,pathname,options={}) {
  return page.evaluate(async ({pathname,options}) => {
    const response=await fetch(pathname,{credentials:'same-origin',cache:'no-store',redirect:'error',...options});
    let json=null; try {json=await response.json();} catch {}
    return {status:response.status,json};
  },{pathname,options});
}

async function browserLogin(context,origin,account) {
  const page=await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(`${origin}/login.html?next=%2Fcms.html`,{waitUntil:'domcontentloaded'});
  await page.locator('#email').fill(account.email); await page.locator('#password').fill(account.password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForURL(url=>url.origin===origin && url.pathname==='/cms.html');
  assert.equal(await browserIdentity(page),account.uid);
  const profile=await page.evaluate(async () => {
    const {auth}=await import('/js/firebase-config.js'); const token=await auth.currentUser.getIdToken();
    const response=await fetch('/api/users/me',{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
    return {status:response.status,json:await response.json()};
  });
  assert.equal(profile.status,200); assert.equal(profile.json.uid,account.uid);
  await page.locator('#content-types button').first().waitFor({state:'visible'});
  return page;
}

async function enterNative(page,origin,account) {
  const button=page.locator('#native-admin-entry-button'); await button.waitFor({state:'visible'});
  assert.equal(await button.isEnabled(),true);
  const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/cms/v2/session' && value.request().method()==='POST');
  await button.click(); const issued=await response; assert.equal(issued.status(),201);
  const body=await issued.json(); assert.equal(body.actor.uid,account.uid); assert.equal(body.actor.version,2);
  await page.waitForURL(url=>url.origin===origin && url.pathname==='/editorial/admin');
  await page.getByRole('heading',{name:'Painel administrativo',exact:true}).waitFor();
  const me=await browserFetch(page,'/editorial/api/portal-editors/me');
  assert.equal(me.status,200); assert.equal(me.json.user.portalUid,account.uid);
  const session=await browserFetch(page,'/api/cms/v2/session');
  assert.equal(session.status,200); assert.equal(session.json.actor.uid,account.uid);
  return body;
}

export async function runBrowserContracts({lease,report,client,accounts,sql,origin}) {
  const browser=await lease.playwright.chromium.launch({headless:true,...(lease.config.browserExecutable ? {executablePath:lease.config.browserExecutable} : {}),
    args:[`--ignore-certificate-errors-spki-list=${lease.tls.spki}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE www.gstatic.com'],
    env: { PATH:process.env.PATH,HOME:process.env.HOME } });
  let context;
  let expired=false;
  const timer=setTimeout(()=>{expired=true;void browser.close().catch(()=>{});},180000);
  try {
    context=await browser.newContext({viewport:{width:1440,height:900},ignoreHTTPSErrors:false,serviceWorkers:'block'});
    const events=attachFunctionalBrowserEvents(context,origin);
    // Keep the redacted trace even when a later assertion fails.
    report.browserEvidence={requests:events.requests,responses:events.responses,
      authTransitions:events.authTransitions,expectedDeniedWrites:events.expectedDeniedWrites,
      tlsTrust:'fixture-spki-only',authTransport:'unmodified-firebase-sdk-and-real-emulator',interceptions:false};
    await context.exposeBinding('__functionalAuthObserved',(_source,signedIn)=>{
      if (typeof signedIn !== 'boolean') throw new Error('functional_auth_observation_invalid');
      events.authTransitions.push({sequence:++events.sequence,signedIn});
    });
    let academyPage;
    await runFunctionalCase(report,'CMS-01',async () => {
      academyPage=await browserLogin(context,origin,accounts.academy);
      assert.deepEqual(await academyPage.locator('#content-types button').allTextContents(),['Academy','Academy — Aulas']);
      const otherContext=await browser.newContext({ignoreHTTPSErrors:false,serviceWorkers:'block'});
      const otherEvents=attachFunctionalBrowserEvents(otherContext,origin);
      try {
        const benefits=await browserLogin(otherContext,origin,accounts.benefits);
        assert.deepEqual(await benefits.locator('#content-types button').allTextContents(),['Benefícios']);
        assert.equal(otherEvents.pageErrors,0); assert.equal(otherEvents.externalRequests,0);
      } finally {await otherContext.close();}
      const viewer=await client('/api/cms/v2/session',{method:'POST',headers:{...bearer(accounts.viewer),Origin:origin},body:{}});
      assert.equal(viewer.status,403);
      await probeCookieLessNativeMe({client,sql,headers:bearer(accounts.viewer)});
      assert.equal(await sql('cms',`SELECT count(*) FROM portal_editors WHERE portal_uid=:'uid';`,{uid:accounts.viewer.uid}),'0');
      return [evidence('real_browser_login_profile_uid_matches'),evidence('academy_areas_exact'),evidence('benefits_area_exact'),
        evidence('viewer_issuance_denied',403),evidence('viewer_no_native_projection')];
    });
    await runFunctionalCase(report,'CMS-02',async () => {
      const issued=await enterNative(academyPage,origin,accounts.academy);
      assert.equal(issued.actor.capabilities.manageAcademy,true); assert.equal(issued.actor.capabilities.manageKnowledge,false);
      const cookies=(await context.cookies(origin)).filter(cookie=>cookie.name==='__Host-ownerinc-editorial');
      assert.equal(cookies.length,1); assert.equal(cookies[0].secure,true); assert.equal(cookies[0].httpOnly,true);
      assert.equal(cookies[0].domain,'127.0.0.1'); assert.equal(cookies[0].path,'/'); assert.equal(cookies[0].sameSite,'Lax');
      assert.equal(await sql('portal',`SELECT mode||'|'||epoch::text FROM owner_news_authority WHERE singleton=true;`),'legacy|1');
      return [evidence('ui_v2_issuance_ack',201),evidence('native_me_session_profile_same_uid',200),evidence('secure_host_only_browser_cookie'),evidence('legacy_epoch_one')];
    });
    await runFunctionalCase(report,'CMS-07-legacy-policy',async () => {
      const access=await browserFetch(academyPage,'/editorial/api/access');assert.equal(access.status,200);
      const allowed=value=>value===true || value?.permission===true;
      assert.equal(access.json.canAccessAdmin,true);
      for(const name of ['news-articles','news-media','news-schedules','news-audit','legacy-news-revisions','payload-jobs']) {
        assert.equal(allowed(access.json.collections?.[name]?.read),false);
      }
      assert.equal(allowed(access.json.collections?.['news-articles']?.readVersions),false);
      assert.equal(allowed(access.json.globals?.['news-home']?.read),false);
      for (const pathname of ['/editorial/api/news-articles','/editorial/api/news-articles/versions',
        '/editorial/api/globals/news-home','/editorial/api/news-media','/editorial/api/news-schedules',
        '/editorial/api/news-audit','/editorial/api/legacy-news-revisions','/editorial/api/payload-jobs']) {
        const result=await browserFetch(academyPage,pathname);
        if(result.status!==403) {
          assert.equal(pathname.includes('/globals/'),false);assert.equal(result.status,200);
          assert.deepEqual(result.json.docs,[]);assert.equal(result.json.totalDocs,0);
        }
      }
      const locks=await browserFetch(academyPage,'/editorial/api/payload-locked-documents');
      assert.equal(locks.status,200); assert.deepEqual(locks.json.docs,[]); assert.equal(locks.json.totalDocs,0);
      // A deliberate denied lock write is not News content interception or a fake actor.
      const denied=await browserFetch(academyPage,'/editorial/api/payload-locked-documents',{
        method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      assert.equal(denied.status,403);
      events.policyProbeActive=true;
      try {
        const deniedArticle=await browserFetch(academyPage,'/editorial/api/news-articles',{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Denied synthetic policy probe'})});
        assert.equal(deniedArticle.status,403);
      } finally {events.policyProbeActive=false;}
      assert.equal((await client('/api/cms/v2/session')).status,401);
      await probeCookieLessNativeMe({client,sql});
      return [evidence('native_news_denied_or_empty'),evidence('locks_empty_no_editor_identity',200),evidence('lock_mutation_denied',403),evidence('native_article_create_denied',403),evidence('anonymous_me_user_null_no_store_writes',200)];
    });
    await runFunctionalCase(report,'AUTH-01',async () => {
      const [cookie]=(await context.cookies(origin)).filter(value=>value.name==='__Host-ownerinc-editorial'); assert.ok(cookie);
      let link=academyPage.locator('a[href$="/editorial/admin/logout"]:visible').first();
      if (await link.count()===0) {
        await academyPage.locator('.nav-toggler:visible').last().click();
        await academyPage.locator('aside.nav--nav-open').waitFor();
        link=academyPage.locator('a[href$="/editorial/admin/logout"]:visible').first();
      }
      assert.equal(await link.innerText(),'Sair do editorial');
      const response=academyPage.waitForResponse(value=>new URL(value.url()).pathname==='/api/cms/session' && value.request().method()==='DELETE');
      await link.click(); assert.equal((await response).status(),204);
      await academyPage.waitForURL(url=>url.origin===origin && url.pathname==='/cms.html');
      assert.equal((await context.cookies(origin)).some(value=>value.name==='__Host-ownerinc-editorial'),false);
      const pair=`${cookie.name}=${cookie.value}`;
      assert.equal((await client('/api/cms/v2/session',{headers:{Cookie:pair}})).status,401);
      assertRevokedNativeMe(await client('/editorial/api/portal-editors/me',{headers:{Cookie:pair}}));
      assert.equal(await browserIdentity(academyPage),accounts.academy.uid);
      return [evidence('editorial_ui_delete_confirmed',204),evidence('cookie_removed_old_native_cookie_denied',401),evidence('firebase_portal_session_retained')];
    });
    await runFunctionalCase(report,'AUTH-02-portal',async () => {
      await enterNative(academyPage,origin,accounts.academy);
      const [cookie]=(await context.cookies(origin)).filter(value=>value.name==='__Host-ownerinc-editorial'); assert.ok(cookie);
      await academyPage.goto(`${origin}/cms.html`,{waitUntil:'domcontentloaded'});
      await academyPage.evaluate(async ()=>{
        const {auth}=await import('/js/firebase-config.js');
        const {onAuthStateChanged}=await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
        await new Promise(resolve=>{
          let initial=true;
          onAuthStateChanged(auth,user=>{
            void window.__functionalAuthObserved(user!==null);
            if(initial){initial=false;resolve();}
          });
        });
      });
      const firstSequence=events.sequence;
      const response=academyPage.waitForResponse(value=>new URL(value.url()).pathname==='/api/cms/session' && value.request().method()==='DELETE');
      await academyPage.locator('.sidebar-logout').click(); assert.equal((await response).status(),204);
      await academyPage.waitForURL(url=>url.origin===origin && url.pathname==='/login.html');
      assert.equal(await browserIdentity(academyPage),null);
      assert.equal((await context.cookies(origin)).some(value=>value.name==='__Host-ownerinc-editorial'),false);
      assert.equal((await client('/api/cms/v2/session',{headers:{Cookie:`${cookie.name}=${cookie.value}`}})).status,401);
      assert.equal(await sql('portal',`SELECT revoked_at IS NOT NULL FROM cms_editor_sessions WHERE user_uid=:'uid' AND token_hash=:'hash';`,
        {uid:accounts.academy.uid,hash:hash(cookie.value)}),'t');
      const deletes=events.responses.filter(value=>value.sequence>firstSequence && value.method==='DELETE' && value.path==='/api/cms/session');
      assert.equal(deletes.length,1); assert.equal(deletes[0].status,204);
      const transitions=events.authTransitions.filter(value=>value.sequence>firstSequence && !value.signedIn);
      assert.equal(transitions.length,1);assert.ok(transitions[0].sequence>deletes[0].sequence);
      // Real SDK transition ordering, not a mocked signOut invocation or heading.
      return [evidence('portal_delete_ack_before_observed_signed_out',204),evidence('firebase_signed_out'),evidence('revoked_database_row_cookie_denied',401)];
    });
    assert.equal(expired,false); assert.equal(events.pageErrors,0); assert.equal(events.externalRequests,0); assert.equal(events.unexpectedWrites,0);
    assert.equal(events.expectedDeniedWrites.length,1);assert.equal(events.expectedDeniedWrites[0].status,403);
    Object.assign(report.browserEvidence,{pageErrors:events.pageErrors,externalRequests:events.externalRequests,
      unexpectedNewsWrites:events.unexpectedWrites});
  } finally {
    clearTimeout(timer);
    await context?.close(); await browser.close();
  }
}
