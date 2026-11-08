// Synthetic keyboard contract on the local fixture server, not a device keyboard test.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const output = resolve(process.env.VISUAL_OUTPUT || '.superpowers/sdd/2026-11-08-conecta-orange-redesign/task-4-inline-viewport');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const evidence = [];
try {
  const page = await browser.newPage({ viewport: { width: 402, height: 874 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto('http://127.0.0.1:4178/cards-pos.html', { waitUntil: 'networkidle' });
  await page.locator('main:not([data-route-pending])').waitFor();
  await page.evaluate(() => {
    window.__testViewport = { height: 874, offsetTop: 0 };
    for (const key of ['height', 'offsetTop']) {
      Object.defineProperty(visualViewport, key, { configurable: true, get: () => window.__testViewport[key] });
    }
  });
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
  const viewport = async (height, offsetTop = 0, event = 'resize') => {
    await page.evaluate(({ height, offsetTop, event }) => {
      Object.assign(window.__testViewport, { height, offsetTop });
      visualViewport.dispatchEvent(new Event(event));
    }, { height, offsetTop, event });
    await settle();
  };
  const open = async () => {
    await page.locator('#cardCanvas [data-edit-key]').first().click();
    await page.locator('#card-inline-layer:not([hidden])').waitFor();
    await settle();
  };
  const visible = async state => {
    const result = await page.evaluate(() => {
      const layer = document.getElementById('card-inline-layer');
      const rect = layer.getBoundingClientRect();
      const bounds = { top: visualViewport.offsetTop, bottom: visualViewport.offsetTop + visualViewport.height };
      const controls = ['#card-inline-field', '[data-inline-action="apply"]', '[data-inline-action="cancel"]'].map(selector => {
        const node = layer.querySelector(selector), box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { selector, top: box.top, bottom: box.bottom, unobscured: node === hit || node.contains(hit) };
      });
      return { bounds, panel: { top: rect.top, bottom: rect.bottom, height: rect.height }, controls };
    });
    assert.ok(result.panel.top >= result.bounds.top + 11, `${state}: panel above visible viewport`);
    assert.ok(result.panel.bottom <= result.bounds.bottom - 11, `${state}: panel behind keyboard`);
    assert.ok(result.panel.height <= result.bounds.bottom - result.bounds.top - 23, `${state}: unbounded panel`);
    for (const control of result.controls) {
      assert.ok(control.top >= result.bounds.top && control.bottom <= result.bounds.bottom, `${state}: ${control.selector} outside visible viewport`);
      assert.ok(control.unobscured, `${state}: ${control.selector} obscured`);
      await page.locator(control.selector).focus();
      assert.equal(await page.locator(control.selector).evaluate(node => node === document.activeElement), true);
    }
    evidence.push({ state, ...result });
    await page.screenshot({ path: resolve(output, `${state}.png`) });
    console.log(`PASS ${state}`);
  };
  const cleared = async () => {
    await settle();
    assert.deepEqual(await page.locator('#card-inline-layer').evaluate(node => [
      node.style.getPropertyValue('--inline-viewport-bottom'), node.style.getPropertyValue('--inline-viewport-height'),
    ]), ['', '']);
  };

  await open();
  await visible('open-full');
  await viewport(450);
  await visible('keyboard-450');
  await viewport(450, 80, 'scroll');
  await visible('keyboard-offset-80');
  await viewport(874);
  await visible('keyboard-restored');
  await page.locator('[data-inline-action="cancel"]').click();
  await cleared();

  // Opening after shrink must work without another viewport event.
  await viewport(450, 40);
  await open();
  await visible('open-already-shrunk');
  await page.setViewportSize({ width: 1024, height: 874 });
  await cleared();
  await page.setViewportSize({ width: 402, height: 874 });
  await settle();
  await visible('mobile-breakpoint-restored');
  await page.locator('[data-inline-action="apply"]').click();
  await cleared();
  await open();
  await page.keyboard.press('Escape');
  await cleared();

  // A real SPA disposal must remove offsets and prevent late viewport writes.
  await open();
  await page.evaluate(() => {
    window.__detachedInline = document.getElementById('card-inline-layer');
    document.querySelector('.sidebar a[href="./profile.html"]').click();
  });
  await page.waitForURL('**/profile.html');
  await page.locator('main:not([data-route-pending])').waitFor();
  await viewport(450, 90);
  assert.deepEqual(await page.evaluate(() => [
    window.__detachedInline.style.getPropertyValue('--inline-viewport-bottom'),
    window.__detachedInline.style.getPropertyValue('--inline-viewport-height'),
  ]), ['', '']);
  assert.deepEqual(errors, []);
  console.log('PASS close, breakpoint and SPA disposal cleanup');
} finally {
  await browser.close();
  await writeFile(resolve(output, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
}
