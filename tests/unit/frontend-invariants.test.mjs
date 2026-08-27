import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pages = ['dashboard', 'knowledge', 'reminders', 'academy', 'benefits', 'profile', 'admin', 'solides'];

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
    'academy', 'admin', 'auth', 'benefits', 'dashboard', 'knowledge', 'login', 'profile', 'reminders', 'sidebar', 'solides', 'ui',
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
  const navigationPages = ['dashboard', 'knowledge', 'reminders', 'academy', 'benefits', 'profile', 'solides'];
  const [auth, shell, layout, ...htmlPages] = await Promise.all([
    readFile('public/js/auth.js', 'utf8'),
    readFile('public/js/auth-shell.js', 'utf8').catch(() => ''),
    readFile('public/css/layout.css', 'utf8'),
    ...navigationPages.map((page) => readFile(`public/${page}.html`, 'utf8')),
  ]);

  assert.match(shell, /sessionStorage\.getItem\('ownerinc-auth-snapshot'\)/);
  assert.match(shell, /dataset\.authState = 'pending'/);
  assert.match(shell, /snapshot\.savedAt/);
  assert.match(shell, /root\.dataset\.portalRole/);
  assert.match(layout, /\.admin-link\s*\{[^}]*display:\s*none/);
  assert.match(layout, /html\[data-auth-state="ready"\]\[data-portal-role="admin"\]\s+\.admin-link\s*\{[^}]*display:\s*list-item/);
  assert.match(layout, /html\[data-auth-snapshot="true"\]\[data-portal-role="admin"\]\s+\.admin-link\s*\{[^}]*display:\s*list-item/);
  assert.match(layout, /html\[data-auth-snapshot="true"\]\[data-autocard-access="true"\]\s+\.autocard-link/);
  assert.match(layout, /html\[data-auth-snapshot="true"\]\[data-cms-access="true"\]\s+\.cms-link/);
  assert.match(layout, /html\[data-auth-snapshot="true"\]\[data-pos-cards-access="true"\]\s+\.pos-cards-link/);
  assert.match(auth, /sessionStorage\.setItem\('ownerinc-verified-role', user\.role\)/);
  assert.match(auth, /sessionStorage\.setItem\(AUTH_SNAPSHOT_KEY/);
  assert.match(auth, /setAuthState\('ready'\)/);
  assert.match(auth, /setAuthState\('error'\)/);
  assert.match(auth, /sessionStorage\.removeItem\('ownerinc-verified-role'\)/);
  assert.match(auth, /sessionStorage\.removeItem\(AUTH_SNAPSHOT_KEY\)/);
  assert.match(auth, /function renderAuthUnavailable\(\)/);
  assert.match(auth, /auth-error-state/);
  assert.match(auth, /window\.location\.reload\(\)/);

  for (const [index, html] of htmlPages.entries()) {
    const page = navigationPages[index];
    assert.match(html, /<script src="\.\/js\/auth-shell\.js"><\/script>[\s\S]*<\/head>/, `${page}: auth shell must run before body paint`);
    assert.match(html, /<li id="admin-link" class="admin-link">/, `${page}: missing stable admin navigation class`);
    assert.doesNotMatch(html, /id="admin-link"[^>]*style=/, `${page}: inline visibility bypasses the stable auth shell`);
  }
});

test('AutoCard navigation consumes backend access instead of a frontend title allowlist', async () => {
  const [auth, apiAuth] = await Promise.all([
    readFile('public/js/auth.js', 'utf8'),
    readFile('api/middleware/auth.js', 'utf8'),
  ]);

  assert.match(apiAuth, /const \{ can, canUseAutoCard, canUsePosCards \} = require\('\.\/policy'\)/);
  assert.match(apiAuth, /req\.user\.autocard_access = canUseAutoCard\(req\.user\)/);
  assert.match(auth, /document\.documentElement\.dataset\.autocardAccess = String\(user\?\.autocard_access === true\)/);
  assert.doesNotMatch(auth, /analista de dho|assistente de dho|coordenador de dho|gerente de dho/i);
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
  const [profile, upload] = await Promise.all([
    readFile('public/js/profile.js', 'utf8'),
    readFile('api/routes/upload.js', 'utf8'),
  ]);
  assert.match(profile, /async function responseError\(response, fallback\)/);
  assert.match(profile, /responseError\(res, 'O servidor recusou o arquivo/);
  assert.match(profile, /Não foi possível salvar o perfil: \$\{err\.message\}/);
  assert.match(profile, /MAX_PHOTO_SIZE = 500 \* 1024/);
  assert.match(profile, /typeof photoURL !== 'string' \|\| !photoURL/);
  assert.match(profile, /frameWidth: avatarButton\?\.clientWidth \|\| 0/);
  assert.match(profile, /frameWidth: cropFrame\?\.clientWidth \|\| 0/);
  assert.match(profile, /if \(removed\) avatarButton\.focus\(\);/);
  assert.match(profile, /if \(saved\) closeCropDialog\(\);/);
  assert.match(profile, /Escolha uma imagem JPEG, PNG ou WebP de até 500 KB/);
  assert.match(profile, /runProfileAction/);
  assert.doesNotMatch(profile, /users\/me\/export/);
  assert.match(upload, /fileSize: 500 \* 1024/);
});

test('profile uses the topbar as its only page heading', async () => {
  const profile = await readFile('public/profile.html', 'utf8');
  assert.equal((profile.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(profile, /<header class="topbar"><h1 class="topbar-title">Meu Perfil<\/h1>/);
  assert.doesNotMatch(profile, /class="page-header"/);
});

test('admin and profile hydrate from the provisional user snapshot before API revalidation', async () => {
  const [auth, admin, profile, profileHtml] = await Promise.all([
    readFile('public/js/auth.js', 'utf8'),
    readFile('public/js/admin.js', 'utf8'),
    readFile('public/js/profile.js', 'utf8'),
    readFile('public/profile.html', 'utf8'),
  ]);
  assert.match(auth, /export function getCachedUserSnapshot\(\)/);
  assert.match(auth, /user: \{/);
  assert.doesNotMatch(admin, /await auth\.authStateReady\(\)/);
  assert.match(admin, /let me = cachedUser;/);
  assert.match(admin, /if \(me\) buildTabs\(false\);/);
  assert.match(admin, /me = await requireAuth\(true\);/);
  assert.match(profile, /const user = cachedUser \|\| \{\};/);
  assert.match(profile, /if \(Object\.keys\(user\)\.length\) \{\s*applyProfileFields\(user\);\s*renderAvatar\(user\.photo_url, user\.name\);/);
  assert.match(profile, /const verifiedUser = await requireAuth\(\);/);
  assert.match(profileHtml, /<textarea[^>]+class="form-textarea"[^>]+id="p-bio"/);
  assert.match(profileHtml, /id="photo-crop-frame"[^>]+role="img"/);
});

test('login keeps a visible heading and uses local icons', async () => {
  const [login, loginScript] = await Promise.all([
    readFile('public/login.html', 'utf8'),
    readFile('public/js/login.js', 'utf8'),
  ]);
  assert.equal((login.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(login, /<h1 id="login-title"/);
  assert.match(login, /assets\/icons\.svg#eye/);
  assert.match(login, /id="email"[^>]*aria-label="E-mail"/);
  assert.match(login, /id="password"[^>]*aria-label="Senha"/);
  assert.match(login, /id="reset-email"[^>]*aria-label="Seu e-mail cadastrado"/);
  assert.doesNotMatch(login, /lucide\.min\.js/);
  assert.match(loginScript, /currentTarget\.querySelector\('\.icon use'\)/);
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

test('admin job titles come from the API instead of an inline catalog', async () => {
  const script = await readFile('public/js/admin.js', 'utf8');
  assert.match(script, /fetchAPIPage\('\/api\/job-titles\?all=true&limit=100&offset=0'\)/);
  assert.match(script, /jobTitles = result\.data/);
  assert.match(script, /jobTitles\.filter\(title => title\.active \|\| title\.id === selectedId\)/);
  assert.match(script, /text: title\.active \? title\.name : `\$\{title\.name\} \(inativo\)`/);
  assert.doesNotMatch(script, /(?:const|let|var)\s+\w*(?:catalog|titles?)\w*\s*=\s*\[\s*(?!\])/i);
  for (const title of [
    'Analista de RH Sênior', 'Gerente de RH', 'Analista Administrativo',
    'Coordenador de Compras', 'Social Media',
  ]) {
    assert.equal(script.includes(title), false, `admin script must not hardcode ${title}`);
  }
});

test('public content pages expose server pagination and category filters', async () => {
  const [knowledge, academy, benefits, pagination] = await Promise.all([
    readFile('public/js/knowledge.js', 'utf8'),
    readFile('public/js/academy.js', 'utf8'),
    readFile('public/js/benefits.js', 'utf8'),
    readFile('public/js/pagination.js', 'utf8'),
  ]);
  assert.match(knowledge, /fetchAPIPage\(`\/api\/knowledge\?\$\{search\}`\)/);
  assert.match(knowledge, /let articlesRequest = 0/);
  assert.match(knowledge, /const requestToken = \+\+articlesRequest/);
  assert.match(knowledge, /if \(requestToken !== articlesRequest\) return/);
  assert.match(knowledge, /renderPagination\(document\.getElementById\('articles-pagination'/);
  assert.match(academy, /fetchAPIPage\(`\/api\/academy\?\$\{request\}`\)/);
  assert.match(academy, /academy-filters/);
  assert.match(benefits, /fetchAPIPage\(`\/api\/benefits\?\$\{request\}`\)/);
  assert.match(benefits, /benefits-filters/);
  assert.match(pagination, /function renderPagination/);
});

test('V1 dashboard keeps scoped data while using the editorial home composition', async () => {
  const [html, script, reminders, homeCss] = await Promise.all([
    readFile('public/dashboard.html', 'utf8'),
    readFile('public/js/dashboard.js', 'utf8'),
    readFile('public/js/reminders.js', 'utf8'),
    readFile('public/css/dashboard-home.css', 'utf8'),
  ]);
  assert.doesNotMatch(html, /pj-card|Nota Fiscal/);
  assert.doesNotMatch(html, /solides-card/);
  assert.match(script, /\/api\/reminders\/upcoming\?days=7/);
  assert.doesNotMatch(script, /pj-card|solides-card|app\.solides\.com\.br/);
  assert.match(html, /class="dashboard-hero"/);
  assert.match(html, /id="announcements-preview" class="dashboard-story-rail"/);
  assert.match(html, /id="quick-links" class="dashboard-areas-grid"/);
  assert.match(script, /renderHero\(announcements\[0\]\)/);
  assert.match(homeCss, /\.dashboard-hero\s*\{/);
  assert.match(homeCss, /@media \(max-width: 768px\)/);
  assert.match(homeCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(reminders, /individual-target-group/);
  assert.match(reminders, /delivery-filters/);
  assert.match(reminders, /deliveries-pagination/);
});

test('admin exposes paginated audit without removed sector controls', async () => {
  const [html, script] = await Promise.all([
    readFile('public/admin.html', 'utf8'),
    readFile('public/js/admin.js', 'utf8'),
  ]);
  assert.match(html, /id="audit-pagination"/);
  assert.match(script, /fetchAPIPage\(`\/api\/users\/audit\?limit=\$\{AUDIT_PAGE_SIZE\}/);
  assert.match(script, /serverPagination\('audit'/);
  assert.doesNotMatch(html, /ombudsman|Ouvidoria|viewOmbudsman/i);
  assert.doesNotMatch(script, /ombudsman|Ouvidoria|viewOmbudsman/i);
});

test('AutoCard shell preserves accessible navigation and reduced motion', async () => {
  const [html, css, ...portalPages] = await Promise.all([
    readFile('public/autocard.html', 'utf8'),
    readFile('public/autocard/styles.css', 'utf8'),
    ...pages.map((page) => readFile(`public/${page}.html`, 'utf8')),
  ]);
  assert.match(html, /href="#main-content"/);
  assert.match(html, /aria-label="Navegação principal"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /aria-label="Navegação do AutoCard"/);
  assert.match(html, /type="button"/);
  assert.match(html, /<script defer src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/html2canvas\/1\.4\.1\/html2canvas\.min\.js" integrity="sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu\+Wgds8Gp\/gU33kqBtgNS4tSPHuGibyoeqMV\/TJlSKda6FXzoEyYGjTe\+vXA==" crossorigin="anonymous"><\/script>/);
  for (const [index, pageHtml] of portalPages.entries()) {
    const page = pages[index];
    assert.match(pageHtml, /<li class="autocard-link"><a href="\.\/autocard\.html"/, `${page}: missing canonical AutoCard link`);
    assert.doesNotMatch(pageHtml, /href="\.\/autocard\/"/, `${page}: retains legacy AutoCard link`);
  }
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('Cards Pós page and navigation stay hidden until the server verifies access', async () => {
  const [html, app, guard, auth, sidebar, layout] = await Promise.all([
    readFile('public/cards-pos.html', 'utf8'),
    readFile('public/cards-pos/app.js', 'utf8'),
    readFile('public/cards-pos/guard.js', 'utf8'),
    readFile('public/js/auth.js', 'utf8'),
    readFile('public/js/sidebar.js', 'utf8'),
    readFile('public/css/layout.css', 'utf8'),
  ]);
  assert.match(html, /type="module" src="\.\/cards-pos\/app\.js"/);
  assert.match(guard, /requireAuth\(\)/);
  assert.match(guard, /user\.pos_cards_access === true/);
  assert.match(app, /if \(await requirePosCards\(\)\) init\(\)/);
  assert.match(auth, /dataset\.posCardsAccess = String\(user\?\.pos_cards_access === true\)/);
  assert.doesNotMatch(sidebar, /posCardsItem|createElement\('li'\)/);
  assert.match(html, /class="pos-cards-link"/);
  assert.match(layout, /\.pos-cards-link \{ display: none; \}/);
  assert.match(layout, /html\[data-auth-state="ready"\]\[data-pos-cards-access="true"\]\s+\.pos-cards-link \{ display: list-item; \}/);
  assert.doesNotMatch(`${html}${app}${guard}`, /\/api\/(?!pos-cards)/);
});

test('authenticated shell is generated from one static build source', async () => {
  const generator = await readFile('scripts/generate-public-shell.mjs', 'utf8');
  assert.match(generator, /generated:portal-sidebar/);
  assert.match(generator, /generated:portal-topbar/);
  assert.match(generator, /id="btn-new"/);
  assert.match(generator, /id="btn-new-reminder"/);
  for (const page of ['dashboard', 'knowledge', 'reminders', 'academy', 'benefits', 'announcements', 'profile', 'admin', 'cms', 'autocard', 'cards-pos', 'solides']) {
    const html = await readFile(`public/${page}.html`, 'utf8');
    assert.match(html, /<!-- generated:portal-sidebar -->[\s\S]*<!-- \/generated:portal-sidebar -->/, `${page}: sidebar is not generated`);
    assert.match(html, /<!-- generated:portal-topbar -->[\s\S]*<!-- \/generated:portal-topbar -->/, `${page}: topbar is not generated`);
    assert.doesNotMatch(html, /data-lucide=/, `${page}: shell contains runtime icon placeholders`);
  }
  assert.match(await readFile('public/knowledge.html', 'utf8'), /id="search"/);
  assert.match(await readFile('public/knowledge.html', 'utf8'), /id="btn-new"/);
  assert.match(await readFile('public/reminders.html', 'utf8'), /id="btn-new-reminder"/);
});
