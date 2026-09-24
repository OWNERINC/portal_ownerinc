import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const pages = ['dashboard', 'knowledge', 'reminders', 'academy', 'benefits', 'profile', 'admin', 'solides'];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createReminderDetailHarness(source) {
  const context = {
    window: { location: { hash: '' } },
    reminderDetail: { hidden: true, focus() { this.focused = true; } },
    reminderDetailTitle: { textContent: '' },
    reminderDetailMeta: { textContent: '' },
    reminderDetailContent: {
      childNodes: [],
      append(...children) { this.childNodes.push(...children); },
    },
    reminderDetailRequest: 0,
    page: 4,
    fetchImpl: () => { throw new Error('fetchImpl not configured'); },
    rendered: [],
    states: [],
    fetchAPI: (...args) => context.fetchImpl(...args),
    clear(node) {
      node.childNodes = [];
      return node;
    },
    element: (tag, options = {}) => ({ tag, ...options }),
    renderReminderDetail: detail => context.rendered.push(detail),
    renderReminderDetailState: (message, retry) => context.states.push({ message, retry }),
    encodeURIComponent,
  };
  context.reminderIdFromHash = (hash = context.window.location.hash) => {
    const match = /^#reminder-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(hash);
    return match ? match[1].toLowerCase() : null;
  };
  vm.runInNewContext(`${source}\nglobalThis.loadReminderDetail = loadReminderDetail;`, context, { filename: 'reminders.js' });
  return context;
}

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

test('authenticated requests centralize auth redirects without treating permission denial as logout', async () => {
  const auth = await readFile('public/js/auth.js', 'utf8');
  const authenticatedFetch = auth.slice(auth.indexOf('function authRedirectReason'), auth.indexOf('async function requestAPI'));
  const requireAuth = auth.slice(auth.indexOf('export async function requireAuth'), auth.indexOf('export async function logout'));
  assert.match(authenticatedFetch, /response\.status === 401/);
  assert.match(authenticatedFetch, /response\.clone\(\)/);
  assert.match(authenticatedFetch, /clearVerifiedRole\(\)/);
  assert.match(authenticatedFetch, /await signOut\(auth\)\.catch/);
  assert.match(authenticatedFetch, /redirectToLogin\(/);
  assert.match(authenticatedFetch, /body\?\.reason === 'email-not-verified'\) return 'email'/);
  assert.match(authenticatedFetch, /\/api\/users\/me/);
  assert.match(requireAuth, /if \(error\.status === 401 \|\| error\.status === 403\) return null;/);
  assert.doesNotMatch(authenticatedFetch, /response\.status === 403\) \{/);
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
  const [profile, upload, auth] = await Promise.all([
    readFile('public/js/profile.js', 'utf8'),
    readFile('api/routes/upload.js', 'utf8'),
    readFile('public/js/auth.js', 'utf8'),
  ]);
  assert.match(profile, /const res = await authenticatedFetch\('\/api\/upload\/photo', \{[\s\S]*body: formData/);
  assert.doesNotMatch(profile, /fetch\('\/api\/upload\/photo'/);
  assert.doesNotMatch(profile, /getIdToken\(\)/);
  assert.match(profile, /responseError\(res, 'O servidor recusou o arquivo/);
  assert.match(profile, /Não foi possível salvar o perfil: \$\{err\.message\}/);
  assert.match(profile, /MAX_PHOTO_SIZE = 500 \* 1024/);
  assert.match(profile, /typeof photoURL !== 'string' \|\| !photoURL/);
  assert.match(profile, /frameWidth: avatarButton\?\.clientWidth \|\| 0/);
  assert.match(profile, /frameWidth: cropFrame\?\.clientWidth \|\| 0/);
   assert.match(profile, /const focusHidden =/);
  assert.match(profile, /if \(saved\) closeCropDialog\(\);/);
  assert.match(profile, /Escolha uma imagem JPEG, PNG ou WebP de até 500 KB/);
  assert.match(profile, /runProfileAction/);
  assert.doesNotMatch(profile, /users\/me\/export/);
  assert.match(auth, /export async function authenticatedFetch\(/);
  assert.match(auth, /await handleAuthenticationFailure\(path, response\)/);
  assert.match(auth, /path === '\/api\/users\/me' \? 'access' : null/);
  assert.match(upload, /fileSize: 500 \* 1024/);
});

test('profile uses the topbar as its only page heading', async () => {
  const profile = await readFile('public/profile.html', 'utf8');
  assert.equal((profile.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(profile, /<header class="topbar"><h1 class="topbar-title">Meu Perfil<\/h1>/);
  assert.doesNotMatch(profile, /class="page-header"/);
});

test('admin and profile mount from validated identity while navigation snapshots stay visual', async () => {
  const [auth, admin, profile, profileHtml] = await Promise.all([
    readFile('public/js/auth.js', 'utf8'),
    readFile('public/js/admin.js', 'utf8'),
    readFile('public/js/profile.js', 'utf8'),
    readFile('public/profile.html', 'utf8'),
  ]);
  assert.match(auth, /export function getCachedUserSnapshot\(\)/);
  assert.match(auth, /user: \{/);
  assert.doesNotMatch(admin, /await auth\.authStateReady\(\)/);
  assert.match(admin, /const me = page\.user;/);
  assert.doesNotMatch(admin, /clear\(document\.getElementById\('admin-tabs'\)\)/);
  const router = await readFile('public/js/router.js', 'utf8');
  assert.match(router, /getCurrentUserDoc\(\)/);
  assert.match(router, /if \(!routeAllowed\(activeURL\.pathname, user\)\)/);
  assert.match(profile, /const user = \{ \.\.\.page\.user \};/);
  assert.match(profile, /if \(Object\.keys\(user\)\.length\) \{\s*applyProfileFields\(user\);\s*renderAvatar\(user\.photo_url, user\.name\);/);
  assert.doesNotMatch(profile, /const user = cachedUser/);
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

test('Portal entry verifies Firebase before routing to dashboard or login', async () => {
  const [html, script] = await Promise.all([
    readFile('public/index.html', 'utf8'),
    readFile('public/js/index.js', 'utf8'),
  ]);
  assert.match(html, /Verificando acesso/);
  assert.match(html, /src="\.\/assets\/icon-branco\.svg"/);
  assert.match(html, /animation:\s*portal-pulse 2\.8s ease-in-out infinite/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /<script type="module" src="\.\/js\/index\.js"><\/script>/);
  assert.match(script, /auth\.authStateReady\(\)/);
  assert.match(script, /auth\.currentUser \? '\.\/dashboard\.html' : '\.\/login\.html'/);
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
    'Analista de DHO Sênior', 'Gerente de DHO', 'Analista Administrativo',
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
  assert.match(knowledge, /renderPagination\(articlesPagination/);
  assert.match(academy, /fetchAPIPage\(`\/api\/academy\?\$\{request\}`\)/);
  assert.match(academy, /academy-filters/);
  assert.match(academy, /let coursesRequest = 0/);
  assert.match(academy, /if \(requestToken !== coursesRequest\) return/);
  assert.match(academy, /if \(!courses\.length && offset > 0\)/);
  assert.match(academy, /updateUrl\(category, 0\)/);
  assert.match(academy, /return loadCourses\(\)/);
  assert.match(academy, /if \(!courses\.length\) \{[\s\S]*clear\(pagination\)/);
  assert.match(benefits, /fetchAPIPage\(`\/api\/benefits\?\$\{request\}`\)/);
  assert.match(benefits, /benefits-filters/);
  assert.match(benefits, /let benefitsRequest = 0/);
  assert.match(benefits, /if \(requestToken !== benefitsRequest\) return/);
  assert.match(benefits, /if \(!benefits\.length && offset > 0\)/);
  assert.match(benefits, /updateUrl\(query\.get\('category'\) \|\| '', 0\)/);
  assert.match(benefits, /return loadBenefits\(\)/);
  assert.match(benefits, /if \(!benefits\.length\) \{[\s\S]*clear\(pagination\)/);
  assert.match(pagination, /function renderPagination/);
  assert.match(academy, /setPaginationBusy\(pagination, true\)/);
  assert.match(academy, /setPaginationBusy\(pagination, false\)/);
  assert.match(knowledge, /setPaginationBusy\(articlesPagination, true\)/);
  assert.match(knowledge, /setPaginationBusy\(articlesPagination, false\)/);
});

test('Knowledge detail reads the authoritative article and stale pages recover', async () => {
  const [knowledge, reminders] = await Promise.all([
    readFile('public/js/knowledge.js', 'utf8'),
    readFile('public/js/reminders.js', 'utf8'),
  ]);
  assert.match(knowledge, /fetchAPI\(`\/api\/knowledge\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.doesNotMatch(knowledge, /articles\.find/);
  assert.match(knowledge, /showState\(articleContent, 'Carregando artigo…'/);
  assert.match(knowledge, /error\?\.status === 404/);
  assert.match(knowledge, /articleTitle\.focus\(\)/);
  assert.match(knowledge, /if \(!articles\.length && offset > 0\)/);
  assert.match(knowledge, /return loadArticles\(\)/);
  assert.match(reminders, /const PAGE_SIZE = 50/);
  assert.match(reminders, /let remindersRequest = 0/);
  assert.match(reminders, /const requestToken = \+\+remindersRequest/);
  assert.match(reminders, /const requestPage = page/);
  assert.match(reminders, /if \(!loaded\.length && requestPage > 0\)/);
  assert.match(reminders, /const lastPage = Math\.max\(0, Math\.ceil\(loadedTotal \/ PAGE_SIZE\) - 1\)/);
  assert.match(reminders, /if \(requestToken !== remindersRequest\) return/);
  assert.match(reminders, /return loadReminders\(\)/);
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

test('reminder UI derives safe content links and formats civil dates in São Paulo', async () => {
  const [dashboard, reminders, html] = await Promise.all([
    readFile('public/js/dashboard.js', 'utf8'),
    readFile('public/js/reminders.js', 'utf8'),
    readFile('public/reminders.html', 'utf8'),
  ]);
  for (const source of [dashboard, reminders]) {
    assert.match(source, /America\/Sao_Paulo/);
    assert.match(source, /content_url/);
    assert.match(source, /reminders\.html#reminder-/);
  }
  assert.match(dashboard, /function daysUntil/);
  assert.match(dashboard, /civilDateOrdinal/);
  assert.match(reminders, /function formatCivilDate/);
  assert.match(reminders, /deliveriesRequest/);
  assert.match(reminders, /delivery\.reason/);
  assert.match(reminders, /function reminderIdFromHash/);
  assert.match(reminders, /location\.hash/);
  assert.match(reminders, /fetchAPI\(`\/api\/reminders\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(reminders, /pageScope\.listen\(window, 'hashchange', loadReminderDetail\)/);
  assert.match(reminders, /reminderDetailRequest/);
  assert.match(reminders, /error\.status === 404/);
  assert.match(reminders, /focusReminderDetail\(\)/);
  assert.doesNotMatch(reminders, /reminders\.push\(detail\)/);
  assert.match(html, /Lembrete.*Destinatário.*Motivo.*Tentativas/);
  assert.match(html, /id="delivery-reminder"/);
  assert.match(html, /id="reminder-detail"/);
});

test('reminder health timestamp formatting keeps absent values neutral', async () => {
  const reminders = await readFile('public/js/reminders.js', 'utf8');
  const sourceStart = reminders.indexOf('function formatTimestamp(');
  const source = reminders.slice(sourceStart, reminders.indexOf('\n\nfunction tableState', sourceStart));
  const context = { Intl, TIME_ZONE: 'America/Sao_Paulo' };
  vm.runInNewContext(`${source}\nglobalThis.formatTimestamp = formatTimestamp;`, context, { filename: 'reminders.js' });

  assert.equal(context.formatTimestamp(null), '—');
  assert.equal(context.formatTimestamp(undefined), '—');
  assert.match(context.formatTimestamp('2026-08-17T12:00:00.000Z'), /17\/08\/2026/);
});

test('reminder hash detail ignores stale responses, preserves pagination, and retries 404s', async () => {
  const reminders = await readFile('public/js/reminders.js', 'utf8');
  const sourceStart = reminders.indexOf('async function loadReminderDetail(');
  const source = reminders.slice(sourceStart, reminders.indexOf('\n\nasync function loadReminders', sourceStart));
  const context = createReminderDetailHarness(source);
  const firstId = '550e8400-e29b-41d4-a716-446655440000';
  const secondId = '550e8400-e29b-41d4-a716-446655440001';
  const first = deferred();
  const second = deferred();
  context.fetchImpl = path => path.includes(firstId) ? first.promise : second.promise;

  context.window.location.hash = `#reminder-${firstId}`;
  const firstLoad = context.loadReminderDetail();
  context.window.location.hash = `#reminder-${secondId}`;
  const secondLoad = context.loadReminderDetail();
  first.resolve({ id: firstId, title: 'Stale' });
  second.resolve({ id: secondId, title: 'Current' });
  await Promise.all([firstLoad, secondLoad]);

  assert.deepEqual(context.rendered.map(detail => detail.id), [secondId]);
  assert.equal(context.page, 4);

  context.window.location.hash = `#reminder-${firstId}`;
  context.fetchImpl = async () => { throw { status: 404 }; };
  await context.loadReminderDetail();
  assert.match(context.states.at(-1).message, /não está disponível/);
  assert.equal(typeof context.states.at(-1).retry, 'function');

  context.fetchImpl = async () => ({ id: firstId, title: 'Retried' });
  await context.states.at(-1).retry();
  assert.equal(context.rendered.at(-1).id, firstId);
});

test('admin exposes paginated audit without removed sector controls', async () => {
  const [html, script] = await Promise.all([
    readFile('public/admin.html', 'utf8'),
    readFile('public/js/admin.js', 'utf8'),
  ]);
  assert.match(html, /id="audit-pagination"/);
  assert.match(html, /Cargo ativo para atribuição e acesso atual/);
  assert.match(html, /páginas marcadas ficam disponíveis para usuários com este cargo enquanto ele estiver ativo/);
  assert.match(script, /fetchAPIPage\(`\/api\/users\/audit\?limit=\$\{AUDIT_PAGE_SIZE\}/);
  assert.match(script, /serverPagination\('audit'/);
  assert.doesNotMatch(html, /ombudsman|Ouvidoria|viewOmbudsman/i);
  assert.doesNotMatch(script, /ombudsman|Ouvidoria|viewOmbudsman/i);
});

test('global navigation omits Benefits and Sólides while admin discovers gated tabs', async () => {
  const [generator, dashboard, preview, admin] = await Promise.all([
    readFile('scripts/generate-public-shell.mjs', 'utf8'),
    readFile('public/js/dashboard.js', 'utf8'),
    readFile('public/home-preview.html', 'utf8'),
    readFile('public/js/admin.js', 'utf8'),
  ]);
  const sidebarSource = generator.match(/const pages = \[[\s\S]*?\n\];/)?.[0] || '';
  const adminTabs = admin.match(/const TABS = \[[\s\S]*?\n\];/)?.[0] || '';
  assert.doesNotMatch(sidebarSource, /benefits|solides/i);
  assert.doesNotMatch(dashboard, /benefits\.html|Benefícios/);
  assert.doesNotMatch(preview, /benefits\.html|Benefícios|solides\.html|Sólides/);
  assert.doesNotMatch(adminTabs, /benefits|solides/i);
  assert.match(admin, /if \(can\(me, 'manageBenefits'\)\) tabs\.push\(\['benefits', 'Benefícios'\]\)/);
  assert.match(admin, /if \(!can\(me, 'manageSolides'\)\) return;/);
  assert.match(admin, /fetchAPI\('\/api\/solides\/admin\/status'\)/);
  assert.match(admin, /if \(solidesAdminAvailable\) tabs\.push\(\['solides', 'Sólides'\]\)/);
  assert.match(admin, /buildTabs\(\);\s*if \(can\(me, 'manageUsers'\)[\s\S]*void discoverAdminFeatures\(\)\.then/);
  for (const page of ['dashboard', 'knowledge', 'reminders', 'academy', 'profile', 'admin', 'benefits', 'solides']) {
    const html = await readFile(`public/${page}.html`, 'utf8');
    const sidebar = html.match(/<!-- generated:portal-sidebar -->[\s\S]*?<!-- \/generated:portal-sidebar -->/)?.[0] || '';
    assert.doesNotMatch(sidebar, /benefits\.html|Benefícios|solides\.html|Sólides/);
  }
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
  assert.match(html, /type="module" src="\.\/js\/router-bootstrap\.js"/);
  assert.match(guard, /requireAuth\(\)/);
  assert.match(guard, /user\.pos_cards_access === true/);
  const router = await readFile('public/js/router.js', 'utf8');
  assert.match(router, /path === '\/cards-pos\.html'\) return user\.pos_cards_access === true/);
  assert.match(app, /export function mount\(page\)/);
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
  assert.doesNotMatch(generator.match(/const pages = \[[\s\S]*?\n\];/)?.[0] || '', /benefits|solides/i);
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
