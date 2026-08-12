import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { canUseAutoCard } = require('../../api/middleware/policy');

const dho = (name) => ({ role: 'viewer', job_title: name, permissions: {} });

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
  const [auth, route, migration, schema, index, nginx] = await Promise.all([
    readFile('public/js/auth.js', 'utf8'),
    readFile('api/routes/autocard.js', 'utf8'),
    readFile('api/db/migrations/010_autocard.sql', 'utf8'),
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
  assert.match(migration, /Analista de RH.*Analista de DHO/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS autocard_cards/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS autocard_media/);
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
  assert.match(await readFile('public/autocard/app.js', 'utf8'), /\/api\/autocard\/cards/);
  const app = await readFile('public/autocard/app.js', 'utf8');
  assert.match(app, /import \{ fetchAPI \} from '\.\.\/js\/auth\.js'/);
  assert.match(app, /\/api\/autocard\/media/);
  assert.match(app, /file\.size>3\*1024\*1024/);
  assert.match(dashboard, /class="autocard-link"/);
});
