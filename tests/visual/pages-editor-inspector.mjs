import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorInsert, pagesEditorPageProperties } from '../helpers/pages-browser.mjs';
import { referenceMedia } from '../helpers/pages-reference-document.mjs';

const blocks = doc => doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
const imageFile = name => ({ name, mimeType: 'image/webp', buffer: referenceMedia()[0].bytes });

export async function checkInspector({ h, browser, output, results, errors }) {
  const failures = [];
  for (const width of [1366, 390]) {
    const created = await h.api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() }, 'super');
    assert.equal(created.status, 201);
    const { page: p, context } = await pagesBrowserContext(browser, { width, errors, touch: width < 1100 });
    const id=created.body.id, writes=[], privateRequests=[];
    p.on('request',r=>{if(r.method()==='PUT')writes.push(r.url());if(r.method()==='GET'&&/\/media\//.test(r.url()))privateRequests.push(r.url());});
    const sql=async()=>(await h.db.query('SELECT r.document FROM page_revisions r JOIN pages p ON p.draft_revision_id=r.id WHERE p.id=$1',[id])).rows[0].document;
    const save=async()=>{const button=p.getByRole('button',{name:/Salvar rascunho/});assert.equal(await button.isEnabled(),true,'explicit save requires dirty state');const response=p.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/pages/${id}/draft`);await button.click();assert.equal((await response).status(),200);await p.locator('#page-editor-root[data-save-state=saved]').waitFor();return sql();};
    const tab=async name=>{if(width<1100)await p.locator(`[data-sheet-tab=${name}]`).click();};
    const undo=async()=>{await p.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();};
    try {
      await p.goto(`${h.origin}/page-editor.html?id=${created.body.id}`); await pagesBrowserReady(p);
      await p.locator('.ProseMirror').first().click();
      const initial=await sql(),firstId=blocks(initial)[0].id;
      await p.locator('.ProseMirror').evaluateAll(nodes=>{globalThis.inspectorViews=nodes.map(n=>[n,n.pmViewDesc]);});
      if (width < 1100) await p.locator('[data-sheet-tab=style]').click();
      const inspector = p.locator('.pages-v2-inspector');
      const hex = inspector.getByRole('textbox', { name: 'Cor de fundo personalizada', exact: true });
      const widthControl = inspector.getByRole('combobox', { name: 'Largura do bloco', exact: true, includeHidden: true });
      if (!await hex.isVisible()) failures.push(`${width}: custom background unavailable directly in Style`);
      if (await widthControl.evaluate(n => n.closest('[data-inspector-section]')?.dataset.inspectorSection) !== 'position') failures.push(`${width}: width belongs to Style, not Position`);
      if (await inspector.locator('.pages-legacy-presentation').evaluate(n => n.closest('[data-inspector-section]')?.dataset.inspectorSection) !== 'style') failures.push(`${width}: legacy presets belong to Position, not Style`);
      await p.screenshot({ path: join(output, `${width}-style.png`) });
      if (width < 1100) await p.locator('[data-sheet-tab=position]').click();
      if (!await inspector.getByRole('button', { name: 'Duplicar', exact: true }).isVisible()) failures.push(`${width}: Duplicate hidden behind advanced disclosure`);
      if(await widthControl.isVisible())await widthControl.scrollIntoViewIfNeeded();
      await p.screenshot({ path: join(output, `${width}-position.png`) });
      assert.equal(writes.length,0);assert.deepEqual(await sql(),initial,'opening tabs never writes or upgrades legacy');
      await tab('style');
      await inspector.locator('.pages-legacy-presentation > summary').click();
      await inspector.locator('.pages-legacy-presentation').getByRole('combobox',{name:'Fonte',exact:true}).scrollIntoViewIfNeeded();
      await p.screenshot({path:join(output,`${width}-legacy-style.png`)});
      await inspector.locator('.pages-legacy-presentation').getByRole('combobox',{name:'Fonte',exact:true}).selectOption('oswald');
      assert.equal(await p.locator(`[data-block-id="${firstId}"]`).getAttribute('data-font'),'oswald');
      let stored=await save();assert.equal(stored.schema_version,2,'explicit legacy preset uses the existing v2 composition command');assert.equal(blocks(stored)[0].style.font,'oswald');
      await undo();await tab('style');
      await hex.fill('invalid');await hex.press('Tab');assert.equal(await hex.getAttribute('aria-invalid'),'true');
      const tags=inspector.getByRole('textbox',{name:'Tags do bloco',exact:true});
      await tags.fill('a,,b');await tags.press('Tab');
      assert.equal(await tags.getAttribute('aria-invalid'),'true');
      const hexFeedback=await hex.getAttribute('aria-describedby'),tagsFeedback=await tags.getAttribute('aria-describedby');
      assert.notEqual(hexFeedback,tagsFeedback);
      assert.match(await inspector.locator(`[id="${hexFeedback}"]`).innerText(),/hexadecimal/);
      assert.match(await inspector.locator(`[id="${tagsFeedback}"]`).innerText(),/tags/);
      await tags.scrollIntoViewIfNeeded();await p.screenshot({path:join(output,`${width}-independent-field-errors.png`)});
      assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'),'dirty','invalid color adds no history entry');
      await hex.fill('#DDEEFF');await hex.press('Tab');await tab('style');
      assert.equal(await hex.inputValue(),'#DDEEFF');
      await undo();await tab('style');assert.notEqual(await hex.inputValue(),'#DDEEFF');
      await hex.fill('#DDEEFF');await hex.press('Tab');
      stored=await save();assert.equal(stored.schema_version,3);assert.equal(blocks(stored)[0].appearance.background,'#DDEEFF');
      await tab('position');
      for(const label of ['Largura do bloco','Composição da linha','Coluna de destino'])assert.equal(await inspector.getByRole('combobox',{name:label,exact:true}).isVisible(),true,label);
      for(const label of ['Duplicar','Excluir','Mover para destino'])assert.equal(await inspector.getByRole('button',{name:label,exact:true}).isVisible(),true,label);
      await inspector.getByRole('button',{name:'Duplicar',exact:true}).click();
      assert.equal(await p.locator('[data-block-type=rich_text]').count(),2);
      await tab('position');await inspector.getByRole('button',{name:'Excluir',exact:true}).click();assert.equal(await p.locator('[data-block-type=rich_text]').count(),1);
      await undo();assert.equal(await p.locator('[data-block-type=rich_text]').count(),2);await undo();assert.equal(await p.locator('[data-block-type=rich_text]').count(),1);
      await p.locator(`[data-block-id="${firstId}"] .pages-select-block`).click();await tab('position');
      await widthControl.selectOption('half');assert.equal(await p.locator('.pages-row-two_equal').count(),1);
      await undo();assert.equal(await p.locator('.pages-row-two_equal').count(),0);
      await pagesEditorInsert(p,'Adicionar galeria');
      const galleryId=await p.locator('[data-block-type=gallery]').getAttribute('data-block-id');await tab('content');
      await p.getByLabel('Adicionar imagens à galeria',{exact:true}).setInputFiles([imageFile('one.webp'),imageFile('two.webp'),imageFile('three.webp')]);
      const items=inspector.locator('[data-media-item-id]');
      await p.waitForFunction(()=>document.querySelectorAll('.pages-v3-gallery figure img[src^="blob:"]').length===3);
      await p.waitForFunction(()=>document.querySelectorAll('.pages-gallery-preview[src^="blob:"]').length===3);
      assert.equal(await items.count(),3);
      await items.first().getByRole('heading').scrollIntoViewIfNeeded();await p.screenshot({path:join(output,`${width}-gallery-private.png`)});
      const originalIds=await items.evaluateAll(nodes=>nodes.map(n=>n.dataset.mediaItemId));
      for(let i=0;i<3;i++){
        const item=items.nth(i);assert.equal(await item.getByRole('heading',{name:`Imagem ${i+1} de 3`,exact:true}).isVisible(),true);
        assert.match(await item.locator('.pages-gallery-metadata').innerText(),/Imagem · arquivo privado · [a-f0-9-]{36}/);
        const order=item.getByRole('group',{name:'Ordem do item',exact:true}),remove=item.getByRole('group',{name:'Remoção do item',exact:true});
        assert.equal(await order.getByRole('button').count(),2);assert.equal(await remove.getByRole('button').count(),1);
        const bounds=await item.evaluate(n=>{const o=n.querySelector('.pages-media-item-order').getBoundingClientRect(),r=n.querySelector('.pages-media-item-remove').getBoundingClientRect();return {gap:r.top-o.bottom};});assert.ok(bounds.gap>=16);
        const alt=item.getByRole('textbox',{name:'Texto alternativo',exact:true});await alt.fill(`Image ${i+1} ${'long'.repeat(65)}`);assert.equal(await alt.evaluate(n=>n===document.activeElement),true);
        await item.getByRole('textbox',{name:'Legenda',exact:true}).fill(`Caption ${i+1}`);await item.getByRole('textbox',{name:'Crédito',exact:true}).fill(`Credit ${i+1}`);
        const size=await item.getByRole('textbox',{name:'Legenda',exact:true}).evaluate(n=>{const l=n.closest('label').getBoundingClientRect(),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{gap:r.top-n.previousElementSibling.getBoundingClientRect().bottom,height:r.height,width:r.width,max:l.width,font:parseFloat(s.fontSize)};});assert.ok(size.gap>=8&&size.height>=44&&size.width<=size.max+.5);if(width<1100)assert.ok(size.font>=16);
      }
      assert.equal(privateRequests.length,3,'inspector reuses canvas private blobs without extra GETs');
      const secondItem=items.nth(1),secondId=originalIds[1];
      await secondItem.getByRole('button',{name:'Subir item',exact:true}).click();
      assert.equal(await inspector.locator(`[data-media-item-id="${secondId}"]`).evaluate(n=>n.contains(document.activeElement)),true,'order keeps focus in the same item, including a newly disabled boundary action');
      await undo();assert.deepEqual(await items.evaluateAll(ns=>ns.map(n=>n.dataset.mediaItemId)),originalIds);
      await items.first().evaluate(n=>{globalThis.galleryRetained=n;});
      await items.first().getByRole('button',{name:'Descer item',exact:true}).click();
      const moved=inspector.locator(`[data-media-item-id="${originalIds[0]}"]`);
      assert.equal(await moved.evaluate(n=>n===galleryRetained),true);assert.equal(await moved.getByRole('heading').innerText(),'Imagem 2 de 3');
      stored=await save();let gallery=blocks(stored).find(b=>b.id===galleryId);assert.deepEqual(gallery.items.map(i=>i.id),[originalIds[1],originalIds[0],originalIds[2]]);
      await undo();assert.deepEqual(await items.evaluateAll(ns=>ns.map(n=>n.dataset.mediaItemId)),originalIds);await p.keyboard.press('Control+y');
      const oldMedia=gallery.items[1].media_id,oldPreview=await moved.locator('.pages-gallery-preview').getAttribute('src');
      await moved.getByLabel('Substituir imagem da galeria',{exact:true}).setInputFiles(imageFile('replacement.webp'));
      await p.waitForFunction(({itemId,old})=>{const src=document.querySelector(`[data-media-item-id="${itemId}"] .pages-gallery-preview`)?.getAttribute('src');return src?.startsWith('blob:')&&src!==old;},{itemId:originalIds[0],old:oldPreview});
      stored=await save();gallery=blocks(stored).find(b=>b.id===galleryId);assert.notEqual(gallery.items[1].media_id,oldMedia);assert.equal(gallery.items[1].id,originalIds[0]);
      const swappedMedia=gallery.items[1].media_id;
      await undo();assert.equal(await moved.evaluate(n=>n===galleryRetained),true);stored=await save();assert.equal(blocks(stored).find(b=>b.id===galleryId).items[1].media_id,oldMedia);
      // A newly disabled Save can blur to body; use the visible history command,
      // not a root-scoped shortcut with no focused editor descendant.
      if(width<600)await p.locator('.pages-v2-overflow > summary').click();
      await p.getByRole('button',{name:'Refazer',exact:true}).click();
      if(width<600)await p.locator('.pages-v2-overflow > summary').click();
      stored=await save();assert.equal(blocks(stored).find(b=>b.id===galleryId).items[1].media_id,swappedMedia);
      await moved.getByRole('button',{name:'Remover item',exact:true}).click();assert.equal(await items.count(),2);
      stored=await save();assert.deepEqual(blocks(stored).find(b=>b.id===galleryId).items.map(i=>i.id),[originalIds[1],originalIds[2]]);
      await undo();assert.equal(await items.count(),3);stored=await save();assert.deepEqual(blocks(stored).find(b=>b.id===galleryId).items.map(i=>i.id),[originalIds[1],originalIds[0],originalIds[2]]);
      await tab('style');assert.equal(await inspector.getByRole('combobox',{name:'Tamanho',exact:true}).isDisabled(),true);
      await tab('content');await items.last().getByRole('heading').scrollIntoViewIfNeeded();await p.screenshot({path:join(output,`${width}-gallery.png`)});
      assert.equal(await p.evaluate(()=>inspectorViews.every(([n,v])=>n.isConnected&&n.pmViewDesc===v)),true);
      await pagesEditorInsert(p,'Adicionar botão');await tab('content');
      await inspector.getByRole('combobox',{name:'Tipo de destino',exact:true}).selectOption('download');
      await inspector.getByRole('combobox',{name:'Arquivo da página',exact:true}).selectOption(gallery.items[0].media_id);
      await inspector.getByRole('textbox',{name:'Nome do arquivo para download',exact:true}).fill(`${'download'.repeat(14)}.webp`);
      const gaps=await inspector.locator('.pages-destination-download').evaluate(n=>[...n.children].map((c,i,a)=>i?c.getBoundingClientRect().top-a[i-1].getBoundingClientRect().bottom:16));assert.ok(gaps.every(g=>g>=16));
      await inspector.getByRole('button',{name:'Aplicar destino',exact:true}).click();stored=await save();assert.equal(blocks(stored).find(b=>b.type==='button').action.type,'download');
      await tab('style');assert.equal(await inspector.getByRole('combobox',{name:'Estilo do botão',exact:true}).isVisible(),true);
      await tab('content');await p.screenshot({path:join(output,`${width}-destination.png`)});
      await p.reload();await pagesBrowserReady(p);await p.locator(`[data-block-id="${galleryId}"] .pages-select-block`).click();await tab('content');assert.equal(await items.count(),3);assert.equal(await items.nth(1).getByRole('textbox',{name:'Legenda',exact:true}).inputValue(),'Caption 1');
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'long metadata cannot overflow page width');
      const read=await pagesBrowserContext(browser,{width,errors,uid:'publisher',touch:width<1100});
      try{await read.page.goto(`${h.origin}/page-editor.html?id=${id}`);await pagesBrowserReady(read.page);await read.page.locator('.pages-document').waitFor();assert.equal(await read.page.locator('.ProseMirror').count(),0);assert.equal(await read.page.getByRole('button',{name:/Salvar rascunho/}).count(),0);assert.equal(await read.page.getByRole('button',{name:'Remover item',exact:true}).count(),0);await pagesEditorPageProperties(read.page);assert.equal(await read.page.getByRole('textbox',{name:'Título',exact:true}).isDisabled(),true);await read.page.screenshot({path:join(output,`${width}-readonly.png`)});}finally{await read.context.close();}
      assert.deepEqual(await sql(),stored,'read-only visit cannot mutate saved draft');
      results.push({ width, grouping: failures.filter(f => f.startsWith(`${width}:`)), explicitSaves:writes.length, privateCanvasAndInspectorGETs:privateRequests.length,
        galleryId,itemOrder:blocks(stored).find(b=>b.id===galleryId).items.map(i=>i.id),legacyPresetSchema:2,savedSchema:stored.schema_version,
        sqlOrderRemoveSwapUndo:true,retainedViews:true,retainedOrderFocus:true,publisherReadonly:true,implicitWrites:false });
    } catch(error){await p.screenshot({path:join(output,`${width}-failure.png`)});await writeFile(join(output,`${width}-failure.html`),await p.content());throw error;} finally { await context.close(); }
  }
  await writeFile(join(output, 'inspector-failures.json'), JSON.stringify(failures, null, 2));
  assert.deepEqual(failures, []);
}
