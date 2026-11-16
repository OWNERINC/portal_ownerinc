import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pagesBrowserContext, pagesBrowserReady } from '../helpers/pages-browser.mjs';

export async function checkReview({ h, browser, output, results, errors }) {
  assert.ok(process.env.AXE_MODULE_PATH,'Set external AXE_MODULE_PATH for review accessibility checks');
  const {default:AxeBuilder}=await import(pathToFileURL(process.env.AXE_MODULE_PATH));
  const ready=p=>p.waitForFunction(()=>document.querySelector('.pages-review-checks input')?.disabled===false);
  for(let i=0;i<24;i++)await h.db.query('INSERT INTO job_titles (id,name) VALUES ($1,$2)',[randomUUID(),`Cargo adicional sintético ${i+1}`]);
  for (const width of [320, 390, 768, 1366]) {
    const created = await h.api('post', '', { template_id: 'guia-interno', client_mutation_id: randomUUID() }, 'super');
    assert.equal(created.status, 201);
    const { page: p, context } = await pagesBrowserContext(browser, { width, errors, touch: width < 1100 });
    p.setDefaultTimeout(5000);
    try {
      await context.route('**/pages/editor.js',async route=>{
        const source=await readFile(new URL('../../public/pages/editor.js',import.meta.url),'utf8');
        await route.fulfill({contentType:'text/javascript',body:source.replace('  void load();\n}', '  globalThis.__issueTest=()=>({state,update});\n  void load();\n}')});
      });
      await p.goto(`${h.origin}/page-editor.html?id=${created.body.id}`); await pagesBrowserReady(p);
      await p.locator('.ProseMirror').first().waitFor();
      await p.evaluate(()=>{globalThis.__issueViews=[...document.querySelectorAll('.ProseMirror')].map(node=>({node,view:node.pmViewDesc}));});
      let posts=0;p.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/publish'))posts++;});
      const sql=async()=>(await h.db.query('SELECT p.version,r.document,p.published_revision_id FROM pages p JOIN page_revisions r ON r.id=p.draft_revision_id WHERE p.id=$1',[created.body.id])).rows[0];
      const before=await sql();
      await p.getByRole('button', { name: 'Publicar', exact: true }).click();
      const dialog = p.locator('.pages-publication-dialog'); await dialog.waitFor();
      await ready(p);
      await p.screenshot({ path: join(output, `${width}-issues.png`) });
      assert.ok(await dialog.locator('[data-publication-issue]:visible').count() > 0, 'publication issues must be visible, not only in tooltip');
      assert.equal(await dialog.getByRole('button',{name:'Publicar página',exact:true}).isDisabled(),true);
      assert.match(await dialog.innerText(),/Conferência pessoal \(opcional\)/);
      assert.doesNotMatch(await dialog.innerText(),/revisado pelo responsável/);
      const bounds=await dialog.boundingBox();assert.ok(bounds.x>=16&&bounds.x+bounds.width<=width-16&&bounds.y>=16);
      // Long audience scroll is internal; header and essential footer stay reachable.
      await dialog.getByRole('button',{name:/Visibilidade/}).click();
      const checkboxRect=await dialog.getByRole('checkbox',{name:'Cargo sintético A',exact:true}).boundingBox();
      assert.ok(checkboxRect.width>=18&&checkboxRect.width<=20&&checkboxRect.height>=18&&checkboxRect.height<=20,'checkbox indicator stays 18–20px inside a 44px row');
      const audit=await new AxeBuilder({page:p}).include('.pages-publication-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      assert.deepEqual(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
      await dialog.getByRole('checkbox',{name:'Cargo adicional sintético 24',exact:true}).scrollIntoViewIfNeeded();
      for(const name of ['Fechar revisão','Voltar à edição','Publicar página']){
        const action=dialog.getByRole('button',{name,exact:true}),r=await action.boundingBox();
        assert.ok(r.y>=16&&r.y+r.height<=p.viewportSize().height-16&&r.height>=44);
        assert.equal(await action.evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'retained header/footer action is not covered');
      }
      await p.screenshot({path:join(output,`${width}-long-audience.png`)});
      await dialog.locator('[data-publication-issue="audience_required"] button').click();
      assert.equal(await dialog.count(),0);
      assert.equal(await p.locator('.pages-audience').evaluate(n=>n.contains(document.activeElement)),true);
      await p.getByRole('checkbox',{name:'Cargo sintético A',exact:true}).check();
      assert.deepEqual(await sql(),before,'correction navigation and edits do not autosave');
      await p.getByRole('button',{name:'Salvar rascunho',exact:true}).click();
      await p.locator('#page-editor-root[data-save-state=saved]').waitFor();
      const saved=await sql();assert.equal(saved.version,before.version+1);assert.equal(saved.document.metadata.audience.job_title_ids.length,1);
      await p.getByRole('button',{name:'Publicar',exact:true}).click();
      await ready(p);
      const faqIssue=dialog.locator('[data-publication-issue="faq_answer_required"]').first();
      await faqIssue.getByRole('button').focus();await p.keyboard.press('Enter');
      assert.equal(await dialog.count(),0);
      assert.equal(await p.evaluate(()=>document.activeElement?.classList.contains('ProseMirror')),true,'FAQ answer receives keyboard focus');
      await p.keyboard.type(`Resposta corrigida ${width}`);
      await p.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await p.locator('#page-editor-root[data-save-state=saved]').waitFor();
      assert.ok(JSON.stringify((await sql()).document).includes(`Resposta corrigida ${width}`));
      await p.getByRole('button',{name:'Publicar',exact:true}).click();await ready(p);
      await dialog.locator('[data-publication-issue="media_accessibility_required"] button').click();
      assert.equal(await p.evaluate(()=>document.activeElement?.textContent),'Substituir arquivo','missing audio focuses safe replacement action without launching picker');
      await p.getByRole('textbox',{name:'Transcrição (obrigatória para publicar)',exact:true}).fill('Transcrição corrigida');
      await p.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await p.locator('#page-editor-root[data-save-state=saved]').waitFor();
      assert.ok(JSON.stringify((await sql()).document).includes('Transcrição corrigida'));
      assert.equal(await p.evaluate(()=>__issueViews.every(x=>x.node.isConnected&&x.node.pmViewDesc===x.view)),true,'all correction routes retain original EditorViews');
      await p.getByRole('button',{name:'Publicar',exact:true}).click();await ready(p);
      await dialog.getByRole('textbox',{name:'Título',exact:true}).fill('');
      await dialog.locator('[data-publication-issue="title_required"] button').click();
      assert.equal(await p.locator('.pages-metadata-title input').evaluate(n=>document.activeElement===n),true,'title issue opens current page properties');
      await p.locator('.pages-metadata-title input').fill(`Título corrigido ${width}`);
      await p.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await p.locator('#page-editor-root[data-save-state=saved]').waitFor();
      assert.equal((await sql()).document.metadata.title,`Título corrigido ${width}`);
      await p.getByRole('button',{name:'Publicar',exact:true}).click();await ready(p);
      await dialog.locator('[data-publication-issue="faq_answer_required"] button').first().evaluate(node=>{globalThis.__removedIssueAction=node;});
      await p.evaluate(()=>{const {state}=__issueTest();state.transact({closeGroup:true},doc=>{for(const s of doc.sections)for(const r of s.rows)for(const c of r.columns)c.blocks=c.blocks.filter(b=>b.type!=='faq');});globalThis.__removedIssueAction.click();});
      assert.equal(await dialog.isVisible(),true,'removed destination cannot close review or select another block');
      assert.match(await dialog.locator('.pages-review-feedback').innerText(),/não existe mais/);
      assert.equal(posts,0);assert.equal((await sql()).published_revision_id,null);
      // Removed FAQ views may disappear; every surviving original view is retained.
      assert.equal(await p.evaluate(()=>__issueViews.filter(x=>x.node.isConnected).every(x=>x.node.pmViewDesc===x.view)),true);
      await p.evaluate(()=>{const {state}=__issueTest();state.undo();state.transact({closeGroup:true},doc=>{for(const s of doc.sections)for(const r of s.rows)for(const c of r.columns)for(const b of c.blocks)if(b.type==='faq')b.items=[];});});
      await dialog.locator('[data-publication-issue="faq_empty"] button').click();
      assert.equal(await dialog.count(),0);
      assert.equal(await p.evaluate(()=>document.activeElement?.textContent),'Adicionar pergunta','empty FAQ focuses its authoring action, not the block drag handle');
      await p.keyboard.press('Enter');assert.equal(await p.getByRole('textbox',{name:'Pergunta',exact:true}).count(),1);
      assert.equal((await sql()).version,4,'navigation/add question is still not autosave');
      results.push({ width, bounds, savedVersion:(await sql()).version, posts, passed: true });
    } finally { await context.close(); }
  }
}
