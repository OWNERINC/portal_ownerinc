import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorMore, pagesEditorInsert, pagesEditorPageProperties } from '../helpers/pages-browser.mjs';

export async function checkOverlays({ h, browser, output, results, errors }) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  for (const width of [1366, 390, 320, 768]) {
    const created = await h.api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() }, 'super');
    assert.equal(created.status, 201);
    const { page: p, context } = await pagesBrowserContext(browser, { width, errors, touch: width < 1100 });
    await p.setViewportSize({ width, height: 768 });
    try {
      await p.goto(`${h.origin}/page-editor.html?id=${created.body.id}`); await pagesBrowserReady(p);
      const rich = p.locator('.ProseMirror').first(); await rich.waitFor();
      await rich.evaluate(n => { globalThis.overlayView = { node: n, view: n.pmViewDesc }; });
      await rich.click(); await rich.press('Control+Home'); await rich.press('Shift+ArrowRight');
      const link = p.getByRole('button', { name: 'Link', exact: true });
      await link.click();
      let d = p.getByRole('dialog', { name: 'Link no texto selecionado', exact: true });
      const r = await d.boundingBox();
      check(r.x >= 16 && r.y >= 16 && r.y + r.height <= 752, `${width}: A05 link safe margins`);
      check(Math.abs(r.x + r.width / 2 - width / 2) < 2, `${width}: A05 link centered`);
      check(await d.getByRole('button', { name: 'Cancelar', exact: true }).evaluate(n => n === document.activeElement), `${width}: initial focus`);
      check(await d.getByRole('button', { name: 'Fechar Link no texto selecionado', exact: true }).count() === 1, `${width}: generic X`);
      await p.screenshot({ path: join(output, `${width}-link.png`) });
      await p.keyboard.press('Escape');
      check(await link.evaluate(n => n === document.activeElement), `${width}: restored focus`);
      await pagesEditorMore(p);
      await p.getByRole('button', { name: 'Inserir bloco', exact: true }).click();
      const insert = p.getByRole('dialog', { name: 'O que você quer adicionar?', exact: true });
      for (const control of await insert.locator('input:not([type=checkbox]),select').all()) {
        check((await control.boundingBox()).height >= 44, `${width}: insert textual field 44px`);
      }
      const closeInsert = await insert.getByRole('button', { name: 'Fechar O que você quer adicionar?', exact: true }).boundingBox();
      const heading = await insert.locator('.pages-panel-heading').boundingBox();
      check(closeInsert.y + closeInsert.height <= heading.y + heading.height, `${width}: insert X inside retained heading`);
      await p.keyboard.press('Escape');
      await pagesEditorInsert(p, 'Adicionar vídeo');
      d = p.getByRole('dialog', { name: 'Adicionar vídeo', exact: true });
      const source = d.getByRole('combobox', { name: 'Fonte do vídeo', exact: true });
      const sourceBox = await source.boundingBox();
      check(sourceBox.height >= 44, `${width}: A06 video source 44px (${sourceBox.height})`);
      if (width < 1100) check(await source.evaluate(n => parseFloat(getComputedStyle(n).fontSize)) >= 16, `${width}: video mobile 16px`);
      await p.screenshot({ path: join(output, `${width}-video.png`) });
      await d.getByRole('button', { name: 'Cancelar', exact: true }).click();
      assert.equal(await p.locator('[data-block-type=video]').count(), 0, 'cancel creates no video');
      await pagesEditorPageProperties(p);
      await p.locator('[data-audience-summary]').click();
      const audience = p.locator('.pages-audience input[type=checkbox]').first();
      if (await audience.count()) {
        const b = await audience.boundingBox();
        check(b.width >= 18 && b.width <= 20 && b.height >= 18 && b.height <= 20, `${width}: A09 checkbox indicator ${b.width}x${b.height}`);
        check((await audience.locator('..').boundingBox()).height >= 44, `${width}: checkbox row`);
      }
      if (width < 1100) await p.getByRole('button', { name: 'Concluir edição', exact: true }).click();
      const anchors = [];
      for (let i = 0; i < (width >= 1100 ? 12 : 1); i++) {
        await pagesEditorMore(p);
        const opener = p.getByRole('button', { name: 'Estilo da página', exact: true, includeHidden: true });
        await opener.click(); d = p.getByRole('dialog', { name: 'Estilo da página', exact: true });
        // Measure the first obtainable frame AND successive frames; no settling
        // sleep is allowed to erase a wrong first-frame anchor.
        const samples = await d.evaluate(async n => {
          const read = () => ({ x: n.getBoundingClientRect().x, left: n.style.getPropertyValue('--panel-left'), top: n.getBoundingClientRect().y });
          const samples = [read()];
          for (let j = 0; j < 3; j++) { await new Promise(requestAnimationFrame); samples.push(read()); }
          return samples;
        });
        const trigger = await opener.boundingBox(), box = await d.boundingBox();
        if (width >= 1100) for (const sample of samples) check(Math.abs(sample.x - Math.max(16, Math.min(trigger.x + 10, width - 416))) < 1, `${width}: anchor first/next frame ${JSON.stringify(sample)}`);
        anchors.push(samples);
        const apply = await d.locator('[data-apply-style]').boundingBox();
        check(apply.height >= 44, `${width}: A14 actual Apply 44px`);
        check(apply.y >= box.y && apply.y + apply.height <= box.y + box.height && apply.y + apply.height <= 752, `${width}: A14 persistent footer initially visible`);
        if (!i) {
          await p.screenshot({ path: join(output, `${width}-style.png`) });
          const hex = d.getByRole('textbox', { name: 'Cor personalizada de destaque', exact: true });
          await hex.fill('invalid');
          check(await d.locator('[data-apply-style]').isDisabled(), `${width}: invalid local draft blocks Apply`);
          const described = await hex.getAttribute('aria-describedby');
          check(!!described && await d.locator(`[id="${described}"]`).count() === 1, `${width}: field error associated`);
          await hex.fill('#112233');
          const focusFit = await hex.evaluate(n => { const r=n.getBoundingClientRect(),b=n.closest('.pages-panel-body')?.getBoundingClientRect(); return !b || (r.top>=b.top+4&&r.bottom<=b.bottom-4); });
          check(focusFit, `${width}: focused field and outline fit the body scroller`);
          await hex.dispatchEvent('compositionstart');
          await hex.dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229 });
          await d.getByRole('button', { name: 'Fechar Estilo da página', exact: true }).click();
          assert.equal(await d.count(), 1, 'Style IME Escape/X keeps the local draft');
          await hex.dispatchEvent('compositionend');
          await p.mouse.click(1, 1);
          assert.equal(await hex.inputValue(), '#112233', 'outside pointer keeps local draft');
          const retainedHex = await hex.elementHandle();
          if (width >= 1100) {
            await p.setViewportSize({ width: 768, height: 768 });
            await p.setViewportSize({ width: 1366, height: 768 });
            // setViewportSize acknowledges the emulation command, not the resize
            // event/paint. Measure its first rendering frame, not protocol timing.
            await p.evaluate(() => new Promise(requestAnimationFrame));
            const repositioned = await d.boundingBox(), triggerAfter = await opener.boundingBox();
            anchors.push({ breakpointRoundtrip: { panel: repositioned, trigger: triggerAfter, inline: await d.evaluate(n => n.style.cssText) } });
            check(Math.abs(repositioned.x - Math.max(16, Math.min(triggerAfter.x + 10, 1366 - 416))) < 1, `anchor repositions after breakpoint roundtrip: ${JSON.stringify(anchors.at(-1))}`);
          }
          assert.equal(await retainedHex.evaluate(n => n === document.querySelector('.pages-page-style-panel input')), true, 'panel controls retained through reflow');
          const hit = await d.locator('[data-apply-style]').evaluate(n => { const r = n.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === n; });
          check(hit, `${width}: footer remains reachable while body is scrolled`);
          await p.screenshot({ path: join(output, `${width}-style-scrolled.png`) });
          await retainedHex.dispose();
        }
        await p.keyboard.press('Escape');
      }
      assert.equal(await rich.evaluate(n => n === overlayView.node && n.pmViewDesc === overlayView.view), true);
      assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'), 'saved');
      await pagesEditorMore(p);
      for (const name of ['Dispositivo', 'Zoom', 'Modelo']) {
        const control = p.getByRole('combobox', { name, exact: true });
        const b = await control.boundingBox();
        check(b.height >= 44, `${width}: ${name} 44px outside/inside toolbar`);
        if (width < 1100) check(await control.evaluate(n => parseFloat(getComputedStyle(n).fontSize)) >= 16, `${width}: ${name} mobile 16px`);
      }
      if (width < 600) await p.keyboard.press('Escape');
      const workspace = await h.api('get', `/${created.body.id}/workspace`, undefined, 'super');
      assert.equal(workspace.body.version, 0, 'no implicit saves/upgrades');
      // Synthetic lifecycle form uses the real exported dialog on the real
      // workspace; it never substitutes the opened document or EditorViews.
      await p.evaluate(async () => {
        const { openPagesDialog } = await import('/pages/dialog.js');
        globalThis.overlayCleanups = [];
        globalThis.overlayActionCount = 0;
        globalThis.openLifecycle = () => {
          const content = document.createElement('div');
          const input = document.createElement('input'); input.setAttribute('aria-label', 'Lifecycle value');
          const label = document.createElement('label'); label.style.cssText = 'display:flex;align-items:center;min-height:44px';
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
          checkbox.style.cssText = 'width:20px;height:20px'; label.append(checkbox, 'Synthetic optional check');
          const long = document.createElement('p'); long.textContent = 'Long synthetic task content. '.repeat(120);
          content.append(input, label, long);
          return openPagesDialog({ page: { active: true, cleanup: fn => overlayCleanups.push(fn) }, title: 'Lifecycle test', content,
            confirmText: 'Run lifecycle', action: async () => { overlayActionCount++; await new Promise((resolve, reject) => { globalThis.overlayResolve = resolve; globalThis.overlayReject = reject; }); } });
        };
        openLifecycle();
      });
      d = p.getByRole('dialog', { name: 'Lifecycle test' });
      const taskLayout = await d.evaluate(n => {
        const box=n.getBoundingClientRect(),body=n.querySelector('.pages-dialog-body'),actions=n.querySelector('.pages-actions').getBoundingClientRect();
        return { scrolls:body ? body.scrollHeight>body.clientHeight : false, footerVisible:actions.top>=box.top&&actions.bottom<=box.bottom, safe:box.top>=16&&box.bottom<=innerHeight-16 };
      });
      check(taskLayout.scrolls && taskLayout.footerVisible && taskLayout.safe, `${width}: long task retains header/footer and safe scrolling ${JSON.stringify(taskLayout)}`);
      await p.screenshot({ path: join(output, `${width}-long-task.png`) });
      const cb = await d.getByRole('checkbox').boundingBox();
      check(cb.width >= 18 && cb.width <= 20 && cb.height >= 18 && cb.height <= 20, `${width}: A09 generic checkbox ${cb.width}x${cb.height}`);
      const x = d.getByRole('button', { name: 'Fechar Lifecycle test' });
      if (!await x.count()) {
        check(false, `${width}: lifecycle X missing; dependent X/busy/IME assertions unavailable`);
        results.push({ width, link: r, source: sourceBox, anchors });
        continue;
      }
      const input = d.getByRole('textbox', { name: 'Lifecycle value' });
      await input.focus(); await input.dispatchEvent('compositionstart');
      await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229 });
      await x.click(); await d.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await d.getByRole('button', { name: 'Run lifecycle' }).click();
      assert.equal(await p.evaluate(() => overlayActionCount), 0, 'IME cannot submit');
      assert.equal(await d.count(), 1, 'IME cannot dismiss');
      await input.dispatchEvent('compositionend');
      await d.getByRole('button', { name: 'Run lifecycle' }).click();
      assert.equal(await d.getAttribute('aria-busy'), 'true');
      assert.equal(await x.isDisabled(), true);
      assert.equal(await d.getByRole('button', { name: 'Cancelar', exact: true }).isDisabled(), true);
      await p.keyboard.press('Escape'); await p.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
      await x.dispatchEvent('click'); await d.getByRole('button', { name: 'Cancelar', exact: true }).dispatchEvent('click');
      assert.equal(await d.count(), 1, 'busy Escape/X/cancel/history cannot dismiss');
      await p.evaluate(() => overlayReject(new Error('Synthetic retry error')));
      await d.getByText('Synthetic retry error', { exact: true }).waitFor();
      assert.equal(await x.isEnabled(), true);
      await d.getByRole('button', { name: 'Run lifecycle' }).click();
      assert.equal(await p.evaluate(() => overlayActionCount), 2);
      await input.dispatchEvent('compositionstart');
      await p.evaluate(() => overlayResolve());
      assert.equal(await d.count(), 1, 'successful task waits for in-progress composition instead of discarding or wedging');
      await input.dispatchEvent('compositionend'); await d.waitFor({ state: 'detached' });
      await p.evaluate(() => openLifecycle());
      await d.getByRole('button', { name: 'Run lifecycle' }).click();
      await p.evaluate(() => overlayReject(new Error('Synthetic cancelable error')));
      await d.getByText('Synthetic cancelable error', { exact: true }).waitFor();
      await d.getByRole('button', { name: 'Cancelar', exact: true }).click(); await d.waitFor({ state: 'detached' });
      await p.evaluate(() => openLifecycle());
      await p.mouse.click(1, 1); assert.equal(await d.count(), 1, 'outside click does not discard form');
      await x.click(); await d.waitFor({ state: 'detached' });
      await p.evaluate(() => openLifecycle());
      await p.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate'))); await d.waitFor({ state: 'detached' });
      await p.evaluate(() => openLifecycle());
      await d.getByRole('button', { name: 'Run lifecycle' }).click();
      await p.evaluate(() => { overlayCleanups.forEach(fn => fn()); overlayResolve(); });
      await d.waitFor({ state: 'detached' });
      await p.goto(`${h.origin}/pages.html?manage=1`); await pagesBrowserReady(p);
      const create = p.getByRole('button', { name: 'Criar comunicado', exact: true });
      await create.click();
      const catalogDialog = p.getByRole('dialog', { name: 'Criar Comunicado', exact: true });
      const catalogBox = await catalogDialog.boundingBox();
      check(Math.abs(catalogBox.x + catalogBox.width / 2 - width / 2) < 2, `${width}: catalog modal remains centered`);
      await catalogDialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
      assert.equal(await create.evaluate(n => n === document.activeElement), true, 'catalog focus restored');
      results.push({ width, link: r, source: sourceBox, anchors });
    } finally { await context.close(); }
  }
  await writeFile(join(output, 'overlay-failures.json'), JSON.stringify(failures, null, 2));
  assert.deepEqual(failures, [], 'approved overlay contract');
}
