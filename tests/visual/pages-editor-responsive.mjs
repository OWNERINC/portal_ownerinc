import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pagesBrowserContext, pagesBrowserReady } from '../helpers/pages-browser.mjs';
import { pageDocument } from '../database/check-pages.mjs';

export async function checkResponsive({ h, browser, output, results, errors }) {
  const { default: AxeBuilder } = await import(pathToFileURL(process.env.AXE_MODULE_PATH));
  const failures = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };
  const created = await h.api('post', '', { template_id: 'guia-interno', client_mutation_id: randomUUID() }, 'super');
  assert.equal(created.status, 201);
  const before = await h.api('get', `/${created.body.id}/workspace`, undefined, 'super');
  const { page: p, context } = await pagesBrowserContext(browser, { width: 1366, errors });
  try {
    await p.goto(`${h.origin}/page-editor.html?id=${created.body.id}`); await pagesBrowserReady(p);
    await p.locator('.ProseMirror').first().waitFor();
    await p.evaluate(() => { globalThis.responsiveViews = [...document.querySelectorAll('.ProseMirror')].map(n => [n, n.pmViewDesc]); });
    for (const width of [320,390,599,600,768,1099,1100,1366,1600]) for (const height of [640,768]) {
      await p.setViewportSize({ width, height });
      await p.evaluate(() => new Promise(requestAnimationFrame));
      const geometry = await p.evaluate(() => {
        const tools = document.querySelector('.pages-v2-tools'), viewport = document.querySelector('.pages-v2-viewport');
        const rect = n => { const r = n.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right }; };
        const controls = [...tools.querySelectorAll('button,select,summary')].filter(n => n.checkVisibility());
        return { tools:rect(tools), viewport:rect(viewport), controls:controls.map(n => {
          const r=rect(n), s=getComputedStyle(n,'::after');
          const inset = key => s.content === '""' ? Math.min(0,parseFloat(s[key]) || 0) : 0;
          const target={ x:r.x+inset('left'), y:r.y+inset('top'), right:r.right-inset('right'), bottom:r.bottom-inset('bottom'), width:r.width-inset('left')-inset('right'), height:r.height-inset('top')-inset('bottom') };
          // Native selects and disabled history controls cannot activate here;
          // Test edge midpoints, not the deliberately rounded outer corners.
          const hit=n.disabled || n.tagName==='SELECT' || [[(target.x+target.right)/2,target.y+2],[(target.x+target.right)/2,target.bottom-2],[target.x+2,(target.y+target.bottom)/2],[target.right-2,(target.y+target.bottom)/2]].every(([x,y]) => n.contains(document.elementFromPoint(x,y)));
          return { name:n.getAttribute('aria-label') || n.textContent, ...r, target, hit };
        }), overflow:document.documentElement.scrollWidth > innerWidth };
      });
      const label = `${width}x${height}`;
      check(geometry.viewport.y >= geometry.tools.bottom, `${label}: viewport below toolbar`);
      for (const c of geometry.controls) {
        check(c.bottom <= geometry.tools.bottom + .5 && c.y >= geometry.tools.y, `${label}: local toolbar containment ${c.name}`);
        check(c.x >= 0 && c.right <= width, `${label}: horizontal control clipping ${c.name}`);
        check(c.target.width >= 44 && c.target.height >= 44, `${label}: 44px target ${c.name}`);
        check(c.hit, `${label}: target hit testing ${c.name}`);
      }
      for (let i=0;i<geometry.controls.length;i++) for(let j=i+1;j<geometry.controls.length;j++) {
        const a=geometry.controls[i].target,b=geometry.controls[j].target;
        check(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=.5 || Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=.5, `${label}: adjacent toolbar targets overlap`);
      }
      check(!geometry.overflow, `${label}: document horizontal overflow`);
      check(await p.getByText('Prévia · conteúdo ilustrativo', { exact:true }).count() === 0, `${label}: honest mode message`);
      check(await p.locator('.pages-v2-mobile-notice').textContent() === 'Edição', `${label}: editing message`);
      const typography = await p.locator('[data-guide-block] .ProseMirror h2').evaluateAll(nodes => nodes.map(n => ({ size:parseFloat(getComputedStyle(n).fontSize), canonical:parseFloat(getComputedStyle(n.closest('[data-guide-block]')).getPropertyValue('--pages-h2-size')), weight:getComputedStyle(n.querySelector('strong') || n).fontWeight, color:getComputedStyle(n.querySelector('[data-pages-text_color]') || n).color })));
      for(const t of typography) check(t.size === t.canonical, `${label}: canonical title size ${JSON.stringify(t)}`);
      const textClipping=await p.locator('[data-guide-block] .ProseMirror h2').evaluateAll(nodes=>nodes.map(n=>{const range=document.createRange();range.selectNodeContents(n);const b=n.closest('.pages-editor-block').getBoundingClientRect();const lines=[...range.getClientRects()].map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom}));return{block:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},lines,contained:lines.every(r=>r.left>=b.left-.5&&r.right<=b.right+.5&&r.top>=b.top-.5&&r.bottom<=b.bottom+.5)};}));
      check(textClipping.every(t=>t.contained),`${label}: heading line ranges stay within their local blocks ${JSON.stringify(textClipping.filter(t=>!t.contained))}`);
      const axe = await new AxeBuilder({ page:p }).include('[data-guide-block=rich_text] .ProseMirror h2').withRules(['color-contrast']).analyze();
      check(axe.violations.length === 0, `${label}: title axe ${JSON.stringify(axe.violations)}`);
      check(axe.incomplete.length === 0, `${label}: every included heading has completed contrast evidence`);
      check(axe.passes.some(rule=>rule.nodes.some(n=>n.html.includes('#E84F1C'))),`${label}: orange title has a completed axe pass, not an incomplete/excluded node`);
      results.push({ width,height,geometry,typography,textClipping,axe:{ violations:axe.violations,passes:axe.passes,incomplete:axe.incomplete } });
      if (height === 768) await p.screenshot({ path:join(output, `${label}-edit.png`) });
      for (const zoom of [50,100,150]) {
        // These are actual native zoom controls, including their compact menu;
        // no state/document fixture is injected into the opened workspace.
        if(width<600) await p.locator('.pages-v2-overflow > summary').click();
        await p.getByRole('combobox',{name:'Zoom',exact:true}).selectOption(String(zoom));
        if(width<600) await p.keyboard.press('Escape');
        await p.evaluate(() => new Promise(requestAnimationFrame));
        const clearance = await p.evaluate(() => {
          const bar=document.querySelector('.pages-v2-viewport > .pages-format-tools');
          const text=document.querySelector('.pages-editor-block.has-context-tools .ProseMirror');
          return bar&&text ? { bar:bar.getBoundingClientRect().bottom, text:text.getBoundingClientRect().top } : null;
        });
        if(width>=1100) check(!!clearance && clearance.text>=clearance.bar+4-.5,`${label}/${zoom}: measured contextual toolbar clearance ${JSON.stringify(clearance)}`);
        results.push({ width,height,zoom,clearance });
      }
      if(width<600) await p.locator('.pages-v2-overflow > summary').click();
      await p.getByRole('combobox',{name:'Zoom',exact:true}).selectOption('100');
      if(width<600) await p.keyboard.press('Escape');
      await p.locator('.pages-v2-preview-menu > summary').click();
      await p.locator('[data-preview-mode=mobile]').click();
      check(await p.locator('.pages-v2-mobile-notice').textContent()==='Prévia',`${label}: preview message`);
      const previewAxe=await new AxeBuilder({page:p}).include('.pages-document [data-guide-block] h2').withRules(['color-contrast']).analyze();
      check(previewAxe.violations.length===0,`${label}: preview title AA`);
      check(previewAxe.incomplete.length===0,`${label}: preview headings have completed contrast evidence`);
      results.push({width,height,previewAxe:{violations:previewAxe.violations,passes:previewAxe.passes,incomplete:previewAxe.incomplete}});
      for(const zoom of [50,100,150]) {
        if(width<600)await p.locator('.pages-v2-overflow > summary').click();
        await p.getByRole('combobox',{name:'Zoom',exact:true}).selectOption(String(zoom));
        if(width<600)await p.keyboard.press('Escape');
        const scale=await p.locator('.pages-editor-surface').evaluate(n=>new DOMMatrix(getComputedStyle(n).transform).a);
        check(scale===zoom/100,`${label}: preview canvas zoom ${zoom}`);
        results.push({width,height,mode:'preview',zoom,scale});
      }
      if(height===768 && [390,768,1366].includes(width))await p.screenshot({path:join(output,`${label}-preview.png`)});
      if(width<600)await p.locator('.pages-v2-overflow > summary').click();
      await p.getByRole('combobox',{name:'Zoom',exact:true}).selectOption('100');
      if(width<600)await p.keyboard.press('Escape');
      await p.locator('.pages-v2-preview-menu > summary').click();
      await p.locator('[data-preview-mode=edit]').click();
    }
    assert.equal(await p.evaluate(() => responsiveViews.every(([n,v]) => n.isConnected && n.pmViewDesc === v)), true, 'breakpoints retain PM identity');
    const after = await h.api('get', `/${created.body.id}/workspace`, undefined, 'super');
    assert.deepEqual(after.body, before.body, 'opening/resizing does not migrate, recolor or save');
    await p.setViewportSize({width:390,height:768});
    const rich=p.locator('.ProseMirror').first();await rich.click();await rich.press('End');await p.keyboard.type(' Task 6 local edit');
    await p.getByRole('button',{name:'Concluir edição',exact:true}).click();
    check(await p.locator('.pages-v2-mobile-notice').textContent()==='Edição','edited content is editing, not illustrative');
    await p.locator('.pages-v2-preview-menu > summary').click();await p.locator('[data-preview-mode=mobile]').click();
    check(await p.locator('.pages-document').innerText().then(t=>t.includes('Task 6 local edit')),'preview renders the actual local edit');
    check(await p.locator('.pages-v2-mobile-notice').textContent()==='Prévia','local edit preview mode');
    await p.locator('.pages-v2-preview-menu > summary').click();await p.locator('[data-preview-mode=edit]').click();
    // Headless Chrome does not normally implement browser chrome shortcuts.
    // Record the actual probe; do not mislabel pageScaleFactor (pinch) as zoom.
    const zoomProbe=await p.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,scale:visualViewport.scale}));
    await p.keyboard.press('Control++');
    const zoomAfter=await p.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,scale:visualViewport.scale}));
    await p.keyboard.press('Control+0');
    results.push({browserZoomShortcutProbe:{before:zoomProbe,after:zoomAfter,native200Verified:zoomAfter.dpr===zoomProbe.dpr*2}});
    for(const physical of [640,768,1366,1600]) {
      const width=physical/2,height=384;
      await p.setViewportSize({width,height});await p.evaluate(()=>new Promise(requestAnimationFrame));
      const save=p.getByRole('button',{name:/Salvar rascunho/}),box=await save.boundingBox();
      check(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,`200% reflow ${physical}: save visible`);
      const tools=await p.locator('.pages-v2-tools').boundingBox(),viewport=await p.locator('.pages-v2-viewport').boundingBox();
      check(viewport.y>=tools.y+tools.height,`200% reflow ${physical}: viewport separation`);
      await p.screenshot({path:join(output,`browser200-reflow-${physical}.png`)});
      results.push({browserZoom:'200% layout-viewport equivalent, not native browser chrome',physical,width,height,save:box,tools,viewport});
    }
    assert.deepEqual((await h.api('get',`/${created.body.id}/workspace`,undefined,'super')).body,before.body,'local edit and zoom never autosave');
    // A fresh task-owned Chrome profile can set browser zoom independently of
    // canvas transforms and pinch zoom. Verify DPR AND CSS viewport; never infer
    // native zoom merely from the stored preference or launch succeeding.
    const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
    const profile=join(output,'chrome-200-profile');await mkdir(profile);
    const nativeContext=await chromium.launchPersistentContext(profile,{headless:true,channel:'chrome',viewport:{width:1366,height:768}});
    try {
      const settings=await nativeContext.newPage();await settings.goto('chrome://settings/appearance');
      const settingsZoom=await settings.evaluate(async()=>{
        if(!globalThis.chrome?.settingsPrivate?.setDefaultZoom)return{available:false};
        await new Promise(resolve=>chrome.settingsPrivate.setDefaultZoom(2,resolve));
        return{available:true,zoom:await new Promise(resolve=>chrome.settingsPrivate.getDefaultZoom(resolve))};
      });
      await settings.close();results.push({nativeSettingsZoom:settingsZoom});
      const nativeVisit=await pagesBrowserContext({newContext:async()=>nativeContext},{width:1366,errors});
      const np=nativeVisit.page;
      await np.goto(`${h.origin}/page-editor.html?id=${created.body.id}`);await pagesBrowserReady(np);await np.locator('.ProseMirror').first().waitFor();
      const metrics=await np.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,scale:visualViewport.scale}));
      const verified=metrics.width===683&&metrics.dpr===2&&metrics.scale===1;
      results.push({nativeBrowser200:{verified,metrics,mechanism:'chrome://settings settingsPrivate.setDefaultZoom(2) in disposable profile; runtime DPR/viewport/scale verification'}});
      check(verified,`native browser 200% verification ${JSON.stringify(metrics)}`);
      if(verified)for(const physical of [640,768,1366,1600])for(const physicalHeight of [640,768]) {
        await np.setViewportSize({width:physical,height:physicalHeight});await np.evaluate(()=>new Promise(requestAnimationFrame));
        const measurement=await np.evaluate(()=>{
          const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
          return{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale,tools:rect(document.querySelector('.pages-v2-tools')),viewport:rect(document.querySelector('.pages-v2-viewport')),save:rect(document.querySelector('[data-save-draft]')||[...document.querySelectorAll('button')].find(n=>n.textContent.includes('Salvar rascunho')))};
        });
        check(measurement.dpr===2&&measurement.width===physical/2&&measurement.scale===1,`${physical}: real browser zoom remains 200%`);
        check(measurement.viewport.y>=measurement.tools.bottom,`${physical}: native 200% toolbar separation`);
        check(measurement.save.y>=0&&measurement.save.bottom<=measurement.height&&measurement.save.x>=0&&measurement.save.right<=measurement.width,`${physical}: native 200% save visible`);
        const targets=await np.locator('.pages-v2-tools').evaluate(n=>{const r=n.getBoundingClientRect();return [...n.querySelectorAll('button,select,summary')].filter(c=>c.checkVisibility()).map(c=>{const b=c.getBoundingClientRect();return{name:c.getAttribute('aria-label')||c.textContent,contained:b.top>=r.top&&b.bottom<=r.bottom&&b.left>=0&&b.right<=innerWidth};});});
        check(targets.every(t=>t.contained),`${physical}x${physicalHeight}: native 200% local toolbar bounds`);
        for(const zoom of [50,100,150]) {
          if(measurement.width<600)await np.locator('.pages-v2-overflow > summary').click();
          await np.getByRole('combobox',{name:'Zoom',exact:true}).selectOption(String(zoom));
          if(measurement.width<600)await np.keyboard.press('Escape');
          check(await np.locator('.pages-editor-surface').evaluate(n=>new DOMMatrix(getComputedStyle(n).transform).a)===zoom/100,`${physical}: browser 200% + canvas ${zoom}`);
        }
        await np.screenshot({path:join(output,`native-browser200-${physical}x${physicalHeight}.png`)});
        results.push({nativeBrowser200:physical,physicalHeight,measurement,targets,canvasZooms:[50,100,150]});
      }
    } finally {await nativeContext.close();}
    // Synthetic legacy snapshots are installed via API BEFORE opening their own
    // editor; the active guide is never replaced by a fixture for evidence.
    for(const version of [1,2]) {
      const legacy=await h.api('post','',{template_id:'comunicado',client_mutation_id:randomUUID()},'super');
      const document=pageDocument(`Legacy v${version} responsive`);document.schema_version=version;
      if(version===2)document.template.version=2;
      const saved=await h.api('put',`/${legacy.body.id}/draft`,{expected_version:0,client_mutation_id:randomUUID(),document},'super');
      assert.equal(saved.status,200,JSON.stringify(saved.body));
      const baseline=await h.api('get',`/${legacy.body.id}/workspace`,undefined,'super');
      await p.goto(`${h.origin}/page-editor.html?id=${legacy.body.id}`);await pagesBrowserReady(p);await p.locator('.ProseMirror').first().waitFor();
      await p.evaluate(()=>{globalThis.legacyResponsive=document.querySelector('.ProseMirror');});
      for(const width of [320,390,599,600,768,1099,1100,1366,1600]) {
        await p.setViewportSize({width,height:768});
        await p.locator('.pages-v2-preview-menu > summary').click();await p.locator('[data-preview-mode=mobile]').click();
        check((await p.locator('.pages-document').innerText()).includes(`Legacy v${version}`),`${width}: actual legacy v${version} preview`);
        await p.locator('.pages-v2-preview-menu > summary').click();await p.locator('[data-preview-mode=edit]').click();
        check(await p.evaluate(()=>legacyResponsive===document.querySelector('.ProseMirror')),`${width}: legacy identity`);
      }
      assert.deepEqual((await h.api('get',`/${legacy.body.id}/workspace`,undefined,'super')).body,baseline.body,'legacy schema/document unchanged');
      results.push({legacy:version,widths:[320,390,599,600,768,1099,1100,1366,1600],unchanged:true});
    }
  } finally {
    await writeFile(join(output,'responsive-failures.json'), JSON.stringify(failures,null,2));
    await context.close();
  }
  assert.deepEqual(failures, []);
}
