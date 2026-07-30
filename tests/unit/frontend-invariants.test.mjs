import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pages = ['dashboard', 'knowledge', 'reminders', 'academy', 'benefits', 'ombudsman', 'profile', 'admin', 'solides'];

test('authenticated pages expose one heading, skip navigation, theme color, and external scripts only', async () => {
  for (const page of pages) {
    const html = await readFile(`public/${page}.html`, 'utf8');
    assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1, `${page}: expected one h1`);
    assert.match(html, /class="skip-link"[^>]*href="#main-content"/, `${page}: missing skip link`);
    assert.match(html, /<main[^>]*id="main-content"/, `${page}: missing main landmark target`);
    assert.match(html, /<meta name="theme-color"/, `${page}: missing theme color`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${page}: inline script violates CSP`);
    assert.doesNotMatch(html, /\son(?:click|change|submit|keydown)=/i, `${page}: inline event handler`);
  }
});

test('frontend avoids unsafe HTML sinks and honors focus and reduced motion', async () => {
  const scripts = await Promise.all([
    'academy', 'admin', 'auth', 'benefits', 'dashboard', 'knowledge', 'login', 'ombudsman', 'profile', 'reminders', 'sidebar', 'solides', 'ui',
  ].map((name) => readFile(`public/js/${name}.js`, 'utf8')));
  assert.doesNotMatch(scripts.join('\n'), /\.innerHTML\s*=/);

  const css = `${await readFile('public/css/layout.css', 'utf8')}\n${await readFile('public/css/components.css', 'utf8')}`;
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@media[^{}]*max-width:\s*768px/);
});

test('admin navigation restores the last verified role before paint and revalidates it', async () => {
  const navigationPages = ['dashboard', 'knowledge', 'reminders', 'academy', 'benefits', 'ombudsman', 'profile', 'solides'];
  const [auth, shell, layout, ...htmlPages] = await Promise.all([
    readFile('public/js/auth.js', 'utf8'),
    readFile('public/js/auth-shell.js', 'utf8').catch(() => ''),
    readFile('public/css/layout.css', 'utf8'),
    ...navigationPages.map((page) => readFile(`public/${page}.html`, 'utf8')),
  ]);

  assert.match(shell, /sessionStorage\.getItem\('ownerinc-verified-role'\)/);
  assert.match(shell, /document\.documentElement\.dataset\.portalRole/);
  assert.match(layout, /\.admin-link\s*\{[^}]*visibility:\s*hidden/);
  assert.match(layout, /html\[data-portal-role="admin"\]\s+\.admin-link\s*\{[^}]*visibility:\s*visible/);
  assert.match(auth, /sessionStorage\.setItem\('ownerinc-verified-role', user\.role\)/);
  assert.match(auth, /sessionStorage\.removeItem\('ownerinc-verified-role'\)/);

  for (const [index, html] of htmlPages.entries()) {
    const page = navigationPages[index];
    assert.match(html, /<script src="\.\/js\/auth-shell\.js"><\/script>[\s\S]*<\/head>/, `${page}: auth shell must run before body paint`);
    assert.match(html, /<li id="admin-link" class="admin-link">/, `${page}: missing stable admin navigation class`);
    assert.doesNotMatch(html, /id="admin-link"[^>]*style=/, `${page}: inline visibility bypasses the stable auth shell`);
  }
});

test('login keeps a visible page heading and pins its third-party icon script', async () => {
  const login = await readFile('public/login.html', 'utf8');
  assert.equal((login.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(login, /<h1 id="login-title"/);
  assert.match(login, /lucide\.min\.js" integrity="sha384-/);
  assert.doesNotMatch(login, /<script(?![^>]*\bsrc=)[^>]*>/);
});

test('Sólides overview loads summary, balance, and schedule independently', async () => {
  const script = await readFile('public/js/solides.js', 'utf8');
  for (const loader of ['loadSummary', 'loadBalance', 'loadSchedule']) {
    assert.match(script, new RegExp(`async function ${loader}\\(\\)`));
  }
  assert.match(script, /Promise\.all\(\[loadSummary\(\), loadBalance\(\), loadSchedule\(\)\]\)/);
});

test('Sólides administration loads every eligible CLT page', async () => {
  const script = await readFile('public/js/admin.js', 'utf8');
  assert.match(script, /while \(offset < total\)/);
  assert.match(script, /solides\/admin\/users\?limit=100&offset=\$\{offset\}/);
});
