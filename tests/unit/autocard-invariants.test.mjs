import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { canUseAutoCard } = require('../../api/middleware/policy');

const dho = (name) => ({ role: 'viewer', job_title: name, permissions: {} });

function createAutoCardElement(id) {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains(name) { return classes.has(name); },
    },
    dataset: {},
    innerHTML: '',
    textContent: '',
    value: '',
    style: {
      values: {},
      setProperty(name, value) { this.values[name] = value; },
      getPropertyValue(name) { return this.values[name] || ''; },
    },
    attributes: {},
    clientWidth: id === 'cropFrame' ? 200 : 0,
    clientHeight: id === 'cropFrame' ? 200 : 0,
    naturalWidth: id === 'cropImage' ? 1000 : 0,
    naturalHeight: id === 'cropImage' ? 500 : 0,
    complete: id === 'cropImage',
    open: false,
    focused: false,
    pointerId: null,
    onclick: null,
    onchange: null,
    oninput: null,
    dispatchEvent(event) {
      if (event.type === 'input') this.oninput?.(event);
      listeners.get(event.type)?.forEach(handler => handler({ ...event, currentTarget: this }));
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    setPointerCapture(pointerId) {
      this.pointerId = pointerId;
    },
    releasePointerCapture(pointerId) {
      if (this.pointerId === pointerId) this.pointerId = null;
    },
    focus() {
      this.focused = true;
      this.ownerDocument.activeElement = this;
    },
    getAttribute(name) {
      if (name !== 'style') return this.attributes[name] || null;
      const source = this.innerHTML.match(/<img class="card-media" src="[^"]+" style="([^"]*)"/);
      return this.attributes.style || source?.[1] || null;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      listeners.get('close')?.forEach(handler => handler({ type: 'close', currentTarget: this }));
    },
    querySelector(selector) {
      if (selector !== '.card-media') return null;
      const source = this.innerHTML.match(/<img class="card-media" src="([^"]+)"(?: style="([^"]*)")?/);
      return source ? { src: source[1], getAttribute: name => name === 'style' ? source[2] || null : null } : null;
    },
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
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const element = createAutoCardElement(id);
        element.ownerDocument = document;
        elements.set(id, element);
      }
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
  const cropSource = (await readFile('public/autocard/crop.js', 'utf8')).replace(/^export /gm, '');
  const appSource = app.replace(/^import[^\n]+\n/gm, '');
  vm.runInContext(`${cropSource}\n${appSource}\n${employee}\nglobalThis.__autocardTest = { current: () => current, cropDraft: () => cropDraft, selectTemplate, renderCard };`, context);
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
    isHidden: id => elements.get(id).classList.contains('hidden'),
    openCrop() {
      const button = elements.get('cropButton');
      button.focus();
      button.onclick();
    },
    dragCrop(dx, dy) {
      const frame = elements.get('cropFrame');
      frame.dispatchEvent({ type: 'pointerdown', pointerId: 1, clientX: 0, clientY: 0 });
      frame.dispatchEvent({ type: 'pointermove', pointerId: 1, clientX: dx, clientY: dy });
      frame.dispatchEvent({ type: 'pointerup', pointerId: 1, clientX: dx, clientY: dy });
    },
    setZoom(zoom) {
      const input = elements.get('cropZoom');
      input.value = String(zoom);
      input.dispatchEvent({ type: 'input' });
    },
    applyCrop() {
      elements.get('cropApply').onclick();
    },
    cancelCrop() {
      elements.get('cropCancel').onclick();
    },
    resetCrop() {
      elements.get('cropReset').onclick();
    },
    draft: () => JSON.parse(JSON.stringify(context.__autocardTest.cropDraft())),
    focusedId: () => document.activeElement?.id || null,
    toast: () => elements.get('toast'),
  };
}

async function createAutoCardCropHarness() {
  const source = await readFile('public/autocard/crop.js', 'utf8');
  const context = vm.createContext({});
  const cropSource = source.replace(/^export /gm, '');
  vm.runInContext(`${cropSource}\nglobalThis.__autocardCropTest = { DEFAULT_MEDIA_CROP, normalizeMediaCrop, cropStyle, dragMediaCrop };`, context);
  const crop = context.__autocardCropTest;
  return {
    DEFAULT_MEDIA_CROP: JSON.parse(JSON.stringify(crop.DEFAULT_MEDIA_CROP)),
    normalizeMediaCrop: value => JSON.parse(JSON.stringify(crop.normalizeMediaCrop(value))),
    cropStyle: crop.cropStyle,
    dragMediaCrop: (value, metrics) => JSON.parse(JSON.stringify(crop.dragMediaCrop(value, metrics))),
  };
}

test('AutoCard crop utility normalizes, styles, and drags media safely', async () => {
  const { DEFAULT_MEDIA_CROP, normalizeMediaCrop, cropStyle, dragMediaCrop } = await createAutoCardCropHarness();

  assert.deepEqual(DEFAULT_MEDIA_CROP, { x: 0.5, y: 0.5, zoom: 1 });
  assert.deepEqual(normalizeMediaCrop(), { x: 0.5, y: 0.5, zoom: 1 });
  assert.deepEqual(normalizeMediaCrop({ x: 2, y: -1, zoom: 8 }), { x: 1, y: 0, zoom: 3 });
  assert.deepEqual(normalizeMediaCrop({ x: 'bad' }), { x: 0.5, y: 0.5, zoom: 1 });
  assert.equal(cropStyle({ x: 0.25, y: 0.75, zoom: 2 }), '--crop-x:25%;--crop-y:75%;--crop-zoom:2');

  const moved = dragMediaCrop({ x: 0.5, y: 0.5, zoom: 2 }, {
    dx: 100,
    dy: 0,
    frameWidth: 200,
    frameHeight: 200,
    imageWidth: 1000,
    imageHeight: 500,
  });
  assert.ok(moved.x < 0.5);
  assert.equal(moved.y, 0.5);

  assert.deepEqual(dragMediaCrop({ x: 0.25, y: 0.75, zoom: 1 }, {
    dx: 100,
    dy: -100,
    frameWidth: 200,
    frameHeight: 200,
    imageWidth: 200,
    imageHeight: 200,
  }), { x: 0.25, y: 0.75, zoom: 1 });
});

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
  assert.equal(harness.isHidden('cropButton'), false);

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
  assert.equal(harness.isHidden('cropButton'), true);
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

test('AutoCard crop editor keeps drafts isolated until apply and restores focus', async () => {
  const harness = await createAutoCardLifecycleHarness();

  harness.selectTemplate('aniversariante', { mediaId: 'photo', mediaCrop: { x: 0.2, y: 0.8, zoom: 2 } });
  assert.equal(harness.state().mediaCrop.x, 0.2);
  await harness.resolve(0);
  harness.openCrop();
  harness.dragCrop(40, 0);
  harness.setZoom(2.5);
  harness.applyCrop();
  assert.equal(harness.state().mediaCrop.zoom, 2.5);
  assert.notEqual(harness.state().mediaCrop.x, 0.2);
  assert.equal(harness.focusedId(), 'cropButton');

  const confirmed = { ...harness.state().mediaCrop };
  harness.openCrop();
  harness.setZoom(1.4);
  assert.equal(harness.draft().zoom, 1.4);
  assert.equal(harness.state().mediaCrop.zoom, 2.5);
  harness.cancelCrop();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.state().mediaCrop)), confirmed);

  harness.openCrop();
  harness.setZoom(2.4);
  harness.resetCrop();
  harness.applyCrop();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.state().mediaCrop)), { x: 0.5, y: 0.5, zoom: 1 });
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
  assert.match(app, /mediaCrop:\s*\{\.\.\.DEFAULT_MEDIA_CROP\}/);
  assert.match(app, /mediaCrop:normalizeMediaCrop\(card\?\.mediaCrop\)/);
  assert.match(app, /function loadMedia\(mediaId,version,openCrop=false\)/);
  assert.match(app, /cropButton'\)\?\.classList\.remove\('hidden'\)/);
  assert.match(app, /if\(openCrop\)openCropEditor\(\)/);
  assert.match(app, /style="\$\{cropStyle\(current\.mediaCrop\)\}"/);
  assert.match(app, /mediaCrop:current\.mediaCrop/);
  assert.match(app, /image\.onload=\(\)=>\{cleanup\(\)/);
  assert.match(app, /image\.onerror=\(\)=>\{cleanup\(\)/);
  assert.match(app, /await img\.decode\(\)/);
  assert.match(app, /button\.disabled=true/);
  assert.match(app, /button\.disabled=false/);
  assert.match(app, /Não foi possível exportar o card/);
  assert.match(app, /duplicate[\s\S]*catch\(\(\)=>toast\('Não foi possível duplicar o card\.'/);
  assert.match(app, /method:'DELETE'[\s\S]*catch\(\(\)=>toast\('Não foi possível excluir o card\.'/);
  assert.match(app, /URL\.revokeObjectURL/);
  assert.match(app, /startsWith\('blob:'\)/);
  assert.match(app, /addEventListener\('pagehide'/);
  assert.match(app, /current\.mediaUrl\s*\?/);
  assert.match(app, /birthday-photo">\$\{current\.mediaUrl\?/);
  assert.doesNotMatch(app, /current\.mediaId\?`<img src="\$\{current\.mediaUrl\}/);
  assert.doesNotMatch(app, /current\.mediaUrl=data\.url/);
  assert.match(vacancy, /const photoElement = cardCanvas\.querySelector\('\.card-media'\)/);
  assert.match(vacancy, /const photoStyle = photoElement\?\.getAttribute\('style'\) \|\| ''/);
  assert.match(vacancy, /style="\$\{photoStyle\}"/);
  assert.doesNotMatch(vacancy, /\/api\/autocard\/media|mediaId|mediaUrl/);
  assert.match(app, /\/api\/autocard\/media/);
  assert.match(app, /file\.size>3\*1024\*1024/);
  assert.match(dashboard, /class="autocard-link"/);
});

test('AutoCard crop editor exposes accessible dialog and responsive frame contracts', async () => {
  const [html, styles] = await Promise.all([
    readFile('public/autocard.html', 'utf8'),
    readFile('public/autocard/styles.css', 'utf8'),
  ]);

  assert.match(html, /id="cropButton"/);
  assert.match(html, /id="cropDialog"/);
  assert.match(html, /id="cropFrame"/);
  assert.match(html, /id="cropImage"/);
  assert.match(html, /id="cropZoom"/);
  assert.match(html, /id="cropReset"/);
  assert.match(html, /id="cropCancel"/);
  assert.match(html, /id="cropApply"/);
  assert.match(html, /Ajustar enquadramento/);
  assert.match(html, /Aplicar enquadramento/);
  assert.match(html, /aria-labelledby="cropTitle"/);
  assert.match(html, /tabindex="0" role="img"/);
  assert.match(styles, /crop-frame/);
  assert.match(styles, /touch-action:none/);
  assert.match(styles, /prefers-reduced-motion/);
});
