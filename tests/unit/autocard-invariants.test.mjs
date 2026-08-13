import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { canUseAutoCard } = require('../../api/middleware/policy');

const dho = (name) => ({ role: 'viewer', job_title: name, permissions: {} });

function createAutoCardElement(id) {
  return {
    id,
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    dataset: {},
    innerHTML: '',
    textContent: '',
    value: '',
    style: { setProperty() {} },
    onclick: null,
    onchange: null,
    oninput: null,
    dispatchEvent(event) {
      if (event.type === 'input') this.oninput?.(event);
    },
    querySelector(selector) {
      if (selector !== '.card-media') return null;
      const source = this.innerHTML.match(/<img class="card-media" src="([^"]+)"/);
      return source ? { src: source[1] } : null;
    },
    showModal() {},
    close() {},
  };
}

async function createAutoCardLifecycleHarness() {
  const [app, employee] = await Promise.all([
    readFile('public/autocard/app.js', 'utf8'),
    readFile('public/autocard/vacancy-enhancements.js', 'utf8'),
  ]);
  const elements = new Map();
  const listeners = new Map();
  const observers = [];
  const requests = [];
  const createdUrls = [];
  const revokedUrls = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createAutoCardElement(id));
      return elements.get(id);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    lucide: null,
  };
  const URL = {
    createObjectURL() {
      const url = `blob:asset-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe() {}
  }
  class Event {
    constructor(type) {
      this.type = type;
    }
  }
  const fetchAPIAsset = (path) => new Promise((resolve, reject) => {
    requests.push({ path, resolve, reject });
  });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  const context = vm.createContext({
    Event,
    MutationObserver,
    URL,
    clearTimeout,
    console,
    document,
    fetchAPI: async () => ({}),
    fetchAPIAsset,
    setTimeout(callback) {
      callback();
      return 0;
    },
    window,
  });
  const appSource = app.replace(/^import[^\n]+\n/, '');
  vm.runInContext(`${appSource}\n${employee}\nglobalThis.__autocardTest = { current: () => current, selectTemplate, renderCard };`, context);
  return {
    cardCanvas: elements.get('cardCanvas'),
    createdUrls,
    dispatch(type) {
      listeners.get(type)?.();
    },
    flushMutations() {
      observers.forEach(observer => observer.callback());
    },
    async reject(index, error) {
      requests[index].reject(error);
      await drain();
    },
    requests,
    async resolve(index) {
      const url = URL.createObjectURL({});
      requests[index].resolve(url);
      await drain();
      return url;
    },
    revokedUrls,
    state: () => context.__autocardTest.current(),
    selectTemplate: (key, card) => context.__autocardTest.selectTemplate(key, card),
    toast: () => elements.get('toast'),
  };
}

test('AutoCard media lifecycle revokes stale and hidden blobs and keeps variants safe', async () => {
  const harness = await createAutoCardLifecycleHarness();

  harness.selectTemplate('aniversariante', { mediaId: 'old-media' });
  harness.selectTemplate('aniversariante', { mediaId: 'new-media' });
  assert.equal(harness.requests.map(request => request.path).join(','), '/api/autocard/media/old-media,/api/autocard/media/new-media');
  assert.match(harness.cardCanvas.innerHTML, /birthday-photo/);
  assert.match(harness.cardCanvas.innerHTML, /data-lucide="cake"/);
  assert.doesNotMatch(harness.cardCanvas.innerHTML, /birthday-photo"><img|undefined|\/api\/autocard\/media/);

  const staleUrl = await harness.resolve(0);
  assert.deepEqual(harness.revokedUrls, [staleUrl]);
  assert.equal(harness.state().mediaUrl, null);

  const currentUrl = await harness.resolve(1);
  assert.equal(harness.state().mediaUrl, currentUrl);
  assert.match(harness.cardCanvas.innerHTML, new RegExp(`src="${currentUrl}"`));

  harness.dispatch('pagehide');
  assert.equal(harness.state().mediaUrl, null);
  assert.deepEqual(harness.revokedUrls, [staleUrl, currentUrl]);

  harness.selectTemplate('aniversariante', { mediaId: 'hidden-media' });
  harness.dispatch('pagehide');
  const hiddenUrl = await harness.resolve(2);
  assert.equal(harness.state().mediaUrl, null);
  assert.deepEqual(harness.revokedUrls, [staleUrl, currentUrl, hiddenUrl]);

  harness.selectTemplate('evento', { mediaId: 'failed-media' });
  await harness.reject(3, new Error('asset unavailable'));
  assert.equal(harness.state().mediaUrl, null);
  assert.match(harness.cardCanvas.innerHTML, /card-placeholder/);
  assert.doesNotMatch(harness.cardCanvas.innerHTML, /undefined|\/api\/autocard\/media/);
  assert.match(harness.toast().textContent, /Não foi possível carregar a imagem: asset unavailable/);

  harness.selectTemplate('novo_funcionario', { mediaId: 'employee-media' });
  harness.flushMutations();
  assert.doesNotMatch(harness.cardCanvas.innerHTML, /<img[^>]+src="undefined"|\/api\/autocard\/media/);
  assert.match(harness.cardCanvas.innerHTML, /employee-photo"><i data-lucide="user-plus"/);

  const employeeUrl = await harness.resolve(4);
  harness.flushMutations();
  assert.match(harness.cardCanvas.innerHTML, new RegExp(`employee-photo"><img src="${employeeUrl}"`));
  assert.doesNotMatch(harness.cardCanvas.innerHTML, /undefined|\/api\/autocard\/media/);
});

test('AutoCard access uses the exact DHO job title allowlist', () => {
  for (const title of ['Analista de DHO', 'Assistente de DHO', 'Coordenador de DHO', 'Gerente de DHO']) {
    assert.equal(canUseAutoCard(dho(title)), true, title);
  }
  for (const title of ['Analista de RH', 'DHO Manager', 'Analista de DHO Jr', 'Gerente de Pessoas', '']) {
    assert.equal(canUseAutoCard(dho(title)), false, title);
  }
  assert.equal(canUseAutoCard({ role: 'admin', permissions: { superAdmin: true }, job_title: 'Diretor' }), false);
});

test('AutoCard API is protected and uses shared PostgreSQL storage', async () => {
  const [auth, route, migration, cropMigration, schema, index, nginx] = await Promise.all([
    readFile('public/js/auth.js', 'utf8'),
    readFile('api/routes/autocard.js', 'utf8'),
    readFile('api/db/migrations/010_autocard.sql', 'utf8'),
    readFile('api/db/migrations/012_autocard_media_crop.sql', 'utf8'),
    readFile('api/db/schema.sql', 'utf8'),
    readFile('api/index.js', 'utf8'),
    readFile('nginx/nginx.conf', 'utf8'),
  ]);
  assert.match(auth, /export async function fetchAPIAsset\(/);
  assert.match(auth, /await response\.blob\(\)/);
  assert.match(auth, /URL\.createObjectURL\(blob\)/);
  assert.match(route, /router\.use\(authMiddleware, requireAutoCard\)/);
  assert.match(route, /router\.get\('\/media\/:id'/);
  assert.match(route, /autocard_cards/);
  assert.match(route, /autocard_media/);
  assert.match(route, /withAudit/);
  assert.match(route, /mediaCrop/);
  assert.match(route, /media_crop AS "mediaCrop"/);
  assert.match(route, /body\.mediaCrop/);
  assert.match(route, /media_crop = \$11::jsonb/);
  assert.match(route, /SELECT name \|\| ' v2',[\s\S]*media_crop/);
  assert.match(migration, /Analista de RH.*Analista de DHO/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS autocard_cards/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS autocard_media/);
  assert.match(cropMigration, /ADD COLUMN IF NOT EXISTS media_crop/);
  assert.match(cropMigration, /SET media_crop = '\{"x":0\.5,"y":0\.5,"zoom":1\}'::jsonb/);
  assert.match(cropMigration, /ALTER COLUMN media_crop SET DEFAULT/);
  assert.match(cropMigration, /ALTER COLUMN media_crop SET NOT NULL/);
  assert.match(cropMigration, /autocard_cards_media_crop_check/);
  assert.match(schema, /media_crop\s+JSONB/);
  assert.match(schema, /autocard_cards_media_crop_check/);
  assert.match(schema, /010_autocard/);
  assert.match(index, /app\.use\('\/api\/autocard', autocardRoutes\)/);
  assert.match(nginx, /location \^~ \/api\/autocard\/media[\s\S]*client_max_body_size 4m;[\s\S]*limit_req zone=uploads/);
});

test('AutoCard UI is guarded before loading the editor', async () => {
  const [entry, guard, html, legacy, dashboard, sidebar] = await Promise.all([
    readFile('public/autocard/entry.js', 'utf8'),
    readFile('public/autocard/guard.js', 'utf8'),
    readFile('public/autocard.html', 'utf8'),
    readFile('public/autocard/index.html', 'utf8'),
    readFile('public/dashboard.html', 'utf8'),
    readFile('public/js/sidebar.js', 'utf8'),
  ]);
  assert.match(entry, /await requireAutoCard\(\)/);
  assert.match(entry, /import\('\.\/app\.js'\)/);
  assert.match(guard, /\/api\/autocard\/access/);
  assert.match(guard, /Acesso restrito/);
  assert.match(html, /class="portal-wrapper"/);
  assert.match(html, /class="sidebar"/);
  assert.match(html, /class="topbar"/);
  assert.match(html, /class="page-body"[^>]+id="main-content"/);
  assert.match(html, /href="\.\/autocard\.html" class="active"/);
  assert.match(html, /src="\.\/autocard\/entry\.js"/);
  for (const path of [
    /<script src="\.\/js\/auth-shell\.js"><\/script>/,
    /<link rel="stylesheet" href="\.\/css\/tokens\.css">/,
    /<link rel="stylesheet" href="\.\/autocard\/styles\.css">/,
    /<link rel="stylesheet" href="\.\/css\/layout\.css">/,
    /<link rel="stylesheet" href="\.\/css\/components\.css">/,
    /<img src="\.\/assets\/logo-branco\.svg"/,
    /<img src="\.\/assets\/icon-branco\.svg"/,
    /<script src="\.\/js\/sidebar\.js"><\/script>/,
    /<script type="module" src="\.\/autocard\/entry\.js"><\/script>/,
  ]) assert.match(html, path);
  assert.match(html, /class="sidebar-toggle" id="sidebar-toggle"/);
  assert.match(html, /class="sidebar-logout"/);
  assert.match(sidebar, /mobileToggle\.className = 'mobile-menu-toggle'/);
  assert.match(sidebar, /querySelectorAll\('\.sidebar-logout'\)/);
  assert.match(sidebar, /import\('\.\/auth\.js'\)/);
  assert.match(html, /id="templateGallery"/);
  const portalTopbar = html.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] || '';
  assert.doesNotMatch(portalTopbar, /AutoCard DHO/);
  assert.match(legacy, /url=\.\.\/autocard\.html/);
  assert.match(legacy, /href="\.\.\/autocard\.html"/);
  assert.doesNotMatch(legacy, /<script\b/);
  assert.match(guard, /getElementById\('main-content'\)/);
  assert.match(guard, /main\.replaceChildren\(message\)/);
  assert.match(guard, /href: '\.\/dashboard\.html'/);
  const app = await readFile('public/autocard/app.js', 'utf8');
  const vacancy = await readFile('public/autocard/vacancy-enhancements.js', 'utf8');
  assert.match(app, /\/api\/autocard\/cards/);
  assert.match(app, /import \{ fetchAPI, fetchAPIAsset \} from '\.\.\/js\/auth\.js'/);
  assert.match(app, /fetchAPIAsset\(`/);
  assert.match(app, /mediaUrl: null/);
  assert.match(app, /URL\.revokeObjectURL/);
  assert.match(app, /startsWith\('blob:'\)/);
  assert.match(app, /addEventListener\('pagehide'/);
  assert.match(app, /current\.mediaUrl\s*\?/);
  assert.match(app, /birthday-photo">\$\{current\.mediaUrl\?/);
  assert.doesNotMatch(app, /current\.mediaId\?`<img src="\$\{current\.mediaUrl\}/);
  assert.doesNotMatch(app, /current\.mediaUrl=data\.url/);
  assert.match(vacancy, /querySelector\('\.card-media'\)\?\.src/);
  assert.doesNotMatch(vacancy, /\/api\/autocard\/media|mediaId|mediaUrl/);
  assert.match(app, /\/api\/autocard\/media/);
  assert.match(app, /file\.size>3\*1024\*1024/);
  assert.match(dashboard, /class="autocard-link"/);
});
