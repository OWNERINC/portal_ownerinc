import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { REQUIRED_CASES } from '../../scripts/test-portal-contents-acceptance.mjs';

const [runbook, review] = await Promise.all([
  readFile(new URL('../../docs/operations/portal-contents-reader.md', import.meta.url), 'utf8'),
  readFile(new URL('../../docs/reviews/2026-10-20-portal-contents-reader-acceptance.md', import.meta.url), 'utf8'),
]);

function runbookCase(caseName) {
  const marker = `<a id="case-${caseName}"></a>`;
  const start = runbook.indexOf(marker);
  assert.notEqual(start, -1, `missing runbook anchor for ${caseName}`);
  const next = runbook.indexOf('<a id="case-', start + marker.length);
  return runbook.slice(start, next === -1 ? undefined : next);
}

test('each acceptance case has a direct runbook cross-reference and remains NOT_EXECUTED', () => {
  for (const caseName of REQUIRED_CASES) {
    assert.ok(runbook.includes(`<a id="case-${caseName}"></a>`), `${caseName} anchor`);
    assert.ok(review.includes(`#case-${caseName}`), `${caseName} review link`);
  }
  const resultRows = review.split('\n').filter(line => /^\| `[^`]+` \| NOT_EXECUTED \|/u.test(line));
  assert.equal(resultRows.length, REQUIRED_CASES.length, 'all 15 review outcomes stay NOT_EXECUTED');
});

test('the reviewer-identified binding procedures are explicit in their existing cases', () => {
  const requirements = {
    'live-auth-gate': ['zero-publication', 'Disable cache', 'visibilitychange', 'online', 'private, no-store'],
    'catalog-routing': ['categories-only', 'Ctrl+click', 'Meta+click', '__proto__', 'page=01', 'utm_source=fixture'],
    'native-image': ['/uploads/cms-private', 'sem bytes'],
    'native-range': ['bytes=0-1023', 'bytes=1024-', 'bytes=-1024', 'bytes=N-', 'bytes */N'],
    'long-video-renewal': [
      'POST /api/contents/media-session', 'status `204`', "document.visibilityState === 'hidden'",
      'video.paused === false', 'timestamps de request e resposta', 'foreground-return recovery is separate',
      'browser impedir observar', 'caso completo `NOT_EXECUTED`', 'path sem UUID/segredo',
      'Authorization', 'cookies', 'headers completos', 'body', 'HAR',
      'mais de cinco minutos', '6:00',
    ],
    'media-failure-recovery': ['t0 + 5 s', '+15 s', '+30 s', '60 s', 'aria-disabled=true'],
    'large-pdf': ['lease release', '5+ min', 'Baixar PDF', 'sem viewer'],
    'auth-exit-cross-tab': ['DELETE', 'revokeEditorialSession', 'BroadcastChannel', '`storage` event', 'emissão tardia'],
    'gallery-keyboard': ['Recarregar conteúdo', 'heading fallback', 'Back real', 'pointer pairs', 'mobile drawer'],
    'screen-reader-gallery': ['leitor anuncia diálogo/modal', 'alt/caption', 'foco não escapa'],
    'embeds-effective-csp': ['header CSP efetivo', '`frame-src`', 'sem wildcard ampliado'],
    'layout-mobile': ['sidebar mobile **expanded** e **collapsed**', 'W ≥44 CSS px e H ≥44 CSS px'],
    'bfcache-cleanup': ['dez ciclos', 'pageshow.persisted === true', 'não force `persisted`'],
    'owner-news-regression': [
      'viewer Portal A ativo', 'sem exigir `manageKnowledge`', 'GET /api/announcements/assets/:id',
      '`asset_scope=owner-news`', 'status `200`', '`Cache-Control: private,no-store`',
      '`X-Content-Type-Options: nosniff`', 'fetchAPIAsset', '`blob:` URL', '`<img>`',
      '`<video controls>`', 'PDF iframe/link', 'controle nativo esperado', 'range no request HTTP',
      'sem Authorization', 'logout/revoke', 'status `401`', 'sem bytes', 'URL completa',
      'filename', 'corpo', 'cookies', 'HAR', 'não use endpoint de preview',
      'logout/revoke editorial', 'Owner News', 'nenhum dado muda',
    ],
    'editorial-accessibility': ['PDF marcado', 'legendas/transcrição', 'ordem de headings/links/alt/captions'],
  };

  for (const [caseName, phrases] of Object.entries(requirements)) {
    const section = runbookCase(caseName).replace(/\s+/gu, ' ').toLowerCase();
    for (const phrase of phrases) {
      assert.ok(section.includes(phrase.toLowerCase()), `${caseName} must specify ${phrase}`);
    }
  }
});

test('the layout matrix explicitly enumerates every block × five layouts plus omitted default', () => {
  const section = runbookCase('layout-mobile');
  const blockTypes = ['heading', 'rich_text', 'image', 'gallery', 'video', 'pdf', 'embed', 'callout', 'link', 'divider'];
  const header = section.split('\n').find(line => line.includes('| Bloco |'));
  for (const layout of ['content', 'wide', 'full', 'left', 'right', 'default omitido']) {
    assert.ok(header?.includes(`\`${layout}\``), `matrix header must include ${layout}`);
  }

  const rows = section.split('\n').filter(line => /^\s*\| `(?:heading|rich_text|image|gallery|video|pdf|embed|callout|link|divider)` \|/u.test(line));
  assert.equal(rows.length, blockTypes.length);
  for (const blockType of blockTypes) {
    const row = rows.find(line => line.includes(`| \`${blockType}\` |`));
    assert.ok(row, `matrix row for ${blockType}`);
    const cells = row.split('|').slice(2, -1);
    assert.equal(cells.length, 6, `${blockType} has five layouts and default-omitted cell`);
    assert.ok(cells.every(cell => cell.includes('Executar + screenshot')), `${blockType} every cell is explicit`);
  }
});

test('evidence template retains the exact schema and provides privacy-safe observation fields', () => {
  const match = /```json\s*([\s\S]*?)\s*```/u.exec(runbook);
  assert.ok(match, 'sanitized JSON example exists');
  const [record] = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(record), [
    'case', 'commit', 'runId', 'environment', 'startedAt', 'finishedAt', 'browser', 'viewport',
    'scenario', 'status', 'artifact', 'notes',
  ]);
  assert.equal(record.status, 'NOT_EXECUTED');
  assert.equal(record.startedAt, null);
  assert.equal(record.finishedAt, null);
  for (const phrase of ['scenario', 'notes', 'key=value', 'elapsed_ms', 'viewport_css',
    'storage_key', 'BroadcastChannel', 'Authorization', 'HAR']) {
    assert.ok(runbook.includes(phrase), `runbook explains sanitized observation field ${phrase}`);
  }
});
