import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pagesBrowserContext, pagesBrowserReady } from '../helpers/pages-browser.mjs';

// Sheet controls are separate from the main toolbar target matrix.
export async function checkCompactTargets({ h, browser, output, results, errors }) {
  for (const width of [320, 390, 768]) {
    const created = await h.api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() }, 'super');
    assert.equal(created.status, 201);
    const { page: p, context } = await pagesBrowserContext(browser, { width, errors, touch: true });
    try {
      await p.goto(`${h.origin}/page-editor.html?id=${created.body.id}`); await pagesBrowserReady(p);
      const editor = p.locator('.ProseMirror').first();
      await editor.click(); await p.keyboard.type('Compact target selection');
      await p.keyboard.press('Home'); await p.keyboard.press('Shift+End');
      await editor.evaluate(n => { globalThis.compactView = [n, n.pmViewDesc]; });
      const inspector = p.locator('.pages-v2-inspector');
      for (const tab of ['content', 'style']) {
        await p.locator(`[data-sheet-tab=${tab}]`).click();
        for (const scroll of ['top', 'bottom', 'revealed']) {
          await inspector.evaluate((n, position) => { n.scrollTop = position === 'bottom' ? n.scrollHeight : 0; }, scroll);
          const controls = inspector.locator('.pages-v2-mobile-format button');
          if (tab === 'content' && scroll === 'revealed') await controls.first().scrollIntoViewIfNeeded();
          const measurements = await controls.evaluateAll(nodes => nodes.map(n => {
            const r = n.getBoundingClientRect(), visible = !!n.getClientRects().length;
            const points = [[r.left+1,r.top+r.height/2],[r.right-1,r.top+r.height/2],[r.left+r.width/2,r.top+1],[r.left+r.width/2,r.bottom-1]];
            const sheet = n.closest('.pages-v2-inspector').getBoundingClientRect();
            const inView = visible && r.top >= sheet.top && r.bottom <= sheet.bottom;
            return { name: n.getAttribute('aria-label') || n.textContent, visible, inView,
              x:r.x,y:r.y,width:r.width,height:r.height,
              edges: inView ? points.map(([x,y]) => n.contains(document.elementFromPoint(x,y))) : [] };
          }));
          results.push({ scenario: 'compact sheet targets', width, tab, scroll, measurements });
          for (const m of measurements.filter(m => m.visible)) {
            assert.ok(m.width >= 44 && m.height >= 44, `${width}/${tab}/${scroll}/${m.name}: actual ${m.width}x${m.height}, expected >=44x44`);
            assert.ok(m.x >= 0 && m.x+m.width <= width, 'compact target within viewport');
            assert.ok(m.edges.every(Boolean), `${width}/${tab}/${scroll}/${m.name}: edge collision/occlusion`);
          }
          for (let i=1;i<measurements.length;i++) {
            const a=measurements[i-1],b=measurements[i];
            if (a.visible && b.visible) assert.ok(a.x+a.width <= b.x || a.y+a.height <= b.y, 'nonoverlapping compact targets');
          }
          if (tab === 'content' && scroll === 'revealed') {
            assert.equal(measurements.length, 4);
            assert.ok(measurements.every(m => m.inView && m.edges.length === 4), 'all four controls fully exposed');
            await p.screenshot({ path: join(output, `${width}-compact-text-targets.png`) });
          }
        }
      }
      for (const [name, tag] of [['Negrito','strong'],['Itálico','em'],['Sublinhado','u']]) {
        await p.locator('[data-sheet-tab=content]').click();
        const button = inspector.getByRole('button', { name, exact:true });
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        await p.mouse.click(box.x + 1, box.y + box.height / 2);
        assert.equal(await editor.locator(tag).count(), 1, `${name} applies to retained selection`);
      }
      await p.locator('[data-sheet-tab=content]').click();
      const linkButton = inspector.getByRole('button', { name:'Link', exact:true });
      await linkButton.scrollIntoViewIfNeeded();
      const linkBox = await linkButton.boundingBox();
      await p.mouse.click(linkBox.x + linkBox.width - 1, linkBox.y + linkBox.height / 2);
      const link = p.getByRole('dialog', { name:'Link no texto selecionado', exact:true });
      await link.getByRole('textbox').fill('https://example.com/compact');
      await link.getByRole('button', { name:'Aplicar link', exact:true }).click();
      assert.equal(await editor.locator('a[href="https://example.com/compact"]').count(), 1);
      await p.locator('[data-sheet-tab=style]').click();
      const field = inspector.getByRole('textbox', { name:'Cor de fundo personalizada', exact:true });
      await field.scrollIntoViewIfNeeded();
      assert.equal(await field.evaluate(n => { const r=n.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2) === n; }), true, 'style field is not occluded');
      assert.equal(await p.evaluate(() => compactView[0].isConnected && compactView[0].pmViewDesc === compactView[1]), true);
      assert.equal((await h.api('get', `/${created.body.id}/workspace`, undefined, 'super')).body.version, 0, 'commands never autosave');
    } finally { await context.close(); }
  }
}
