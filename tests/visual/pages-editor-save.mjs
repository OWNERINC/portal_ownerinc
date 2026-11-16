// Real local routes/SQL; only transport delay/failure is injected, never a fake ACK.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorPageProperties } from '../helpers/pages-browser.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export async function checkSave({ h, browser, output, results, errors }) {
  const failures = [];
  for (const width of [320, 390, 768, 1366]) {
    const created = await h.api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() }, 'super');
    assert.equal(created.status, 201);
    const id = created.body.id, path = `/api/pages/${id}/draft`;
    const sql = async () => (await h.db.query(`SELECT p.version, r.document,
      (SELECT count(*)::int FROM page_revisions WHERE page_id=p.id) AS revisions
      FROM pages p JOIN page_revisions r ON r.id=p.draft_revision_id WHERE p.id=$1`, [id])).rows[0];
    const { page: p, context } = await pagesBrowserContext(browser, { width, errors, touch: width < 1100 });
    p.setDefaultTimeout(5000);
    let release;
    try {
      await p.goto(`${h.origin}/page-editor.html?id=${id}`); await pagesBrowserReady(p);
      await p.locator('.ProseMirror').first().waitFor();
      await p.evaluate(() => { globalThis.__saveViews = [...document.querySelectorAll('.ProseMirror')].map(node => ({ node, view: node.pmViewDesc })); });
      const status = p.locator('.pages-save-status'), save = p.locator('#page-editor-root > header .pages-action-button, .pages-secondary-actions .pages-action-button');
      await save.evaluate(n => { globalThis.__saveAction = n; globalThis.__saveActionParent = n.parentElement; });
      const publish = p.getByRole('button', { name: 'Publicar', exact: true });
      const before = await sql();
      await pagesEditorPageProperties(p);
      const title = p.getByRole('textbox', { name: 'Título', exact: true });
      await title.fill(`Título alterado ${width}`);
      await p.screenshot({ path: join(output, `${width}-dirty.png`) });
      assert.equal(await p.getByRole('button', { name: 'Salvar rascunho', exact: true }).isVisible(), true, `${width}: Save reachable with sheet open, without More actions`);
      const reachable = async () => {
        for (const control of [save, publish, status]) {
          const r = await control.boundingBox();
          assert.ok(r && r.width > 10 && r.height >= 16 && r.x >= 0 && r.x + r.width <= width && r.y >= 0 && r.y + r.height <= p.viewportSize().height, `${width}: visible chrome bounds`);
          assert.equal(await control.evaluate(n => { const r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'chrome not covered by sheet');
        }
        for (const control of [save, publish]) { const r = await control.boundingBox(); assert.ok(r.height >= 44 && r.width >= 44); }
      };
      await reachable();
      const dirtySaveRect = await save.boundingBox();
      assert.match(await status.innerText(), /Alterações não salvas/);
      assert.equal(await publish.isDisabled(), true);
      const disabledColor = await publish.evaluate(n => getComputedStyle(n).backgroundColor);
      assert.notEqual(disabledColor, 'rgb(42, 39, 94)'); await publish.hover({ force: true });
      assert.equal(await publish.evaluate(n => getComputedStyle(n).backgroundColor), disabledColor);
      assert.match(await p.locator('.pages-publish-reason').innerText(), /Salve o rascunho/);
      assert.deepEqual(await sql(), before, 'title edit is not autosaved');

      let mode = 'held', calls = [], entered = deferred();
      release = deferred();
      await p.route(`**${path}`, async route => {
        calls.push(route.request().postDataJSON()); entered.resolve();
        if (mode === '503') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Falha sintética de transporte' }) });
        if (mode === 'held') await release.promise;
        const response = await route.fetch();
        if (mode === 'lost') { assert.equal(response.status(), 200); return route.abort('failed'); }
        return route.fulfill({ response });
      });
      await save.click(); await entered.promise;
      await p.locator('#page-editor-root[data-save-state=saving]').waitFor();
      assert.match(await status.innerText(), /Salvando/); assert.equal(await save.isDisabled(), true);
      await p.screenshot({ path: join(output, `${width}-busy.png`) });
      await reachable(); await p.keyboard.press('Control+s'); await save.evaluate(n => n.click());
      assert.equal(calls.length, 1, 'double activation and Mod+S cannot send twice');
      await title.fill(`Mais recente ${width}`);
      release.resolve(); await p.locator('#page-editor-root[data-save-state=dirty]').waitFor();
      assert.match(await status.innerText(), /Alterações não salvas/);
      assert.equal(await save.getAttribute('data-preset'), 'secondary', 'old ACK must not confirm newer edits');
      assert.equal((await sql()).document.metadata.title, `Título alterado ${width}`);
      assert.equal(await title.inputValue(), `Mais recente ${width}`);
      mode = 'normal'; await save.click(); await p.locator('#page-editor-root[data-save-state=saved]').waitFor();
      assert.equal((await sql()).document.metadata.title, `Mais recente ${width}`);
      assert.match(await status.innerText(), /Rascunho salvo/); await reachable();
      const savedSaveRect = await save.boundingBox();
      assert.equal(savedSaveRect.x, dirtySaveRect.x, 'ACK does not move Save horizontally');
      assert.equal(savedSaveRect.y, dirtySaveRect.y, 'ACK does not move the action row vertically');
      assert.equal(savedSaveRect.width, dirtySaveRect.width, 'confirmed label retains the same action slot');
      if (width < 1100) {
        await p.locator('.pages-v2-inspector').evaluate(n => { n.scrollTop = n.scrollHeight; });
        await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await reachable();
        await title.scrollIntoViewIfNeeded();
      }
      await p.screenshot({ path: join(output, `${width}-saved.png`) });

      mode = '503'; await title.fill(`503 ${width}`); await save.click();
      await p.locator('#page-editor-root[data-save-state=failure]').waitFor();
      assert.match(await status.innerText(), /não confirmado/i); const failedPayload = calls.at(-1);
      await title.fill(`Após falha ${width}`); mode = 'normal'; await save.click();
      await p.locator('#page-editor-root[data-save-state=dirty]').waitFor();
      assert.deepEqual(calls.at(-1), failedPayload); assert.equal((await sql()).document.metadata.title, `503 ${width}`);
      await save.click(); await p.locator('#page-editor-root[data-save-state=saved]').waitFor();

      mode = 'lost'; await title.fill(`ACK perdido ${width}`); const preLost = await sql();
      await save.click(); await p.locator('#page-editor-root[data-save-state=failure]').waitFor();
      const committed = await sql(), lostPayload = calls.at(-1);
      assert.equal(committed.revisions, preLost.revisions + 1); assert.equal(committed.document.metadata.title, `ACK perdido ${width}`);
      assert.match(await status.innerText(), /não confirmado/i); await reachable();
      await p.screenshot({ path: join(output, `${width}-lost-ack.png`) });
      if (width < 600) {
        await p.setViewportSize({ width, height: 480 });
        await title.focus(); await title.scrollIntoViewIfNeeded(); await reachable();
        assert.equal(await title.evaluate(n => { const r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'focused field is not covered in a short viewport');
        await p.screenshot({ path: join(output, `${width}-short-viewport.png`) });
        await p.setViewportSize({ width, height: 840 });
      }
      await title.fill(`Após COMMIT ${width}`); mode = 'normal'; await save.click();
      await p.locator('#page-editor-root[data-save-state=dirty]').waitFor();
      assert.deepEqual(calls.at(-1), lostPayload); assert.deepEqual(await sql(), committed, 'replay creates no revision');
      await title.focus(); await p.keyboard.press('Control+s'); await p.locator('#page-editor-root[data-save-state=saved]').waitFor();
      assert.equal((await sql()).document.metadata.title, `Após COMMIT ${width}`);
      const remote = (await h.api('get', `/${id}/workspace`, undefined, 'super')).body;
      remote.draft.document.metadata.title = `Concorrente ${width}`;
      assert.equal((await h.api('put', `/${id}/draft`, { expected_version: remote.version, client_mutation_id: randomUUID(), document: remote.draft.document }, 'super')).status, 200);
      await title.fill(`Local em conflito ${width}`); await save.click();
      await p.locator('#page-editor-root[data-save-state=conflict]').waitFor();
      assert.match(await status.innerText(), /Conflito/); assert.equal(await save.isDisabled(), true); assert.equal(await publish.isDisabled(), true);
      assert.equal(await title.inputValue(), `Local em conflito ${width}`); assert.equal((await sql()).document.metadata.title, `Concorrente ${width}`);
      await reachable(); await p.screenshot({ path: join(output, `${width}-conflict.png`) });
      await p.setViewportSize({ width: width < 1100 ? 1366 : 390, height: 840 });
      assert.equal(await p.evaluate(() => __saveAction.isConnected && __saveAction.parentElement === __saveActionParent), true, 'breakpoints retain the same Save node and parent');
      assert.equal(await p.evaluate(() => globalThis.__saveViews.every(({ node, view }) => node.isConnected && node.pmViewDesc === view)), true);
      results.push({ width, passed: true, dirtySaveRect, savedSaveRect, calls: calls.length, committedRevisions: committed.revisions, lostMutation: lostPayload.client_mutation_id });
    } catch (error) {
      failures.push(error); results.push({ width, passed: false, error: error.message });
      await p.screenshot({ path: join(output, `${width}-failure.png`) });
    } finally { release?.resolve(); await context.close(); }
  }
  assert.equal(failures.length, 0, failures.map(e => e.stack).join('\n'));
  // Separate real identities: author without publication, publisher without authorship.
  const own = await h.api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() }, 'author');
  assert.equal(own.status, 201);
  for (const uid of ['author', 'publisher']) {
    const { page: p, context } = await pagesBrowserContext(browser, { uid, width: 390, errors, touch: true });
    try {
      await p.goto(`${h.origin}/page-editor.html?id=${own.body.id}`); await pagesBrowserReady(p);
      await p.locator('.pages-v2-header').waitFor(); await pagesEditorPageProperties(p);
      const title = p.getByRole('textbox', { name: 'Título', exact: true });
      if (uid === 'author') {
        await title.fill('Autor sem publicação'); assert.equal(await p.getByRole('button', { name: 'Salvar rascunho', exact: true }).isEnabled(), true);
        assert.equal(await p.getByRole('button', { name: 'Publicar', exact: true }).count(), 0);
      } else {
        assert.equal(await title.isDisabled(), true); assert.equal(await p.locator('.pages-action-button').count(), 0);
        const w = (await h.api('get', `/${own.body.id}/workspace`, undefined, uid)).body;
        const payload = { expected_version: w.version, client_mutation_id: randomUUID(), document: w.draft.document };
        assert.equal((await h.api('put', `/${own.body.id}/draft`, payload, uid)).status, 403);
        assert.equal((await h.api('put', `/${own.body.id}/draft`, payload, 'other')).status, 403);
      }
      await p.screenshot({ path: join(output, `390-${uid}-permissions.png`) }); results.push({ uid, permissions: true });
    } finally { await context.close(); }
  }
}
