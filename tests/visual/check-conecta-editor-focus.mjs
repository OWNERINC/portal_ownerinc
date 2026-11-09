// Native keyboard regression for the editor chrome; fixtures only, no writes.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  for (const [width, height] of [[360, 874], [768, 874], [1366, 768]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:4178/autocard.html', { waitUntil: 'networkidle' });
    await page.locator('.template-tile[data-template="vaga"]').click();
    await page.locator('#fields input').first().focus();
    const inspectFocus = async () => {
      const state = await page.evaluate(() => {
        const focused = document.activeElement;
        if (!focused?.closest('.editor-panel')) return null;
        const box = focused.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { label: focused.id || focused.textContent.trim(), visible: box.top >= 0 && box.bottom <= innerHeight,
          unobscured: hit === focused || focused.contains(hit) };
      });
      if (state) {
        assert.equal(state.visible, true, `${width}: focused ${state.label} is outside viewport`);
        assert.equal(state.unobscured, true, `${width}: focused ${state.label} is covered`);
      }
      return state;
    };
    let steps = 0;
    while (steps++ < 40) {
      await inspectFocus();
      if (await page.locator('#saveButton').evaluate(node => node === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    assert.ok(steps < 40, 'Tab reaches the sticky save action');
    for (let step = 1; step < steps; step++) {
      await page.keyboard.press('Shift+Tab');
      await inspectFocus();
    }
    console.log(`PASS AutoCard native forward/reverse Tab ${width}x${height}: ${steps} controls`);
    await page.close();
  }
} finally {
  await browser.close();
}
