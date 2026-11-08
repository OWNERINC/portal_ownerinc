// Run against serve-conecta.mjs only. This is visual fixture evidence, not an
// authenticated acceptance test. Playwright is installed outside the project.
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!modulePath) throw new Error('Set PLAYWRIGHT_MODULE_PATH to the installed playwright/index.mjs');
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const output = resolve(process.env.VISUAL_OUTPUT || '.superpowers/sdd/2026-11-08-conecta-orange-redesign/visual');
await mkdir(output, { recursive: true });
const origin = 'http://127.0.0.1:4178';
const routes = ['login.html', 'dashboard.html', 'knowledge.html', 'reminders.html', 'academy.html', 'profile.html', 'admin.html', 'autocard.html', 'cards-pos.html', 'benefits.html', 'solides.html'];
const widths = process.env.VISUAL_WIDTHS ? process.env.VISUAL_WIDTHS.split(',').map(Number) : [1920, 402, 360, 768, 1366];
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
const results = [];
try {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: width > 1000 ? 1080 : 874 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    for (const route of routes) {
      const errors = [];
      const onError = error => errors.push(error.message);
      page.on('pageerror', onError);
      let failure = null;
      try {
        await page.goto(`${origin}/${route}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator(route === 'login.html' ? '#login-form' : 'main:not([data-route-pending])').waitFor({ state: 'visible', timeout: 15000 });
        await page.evaluate(() => document.fonts.ready);
        const metrics = await page.evaluate(() => ({
          viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
          font: getComputedStyle(document.body).fontFamily,
          headings: [...document.querySelectorAll('h1')].filter(node => node.getClientRects().length).map(node => node.textContent.trim()),
          brokenImages: [...document.images].filter(image => image.getClientRects().length && (!image.complete || image.naturalWidth === 0)).map(image => image.getAttribute('src')),
        }));
        assert.ok(metrics.documentWidth <= width + 1, `${route}: horizontal overflow ${metrics.documentWidth}/${width}`);
        assert.equal(metrics.headings.length, 1, `${route}: expected one visible h1`);
        assert.equal(metrics.brokenImages.length, 0, `${route}: broken images ${metrics.brokenImages.join(', ')}`);
        if (width === 1920 || width === 402) await page.screenshot({ path: resolve(output, `${route.replace('.html', '')}-${width}.png`), fullPage: true });
        results.push({ route, width, ...metrics, errors });
      } catch (error) {
        failure = error.message;
        results.push({ route, width, failure, errors });
        await page.screenshot({ path: resolve(output, `failure-${route.replace('.html', '')}-${width}.png`), fullPage: true });
      } finally { page.off('pageerror', onError); }
      console.log(`${failure || errors.length ? 'FAIL' : 'PASS'} ${width} ${route}${failure ? ` ${failure}` : ''}`);
    }
    if (width === 402) {
      await page.goto(`${origin}/dashboard.html`, { waitUntil: 'networkidle' });
      const toggle = page.locator('.mobile-menu-toggle');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await page.screenshot({ path: resolve(output, 'navigation-402.png') });
      await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await toggle.evaluate(node => document.activeElement === node), true);
      results.push({ route: 'drawer-keyboard', width, passed: true });
    }
    if (width === 1920) {
      await page.goto(`${origin}/dashboard.html`, { waitUntil: 'networkidle' });
      await page.locator('#sidebar-toggle').click();
      assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: resolve(output, 'navigation-collapsed-1920.png') });
      await page.locator('.sidebar-nav a[href="./knowledge.html"]').click();
      await page.locator('main:not([data-route-pending])').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
      results.push({ route: 'collapsed-persistent-navigation', width, passed: true });
    }
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
}
if (results.some(item => item.failure || item.errors?.length)) process.exitCode = 1;
