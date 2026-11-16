// Incremental structure case: actual editor/template, local HTTP/SQL, no fixture substitution.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pagesBrowserContext, pagesBrowserReady } from '../helpers/pages-browser.mjs';

export async function checkStructure({ h, browser, output, results, errors }) {
  for (const width of [320, 390, 768, 1366]) {
    const created = await h.api('post', '', { template_id: 'guia-interno', client_mutation_id: randomUUID() }, 'super');
    assert.equal(created.status, 201);
    const id = created.body.id;
    const initial = (await h.api('get', `/${id}/workspace`, undefined, 'super')).body.draft.document;
    const ids = initial.sections.map(s => s.id), first = ids[0];
    const { page: p, context } = await pagesBrowserContext(browser, { width, errors, touch: width < 1100 });
    p.setDefaultTimeout(5000);
    try {
      await p.goto(`${h.origin}/page-editor.html?id=${id}`); await pagesBrowserReady(p);
      await p.locator('.ProseMirror').first().waitFor();
      await p.evaluate(() => { globalThis.__structureViews = [...document.querySelectorAll('.ProseMirror')].map(node => ({ node, view: node.pmViewDesc })); });
      const compact = width < 1100;
      const opener = p.getByRole('button', { name: 'Blocos', exact: true });
      if (compact) await opener.click();
      const panel = compact ? p.getByRole('dialog', { name: 'Estrutura da página' }) : p.locator('.pages-v2-structure');
      const organize = panel.getByRole('button', { name: 'Organizar estrutura', exact: true });
      await organize.click();
      const structure = compact ? panel.locator('.pages-v2-structure') : panel;
      assert.equal(await structure.getAttribute('data-organizing'), 'true');
      await organize.click(); assert.equal(await panel.locator('.pages-v2-section-position').first().isVisible(), false);
      await organize.click();
      const order = () => panel.locator('[data-section-sort-id]').evaluateAll(nodes => nodes.map(n => n.dataset.sectionSortId));
      const entry = sectionId => panel.locator(`[data-section-sort-id="${sectionId}"]`);
      const openPosition = async sectionId => { const details = entry(sectionId).locator('details'); if (!await details.evaluate(n => n.open)) await details.locator('summary').click(); };
      const rectangles = [];
      for (const section of initial.sections) {
        await openPosition(section.id);
        await p.screenshot({ path: join(output, `${width}-structure-${initial.sections.indexOf(section)}.png`) });
        const extent = await panel.evaluate(n => ({ width: n.clientWidth, scroll: n.scrollWidth }));
        assert.ok(extent.scroll <= extent.width, `structure ${width}: horizontal clipping ${extent.scroll} > ${extent.width}`);
        const controls = [...await entry(section.id).locator('button').all(), entry(section.id).locator('summary')];
        for (const control of controls) {
          await control.scrollIntoViewIfNeeded();
          const r = await control.boundingBox(), box = await panel.boundingBox();
          rectangles.push({ label: await control.getAttribute('aria-label'), ...r });
          assert.ok(r.x >= box.x && r.x + r.width <= box.x + box.width, `structure ${width}: clipped ${await control.getAttribute('aria-label')} x=${r.x} width=${r.width} panel=${box.x}+${box.width}`);
          assert.ok(r.width >= 44 && r.height >= 44, `structure ${width}: target ${await control.getAttribute('aria-label')} ${r.width}x${r.height}`);
          assert.ok(r.y >= box.y && r.y + r.height <= box.y + box.height, 'control scrolls inside usable panel');
          assert.equal(await control.evaluate(n => { const r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'neighboring targets do not intercept the control');
        }
      }
      await panel.evaluate(n => { n.scrollTop = 0; });
      if (!compact) await p.evaluate(() => window.scrollTo(0, 0));
      await p.screenshot({ path: join(output, `${width}-structure.png`) });
      assert.equal(await entry(first).getByRole('button', { name: 'Subir seção Capa', exact: true }).isDisabled(), true);
      assert.equal(await entry(ids.at(-1)).getByRole('button', { name: /^Descer seção/ }).isDisabled(), true);
      await entry(first).getByRole('button', { name: 'Descer seção Capa', exact: true }).click();
      assert.deepEqual(await order(), [ids[1], first, ...ids.slice(2)]);
      assert.equal(await entry(first).locator('[data-structure-section]').evaluate(n => n === document.activeElement), true);
      await openPosition(first); await entry(first).getByRole('button', { name: 'Subir seção Capa', exact: true }).click();
      assert.deepEqual(await order(), ids);
      await entry(first).locator('.pages-section-drag-handle').focus(); await p.keyboard.press('Alt+ArrowUp'); assert.deepEqual(await order(), ids);
      await p.keyboard.press('Alt+ArrowDown'); assert.deepEqual(await order(), [ids[1], first, ...ids.slice(2)]);
      await p.keyboard.press('Alt+ArrowUp'); assert.deepEqual(await order(), ids);
      const drag = async cancel => {
        await entry(first).scrollIntoViewIfNeeded();
        const a = await entry(first).locator('.pages-section-drag-handle').boundingBox(), b = await entry(ids[1]).boundingBox();
        await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await p.mouse.down();
        await p.mouse.move(a.x + a.width / 2 + 7, a.y + a.height / 2 + 7, { steps: 4 }); await p.waitForTimeout(120);
        await p.mouse.move(b.x + b.width / 2, b.y + b.height * .9, { steps: 24 }); await p.waitForTimeout(250);
        if (cancel) await p.keyboard.press('Escape');
        await p.mouse.up(); await p.waitForTimeout(100);
      };
      await drag(true); assert.deepEqual(await order(), ids);
      await drag(false); const moved = [ids[1], first, ...ids.slice(2)]; assert.deepEqual(await order(), moved);
      assert.equal(await entry(first).locator('[data-structure-section]').evaluate(n => n === document.activeElement), true);
      await entry(first).locator('[data-structure-section]').click();
      if (compact) assert.equal(await panel.count(), 0);
      assert.equal(await p.locator(`[data-structure-section="${first}"]`).getAttribute('aria-pressed'), 'true');
      const sqlDocument = async () => (await h.db.query('SELECT r.document FROM page_revisions r JOIN pages p ON p.draft_revision_id = r.id WHERE p.id = $1', [id])).rows[0].document;
      assert.deepEqual(await sqlDocument(), initial, 'reorder is not autosaved');
      const response = p.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/pages/${id}/draft`);
      await p.keyboard.press('Control+s'); assert.equal((await response).status(), 200);
      await p.locator('#page-editor-root[data-save-state=saved]').waitFor();
      assert.deepEqual((await sqlDocument()).sections.map(s => s.id), moved);
      await p.keyboard.press('Control+z');
      assert.deepEqual(await p.locator('[data-section-sort-id]').evaluateAll(nodes => nodes.map(n => n.dataset.sectionSortId)), ids);
      assert.deepEqual((await sqlDocument()).sections.map(s => s.id), moved, 'undo remains local');
      assert.equal(await p.evaluate(() => globalThis.__structureViews.every(({ node, view }) => node.isConnected && node.pmViewDesc === view)), true);
      if (compact) { await opener.click(); await p.keyboard.press('Escape'); assert.equal(await opener.evaluate(n => n === document.activeElement), true); }
      await p.setViewportSize({ width: compact ? 1366 : 390, height: 900 });
      assert.equal(await p.evaluate(() => globalThis.__structureViews.every(({ node, view }) => node.isConnected && node.pmViewDesc === view)), true);
      results.push({ width, passed: true, rectangles, savedOrder: moved, undoOrder: ids });
    } catch (error) {
      await p.screenshot({ path: join(output, `${width}-failure.png`) }); throw error;
    } finally { await context.close(); }
  }
}
