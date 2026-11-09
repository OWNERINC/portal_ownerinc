// Compare original and redesigned art at equal canvas widths, independently of
// the surrounding editor layout. Both origins must be loopback fixture servers.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const output = resolve(process.env.VISUAL_OUTPUT || '.superpowers/sdd/2026-11-08-conecta-orange-redesign/art');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const results = [];
async function sample(origin, route, kind, width) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const selector = '#cardCanvas';
  // Fix geometry before render/mount so body-fitting never observes a temporary
  // editor width. Applying this after mount creates a false art diff.
  await page.route(`${origin}/${route}.html`, async routeRequest => {
    const response = await routeRequest.fetch();
    const html = await response.text();
    await routeRequest.fulfill({ response, body: html.replace('</head>', `<style>${selector} { width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; margin: 0 !important; transform: none !important; }</style></head>`) });
  });
  await page.goto(`${origin}/${route}.html`, { waitUntil: 'networkidle' });
  await page.locator('main:not([data-route-pending])').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  if (route === 'autocard') await page.locator(`#templateGallery [data-template="${kind}"]`).click();
  else if (kind === 'owner') await page.locator('[data-module="owner"]').click();
  await page.locator(selector).waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  // Resize observers, art theme observers and fitCardBody each schedule frames.
  await page.evaluate(async () => {
    for (let frame = 0; frame < 12; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
  const metrics = await page.locator(selector).evaluate(root => {
    const base = root.getBoundingClientRect();
    const properties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'padding', 'margin', 'borderRadius', 'objectFit'];
    return [root, ...root.querySelectorAll('*')].map(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return { tag: node.tagName, class: node.getAttribute('class'), text: node.children.length ? null : node.textContent,
        box: [rect.x - base.x, rect.y - base.y, rect.width, rect.height].map(value => Math.round(value * 100) / 100),
        styles: Object.fromEntries(properties.map(property => [property, style[property]])) };
    });
  });
  await page.locator(selector).screenshot({ path: resolve(output, `${route}-${kind}-${width}-${origin.endsWith('4179') ? 'baseline' : 'current'}.png`) });
  await context.close();
  return metrics;
}
try {
  // The maintained templates share renderers but cover distinct art geometry.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4179/autocard.html', { waitUntil: 'networkidle' });
  await page.locator('#templateGallery [data-template]').first().waitFor();
  const templates = await page.locator('#templateGallery [data-template]').evaluateAll(nodes => nodes.map(node => node.dataset.template));
  await context.close();
  for (const [route, kinds] of [['autocard', templates], ['cards-pos', ['guest', 'owner']]]) {
    for (const kind of kinds) {
      for (const width of [540, 320]) {
        const before = await sample('http://127.0.0.1:4179', route, kind, width);
        const after = await sample('http://127.0.0.1:4178', route, kind, width);
        const differences = [];
        for (let i = 0; i < Math.max(before.length, after.length); i++) {
          try { assert.deepEqual(after[i], before[i]); } catch { differences.push({ index: i, before: before[i], after: after[i] }); }
        }
        results.push({ route, kind, width, differences });
        console.log(`${differences.length ? 'FAIL' : 'PASS'} ${route}/${kind}/${width}: ${differences.length} changed nodes`);
      }
    }
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, 'art-comparison.json'), JSON.stringify(results, null, 2) + '\n');
}
if (results.some(item => item.differences.length)) process.exitCode = 1;
