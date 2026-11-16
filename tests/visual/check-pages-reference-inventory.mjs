import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {referenceInventory} from './pages-reference-inventory.mjs';
import {compareText,expectedText} from './pages-reference-text.mjs';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href);
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
  const page=await browser.newPage({viewport:{width:800,height:600}});
  await page.setContent(`<label>Typography<select aria-label="Typography"><option selected>Wrong</option><option>Manrope · 16 px</option></select></label>
    <details><summary>Extras</summary><p>Closed only</p></details>
    <div style="height:25px;overflow:hidden"><div style="height:60px"></div><p>Clipped only</p></div>
    <p id="covered">Covered text</p><p style="font:28px/32px Arial;overflow:hidden">Readable tight line</p>
    <div style="position:relative"><p>Transparent hit layer</p><div style="position:absolute;inset:0;opacity:0"><button style="width:100%;height:100%;pointer-events:auto">Invisible</button></div></div><dialog><p>Dialog text</p></dialog>`);
  await page.locator('select').evaluate(n=>{n.__referenceRegions=['typography'];});
  let inventory=await page.evaluate(referenceInventory);
  assert.deepEqual(inventory.text.filter(t=>t.tag==='LABEL').map(t=>t.text),['Typography']);
  assert.equal(inventory.text.find(t=>t.kind==='selected-value').text,'Wrong');
  assert.ok(inventory.text.some(t=>t.text==='Readable tight line'));
  assert.ok(inventory.text.some(t=>t.text==='Transparent hit layer'));
  for(const text of ['Closed only','Clipped only','Manrope · 16 px'])assert.ok(!inventory.text.some(t=>t.text.includes(text)),text);
  assert.ok(inventory.underlyingDOM.find(t=>t.text==='Closed only').excluded.includes('closed-details'));
  assert.ok(inventory.underlyingDOM.find(t=>t.text==='Clipped only').excluded.includes('ancestor-clipped'));
  const capture={...inventory,textChecks:expectedText('mobile-content').map(t=>({...t,pass:true}))};
  assert.equal(compareText('mobile-content',capture,[{id:'typography',x:0,y:0,width:800,height:600}]).find(t=>t.region==='typography').pass,false);
  await page.locator('select').selectOption({label:'Manrope · 16 px'});
  inventory=await page.evaluate(referenceInventory);
  assert.equal(compareText('mobile-content',{...capture,...inventory},[{id:'typography',x:0,y:0,width:800,height:600}]).find(t=>t.region==='typography').pass,true);
  // The modal intercepts interaction across the viewport, but paints only its
  // box when ::backdrop is transparent. Coordinates deliberately separate both.
  await page.setContent(`<style>
    body{margin:0}p{margin:0;font:16px/24px Arial}
    dialog{margin:0;position:fixed;left:200px;top:100px;width:320px;height:200px;box-sizing:border-box;background:white;border:0;padding:20px}
    dialog::backdrop{background:var(--backdrop,transparent)}
    #exposed{position:absolute;left:20px;top:10px}#covered{position:absolute;left:220px;top:140px}
    #inspector{position:absolute;left:650px;top:190px}
  </style><p id="exposed">Código de vestimenta</p><p id="covered">Vestir-se bem é</p><p id="inspector">Introdução</p><p id="edge" style="position:absolute;left:150px;top:0">Ú     abcdefghijk</p><dialog><p>Dialog text</p></dialog>`);
  await page.evaluate(()=>{
    document.querySelector('#exposed').__referenceRegions=['header'];
    document.querySelector('#covered').__referenceRegions=['canvas'];
    document.querySelector('#inspector').__referenceRegions=['inspector'];
    const dialog=document.querySelector('dialog');dialog.__referenceRegions=['style-popover'];dialog.showModal();
    const edge=document.querySelector('#edge'),range=document.createRange();range.selectNodeContents(edge);
    const context=document.createElement('canvas').getContext('2d');context.font='16px Arial';
    const metrics=context.measureText('abcdefghijk'),baseline=range.getBoundingClientRect().bottom-metrics.fontBoundingBoxDescent;
    // Lowercase ink starts at the panel bottom; the taller Ú is outside its left
    // edge. The run envelope intersects the panel, but no glyph ink does.
    edge.style.top=`${dialog.getBoundingClientRect().bottom+metrics.actualBoundingBoxAscent-baseline}px`;
  });
  assert.equal(await page.evaluate(()=>document.elementFromPoint(30,20).tagName),'DIALOG','regression really exercises modal hit suppression outside the painted panel');
  inventory=await page.evaluate(referenceInventory);
  assert.ok(inventory.text.some(t=>t.text==='Código de vestimenta'));
  assert.ok(inventory.text.some(t=>t.text==='Introdução'));
  const edge=inventory.text.find(t=>t.text==='Ú abcdefghijk');
  assert.ok(edge?.glyphRects?.length,'glyph-envelope corner regression is visible after actual intersection refinement');
  assert.ok(!inventory.text.some(t=>t.text==='Vestir-se bem é'));
  assert.ok(inventory.underlyingDOM.find(t=>t.text==='Vestir-se bem é').excluded.includes('panel-covered'));
  assert.ok(inventory.text.some(t=>t.text==='Dialog text'));
  const regions=['header','canvas','inspector'].map(id=>({id,x:0,y:0,width:800,height:600}));
  const compare=(id,inv)=>compareText(id,{...inv,textChecks:expectedText(id).map(t=>({...t,pass:true,exposure:'underlyingDOM'}))},regions);
  for(const name of ['header','inspector','canvas'])assert.equal(compare('desktop-style',inventory).find(t=>t.region===name).pass,true,name);
  await page.locator('#exposed').evaluate(n=>{n.style.visibility='hidden';});
  inventory=await page.evaluate(referenceInventory);
  assert.equal(compare('desktop-style',inventory).find(t=>t.region==='header').pass,false,'hidden exposed requirement fails despite modal interaction blocking and forged downgrade');
  await page.evaluate(()=>{
    document.querySelector('#exposed').style.visibility='visible';
    const dialog=document.querySelector('dialog');dialog.__referenceRegions=['review-dialog'];dialog.style.setProperty('--backdrop','rgba(32,30,77,.4)');
  });
  inventory=await page.evaluate(referenceInventory);
  assert.ok(inventory.text.find(t=>t.text==='Código de vestimenta').paintLayers.some(l=>l.kind==='backdrop'&&l.alpha===0.4));
  assert.equal(compare('desktop-review',inventory).find(t=>t.region==='header').pass,true,'source review scrim leaves exposed text readable');
  assert.equal(compare('desktop-review',inventory).find(t=>t.region==='canvas').pass,true,'opaque review panel still covers the heading');
  await page.locator('dialog').evaluate(n=>n.style.setProperty('--backdrop','rgb(32,30,77)'));
  inventory=await page.evaluate(referenceInventory);
  assert.ok(inventory.underlyingDOM.find(t=>t.text==='Código de vestimenta').excluded.includes('opaque-backdrop'));
  assert.equal(compare('desktop-review',inventory).find(t=>t.region==='header').pass,false,'opaque scrim cannot pass the translucent source contract');
  console.log('PASS actual Chrome own labels/selected values/closed/clipped text; transparent modal exposed versus panel-covered text; hidden exposed negative; 40% source scrim versus opaque backdrop');
}finally{await browser.close();}
