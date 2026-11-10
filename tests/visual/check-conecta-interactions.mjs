// Fixture-only keyboard, dialog, error and detail coverage. No real writes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const output = resolve(process.env.VISUAL_OUTPUT || '.superpowers/sdd/2026-11-08-conecta-orange-redesign/interactions');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const results = [];
const origin = process.env.VISUAL_ORIGIN || 'http://127.0.0.1:4178';
try {
  for (const width of [1920, 402, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const visit = async route => {
      await page.goto(`${origin}/${route}`, { waitUntil: 'networkidle' });
      await page.locator('main:not([data-route-pending])').waitFor({ state: 'visible' });
    };
    const capture = async name => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name}: overflow`);
      await page.screenshot({ path: resolve(output, `${name}-${width}.png`) });
      results.push({ name, width, passed: true });
    };
    await visit('knowledge.html');
    await page.locator('#articles-list .article-card').first().click();
    await page.locator('#article-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#article-title').evaluate(node => document.activeElement === node), true);
    await capture('knowledge-detail');
    await page.locator('#btn-back').click();
    await page.locator('#btn-new').click();
    await page.locator('#modal-article').waitFor({ state: 'visible' });
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('#modal-article'))), true);
    await capture('knowledge-dialog');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#modal-article').isVisible(), false);
    assert.equal(await page.locator('#btn-new').evaluate(node => document.activeElement === node), true);

    await visit('reminders.html');
    assert.equal(await page.title(), 'Notificações — Conecta Ownerinc');
    assert.equal(await page.locator('h1').textContent(), 'Notificações');
    assert.equal(await page.locator('.sidebar-nav a[href="./reminders.html"]').getAttribute('title'), 'Notificações');
    assert.equal(await page.locator('#btn-new-reminder').textContent(), 'Nova notificação');
    await page.locator('#btn-new-reminder').click();
    await page.locator('#modal-reminder').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#modal-reminder-title').textContent(), 'Nova notificação');
    await capture('reminder-dialog');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#btn-new-reminder').evaluate(node => document.activeElement === node), true);
    await page.getByRole('button', { name: /^Editar notificação:/ }).first().click();
    await page.locator('#modal-reminder').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#modal-reminder-title').textContent(), 'Editar notificação');
    await capture('notification-edit-dialog');
    await page.keyboard.press('Escape');
    await page.locator('#delivery-reminder').fill('invalid-uuid');
    await page.locator('#delivery-filters button[type="submit"]').click();
    assert.equal(await page.locator('#delivery-reminder').getAttribute('aria-invalid'), 'true');
    await capture('reminder-validation');

    await visit('academy.html?course=culture');
    await page.getByRole('link', { name: 'Continuar curso', exact: true }).waitFor();
    await capture('academy-course');
    await page.getByRole('link', { name: 'Continuar curso', exact: true }).click();
    await page.getByRole('heading', { name: 'Nosso jeito de trabalhar', exact: true }).waitFor();
    await capture('academy-lesson');

    await page.route('**/api/academy/continue?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Falha simulada de carregamento' }) }));
    await page.route('**/api/academy?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Falha simulada de carregamento' }) }));
    await visit('dashboard.html');
    await page.getByRole('button', { name: 'Tentar novamente' }).waitFor();
    assert.ok(await page.locator('.dashboard-reminder').count() > 0, 'Academy failure must preserve reminders');
    await capture('dashboard-independent-error');
    await page.unroute('**/api/academy/continue?*');
    await page.unroute('**/api/academy?*');
    await page.getByRole('button', { name: 'Tentar novamente' }).click();
    await page.locator('.dashboard-course-action').waitFor({ state: 'visible' });
    await capture('dashboard-retry');

    await page.evaluate(() => { window.__conectaNavigationMarker = 'same-document'; });
    for (const route of ['autocard', 'cards-pos', 'profile', 'admin', 'dashboard']) {
      if (width <= 768) await page.locator('.mobile-menu-toggle').click();
      // Cards Pós normalizes initial rich text and already prompts on leave in
      // the baseline. Confirm the fixture draft discard through the real guard.
      if (route === 'profile') page.once('dialog', async dialog => {
        assert.equal(dialog.type(), 'confirm');
        assert.match(dialog.message(), /alterações dos Cards Pós/);
        await dialog.accept();
      });
      await page.locator(`.sidebar-nav a[href="./${route}.html"]`).click();
      await page.waitForURL(`**/${route}.html`);
      await page.locator('main:not([data-route-pending])').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => window.__conectaNavigationMarker), 'same-document');
      assert.equal(await page.locator('.topbar').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 254, 251)', `${route}: route stylesheet changed shell surface`);
      assert.match(await page.locator('body').evaluate(node => getComputedStyle(node).fontFamily), /Manrope/);
      assert.equal(await page.locator('h1:visible').count(), 1);
      await capture(`persistent-${route}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, 'interactions.json'), JSON.stringify(results, null, 2) + '\n');
}
