import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  POS_CARDS_ADMIN_BYPASS,
  POS_CARDS_JOB_TITLES,
  canUseAutoCard,
  canUsePosCards,
} = require('../../api/middleware/policy');

const user = (role, job_title) => ({ role, job_title, permissions: {} });

test('Pos-Cards policy allows temporary admins and future exact titles', () => {
  assert.equal(POS_CARDS_ADMIN_BYPASS, true);
  assert.equal(POS_CARDS_JOB_TITLES.size, 0);
  assert.equal(canUsePosCards(user('admin', 'Diretor')), true);
  assert.equal(canUsePosCards(user('viewer', 'Analista de Pos-Vendas')), false);

  POS_CARDS_JOB_TITLES.add('analista de pos-vendas');
  try {
    assert.equal(canUsePosCards(user('viewer', 'Analista de Pos-Vendas')), true);
    assert.equal(canUsePosCards(user('viewer', 'Analista de Pos-Vendas Jr.')), false);
  } finally {
    POS_CARDS_JOB_TITLES.delete('analista de pos-vendas');
  }
});

test('Pos-Cards policy remains independent from AutoCard policy', () => {
  const rhViewer = user('viewer', 'Analista de RH Sênior');
  const admin = user('admin', 'Diretor');

  assert.equal(canUseAutoCard(rhViewer), true);
  assert.equal(canUsePosCards(rhViewer), false);
  assert.equal(canUseAutoCard(admin), false);
  assert.equal(canUsePosCards(admin), true);
});

test('auth and frontend propagate the Pos-Cards access field', async () => {
  const [authMiddleware, frontendAuth] = await Promise.all([
    readFile('api/middleware/auth.js', 'utf8'),
    readFile('public/js/auth.js', 'utf8'),
  ]);

  assert.match(authMiddleware, /req\.user\.pos_cards_access\s*=\s*canUsePosCards\(req\.user\)/);
  assert.match(frontendAuth, /dataset\.posCardsAccess\s*=\s*String\(user\?\.pos_cards_access === true\)/);
});

test('Pos-Cards navigation is gated and preserves the required link contract', async () => {
  const [html, sidebar, styles] = await Promise.all([
    readFile('public/cards-pos.html', 'utf8'),
    readFile('public/js/sidebar.js', 'utf8'),
    readFile('public/css/layout.css', 'utf8'),
  ]);

  assert.match(html, /<!-- generated:portal-sidebar -->[\s\S]*class="pos-cards-link"/);
  assert.doesNotMatch(sidebar, /posCardsItem|posCardsLink/);
  assert.match(styles, /\.pos-cards-link\s*\{\s*display:\s*none;\s*\}/);
  assert.match(styles, /html\[data-auth-state="ready"\]\[data-pos-cards-access="true"\]\s+\.pos-cards-link\s*\{\s*display:\s*list-item;\s*\}/);
});
