// Read-only inspection of local demo content using the real frontend.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureData } from './conecta-fixtures.mjs';

if (!process.env.PLAYWRIGHT_MODULE_PATH) throw new Error('Set PLAYWRIGHT_MODULE_PATH to external playwright/index.mjs');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const origin = process.env.VISUAL_ORIGIN || 'http://127.0.0.1:4178';
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Content checks require the loopback fixture server.');
const output = resolve(process.env.VISUAL_OUTPUT || '.superpowers/sdd/2026-11-09-conecta-content');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
const results = [];
try {
  for (const width of [1366, 402]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const capture = async name => {
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name}: overflow`);
      assert.deepEqual(errors, [], `${name}: page errors`);
      await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
      results.push({ name, width, passed: true });
      console.log(`PASS ${width} ${name}`);
    };
    const visit = async route => {
      await page.goto(`${origin}/${route}`, { waitUntil: 'networkidle' });
      await page.locator('main:not([data-route-pending])').waitFor({ state: 'visible' });
    };
    await visit('dashboard.html');
    await page.locator('.dashboard-course-action').waitFor();
    assert.ok(await page.locator('.dashboard-reminder').count() >= 3);
    await capture('dashboard-content');

    await visit('knowledge.html');
    assert.equal(await page.locator('.article-card').count(), 8);
    await capture('knowledge-content');
    await page.locator('#categories [data-category="Tecnologia"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.article-card').length === 2);
    await page.locator('#search').fill('SEGURANÇA');
    await page.waitForFunction(() => document.querySelectorAll('.article-card').length === 1);
    await page.locator('.article-card').click();
    await page.locator('#article-view').waitFor();
    await page.getByRole('heading', { name: 'Segurança de acesso e senhas', exact: true }).waitFor();
    assert.match(await page.locator('#article-title').textContent(), /Segurança/);
    assert.ok((await page.locator('#article-view').textContent()).length > 500);
    await capture('knowledge-filter-and-detail');

    const reminder = fixtureData(new URL('/api/reminders', origin))[0];
    await visit(`reminders.html#reminder-${reminder.id}`);
    await page.getByRole('heading', { name: reminder.title, exact: true }).waitFor();
    assert.equal(await page.locator('#reminders-tbody tr').count(), 6);
    assert.equal(await page.locator('#deliveries-tbody tr').count(), 4);
    await capture('reminders-content-and-detail');
    await page.locator('#delivery-status').selectOption('sent');
    await page.locator('#delivery-filters button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#deliveries-tbody tr').length === 2);
    await capture('reminder-delivery-filter');

    await visit('academy.html');
    await page.getByRole('heading', { name: 'Primeiros passos na Ownerinc', exact: true }).first().waitFor();
    await page.getByRole('heading', { name: 'Atendimento e relacionamento com o cliente', exact: true }).waitFor();
    await capture('academy-two-paths');
    for (const course of fixtureData(new URL('/api/academy', origin))) {
      await visit(`academy.html?course=${course.id}`);
      await page.getByRole('heading', { name: course.title, exact: true }).waitFor();
      await capture(`academy-${course.id}-curriculum`);
      await page.getByRole('link', { name: course.resume_lesson_id ? 'Continuar curso' : 'Começar curso', exact: true }).click();
      const id = course.resume_lesson_id || `${course.id}-1`;
      const lesson = fixtureData(new URL(`/api/academy/lessons/${id}`, origin));
      await page.getByRole('heading', { name: lesson.lesson.title, exact: true }).waitFor();
      assert.match(await page.locator('.academy-materials').textContent(), /Aula demonstrativa/);
      await capture(`academy-${course.id}-lesson`);
    }

    await visit('benefits.html');
    assert.equal(await page.locator('.benefit-description').count(), 4);
    await capture('benefits-content');
    await visit('profile.html');
    await page.locator('#profile-email').getByText('marina@example.test', { exact: true }).waitFor();
    await capture('profile-content');

    await visit('admin.html');
    assert.equal(await page.locator('#users-tbody tr').count(), 6);
    assert.ok(await page.locator('#audit-tbody tr').count() > 0);
    await capture('admin-users');
    await page.locator('#users-q').fill('Rafael');
    await page.locator('#users-filters button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#users-tbody tr').length === 1 && document.querySelector('#users-tbody').textContent.includes('Rafael'));
    await capture('admin-users-filter');
    await page.getByRole('tab', { name: 'Solicitações', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#registrations-tbody tr').length === 2);
    await capture('admin-registrations');
    await page.getByRole('tab', { name: 'Cargos', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#job-titles-tbody tr').length === 5);
    await capture('admin-job-titles');

    await visit('autocard.html');
    await page.locator('[data-tab="saved"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#savedList .saved-card').length === 4);
    await capture('autocard-history');
    await page.locator('#savedList [data-edit]').first().click();
    await page.locator('#editorView').waitFor();
    assert.match(await page.locator('#cardCanvas').textContent(), /Vamos nos conectar/);
    await capture('autocard-saved-detail');

    await visit('cards-pos.html');
    await page.locator('[data-view="history"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#historyList .history-item').length === 2);
    await capture('pos-history');
    // The real editor normalizes initial rich text and protects that draft.
    page.once('dialog', async dialog => {
      assert.equal(dialog.type(), 'confirm');
      assert.match(dialog.message(), /alterações dos Cards Pós/);
      await dialog.accept();
    });
    await page.locator('#historyList [data-edit]').first().click();
    await page.getByRole('region', { name: 'Pré-visualização do convite' }).getByText('Este é um convite demonstrativo, sem reserva ou validade comercial.', { exact: true }).waitFor();
    await capture('pos-saved-detail');

    await visit('solides.html');
    assert.match(await page.locator('#schedule-summary').textContent(), /demonstrativa/);
    assert.equal(await page.locator('#schedule-days article').count(), 5);
    assert.ok(await page.locator('#punch-history tbody tr').count() > 0);
    await capture('solides-demo-content');
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, 'content-results.json'), JSON.stringify(results, null, 2) + '\n');
}
