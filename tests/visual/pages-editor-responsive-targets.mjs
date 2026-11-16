import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pageDocument } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady } from '../helpers/pages-browser.mjs';

const widths=[320,390,599,600,768,1099,1100,1366,1600];
const heights=[640,768], zooms=[50,100,150];

// Exactly the same measurement/assertions at every browser/canvas zoom. Native
// select edges are now hit-tested too; disabled nodes are measured but cannot
// activate, so their hit records explicitly state that limitation.
export async function measureResponsiveTargets(p) {
  return p.evaluate(() => {
    const tools=document.querySelector('.pages-v2-tools'),viewport=document.querySelector('.pages-v2-viewport');
    const titleScope=document.querySelector('#page-editor-root').dataset.editorMode==='preview'?'.pages-document':'.ProseMirror';
    // Locate the run by document text, not by the color being asserted. PM wraps
    // strong outside its color span; the shared renderer puts it inside the run.
    const orangeHeading=[...document.querySelectorAll(`${titleScope} h2`)].find(n=>n.textContent==='Para cada momento, uma escolha');
    const orange=orangeHeading?.querySelector('[data-pages-text_color],[data-pages-rich-run]');
    const strong=orange?.closest('strong')||orange?.querySelector('strong');
    const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
    const controls=[...tools.querySelectorAll('button,select,summary')].filter(n=>n.checkVisibility());
    return { width:innerWidth,height:innerHeight,dpr:devicePixelRatio,pinchScale:visualViewport.scale,
      canvasScale:new DOMMatrix(getComputedStyle(document.querySelector('.pages-editor-surface')).transform).a,
      orange:orange?{color:getComputedStyle(orange).color,weight:getComputedStyle(strong||orange).fontWeight,strong:!!strong,size:parseFloat(getComputedStyle(orange).fontSize)}:null,
      tools:rect(tools),viewport:rect(viewport),controls:controls.map(n=>{
        const r=rect(n),s=getComputedStyle(n,'::after');
        const inset=key=>s.content==='""'?Math.min(0,parseFloat(s[key])||0):0;
        const target={x:r.x+inset('left'),y:r.y+inset('top'),right:r.right-inset('right'),bottom:r.bottom-inset('bottom'),width:r.width-inset('left')-inset('right'),height:r.height-inset('top')-inset('bottom')};
        const edges=[[(target.x+target.right)/2,target.y+2],[(target.x+target.right)/2,target.bottom-2],[target.x+2,(target.y+target.bottom)/2],[target.right-2,(target.y+target.bottom)/2]].map(([x,y])=>({x,y,hit:n.contains(document.elementFromPoint(x,y))}));
        return{name:n.getAttribute('aria-label')||n.textContent,...r,target,disabled:n.disabled===true,edges};
      }),overflow:document.documentElement.scrollWidth>innerWidth };
  });
}

export function assertResponsiveTargets(g,check,label) {
  check(g.controls.length>0,`${label}: toolbar contains actual visible controls`);
  check(g.viewport.y>=g.tools.bottom,`${label}: viewport below toolbar`);
  for(const c of g.controls) {
    check(c.bottom<=g.tools.bottom+.5&&c.y>=g.tools.y,`${label}: local toolbar containment ${c.name}`);
    check(c.target.y>=g.tools.y-.5&&c.target.bottom<=g.tools.bottom+.5,`${label}: effective target local containment ${c.name}`);
    check(c.target.x>=0&&c.target.right<=g.width,`${label}: horizontal target clipping ${c.name}`);
    check(c.target.width>=44&&c.target.height>=44,`${label}: 44px target ${c.name}`);
    check(c.disabled||c.edges.every(e=>e.hit),`${label}: target edge hits ${c.name} ${JSON.stringify(c.edges)}`);
  }
  for(let i=0;i<g.controls.length;i++)for(let j=i+1;j<g.controls.length;j++) {
    const a=g.controls[i].target,b=g.controls[j].target;
    check(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=.5||Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=.5,`${label}: adjacent toolbar targets overlap ${g.controls[i].name}/${g.controls[j].name}`);
  }
  check(!g.overflow,`${label}: document horizontal overflow`);
}

export async function checkResponsiveTargetMatrix({h,browser,output,results,errors,check,guideId}) {
  const documents=[{version:3,id:guideId}];
  for(const version of [1,2]) {
    const created=await h.api('post','',{template_id:'comunicado',client_mutation_id:randomUUID()},'super');assert.equal(created.status,201);
    const document=pageDocument(`Target matrix legacy v${version}`);document.schema_version=version;if(version===2)document.template.version=2;
    const saved=await h.api('put',`/${created.body.id}/draft`,{expected_version:0,client_mutation_id:randomUUID(),document},'super');assert.equal(saved.status,200);
    documents.push({version,id:created.body.id});
  }
  for(const doc of documents)doc.before=(await h.api('get',`/${doc.id}/workspace`,undefined,'super')).body;
  for(const browserZoom of [100,200]) {
    let context,p;
    if(browserZoom===100)({context,page:p}=await pagesBrowserContext(browser,{width:1366,errors}));
    else {
      const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
      const profile=join(output,'target-matrix-chrome-200');await mkdir(profile);
      context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chrome',viewport:{width:1366,height:768}});
      const settings=await context.newPage();await settings.goto('chrome://settings/appearance');
      await settings.evaluate(()=>new Promise(resolve=>chrome.settingsPrivate.setDefaultZoom(2,resolve)));await settings.close();
      ({page:p}=await pagesBrowserContext({newContext:async()=>context},{width:1366,errors}));
    }
    try {
      for(const doc of documents) {
        await p.goto(`${h.origin}/page-editor.html?id=${doc.id}`);await pagesBrowserReady(p);await p.locator('.ProseMirror').first().waitFor();
        await p.evaluate(()=>{globalThis.targetMatrixViews=[...document.querySelectorAll('.ProseMirror')].map(n=>[n,n.pmViewDesc]);});
        for(const width of widths)for(const height of heights) {
          // Playwright's viewport argument is physical browser viewport pixels
          // under native zoom. Doubling produces the exact requested CSS size.
          const physical={width:width*browserZoom/100,height:height*browserZoom/100};
          await p.setViewportSize(physical);await p.evaluate(()=>new Promise(requestAnimationFrame));
          for(const mode of ['edit','preview']) {
            if(mode==='preview') {await p.locator('.pages-v2-preview-menu > summary').click();await p.locator('[data-preview-mode=mobile]').click();}
            for(const zoom of zooms) {
              if(width<600)await p.locator('.pages-v2-overflow > summary').click();
              await p.getByRole('combobox',{name:'Zoom',exact:true}).selectOption(String(zoom));
              if(width<600)await p.keyboard.press('Escape');
              await p.evaluate(()=>new Promise(requestAnimationFrame));
              const geometry=await measureResponsiveTargets(p),label=`v${doc.version}/${mode}/browser${browserZoom}/canvas${zoom}/${width}x${height}`;
              check(geometry.width===width&&geometry.height===height,`${label}: exact real CSS viewport ${geometry.width}x${geometry.height}`);
              check(geometry.dpr===browserZoom/100&&geometry.pinchScale===1,`${label}: native browser zoom verified, not pinch`);
              check(geometry.canvasScale===zoom/100,`${label}: actual canvas transform`);
              if(doc.version===3)check(geometry.orange?.color==='rgb(232, 79, 28)'&&geometry.orange.strong&&Number(geometry.orange.weight)>=700&&geometry.orange.size===20,`${label}: persisted orange and canonical strong title ${JSON.stringify(geometry.orange)}`);
              assertResponsiveTargets(geometry,check,label);
              results.push({targetMatrix:true,schema:doc.version,mode,browserZoom,canvasZoom:zoom,width,height,physical,geometry});
            }
            if(mode==='preview') {await p.locator('.pages-v2-preview-menu > summary').click();await p.locator('[data-preview-mode=edit]').click();}
          }
        }
        check(await p.evaluate(()=>targetMatrixViews.every(([n,v])=>n.isConnected&&n.pmViewDesc===v)),`v${doc.version}/browser${browserZoom}: PM identity retained`);
        assert.deepEqual((await h.api('get',`/${doc.id}/workspace`,undefined,'super')).body,doc.before,'matrix does not save, migrate or recolor');
      }
    } finally {await context.close();}
  }
  const rows=results.filter(r=>r.targetMatrix);
  const keys=rows.map(r=>[r.schema,r.mode,r.browserZoom,r.canvasZoom,r.width,r.height].join('/'));
  assert.equal(new Set(keys).size,648,'every requested combination measured exactly once');
  await writeFile(join(output,'target-matrix.json'),JSON.stringify(rows,null,2));
}
