import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorInsert } from '../helpers/pages-browser.mjs';

export async function checkTextVideo({ h, browser, output, results, errors }) {
  const failures = [];
  // Separate synthetic surface: never replaces an opened user document.
  h.app.get('/__task7-format', (_req, res) => res.type('html').send(`<!doctype html><div id="rich"></div><script type="module">
    import {createRichEditor} from '/pages/vendor/editor.js';
    const text = (type, value, level) => ({type,...(level?{attrs:{level}}:{}),...(value?{content:[{type:'text',text:value}]}:{})});
    const content={type:'doc',content:[text('heading','Heading',2),text('paragraph','Body'),{type:'bullet_list',content:[{type:'list_item',content:[text('paragraph','Nested')]}]},text('paragraph','')]};
    globalThis.formatAPI=createRichEditor({host:document.querySelector('#rich'),content,onChange(){}});
    globalThis.formatContent=content;
    document.documentElement.dataset.ready='true';
  </script>`));
  const synthetic = await pagesBrowserContext(browser, { width: 1366, errors });
  try {
    await synthetic.page.goto(h.origin + '/__task7-format');
    await synthetic.page.waitForFunction(() => !!globalThis.formatAPI);
    const apiEvidence = await synthetic.page.evaluate(() => {
      const api = formatAPI, content = formatContent, result = [];
      const probe = (from, to = from) => { api.sync(content, { from, to }); result.push(api.selectionFormat()); };
      probe(1); probe(10); probe(1,12); probe(18); probe(28);
      api.sync(content,{from:1,to:1}); api.heading(3); result.push(api.selectionFormat());
      api.undo(); result.push(api.selectionFormat()); api.redo(); result.push(api.selectionFormat());
      return result;
    });
    assert.deepEqual(apiEvidence, ['2','paragraph','mixed','paragraph','paragraph','3','2','3']);
    results.push({ scenario: 'exact selectionFormat API: heading, paragraph, mixed, nested list, empty paragraph, standalone undo/redo', apiEvidence });
  } finally { await synthetic.context.close(); }
  for (const width of [1366, 390]) {
    const created = await h.api('post', '', { template_id: 'guia-interno', client_mutation_id: randomUUID() }, 'super');
    assert.equal(created.status, 201);
    const { page: p, context } = await pagesBrowserContext(browser, { width, errors, touch: width < 1100 });
    const externalVideoRequests = [];
    p.on('request', request => { if (/youtube|youtu\.be|ytimg|googlevideo/.test(new URL(request.url()).hostname)) externalVideoRequests.push(request.url()); });
    try {
      await p.goto(`${h.origin}/page-editor.html?id=${created.body.id}`); await pagesBrowserReady(p);
      await p.locator('.ProseMirror h2').first().click();
      if (width < 1100) await p.locator('[data-sheet-tab=style]').click();
      const format = p.getByRole('combobox', { name: 'Formato do texto', exact: true });
      const actual = await format.inputValue();
      if (actual !== '2') failures.push(`${width}: H2 selection displays ${actual}, expected 2`);
      // Retain actual view descriptors, not just matching markup.
      await p.locator('.ProseMirror').evaluateAll(nodes => { globalThis.textVideoViews = nodes.map(node => [node, node.pmViewDesc]); });
      const showFormat = async () => { if (width < 1100) await p.locator('[data-sheet-tab=style]').click(); };
      const changeFormat = async value => { await format.selectOption(value); await showFormat(); };
      const heading = p.locator('.ProseMirror h2').first();
      const blockId = await heading.evaluate(n => n.closest('[data-block-id]').dataset.blockId);
      const host = p.locator(`[data-block-id="${blockId}"] .ProseMirror`);
      await changeFormat('3');
      assert.equal(await host.locator('h3').count(), 1);
      assert.equal(await format.inputValue(), '3');
      await changeFormat('paragraph');
      assert.equal(await format.inputValue(), 'paragraph');
      await p.keyboard.press('Control+z'); await showFormat();
      assert.equal(await format.inputValue(), '3', 'undo restores actual heading format');
      await p.keyboard.press('Control+z'); await showFormat();
      assert.equal(await format.inputValue(), '2');
      // Create two differently formatted textblocks using native PM keyboard input.
      await host.locator('h2').click(); await p.keyboard.press('End'); await p.keyboard.press('Enter');
      await p.keyboard.type('Selection paragraph'); await showFormat(); await changeFormat('paragraph');
      await host.locator('h2').click();
      const textblocks = await host.locator('h2,p').count();
      await p.keyboard.press('Control+Home'); await p.keyboard.press('Control+Shift+End');
      await showFormat();
      await p.waitForFunction(() => document.querySelector('[aria-label="Formato do texto"]')?.value === 'mixed');
      assert.equal(await format.locator('option[value=mixed]').isDisabled(), true);
      await p.screenshot({ path: join(output, `${width}-mixed-format.png`) });
      const mixedContent = await host.innerHTML();
      await format.dispatchEvent('change');
      assert.equal(await host.innerHTML(), mixedContent, 'mixed is never a mutation command');
      await showFormat(); await changeFormat('3');
      assert.equal(await host.locator('h3').count(), textblocks, 'mixed selection applies to all textblocks');
      await p.keyboard.press('Control+z'); await showFormat(); assert.equal(await format.inputValue(), 'mixed');
      // Another block and FAQ answer must resolve their own live editor.
      await p.locator(`[data-block-type=rich_text]:not([data-block-id="${blockId}"]) .ProseMirror p`).first().click(); await showFormat();
      await p.waitForFunction(() => document.querySelector('[aria-label="Formato do texto"]')?.value === 'paragraph');
      assert.equal(await format.inputValue(), 'paragraph');
      const faq = p.locator('[data-block-type=faq] [data-media-item-id]').first();
      await faq.locator('summary').click();
      const answer = faq.locator('.ProseMirror'); await answer.click(); await p.keyboard.type('Task seven FAQ answer'); await showFormat();
      await changeFormat('2'); assert.equal(await answer.locator('h2').count(), 1);
      await changeFormat('3'); assert.equal(await answer.locator('h3').count(), 1);
      await changeFormat('paragraph'); assert.equal(await answer.locator('h3').count(), 0);
      await p.keyboard.press('Control+z'); await showFormat(); assert.equal(await format.inputValue(), '3');
      // Real selection BEFORE link and color, retaining the FAQ item identity.
      await answer.click(); await p.keyboard.press('Home'); await p.keyboard.press('Shift+ArrowRight');
      if (width < 1100) await p.locator('[data-sheet-tab=content]').click();
      await p.getByRole('button', { name: 'Link', exact: true }).click();
      let task = p.getByRole('dialog', { name: 'Link no texto selecionado', exact: true });
      await task.getByRole('textbox').fill('https://example.com/task7'); await task.getByRole('button', { name: 'Aplicar link', exact: true }).click();
      assert.equal(await answer.locator('a[href="https://example.com/task7"]').count(), 1);
      await answer.click(); await p.keyboard.press('Home'); await p.keyboard.press('Shift+ArrowRight'); await showFormat();
      await p.getByRole('button', { name: 'Cor do texto selecionado', exact: true }).click();
      task = p.getByRole('dialog').last();
      await task.getByRole('textbox', { name: 'Cor hexadecimal', exact: true }).fill('#112233');
      await task.getByRole('button', { name: 'Aplicar cor', exact: true }).click();
      assert.equal(await answer.locator('[data-pages-text_color="#112233"]').count(), 1);
      await p.keyboard.press('Control+z'); await showFormat();
      assert.equal(await answer.locator('[data-pages-text_color="#112233"]').count(), 0);
      assert.equal(await p.evaluate(() => textVideoViews.every(([node, view]) => node.isConnected && node.pmViewDesc === view)), true, 'all PM views retained');
      await pagesEditorInsert(p, 'Adicionar vídeo');
      const d = p.getByRole('dialog', { name: 'Adicionar vídeo', exact: true });
      if (await d.getByRole('textbox', { name: 'URL do YouTube' }).isVisible()) failures.push(`${width}: private MP4 exposes YouTube URL`);
      await p.screenshot({ path: join(output, `${width}-private-video.png`) });
      assert.equal(await d.getByRole('button', { name: 'Escolher MP4', exact: true }).isVisible(), true);
      const chooserEvent = p.waitForEvent('filechooser');
      await d.getByRole('button', { name: 'Escolher MP4', exact: true }).click();
      await (await chooserEvent).setFiles([]); // Native cancellation, no upload/document mutation.
      assert.equal(await p.locator('[data-block-type=video]').count(), 0);
      await pagesEditorInsert(p, 'Adicionar vídeo');
      await d.getByRole('combobox', { name: 'Fonte do vídeo' }).selectOption('youtube');
      const url = d.getByRole('textbox', { name: 'URL do YouTube' });
      assert.equal(await url.isVisible(), true);
      await url.fill('https://example.com/not-youtube');
      await d.getByRole('button', { name: 'Inserir vídeo', exact: true }).click();
      assert.equal(await d.isVisible(), true); assert.equal(await url.getAttribute('aria-invalid'), 'true');
      assert.equal(await d.locator(`[id="${await url.getAttribute('aria-describedby')}"]`).getAttribute('role'), 'alert');
      await p.screenshot({ path: join(output, `${width}-youtube-error.png`) });
      await url.fill('https://youtu.be/dQw4w9WgXcQ');
      await d.getByRole('button', { name: 'Inserir vídeo', exact: true }).click();
      const video = p.locator('[data-block-type=video_embed]'); await video.waitFor();
      const originalVideoId = await video.getAttribute('data-block-id');
      assert.equal(await p.locator('iframe, img[src*="ytimg"]').count(), 0);
      await video.click();
      if (width < 1100) await p.locator('[data-sheet-tab=content]').click();
      await p.getByRole('button', { name: 'Trocar fonte do vídeo', exact: true }).click();
      const replace = p.getByRole('dialog', { name: 'Trocar fonte do vídeo', exact: true });
      await replace.getByRole('combobox', { name: 'Fonte do vídeo' }).selectOption('youtube');
      assert.equal(await replace.getByRole('button', { name: 'Aplicar fonte', exact: true }).isVisible(), true);
      await replace.getByRole('textbox', { name: 'URL do YouTube' }).fill('https://youtu.be/abcdefghijk');
      assert.equal(await video.count(), 1, 'changing source draft preserves block');
      await replace.getByRole('button', { name: 'Cancelar', exact: true }).click();
      assert.equal(await video.count(), 1, 'cancel preserves original source');
      assert.equal(await video.getAttribute('data-block-id'), originalVideoId, 'cancel preserves original block UUID');
      await pagesEditorInsert(p, 'Adicionar vídeo');
      await d.getByRole('button', { name: 'Cancelar', exact: true }).click();
      const stored = await h.api('get', `/${created.body.id}/workspace`, undefined, 'super');
      assert.equal(stored.body.version, 0, 'no autosave or implicit persisted upgrade');
      const saveResponse = p.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/pages/${created.body.id}/draft`);
      await p.getByRole('button', { name: /Salvar rascunho/ }).click();
      assert.equal((await saveResponse).status(), 200);
      await p.locator('#page-editor-root[data-save-state=saved]').waitFor();
      const saved = (await h.db.query('SELECT r.document FROM page_revisions r JOIN pages p ON p.draft_revision_id=r.id WHERE p.id=$1', [created.body.id])).rows[0].document;
      const savedVideo = saved.sections.flatMap(s=>s.rows.flatMap(r=>r.columns.flatMap(c=>c.blocks))).find(b=>b.id===originalVideoId);
      assert.equal(savedVideo.type, 'video_embed'); assert.equal(savedVideo.provider, 'youtube');
      assert.equal(savedVideo.video_id, 'dQw4w9WgXcQ', 'cancel preserves original source ID, not replacement draft');
      assert.deepEqual(externalVideoRequests, [], 'editor never requests external video/player/thumbnail');
      results.push({ width, format: actual, externalVideoRequests, retainedViews: true, noAutosave: true, cancelledSourceSQL: { blockId: originalVideoId, sourceId: savedVideo.video_id } });
    } catch (error) {
      const selection = await p.evaluate(() => ({ text: String(getSelection()),
        active: document.activeElement?.outerHTML.slice(0,500),
        formats: [...document.querySelectorAll('[aria-label="Formato do texto"]')].map(n => n.value) }));
      await writeFile(join(output, `${width}-selection.json`), JSON.stringify(selection, null, 2));
      await p.screenshot({ path: join(output, `${width}-failure.png`) });
      await writeFile(join(output, `${width}-failure.html`), await p.content());
      throw error;
    } finally { await context.close(); }
  }
  await writeFile(join(output, 'text-video-failures.json'), JSON.stringify(failures, null, 2));
  assert.deepEqual(failures, []);
}
