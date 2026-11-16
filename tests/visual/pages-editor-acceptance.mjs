// Supplemental acceptance: real local SQL fixtures are prepared BEFORE opening.
// No replacement of a live editor document, no golden/reference mutation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorMore, pagesEditorPageProperties, pagesEditorInsert } from '../helpers/pages-browser.mjs';

export async function checkAcceptance({ h, browser, output, results, errors }) {
  const { default: AxeBuilder } = await import(pathToFileURL(process.env.AXE_MODULE_PATH));
  const cargoIds = Array.from({length:60},()=>randomUUID());
  for (const [index,id] of cargoIds.entries()) await h.db.query('INSERT INTO job_titles(id,name) VALUES($1,$2)',[id,`Cargo de aceitação ${String(index).padStart(2,'0')} ${'nome longo '.repeat(8)}`]);
  for (const width of [1366,768,390]) {
    const created = await h.api('post','',{template_id:'comunicado',client_mutation_id:randomUUID()},'super');
    assert.equal(created.status,201);
    const id=created.body.id, initial=(await h.api('get',`/${id}/workspace`,undefined,'super')).body;
    initial.draft.document.sections[0].rows[0].columns[0].blocks[0].content={type:'doc',content:Array.from({length:30},(_,i)=>({type:'paragraph',content:[{type:'text',text:`Parágrafo ${i}. ${'Conteúdo longo legível com acentuação. '.repeat(12)}`}]}))};
    const prepared=await h.api('put',`/${id}/draft`,{expected_version:initial.version,document:initial.draft.document,client_mutation_id:randomUUID()},'super');
    assert.equal(prepared.status,200);
    const {page:p,context}=await pagesBrowserContext(browser,{width,errors,touch:width<1100});
    const audits=[];
    const audit=async(name,selector)=>{
      const report=await new AxeBuilder({page:p}).include(selector).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      audits.push({name,violations:report.violations,incomplete:report.incomplete,passes:report.passes.length});
      await writeFile(join(output,`${width}-axe.json`),JSON.stringify(audits,null,2));
      assert.deepEqual(report.violations,[],`${width}/${name}: open-state axe violations`);
    };
    try {
      await p.setViewportSize({width,height:768});
      await p.goto(`${h.origin}/page-editor.html?id=${id}`);await pagesBrowserReady(p);
      await p.locator('.ProseMirror').first().waitFor();
      await p.locator('.ProseMirror').evaluateAll(nodes=>{globalThis.acceptanceViews=nodes.map(n=>[n,n.pmViewDesc]);});
      // Keyboard-only activation, coordinated Escape and actual outside target focus.
      const preview=p.locator('.pages-v2-preview-menu > summary');
      await preview.focus();await p.keyboard.press('Enter');
      assert.equal(await preview.locator('..').evaluate(n=>n.open),true);
      await audit('preview-menu','.pages-v2-preview-menu');
      await p.screenshot({path:join(output,`${width}-keyboard-menu.png`)});
      await p.keyboard.press('Escape');assert.equal(await preview.evaluate(n=>n===document.activeElement),true);
      await preview.press('Enter');await p.locator('.ProseMirror').first().click();
      assert.equal(await preview.locator('..').evaluate(n=>n.open),false);
      assert.equal(await p.locator('.ProseMirror').first().evaluate(n=>n===document.activeElement),true,'outside click retains clicked target focus');
      if(width<1100)await p.locator('[data-sheet-tab=style]').click();
      const more=p.locator('.pages-format-more > summary');await more.focus();await more.press('Enter');
      await audit('text-menu','.pages-format-more');await p.keyboard.press('Escape');
      if(width<1100)await p.locator('[data-sheet-tab=content]').click();
      await p.getByRole('button',{name:'Link',exact:true}).click();
      await audit('link-task','dialog[open]');await p.keyboard.press('Escape');
      await pagesEditorInsert(p,'Adicionar vídeo');
      const video=p.getByRole('dialog',{name:'Adicionar vídeo',exact:true});
      await video.getByRole('combobox',{name:'Fonte do vídeo'}).selectOption('youtube');
      await video.getByRole('textbox',{name:'URL do YouTube'}).fill('https://example.com/invalid');
      await video.getByRole('button',{name:'Inserir vídeo',exact:true}).click();
      await audit('video-task-error','dialog[open]');await p.screenshot({path:join(output,`${width}-video-error.png`)});
      await video.getByRole('button',{name:'Cancelar',exact:true}).click();
      await pagesEditorMore(p);await p.getByRole('button',{name:'Inserir bloco',exact:true}).click();
      await audit('insert-panel','dialog[open]');await p.keyboard.press('Escape');
      await pagesEditorPageProperties(p);await p.locator('[data-audience-summary]').click();
      const audience=p.locator('.pages-audience');
      assert.equal(await audience.getByRole('checkbox').count(),62);
      const cargoText=await audience.locator('label').evaluateAll(nodes=>nodes.map(n=>{
        const box=n.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(n);
        const lines=[...range.getClientRects()].map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom}));
        return {text:n.textContent,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom},contained:lines.every(r=>r.left>=box.left-.5&&r.right<=box.right+.5&&r.top>=box.top-.5&&r.bottom<=box.bottom+.5)};
      }));
      await writeFile(join(output,`${width}-cargo-text.json`),JSON.stringify(cargoText,null,2));
      assert.ok(cargoText.every(n=>n.contained),'every long cargo text line fits its own row without overlap, including scrolled-away rows');
      const last=audience.getByRole('checkbox').last();await last.scrollIntoViewIfNeeded();await last.check();
      const bounds=await last.locator('..').evaluate(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:innerWidth};});
      assert.ok(bounds.left>=0&&bounds.right<=width+.5&&bounds.height>=44,'long cargo label is locally contained with a real touch row');
      assert.equal(await last.evaluate(n=>{const r=n.getBoundingClientRect();return n===document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);}),true,'last cargo not covered');
      await audit('many-cargos','.pages-audience');await p.screenshot({path:join(output,`${width}-many-cargos.png`)});
      if(width<1100)await p.getByRole('button',{name:'Concluir edição',exact:true}).click();
      await pagesEditorMore(p);await p.getByRole('button',{name:'Estilo da página',exact:true}).click();
      await audit('style-panel','dialog[open]');await p.screenshot({path:join(output,`${width}-style-open.png`)});await p.keyboard.press('Escape');
      // Real structure content is reused by the workspace. Count actual scrolling
      // callbacks, not a DOM clone or replacement EditorView.
      await p.evaluate(()=>{globalThis.acceptanceScrolls=0;globalThis.acceptanceScrollOriginal=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(...args){if(this.dataset.structureSection)acceptanceScrolls++;return acceptanceScrollOriginal.apply(this,args);};});
      if(width<1100){
        for(let i=0;i<3;i++){
          await p.locator('.pages-structure-toggle').click();
          const structure=p.getByRole('dialog',{name:'Estrutura da página',exact:true});
          await structure.waitFor();
          const link=structure.locator('[data-structure-section]').first();
          const delta=await link.evaluate(n=>{n.blur();const before=acceptanceScrolls;n.focus();return acceptanceScrolls-before;});
          assert.equal(delta,1,'reopened reused structure has one focus callback');
          await audit(`structure-${i}`,'dialog[open]');
          await p.keyboard.press('Escape');
        }
      }
      const beforeSQL=(await h.api('get',`/${id}/workspace`,undefined,'super')).body;
      assert.equal(beforeSQL.version,prepared.body.version,'opening panels did not save long legacy content');
      assert.equal(beforeSQL.draft.document.schema_version,1);
      assert.equal(await p.evaluate(()=>acceptanceViews.every(([n,v])=>n.isConnected&&n.pmViewDesc===v)),true);
      results.push({width,longParagraphs:30,cargos:62,keyboardAndOutsideFocus:true,structureReopens:width<1100?3:0,audits,legacySchema:1,implicitWrites:false,retainedViews:true});
    } catch(error) {
      await p.screenshot({path:join(output,`${width}-failure.png`)});await writeFile(join(output,`${width}-failure.html`),await p.content());throw error;
    } finally {await context.close();}
  }
}
