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
  const [route, migration, schema, index] = await Promise.all([
    readFile('api/routes/autocard.js', 'utf8'),
    readFile('api/db/migrations/010_autocard.sql', 'utf8'),
    readFile('api/db/schema.sql', 'utf8'),
    readFile('api/index.js', 'utf8'),
  ]);
  assert.match(route, /router\.use\(authMiddleware, requireAutoCard\)/);
  assert.match(route, /autocard_cards/);
  assert.match(route, /autocard_media/);
  assert.match(route, /withAudit/);
  assert.match(migration, /Analista de RH.*Analista de DHO/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS autocard_cards/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS autocard_media/);
  assert.match(schema, /010_autocard/);
  assert.match(index, /app\.use\('\/api\/autocard', autocardRoutes\)/);
});

test('AutoCard UI is guarded before loading the editor', async () => {
  const [entry, guard, html, dashboard] = await Promise.all([
    readFile('public/autocard/entry.js', 'utf8'),
    readFile('public/autocard/guard.js', 'utf8'),
    readFile('public/autocard/index.html', 'utf8'),
    readFile('public/dashboard.html', 'utf8'),
  ]);
  assert.match(entry, /await requireAutoCard\(\)/);
  assert.match(entry, /import\('\.\/app\.js'\)/);
  assert.match(guard, /\/api\/autocard\/access/);
  assert.match(guard, /Acesso restrito/);
  assert.match(html, /\.\/entry\.js/);
  assert.match(html, /class="portal-wrapper"/);
  assert.match(html, /class="sidebar"/);
  assert.match(html, /class="page-body"[^>]+id="main-content"/);
  assert.match(html, /href="\.\/" class="active"/);
  assert.match(html, /id="templateGallery"/);
  const portalTopbar = html.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] || '';
  assert.doesNotMatch(portalTopbar, /AutoCard DHO/);
  assert.match(guard, /getElementById\('main-content'\)/);
  assert.match(guard, /main\.replaceChildren\(message\)/);
  assert.match(await readFile('public/autocard/app.js', 'utf8'), /\/api\/autocard\/cards/);
  assert.match(await readFile('public/autocard/app.js', 'utf8'), /\/api\/autocard\/media/);
  assert.match(dashboard, /class="autocard-link"/);
});
