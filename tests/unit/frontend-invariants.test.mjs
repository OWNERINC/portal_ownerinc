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
  assert.match(css, /\.filter-bar\s*\{/);
  assert.match(scripts.at(-1), /querySelectorAll\('\.table-wrapper'\)/);
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
  assert.match(layout, /\.admin-link\s*\{[^}]*display:\s*none/);
  assert.match(layout, /html\[data-portal-role="admin"\]\s+\.admin-link\s*\{[^}]*display:\s*list-item/);
  assert.match(auth, /sessionStorage\.setItem\('ownerinc-verified-role', user\.role\)/);
  assert.match(auth, /sessionStorage\.removeItem\('ownerinc-verified-role'\)/);

  for (const [index, html] of htmlPages.entries()) {
    const page = navigationPages[index];
    assert.match(html, /<script src="\.\/js\/auth-shell\.js"><\/script>[\s\S]*<\/head>/, `${page}: auth shell must run before body paint`);
    assert.match(html, /<li id="admin-link" class="admin-link">/, `${page}: missing stable admin navigation class`);
    assert.doesNotMatch(html, /id="admin-link"[^>]*style=/, `${page}: inline visibility bypasses the stable auth shell`);
  }
});

test('authenticated shell has no personalized greeting and admin invites do not ask for a password', async () => {
  const html = await Promise.all(pages.map((page) => readFile(`public/${page}.html`, 'utf8')));
  const scripts = await readFile('public/js/auth.js', 'utf8');
  assert.doesNotMatch(html.join('\n'), /Olá,|Ola,/);
  assert.doesNotMatch(scripts, /renderUserInTopbar/);
  const admin = html[pages.indexOf('admin')];
  assert.match(admin, /Convidar usuário/);
  assert.doesNotMatch(admin, /id="u-password"|Senha inicial/);
});

test('admin table states tolerate sections without pagination containers', async () => {
  const admin = await readFile('public/js/admin.js', 'utf8');
  assert.match(admin, /const pagination = document\.getElementById\(tbodyId\.replace\(\/-tbody\$\/, '-pagination'\)\);/);
  assert.match(admin, /if \(pagination\) clear\(pagination\);/);
});

test('profile exposes safe API errors instead of hiding upload and save failures', async () => {
  const profile = await readFile('public/js/profile.js', 'utf8');
  assert.match(profile, /async function responseError\(response, fallback\)/);
  assert.match(profile, /responseError\(res, 'O servidor recusou o arquivo/);
  assert.match(profile, /Não foi possível salvar o perfil: \$\{err\.message\}/);
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

test('public content pages expose server pagination and category filters', async () => {
  const [knowledge, academy, benefits, pagination] = await Promise.all([
    readFile('public/js/knowledge.js', 'utf8'),
    readFile('public/js/academy.js', 'utf8'),
    readFile('public/js/benefits.js', 'utf8'),
    readFile('public/js/pagination.js', 'utf8'),
  ]);
  assert.match(knowledge, /fetchAPIPage\(`\/api\/knowledge\?\$\{search\}`\)/);
  assert.match(knowledge, /renderPagination\(document\.getElementById\('articles-pagination'/);
  assert.match(academy, /fetchAPIPage\(`\/api\/academy\?\$\{request\}`\)/);
  assert.match(academy, /academy-filters/);
  assert.match(benefits, /fetchAPIPage\(`\/api\/benefits\?\$\{request\}`\)/);
  assert.match(benefits, /benefits-filters/);
  assert.match(pagination, /function renderPagination/);
});

test('V1 dashboard removes unavailable integrations and reminders use scoped upcoming data', async () => {
  const [html, script, reminders] = await Promise.all([
    readFile('public/dashboard.html', 'utf8'),
    readFile('public/js/dashboard.js', 'utf8'),
    readFile('public/js/reminders.js', 'utf8'),
  ]);
  assert.doesNotMatch(html, /pj-card|Nota Fiscal/);
  assert.doesNotMatch(html, /solides-card/);
  assert.match(script, /\/api\/reminders\/upcoming\?days=7/);
  assert.doesNotMatch(script, /pj-card|solides-card|app\.solides\.com\.br/);
  assert.match(reminders, /individual-target-group/);
  assert.match(reminders, /delivery-filters/);
  assert.match(reminders, /deliveries-pagination/);
});

test('admin exposes paginated audit and Ombudsman filters', async () => {
  const [html, script] = await Promise.all([
    readFile('public/admin.html', 'utf8'),
    readFile('public/js/admin.js', 'utf8'),
  ]);
  assert.match(html, /id="audit-pagination"/);
  assert.match(html, /id="ombudsman-filters"/);
  assert.match(html, /id="ombudsman-status"/);
  assert.match(script, /fetchAPIPage\(`\/api\/users\/audit\?limit=\$\{AUDIT_PAGE_SIZE\}/);
  assert.match(script, /serverPagination\('audit'/);
  assert.match(script, /ombudsman-status/);
  assert.match(script, /ombudsman-assigned/);
});

test('AutoCard shell preserves accessible navigation and reduced motion', async () => {
  const [html, css] = await Promise.all([
    readFile('public/autocard/index.html', 'utf8'),
    readFile('public/autocard/styles.css', 'utf8'),
  ]);
  assert.match(html, /href="#main-content"/);
  assert.match(html, /aria-label="Navegação principal"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /aria-label="Navegação do AutoCard"/);
  assert.match(html, /type="button"/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
