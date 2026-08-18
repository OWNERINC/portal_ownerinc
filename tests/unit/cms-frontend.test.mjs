import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [cmsHtml, cms, editor, renderer, css, admin, knowledge, academy, benefits, reminders, announcements, announcementsHtml, dashboard, auth, layout] = await Promise.all([
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
  readFile('public/js/auth.js', 'utf8'),
  readFile('public/css/layout.css', 'utf8'),
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

test('autosave coalesces in-flight edits and rejects stale document responses', () => {
  assert.match(cms, /let saveQueued = false/);
  assert.match(cms, /let editVersion = 0/);
  assert.match(cms, /if \(saving\) \{\s*saveQueued = true/);
  assert.match(cms, /requestVersion = editVersion/);
  assert.match(cms, /editVersion !== requestVersion/);
  assert.match(cms, /requestToken !== selectionToken/);
  assert.match(cms, /actionBusy = true/);
  assert.match(cms, /publishButton\.disabled = !active/);
});

test('CMS navigation links are permission-gated before the API remains authoritative', () => {
  assert.match(auth, /dataset\.cmsAccess/);
  assert.match(auth, /manageKnowledge.*manageAcademy.*manageBenefits.*manageReminders/s);
  assert.match(layout, /\.cms-link, \.cms-entry-link \{ display: none/);
  assert.match(layout, /html\[data-cms-access="true"\] \.cms-link/);
  assert.match(admin, /class="cms-entry-link/);
  assert.match(cms, /\.filter\(\(\[, , permission\]\) => can\(user, permission\)\)/);
});

test('reminder content uses the safe renderer while retaining description fallback', () => {
  assert.match(reminders, /renderBlocks\(content, reminder\.content_blocks/);
  assert.match(reminders, /fallbackText: reminder\.description/);
  assert.match(dashboard, /renderBlocks\(content, reminder\.content_blocks/);
  assert.match(dashboard, /fallbackText: reminder\.description/);
});

test('private preview URLs are revoked and media reserve intrinsic layout space', () => {
  assert.match(renderer, /export function cleanupRenderedBlocks/);
  assert.match(renderer, /URL\.revokeObjectURL/);
  assert.match(renderer, /MutationObserver/);
  assert.match(css, /aspect-ratio: 16 \/ 9/);
});

test('block selection has semantic keyboard controls and visible focus', () => {
  assert.match(editor, /className: 'cms-block-select'/);
  assert.match(editor, /aria-pressed/);
  assert.match(editor, /event\.key === 'Enter'/);
  assert.match(editor, /event\.key === ' '/);
  assert.match(css, /\.cms-block-select:focus-visible/);
  assert.match(cmsHtml, /name="cms-document"/);
  assert.match(cmsHtml, /name="title" autocomplete="off"/);
});

test('dirty CMS navigation confirms anchors and protects reload/close without blocking editor actions', () => {
  assert.match(cms, /window\.addEventListener\('beforeunload'/);
  assert.match(cms, /closest\('a\[href\]'/);
  assert.match(cms, /window\.confirm\('Há alterações do CMS/);
  assert.match(cms, /event\.preventDefault\(\)/);
  assert.match(cms, /navigationConfirmed = true/);
  assert.match(cms, /navigationBusy\(\) \|\| saveQueued/);
});

test('one document-level observer cleans private media when any rendered ancestor detaches', () => {
  assert.match(renderer, /const documentObservers = new WeakMap\(\)/);
  assert.match(renderer, /container\.ownerDocument\?\.documentElement/);
  assert.match(renderer, /observer\.observe\(document\.documentElement, \{ childList: true, subtree: true \}\)/);
  assert.match(renderer, /candidate\.container\.isConnected/);
  assert.match(renderer, /record\.states\.add\(state\)/);
  assert.doesNotMatch(renderer, /observer\.observe\(parent/);
});

test('direct and keyboard block selection update every aria-pressed state immediately', () => {
  assert.match(editor, /function selectBlock\(index\)/);
  assert.match(editor, /querySelectorAll\('\.cms-block-select'\)/);
  assert.match(editor, /button\.setAttribute\('aria-pressed', String\(buttonIndex === selectedIndex\)\)/);
  assert.match(editor, /on: \{ click: \(\) => selectBlock\(index\) \}/);
  assert.match(editor, /selectBlock\(index\);\s*return;/);
});

test('published CMS blocks integrate with legacy fallbacks and dashboard announcements', () => {
  for (const source of [knowledge, academy, benefits, announcements]) {
    assert.match(source, /content_blocks/);
    assert.match(source, /renderBlocks/);
  }
  assert.match(reminders, /renderBlocks\(content, reminder\.content_blocks/);
  assert.match(announcementsHtml, /id="main-content"/);
  assert.match(dashboard, /\/api\/announcements\?limit=3&offset=0/);
  assert.match(dashboard, /announcements-preview/);
  assert.match(announcements, /\/api\/announcements\/\$\{encodeURIComponent\(announcementId\)\}/);
  assert.match(announcements, /href: `\?id=\$\{encodeURIComponent\(announcement\.id\)\}`/);
});
