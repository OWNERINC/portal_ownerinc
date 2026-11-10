// Automated accessibility evidence against labelled local fixtures only.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.PLAYWRIGHT_MODULE_PATH || !process.env.AXE_MODULE_PATH) {
  throw new Error('Set PLAYWRIGHT_MODULE_PATH and AXE_MODULE_PATH to external module entry files.');
}
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const output = resolve(process.env.VISUAL_OUTPUT || '.superpowers/sdd/2026-11-08-conecta-orange-redesign/visual');
const routes = (process.env.VISUAL_ROUTES || 'login,dashboard,knowledge,reminders,academy,academy?course=culture,academy?course=culture&lesson=culture-4,profile,admin,autocard,cards-pos,benefits,solides').split(',');
const widths = (process.env.VISUAL_WIDTHS || '1920,402').split(',').map(Number);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
const results = [];
const origin = process.env.VISUAL_ORIGIN || 'http://127.0.0.1:4178';
try {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: width > 1000 ? 1080 : 874 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    for (const route of routes) {
      const [name, query = ''] = route.split('?');
      await page.goto(`${origin}/${name}.html${query ? `?${query}` : ''}`, { waitUntil: 'networkidle' });
      await page.locator(route === 'login' ? '#login-form' : 'main:not([data-route-pending])').waitFor({ state: 'visible' });
      await page.evaluate(() => document.fonts.ready);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      const violations = audit.violations.map(({ id, impact, description, nodes }) => ({
        id, impact, description, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      }));
      results.push({ route, width, violations, incomplete: audit.incomplete.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) })) });
      console.log(`${violations.length ? 'FAIL' : 'PASS'} ${width} ${route}: ${violations.map(item => `${item.id} (${item.nodes.length})`).join(', ') || 'no automated WCAG A/AA violations'}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, 'accessibility.json'), JSON.stringify(results, null, 2) + '\n');
}
if (results.some(item => item.violations.length)) process.exitCode = 1;
