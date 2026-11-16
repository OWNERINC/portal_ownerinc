// Local synthetic integration only. Outbound traffic is denied by pagesBrowserContext.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createPagesDatabaseHarness } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady } from '../helpers/pages-browser.mjs';
import { checkStructure } from './pages-editor-structure.mjs';
import { checkSave } from './pages-editor-save.mjs';
import { checkReview } from './pages-editor-review-controls.mjs';
import { checkOverlays } from './pages-editor-overlays.mjs';

const scenario = process.argv[2] || 'menus';
assert.ok(['menus', 'structure', 'save', 'review', 'overlays'].includes(scenario));
assert.ok(process.env.PAGES_CONTROLS_OUTPUT, 'Set a new evidence directory');
const output = resolve(process.env.PAGES_CONTROLS_OUTPUT);
await mkdir(output, { recursive: false });
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH));
const require = createRequire(resolve('api/package.json'));
const h = await createPagesDatabaseHarness({ v3WritesEnabled: true });
const results = [], errors = [];
let browser;
try {
  h.app.use(require('express').static(resolve('public')));
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  if (scenario === 'structure') await checkStructure({ h, browser, output, results, errors });
  if (scenario === 'save') await checkSave({ h, browser, output, results, errors });
  if (scenario === 'review') await checkReview({ h, browser, output, results, errors });
  if (scenario === 'overlays') await checkOverlays({ h, browser, output, results, errors });
  for (const width of scenario === 'menus' ? [1366, 390, 320, 768] : []) {
    const created = await h.api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() }, 'super');
    assert.equal(created.status, 201);
    const { page: p, context } = await pagesBrowserContext(browser, { width, errors, touch: width < 1100 });
    p.setDefaultTimeout(5000);
    try {
      await p.goto(`${h.origin}/page-editor.html?id=${created.body.id}`); await pagesBrowserReady(p);
      const editor = p.locator('.ProseMirror').first(); await editor.waitFor();
      await p.evaluate(() => { globalThis.__retainedEditor = document.querySelector('.ProseMirror'); });
      await editor.click(); await p.keyboard.type('Menu regression');
      const original = await editor.innerText();
      if (width < 1100) await p.locator('[data-sheet-tab=style]').click();
      const more = p.locator('.pages-format-more');
      await more.locator('summary').click();
      const list = p.getByRole('button', { name: 'Lista numerada', exact: true });
      const rect = await list.boundingBox();
      await p.screenshot({ path: join(output, `${width}-text-menu.png`) });
      results.push({ width, rect });
      assert.ok(rect.width >= 100, `menus ${width}: textual action width ${rect.width}`);
      assert.ok(rect.height >= 44, `menus ${width}: target height`);
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width, 'viewport bounds');
      await p.keyboard.press('Escape'); assert.equal(await more.evaluate(n => n.open), false);
      assert.equal(await more.locator('summary').evaluate(n => n === document.activeElement), true);
      await more.locator('summary').click(); await list.click(); assert.equal(await editor.locator('ol').count(), 1);
      if (width < 1100) await p.locator('[data-sheet-tab=style]').click();
      if (!await more.evaluate(n => n.open)) await more.locator('summary').click();
      await p.getByRole('button', { name: 'Remover lista', exact: true }).click();
      assert.equal(await editor.locator('ol').count(), 0); assert.equal(await editor.innerText(), original);
      if (width < 1100) await p.locator('[data-sheet-tab=style]').click();
      if (!await more.evaluate(n => n.open)) await more.locator('summary').click();
      await p.getByRole('button', { name: 'Desfazer texto', exact: true }).click();
      assert.equal(await editor.locator('ol').count(), 1);
      if (width < 1100) await p.locator('[data-sheet-tab=style]').click();
      if (!await more.evaluate(n => n.open)) await more.locator('summary').click();
      await p.getByRole('button', { name: 'Remover lista', exact: true }).click();
      if (width < 1100) await p.locator('[data-sheet-tab=style]').click();
      if (!await more.evaluate(n => n.open)) await more.locator('summary').click();
      await p.getByRole('button', { name: 'Lista', exact: true }).click();
      assert.equal(await editor.locator('ul').count(), 1);
      if (width < 1100) await p.locator('[data-sheet-tab=style]').click();
      if (!await more.evaluate(n => n.open)) await more.locator('summary').click();
      const preview = p.locator('.pages-v2-preview-menu');
      await preview.locator('summary').click(); assert.equal(await more.evaluate(n => n.open), false);
      const previewBox = await preview.locator('.pages-preview-tools').boundingBox();
      assert.ok(previewBox.x >= 0 && previewBox.x + previewBox.width <= width, 'preview viewport bounds');
      await p.screenshot({ path: join(output, `${width}-preview-menu.png`) });
      if (width < 600) {
        const actions = p.locator('.pages-v2-overflow'); await actions.locator('summary').click();
        assert.equal(await preview.evaluate(n => n.open), false);
        await p.screenshot({ path: join(output, `${width}-actions-menu.png`) });
        await p.keyboard.press('Escape'); assert.equal(await actions.evaluate(n => n.open), false);
      } else { await p.keyboard.press('Escape'); assert.equal(await preview.evaluate(n => n.open), false); }
      await preview.locator('summary').click();
      await p.locator('[data-document-name]').click(); assert.equal(await preview.evaluate(n => n.open), false);
      await p.setViewportSize({ width: width === 1366 ? 768 : 1366, height: 900 });
      assert.equal(await p.evaluate(() => globalThis.__retainedEditor === document.querySelector('.ProseMirror')), true);
      results.at(-1).passed = true;
    } catch (error) {
      await p.screenshot({ path: join(output, `${width}-failure.png`) });
      await writeFile(join(output, `${width}-failure.html`), await p.content());
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(join(output, `${scenario}.json`), JSON.stringify({ results, errors }, null, 2));
  await browser?.close(); await h.close();
}
