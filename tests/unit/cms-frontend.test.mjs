import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [cmsHtml, cms, editor, renderer, css, admin, knowledge, academy, benefits, reminders, announcements, announcementsHtml, dashboard] = await Promise.all([
  readFile('public/cms.html', 'utf8'),
  readFile('public/js/cms.js', 'utf8'),
  readFile('public/js/cms-block-editor.js', 'utf8'),
  readFile('public/js/cms-block-renderer.js', 'utf8'),
  readFile('public/css/cms.css', 'utf8'),
  readFile('public/admin.html', 'utf8'),
  readFile('public/js/knowledge.js', 'utf8'),
  readFile('public/js/academy.js', 'utf8'),
  readFile('public/js/benefits.js', 'utf8'),
  readFile('public/js/reminders.js', 'utf8'),
  readFile('public/js/announcements.js', 'utf8'),
  readFile('public/announcements.html', 'utf8'),
  readFile('public/js/dashboard.js', 'utf8'),
]);

test('CMS entry point is authenticated, linked from admin, and has responsive editor regions', () => {
  assert.match(cmsHtml, /<script src="\.\/js\/auth-shell\.js"><\/script>/);
  assert.match(cmsHtml, /type="module" src="\.\/js\/cms\.js"/);
  assert.match(cmsHtml, /id="content-types"/);
  assert.match(cmsHtml, /id="editor-root"/);
  assert.match(cmsHtml, /id="inspector-type"/);
  assert.match(cmsHtml, /id="inspector-block-settings"/);
  assert.match(cmsHtml, /id="publish-document"/);
  assert.match(admin, /href="\.\/cms\.html"[^>]*>.*Editor CMS/s);
  assert.match(cms, /requireAuth\(true\)/);
  for (const permission of ['manageKnowledge', 'manageAcademy', 'manageBenefits', 'manageReminders']) assert.match(cms, new RegExp(permission));
  assert.match(css, /grid-template-columns:/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /overflow-x: auto/);
});

test('CMS editor exposes all approved block types, native drag/drop, and keyboard fallback controls', () => {
  for (const type of ['heading', 'paragraph', 'list', 'callout', 'image', 'divider', 'link', 'pdf', 'video']) assert.match(editor, new RegExp(`['"]${type}['"]`));
  assert.match(editor, /draggable: 'true'/);
  assert.match(editor, /dataTransfer\?\.setData\('text\/plain'/);
  assert.match(editor, /ArrowUp/);
  assert.match(editor, /Mover.*para cima/);
  assert.match(editor, /Mover.*para baixo/);
  assert.match(editor, /serializeBlocks/);
  assert.match(editor, /fetchAPI\('\/api\/cms\/assets'/);
  assert.match(editor, /FormData/);
});

test('safe renderer validates the allowlist and never uses raw HTML sinks', () => {
  assert.match(renderer, /export const BLOCK_TYPES/);
  assert.match(renderer, /export function validateBlocks/);
  assert.match(renderer, /textContent/);
  assert.match(renderer, /fetchAPIAsset/);
  assert.match(renderer, /\/api\/cms\/assets\//);
  assert.doesNotMatch(renderer, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(editor, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('CMS actions use the existing API contracts and keep generic failure states visible', () => {
  for (const endpoint of ['/api/cms/documents', '/draft', '/publish', '/schedule', '/unpublish']) assert.match(cms, new RegExp(endpoint.replace('/', '\\/')));
  assert.match(cms, /method: 'DELETE'/);
  assert.match(cms, /Salvando rascunho/);
  assert.match(cms, /Não foi possível salvar o rascunho/);
  assert.match(cms, /scheduled_at/);
});

test('published CMS blocks integrate with legacy fallbacks and dashboard announcements', () => {
  for (const source of [knowledge, academy, benefits, announcements]) {
    assert.match(source, /content_blocks/);
    assert.match(source, /renderBlocks/);
  }
  assert.match(reminders, /blocksToText\(reminder\.content_blocks\)/);
  assert.match(announcementsHtml, /id="main-content"/);
  assert.match(dashboard, /\/api\/announcements\?limit=3&offset=0/);
  assert.match(dashboard, /announcements-preview/);
});
