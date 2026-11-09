import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

if (!process.env.PLAYWRIGHT_MODULE_PATH) throw new Error('Set PLAYWRIGHT_MODULE_PATH');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const origin = new URL(process.env.VISUAL_ORIGIN || 'http://127.0.0.1:4178');
assert.equal(origin.hostname, '127.0.0.1');
const output = resolve(process.env.VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'login-aurora-visual'));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
const results = [];
try {
  for (const reducedMotion of ['reduce', 'no-preference']) {
    const context = await browser.newContext({ reducedMotion });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [360, 402, 1366]) {
      await page.setViewportSize({ width, height: width > 1000 ? 768 : 667 });
      await page.goto(new URL('/login.html', origin).href, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const layers = await page.evaluate(async () => {
        const animations = document.body.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'login-aurora-enter');
        const count = animations.length;
        await Promise.all(animations.map(animation => animation.finished));
        return {
          count,
          animations: animations.map(animation => ({
            duration: animation.effect.getTiming().duration,
            iterations: animation.effect.getTiming().iterations,
            state: animation.playState,
          })),
          layers: ['::before', '::after'].map(pseudo => {
            const style = getComputedStyle(document.body, pseudo);
            // Filled CSS animations may serialize the final `none` as an identity matrix.
            const transformIsIdentity = style.transform === 'none' || new DOMMatrixReadOnly(style.transform).isIdentity;
            return { background: style.backgroundImage, pointerEvents: style.pointerEvents, zIndex: style.zIndex, transform: style.transform, transformIsIdentity, animation: style.animationName, opacity: style.opacity };
          }),
          overflow: document.documentElement.scrollWidth > innerWidth,
          scrollable: getComputedStyle(document.body).overflowY !== 'hidden',
        };
      });
      assert.equal(layers.count, reducedMotion === 'reduce' ? 0 : 2);
      for (const animation of layers.animations) {
        assert.equal(animation.duration, 900);
        assert.equal(animation.iterations, 1);
        assert.equal(animation.state, 'finished');
      }
      assert.equal(layers.overflow, false);
      assert.equal(layers.scrollable, true);
      for (const layer of layers.layers) {
        assert.match(layer.background, /radial-gradient/);
        assert.equal(layer.pointerEvents, 'none');
        assert.equal(layer.zIndex, '-1');
        assert.equal(layer.opacity, '1');
        assert.equal(layer.transformIsIdentity, true);
        if (reducedMotion === 'reduce') assert.equal(layer.transform, 'none');
        assert.equal(layer.animation, reducedMotion === 'reduce' ? 'none' : 'login-aurora-enter');
      }
      await page.getByRole('button', { name: 'Esqueci minha senha', exact: true }).click();
      assert.equal(await page.locator('#reset-section').isVisible(), true);
      await page.locator('#back-link').click();
      await page.getByRole('button', { name: 'Cadastre-se', exact: true }).click();
      assert.equal(await page.locator('#register-section').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.locator('#register-back-link').click();
      await page.screenshot({ path: join(output, `login-${width}-${reducedMotion}.png`), fullPage: true });
      results.push({ width, reducedMotion, ...layers });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`PASS ${results.length} aurora cases: ${output}`);
} finally {
  await browser.close();
}
