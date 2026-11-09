// Run only against the loopback fixture server. All writes and external
// navigation are mocked here; this is not real Firebase/email acceptance.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

if (!process.env.PLAYWRIGHT_MODULE_PATH || !process.env.AXE_MODULE_PATH) {
  throw new Error('Set PLAYWRIGHT_MODULE_PATH and AXE_MODULE_PATH to the external test modules');
}
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const origin = new URL(process.env.VISUAL_ORIGIN || 'http://127.0.0.1:4178');
assert.equal(origin.hostname, '127.0.0.1', 'Use only the loopback preview, never production');
const output = resolve(process.env.VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'login-approved-visual'));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
const results = [];
const widths = [320, 360, 402, 768, 769, 1000, 1001, 1366, 1440, 1920];
try {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('https://app.denouncefy.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Mock external channel</p>' }));
  await page.goto(new URL('/login.html', origin).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const title = page.locator('#login-title');
  const register = page.getByRole('button', { name: 'Cadastre-se', exact: true });
  const forgot = page.getByRole('button', { name: 'Esqueci minha senha', exact: true });
  const submit = page.getByRole('button', { name: 'Entrar no portal', exact: true });
  const channel = page.getByRole('link', { name: 'PodFalar (abre em nova aba)', exact: true });
  const setup = page.getByRole('button', { name: 'Criar senha do cadastro', exact: true });
  const visible = async locator => assert.equal(await locator.isVisible(), true);
  const focused = async locator => assert.equal(await locator.evaluate(node => document.activeElement === node), true);
  const checkMobileCentering = async (width, state) => {
    const layout = await page.evaluate(() => {
      const main = document.querySelector('.login-split');
      const brand = document.querySelector('.brand-panel').getBoundingClientRect();
      const card = document.querySelector('.form-panel').getBoundingClientRect();
      const style = getComputedStyle(main);
      return {
        top: brand.top + scrollY, bottom: card.bottom + scrollY,
        brandCenterX: brand.left + brand.width / 2,
        cardCenterX: card.left + card.width / 2,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom),
      };
    });
    assert.ok(Math.abs(layout.brandCenterX - layout.viewportWidth / 2) <= 1, `${width}/${state}: brand horizontally centered`);
    assert.ok(Math.abs(layout.cardCenterX - layout.viewportWidth / 2) <= 1, `${width}/${state}: card horizontally centered`);
    const room = layout.viewportHeight - layout.paddingTop - layout.paddingBottom;
    if (layout.bottom - layout.top <= room + 1) {
      const center = (layout.paddingTop + layout.viewportHeight - layout.paddingBottom) / 2;
      assert.ok(Math.abs((layout.top + layout.bottom) / 2 - center) <= 1, `${width}/${state}: whole composition vertically centered`);
    } else {
      assert.ok(Math.abs(layout.top - layout.paddingTop) <= 1, `${width}/${state}: tall content starts safely instead of clipping above the viewport`);
    }
    return layout;
  };
  const audit = async (width, state) => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${state}: horizontal overflow`);
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.equal(audit.violations.length, 0, JSON.stringify(audit.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))));
    const layout = width <= 768 ? await checkMobileCentering(width, state) : undefined;
    results.push({ width, state, violations: audit.violations.length, layout });
  };
  for (const width of widths) {
    await page.setViewportSize({ width, height: width > 1000 ? 900 : 874 });
    await page.waitForFunction(expected => {
      const image = document.querySelector('.brand-logo');
      return image.complete && image.naturalWidth > 0 && image.currentSrc.endsWith(expected);
    }, width <= 768 ? '/symbol.svg' : '/logo.svg');
    await visible(channel);
    await visible(submit);
    await visible(register);
    assert.equal(await page.getByRole('heading', { level: 1, name: 'Conecta Ownerinc' }).count(), 1);
    assert.equal(await page.getByRole('heading', { level: 2, name: 'Boas conexões começam aqui.' }).count(), 1);
    assert.equal(await title.isVisible(), false);
    assert.equal(await setup.isVisible(), false);
    assert.equal(await page.getByRole('region', { name: 'Acesso ao portal', exact: true }).count(), 1);
    const metrics = await page.evaluate(() => {
      const brand = document.querySelector('.brand-logo');
      const headline = document.querySelector('.brand-headline');
      return {
        logo: brand.currentSrc, brandWidth: brand.getBoundingClientRect().width,
        panelWidth: document.querySelector('.brand-panel').getBoundingClientRect().width,
        headlineSize: parseFloat(getComputedStyle(headline).fontSize),
        subtitle: getComputedStyle(document.querySelector('.brand-subtitle')).display,
        accent: getComputedStyle(document.querySelector('.brand-accent')).display,
      };
    });
    assert.equal(metrics.brandWidth, width <= 768 ? 104 : Math.min(320, metrics.panelWidth));
    assert.ok(metrics.logo.endsWith(width <= 768 ? '/symbol.svg' : '/logo.svg'));
    assert.equal(metrics.headlineSize, width <= 768 ? 17 : 22);
    assert.equal(metrics.subtitle === 'none', width <= 768);
    assert.equal(metrics.accent === 'none', width <= 768);
    const primary = await submit.boundingBox();
    const secondary = await register.boundingBox();
    assert.ok(primary.height >= 48 && secondary.height >= 48);
    assert.equal(primary.width, secondary.width);
    assert.ok(Math.abs(secondary.y - primary.y - primary.height - 12) < 1);
    const channelBox = await channel.boundingBox();
    assert.ok(channelBox.height >= 48 && channelBox.x >= 0 && channelBox.x + channelBox.width <= width);
    assert.equal(await channel.evaluate(link => link.closest('form') === null && link.closest('.form-panel') !== null), true);
    assert.ok(channelBox.y >= secondary.y + secondary.height + 24, 'PodFalar sits below the login actions, separated from them');
    const card = await page.locator('.form-panel').boundingBox();
    assert.ok(channelBox.x >= card.x && channelBox.x + channelBox.width <= card.x + card.width);
    assert.ok(channelBox.y + channelBox.height <= card.y + card.height, 'PodFalar remains inside the access card');
    const channelLogo = await channel.locator('img').evaluate(image => ({
      loaded: image.complete && image.naturalWidth > 0,
      source: image.currentSrc, alt: image.alt,
      width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height,
    }));
    assert.equal(channelLogo.loaded, true, 'original PodFalar logo must load');
    assert.ok(channelLogo.source.endsWith('/assets/podfalar/logo-horizontal.svg'));
    assert.equal(channelLogo.alt, 'PodFalar');
    assert.equal(channelLogo.width, 108);
    assert.ok(Math.abs(channelLogo.width / channelLogo.height - 274.84 / 60.9) < 0.01, 'logo aspect ratio is preserved');
    if (width === 320 || width === 402) assert.ok(primary.y + primary.height <= 874, 'primary action stays in the initial mobile viewport');
    await audit(width, 'login');
    if ([402, 1440].includes(width)) {
      await page.screenshot({ path: resolve(output, `login-${width}.png`), fullPage: true });
    }
    await forgot.click();
    assert.equal(await title.textContent(), 'Redefinir senha');
    await visible(title);
    await focused(title);
    await audit(width, 'recovery');
    await page.locator('#back-link').click();
    await focused(forgot);
    assert.equal(await title.isVisible(), false);
    await register.click();
    assert.equal(await title.textContent(), 'Cadastre-se');
    await visible(setup);
    await focused(title);
    await audit(width, 'register');
    await setup.click();
    assert.equal(await title.textContent(), 'Criar senha do cadastro');
    await focused(title);
    await audit(width, 'password');
    await page.locator('#registration-password-back-link').click();
    await focused(setup);
    assert.equal(await title.textContent(), 'Cadastre-se');
    await page.locator('#register-back-link').click();
    await focused(register);
    assert.equal(await title.isVisible(), false);
    console.log(`PASS ${width}: approved brand, layout, four states, focus returns, axe`);
  }
  for (const height of [480, 568, 667]) {
    await page.setViewportSize({ width: 360, height });
    await page.evaluate(() => scrollTo(0, 0));
    const layout = await checkMobileCentering(360, `short-login-${height}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await channel.scrollIntoViewIfNeeded();
    const channelBox = await channel.boundingBox();
    assert.ok(channelBox.y >= 0 && channelBox.y + channelBox.height <= height, 'footer remains reachable on a short viewport');
    await page.locator('#email').focus();
    const emailBox = await page.locator('#email').boundingBox();
    assert.ok(emailBox.y >= 0 && emailBox.y + emailBox.height <= height, 'email remains reachable after scrolling back');
    results.push({ width: 360, height, state: 'short-login', layout, passed: true });
    console.log(`PASS 360x${height}: safe centering, natural scroll, footer and input reachable`);
  }
  await page.setViewportSize({ width: 402, height: 874 });
  await forgot.focus();
  await page.keyboard.press('Tab');
  await focused(submit);
  await page.keyboard.press('Tab');
  await focused(register);
  await page.keyboard.press('Tab');
  await focused(channel);
  await page.locator('#toggle-pw').click();
  assert.equal(await page.locator('#password').getAttribute('type'), 'text');
  assert.equal(await page.locator('#toggle-pw').getAttribute('aria-label'), 'Ocultar senha');
  await page.locator('#toggle-pw').click();
  assert.equal(await page.locator('#password').getAttribute('type'), 'password');
  const calls = [];
  await context.route('**/api/auth/**', async route => {
    const request = route.request();
    calls.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    const registration = request.url().endsWith('/register');
    await route.fulfill({ status: registration ? 202 : 200, contentType: 'application/json', body: JSON.stringify(registration ? { status: 'accepted', state: 'received' } : {}) });
  });
  await register.click();
  await page.locator('#register-name').fill('Pessoa de teste');
  await page.locator('#register-email').fill('person@example.test');
  await page.locator('#register-btn').click();
  await page.locator('#register-success').waitFor({ state: 'visible' });
  assert.match(await page.locator('#register-success').textContent(), /Se o cadastro puder ser processado/);
  await setup.click();
  await page.locator('#registration-password-email').fill('person@example.test');
  await page.locator('#registration-password-btn').click();
  await page.locator('#registration-password-success').waitFor({ state: 'visible' });
  await page.locator('#registration-password-back-link').click();
  await page.locator('#register-back-link').click();
  await forgot.click();
  await page.locator('#reset-email').fill('person@example.test');
  await page.locator('#reset-btn').click();
  await page.locator('#reset-success').waitFor({ state: 'visible' });
  assert.match(await page.locator('#reset-success').textContent(), /Se a conta estiver ativa/);
  await page.locator('#back-link').click();
  assert.deepEqual(calls, [
    { path: '/api/auth/register', body: { name: 'Pessoa de teste', email: 'person@example.test' } },
    { path: '/api/auth/registration-password', body: { email: 'person@example.test' } },
    { path: '/api/auth/password-reset', body: { email: 'person@example.test' } },
  ]);
  const [popup] = await Promise.all([context.waitForEvent('page'), channel.click()]);
  await popup.waitForLoadState();
  assert.equal(popup.url(), 'https://app.denouncefy.com/portal/canaldedenunciaownerinc');
  assert.equal(await popup.evaluate(() => window.opener === null && document.referrer === ''), true);
  await popup.close();
  assert.deepEqual(errors, []);
  results.push({ state: 'mocked-transports-keyboard-and-channel', passed: true });
  console.log('PASS mocked transports, keyboard order, password visibility and isolated external navigation');
} finally {
  await browser.close();
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(`Evidence: ${output}`);
