import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentsHarness, createContentsClock } from '../helpers/portal-contents-harness.mjs';
import { ASSET_ID, PAGE_ID, REVISION_ID, pageFixture } from '../helpers/portal-contents-fixtures.mjs';
import { TestEvent, drain } from '../helpers/frontend-feedback-harness.mjs';

const ready = () => new Response(null, { status: 204 });
const context = () => ({ signal: new AbortController().signal, isCurrent: () => true, onReload() {} });

async function mountGallery(h, contentBlocks, viewContext = context()) {
  const root = h.document.createElement('section'); h.document.body.append(root);
  const dto = pageFixture({ content_blocks: contentBlocks });
  const view = h.modules.reader.renderReader(root, dto, {}, viewContext);
  const gallery = h.modules.gallery.createContentsGallery({ page: h.page, rootHeading: () => view.heading });
  const activation = h.modules.media.activateContentsMedia(view.media, { context: viewContext, gallery });
  if (h.pendingIssues.length) h.pendingIssues[0].resolve(ready());
  await drain();
  return { root, dto, view, gallery, activation };
}

const pair = () => [
  { asset_id: ASSET_ID, alt: 'Primeira paisagem', caption: 'Legenda um' },
  { asset_id: '018f47a2-7b3c-7a11-8a2c-000000000001', alt: 'Segunda paisagem', caption: 'Legenda dois' },
];

test('gallery is an ordered semantic list; every trigger and full view keeps its caption and position', async () => {
  const h = await createContentsHarness();
  const state = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
  const list = state.root.querySelector('.contents-gallery-list');
  assert.equal(list.tagName, 'OL');
  assert.equal(list.children.length, 2);
  const triggers = state.root.querySelectorAll('[data-contents-gallery-trigger]');
  assert.equal(triggers.length, 2);
  assert.equal(triggers[0].getAttribute('aria-label'), 'Abrir imagem 1 de 2 — Primeira paisagem');
  assert.equal(state.root.querySelectorAll('figcaption').length, 2);
  assert.equal(state.root.querySelectorAll('img[src]').length, 2);
  const dialogCountBefore = h.document.querySelectorAll('dialog[data-page-overlay]').length;
  assert.equal(dialogCountBefore, 1, 'the reader owns one closed dialog without opening it');
  assert.equal(h.document.querySelector('dialog[data-page-overlay]').open, false);
  state.activation.dispose();
  state.gallery.dispose();
});

test('one native dialog is owned per reader, wraps only its gallery and restores exact background state', async () => {
  const h = await createContentsHarness();
  const sibling = h.document.createElement('section'); sibling.inert = true; h.document.body.append(sibling);
  const app = h.document.querySelector('.portal-wrapper');
  const { root, dto, view, gallery, activation } = await mountGallery(h, [
    { type: 'gallery', images: pair() },
    { type: 'gallery', images: pair() },
  ]);
  const triggers = root.querySelectorAll('[data-contents-gallery-trigger]');
  triggers[0].click(); await drain();
  const dialogs = h.document.querySelectorAll('dialog[data-page-overlay]');
  assert.equal(dialogs.length, 1);
  const dialog = dialogs[0];
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute('aria-labelledby')?.startsWith('contents-lightbox-'), true);
  assert.equal(dialog.getAttribute('aria-describedby')?.startsWith('contents-lightbox-'), true);
  assert.equal(h.document.activeElement.className, 'contents-lightbox-close');
  assert.equal(app.inert, true);
  assert.equal(sibling.inert, true, 'pre-existing inert state is not overwritten');
  const next = dialog.querySelector('.contents-lightbox-next');
  assert.equal(next.getAttribute('aria-label'), 'Próxima imagem');
  assert.ok(next.clientWidth >= 44);
  next.click();
  assert.match(dialog.querySelector('.contents-lightbox-status').textContent, /Imagem 2 de 2/u);
  await drain();
  assert.equal(dialog.querySelector('.contents-lightbox-image').getAttribute('src'),
    `/api/contents/assets/${PAGE_ID}/${REVISION_ID}/018f47a2-7b3c-7a11-8a2c-000000000001`);
  next.click();
  assert.match(dialog.querySelector('.contents-lightbox-status').textContent, /Imagem 1 de 2/u);

  dialog.querySelector('.contents-lightbox-close').click();
  assert.equal(dialog.open, false);
  assert.equal(app.inert, false);
  assert.equal(sibling.inert, true);
  assert.equal(h.document.activeElement, triggers[0]);
  assert.equal(dialog.querySelector('.contents-lightbox-image').hasAttribute('src'), false);
  activation.dispose(); gallery.dispose();
});

test('Tab trap filters disabled controls in both directions and Escape cancel closes normally', async () => {
  const h = await createContentsHarness();
  const { root, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
  const trigger = root.querySelector('[data-contents-gallery-trigger]'); trigger.click(); await drain();
  const dialog = h.document.querySelector('dialog[data-page-overlay]');
  const close = dialog.querySelector('.contents-lightbox-close');
  const previous = dialog.querySelector('.contents-lightbox-previous');
  const next = dialog.querySelector('.contents-lightbox-next');
  const disabled = h.document.createElement('button'); disabled.disabled = true; dialog.append(disabled);
  const nativeQuerySelectorAll = dialog.querySelectorAll.bind(dialog);
  dialog.querySelectorAll = selector => ({
    [Symbol.iterator]: () => nativeQuerySelectorAll(selector)[Symbol.iterator](),
  });
  h.document.activeElement = next;
  const firstTab = new TestEvent('keydown', { key: 'Tab' });
  dialog.dispatchEvent(firstTab);
  assert.equal(firstTab.defaultPrevented, true);
  assert.equal(h.document.activeElement, close);
  h.document.activeElement = close;
  const reverseTab = new TestEvent('keydown', { key: 'Tab', shiftKey: true });
  dialog.dispatchEvent(reverseTab);
  assert.equal(reverseTab.defaultPrevented, true);
  assert.equal(h.document.activeElement, next);
  const cancel = new TestEvent('cancel');
  dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(dialog.open, false);
  activation.dispose(); gallery.dispose();
});

test('a failed session preparation is announced beside the gallery and can be retried into the dialog', async () => {
  const h = await createContentsHarness();
  const root = h.document.createElement('section'); h.document.body.append(root);
  const dto = pageFixture({ content_blocks: [{ type: 'gallery', images: pair() }] });
  const view = h.modules.reader.renderReader(root, dto, {}, context());
  const gallery = h.modules.gallery.createContentsGallery({ page: h.page, rootHeading: () => view.heading });
  const activation = h.modules.media.activateContentsMedia(view.media, { context: context(), gallery });
  h.pendingIssues[0].resolve(new Response(null, { status: 503 }));
  await drain();
  const trigger = root.querySelector('[data-contents-gallery-trigger]');
  trigger.click();
  h.pendingIssues[1].resolve(new Response(null, { status: 503 }));
  await drain();
  const status = root.querySelector('.contents-gallery-status');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Não foi possível preparar a galeria/u);
  status.querySelector('button').click();
  assert.equal(h.pendingIssues.length, 3);
  h.pendingIssues[2].resolve(ready());
  await drain();
  assert.equal(status.hidden, true);
  assert.equal(h.document.querySelector('dialog[data-page-overlay]').open, true);
  activation.dispose(); gallery.dispose();
});

test('arrows only navigate while focus belongs to the lightbox and never steal editable input keys', async () => {
  const h = await createContentsHarness();
  const { root, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
  root.querySelector('[data-contents-gallery-trigger]').click(); await drain();
  const dialog = h.document.querySelector('dialog[data-page-overlay]');
  h.document.activeElement = root.querySelector('[data-contents-gallery-trigger]');
  dialog.dispatchEvent(new TestEvent('keydown', { key: 'ArrowRight' }));
  assert.match(dialog.querySelector('.contents-lightbox-status').textContent, /Imagem 1 de 2/u);
  const input = h.document.createElement('input'); dialog.append(input); input.focus();
  input.dispatchEvent(new TestEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.match(dialog.querySelector('.contents-lightbox-status').textContent, /Imagem 1 de 2/u);
  h.document.activeElement = dialog.querySelector('.contents-lightbox-close');
  dialog.dispatchEvent(new TestEvent('keydown', { key: 'ArrowRight' }));
  assert.match(dialog.querySelector('.contents-lightbox-status').textContent, /Imagem 2 de 2/u);
  activation.dispose(); gallery.dispose();
});

test('gallery image failure is announced and can be bypassed; backdrop requires matching pointer down/up', async () => {
  const h = await createContentsHarness();
  const { root, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
  root.querySelector('[data-contents-gallery-trigger]').click(); await drain();
  const dialog = h.document.querySelector('dialog[data-page-overlay]');
  const image = dialog.querySelector('.contents-lightbox-image');
  image.dispatchEvent(new TestEvent('error'));
  assert.match(dialog.querySelector('.contents-lightbox-status').textContent, /Não foi possível carregar esta imagem/u);
  dialog.querySelector('.contents-lightbox-next').click();
  assert.match(dialog.querySelector('.contents-lightbox-status').textContent, /Imagem 2 de 2/u);
  dialog.dispatchEvent(new TestEvent('pointerdown', { target: image }));
  dialog.dispatchEvent(new TestEvent('pointerup', { target: dialog }));
  assert.equal(dialog.open, true, 'dragging from image to backdrop is not a backdrop click');
  dialog.dispatchEvent(new TestEvent('pointerdown', { target: dialog, pointerId: 1 }));
  dialog.dispatchEvent(new TestEvent('pointerup', { target: dialog, pointerId: 2 }));
  assert.equal(dialog.open, true, 'a different pointer cannot complete the backdrop press');
  dialog.dispatchEvent(new TestEvent('pointerdown', { target: dialog, pointerId: 3 }));
  dialog.dispatchEvent(new TestEvent('pointerup', { target: dialog, pointerId: 3 }));
  assert.equal(dialog.open, false);
  activation.dispose(); gallery.dispose();
});

test('thumbnail and lightbox allow one forced recovery per asset activation', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const { root, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
  const thumbnail = root.querySelector('.contents-gallery-thumbnail');
  thumbnail.dispatchEvent(new TestEvent('error'));
  let retry = root.querySelector('.contents-media-retry');
  retry.click();
  assert.equal(h.pendingIssues.length, 2);
  retry.click();
  assert.equal(h.pendingIssues.length, 2, 'one thumbnail failure cannot fan out forced issue requests');
  h.pendingIssues[1].resolve(ready()); await drain();
  thumbnail.dispatchEvent(new TestEvent('load'));
  assert.equal(root.querySelector('.contents-media-retry'), null);

  thumbnail.dispatchEvent(new TestEvent('error'));
  const thumbnailReload = root.querySelector('.contents-gallery-reload');
  assert.ok(thumbnailReload);
  assert.equal(thumbnail.hasAttribute('src'), false);
  assert.ok(root.querySelector('.contents-gallery-reload'), 'a repeated native failure falls back to full content reload');
  assert.equal(h.pendingIssues.length, 2, 'a second thumbnail error cannot consume another forced issue');

  root.querySelector('[data-contents-gallery-trigger]').click(); await drain();
  const image = h.document.querySelector('.contents-lightbox-image');
  const lightboxReload = h.document.querySelector('.contents-lightbox-reload');
  assert.ok(lightboxReload, 'lightbox presents the shared per-asset terminal fallback');
  assert.equal(image.hasAttribute('src'), false, 'opening terminal content does not assign a protected URL');
  await h.advance(240_000);
  assert.equal(h.pendingIssues.length, 3);
  h.pendingIssues[2].resolve(ready()); await drain();
  assert.equal(thumbnail.hasAttribute('src'), false, 'routine ready preserves terminal thumbnail failure');
  assert.equal(root.querySelector('.contents-gallery-reload'), thumbnailReload);
  assert.equal(image.hasAttribute('src'), false, 'routine ready does not revive terminal lightbox content');
  assert.equal(h.document.querySelector('.contents-lightbox-reload'), lightboxReload);
  assert.equal(h.pendingIssues.length, 3);
  activation.dispose(); gallery.dispose();
});

test('thumbnail and lightbox share one asset recovery budget and offer one validated content reload', async () => {
  const h = await createContentsHarness();
  let reloadCalls = 0;
  const viewContext = { ...context(), onReload() { reloadCalls += 1; } };
  const { root, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images: pair() }], viewContext);
  const thumbnail = root.querySelector('.contents-gallery-thumbnail');
  thumbnail.dispatchEvent(new TestEvent('error'));
  root.querySelector('.contents-media-retry').click();
  assert.equal(h.pendingIssues.length, 2);
  h.pendingIssues[1].resolve(ready()); await drain();

  root.querySelector('[data-contents-gallery-trigger]').click(); await drain();
  const dialog = h.document.querySelector('dialog[data-page-overlay]');
  const image = dialog.querySelector('.contents-lightbox-image');
  image.dispatchEvent(new TestEvent('error'));
  const reload = dialog.querySelector('.contents-lightbox-reload');
  assert.ok(reload, 'the repeated native failure offers the content-level recovery');
  assert.equal(image.hasAttribute('src'), false, 'terminal native failure removes the failed protected URL');
  assert.equal(reload.textContent, 'Recarregar conteúdo');
  assert.equal(h.pendingIssues.length, 2, 'thumbnail recovery suppresses a second forced issue for the same asset');
  viewContext.isCurrent = () => false;
  reload.click();
  assert.equal(reloadCalls, 0, 'stale view contexts cannot invoke a reload callback');
  viewContext.isCurrent = () => true;
  reload.click();
  reload.click();
  assert.equal(reloadCalls, 1, 'the validated onReload callback runs at most once per activation');
  activation.dispose(); gallery.dispose();
});

test('a newly mounted view gets a fresh per-asset recovery budget', async () => {
  const h = await createContentsHarness();
  const first = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
  const firstThumb = first.root.querySelector('.contents-gallery-thumbnail');
  firstThumb.dispatchEvent(new TestEvent('error'));
  first.root.querySelector('.contents-media-retry').click();
  h.pendingIssues[1].resolve(ready()); await drain();
  firstThumb.dispatchEvent(new TestEvent('error'));
  assert.ok(first.root.querySelector('.contents-gallery-reload'));
  first.activation.dispose(); first.gallery.dispose();

  const nextContext = context();
  const remount = await mountGallery(h, [{ type: 'gallery', images: pair() }], nextContext);
  assert.equal(h.pendingIssues.length, 3);
  h.pendingIssues[2].resolve(ready()); await drain();
  const nextThumb = remount.root.querySelector('.contents-gallery-thumbnail');
  nextThumb.dispatchEvent(new TestEvent('error'));
  assert.ok(remount.root.querySelector('.contents-media-retry'), 'a new activation can attempt one fresh issuance');
  remount.root.querySelector('.contents-media-retry').click();
  assert.equal(h.pendingIssues.length, 4);
  h.pendingIssues[3].resolve(ready()); await drain();
  remount.activation.dispose(); remount.gallery.dispose();
});

test('opening closes the mobile drawer before inerting; route close does not restore focus into departing content', async () => {
  const h = await createContentsHarness();
  let drawerClosed = 0;
  h.document.addEventListener('portal:close-drawer', () => { drawerClosed += 1; });
  const { root, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
  const trigger = root.querySelector('[data-contents-gallery-trigger]');
  trigger.click(); await drain();
  assert.equal(drawerClosed, 1);
  const dialog = h.document.querySelector('dialog[data-page-overlay]');
  const departing = h.document.createElement('div'); h.document.body.append(departing);
  trigger.remove();
  h.modules.ui.closePageDialogs();
  assert.equal(dialog.open, false);
  assert.notEqual(h.document.activeElement, trigger, 'router-driven close does not focus a removed trigger');
  activation.dispose(); gallery.dispose();
});

test('normal close falls back to connected reader heading when the opener was removed', async () => {
  const h = await createContentsHarness();
  const { root, view, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
  const trigger = root.querySelector('[data-contents-gallery-trigger]'); trigger.click(); await drain();
  const dialog = h.document.querySelector('dialog[data-page-overlay]');
  trigger.remove();
  dialog.querySelector('.contents-lightbox-close').click();
  assert.equal(h.document.activeElement, view.heading);
  activation.dispose(); gallery.dispose();
});

test('dialog locks and restores exact pre-existing overflow, padding and scroll styles', async () => {
  const h = await createContentsHarness();
  h.document.body.style.overflow = 'clip';
  h.document.body.style.paddingInlineEnd = '7px';
  h.document.documentElement.style.overflow = 'auto';
  h.window.scrollX = 9; h.window.scrollY = 80;
  const { root, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
  root.querySelector('[data-contents-gallery-trigger]').click(); await drain();
  assert.equal(h.document.body.style.overflow, 'hidden');
  assert.notEqual(h.document.body.style.paddingInlineEnd, '7px');
  h.document.querySelector('dialog[data-page-overlay]').querySelector('.contents-lightbox-close').click();
  assert.equal(h.document.body.style.overflow, 'clip');
  assert.equal(h.document.body.style.paddingInlineEnd, '7px');
  assert.equal(h.document.documentElement.style.overflow, 'auto');
  assert.deepEqual([h.window.scrollX, h.window.scrollY], [9, 80]);
  activation.dispose(); gallery.dispose();
});

test('repeated gallery mount/dispose leaves one dialog at most and no lightbox DOM or asset source', async () => {
  const h = await createContentsHarness();
  for (let i = 0; i < 3; i += 1) {
    const { root, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images: pair() }]);
    root.querySelector('[data-contents-gallery-trigger]').click(); await drain();
    assert.equal(h.document.querySelectorAll('dialog[data-page-overlay]').length, 1);
    const thumbnail = root.querySelector('.contents-gallery-thumbnail');
    assert.equal(thumbnail.listeners.get('load')?.length, 1);
    assert.equal(thumbnail.listeners.get('error')?.length, 1);
    activation.dispose(); gallery.dispose(); root.remove();
    assert.equal(h.document.querySelectorAll('dialog[data-page-overlay]').length, 0);
    assert.equal(h.document.querySelectorAll('dialog img[src]').length, 0);
    assert.equal(thumbnail.listeners.get('load')?.length, 0, 'dispose removes the exact load listener');
    assert.equal(thumbnail.listeners.get('error')?.length, 0, 'dispose removes the exact error listener');
    thumbnail.dispatchEvent(new TestEvent('error'));
    assert.equal(root.querySelector('.contents-gallery-image-status'), null, 'late detached events cannot mutate disposed gallery DOM');
  }
});

test('lightbox is not a history mutation and preserves repeated asset positions', async () => {
  const h = await createContentsHarness();
  const images = [
    { asset_id: ASSET_ID, alt: 'Primeira referência' },
    { asset_id: ASSET_ID, alt: 'Mesma referência novamente' },
  ];
  const startLength = h.history.length;
  const { root, gallery, activation } = await mountGallery(h, [{ type: 'gallery', images }]);
  const triggers = root.querySelectorAll('[data-contents-gallery-trigger]');
  assert.equal(triggers[0].getAttribute('aria-label'), 'Abrir imagem 1 de 2 — Primeira referência');
  assert.equal(triggers[1].getAttribute('aria-label'), 'Abrir imagem 2 de 2 — Mesma referência novamente');
  triggers[1].click(); await drain();
  const dialog = h.document.querySelector('dialog[data-page-overlay]');
  assert.match(dialog.querySelector('.contents-lightbox-status').textContent, /Imagem 2 de 2/u);
  assert.equal(h.history.length, startLength);
  assert.equal(dialog.querySelector('.contents-lightbox-image').getAttribute('src'),
    `/api/contents/assets/${PAGE_ID}/${REVISION_ID}/${ASSET_ID}`);
  activation.dispose(); gallery.dispose();
});
