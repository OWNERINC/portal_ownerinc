import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [cmsHtml, cms, editor, renderer, css, knowledgeCss, knowledgeHtml, admin, knowledge, academy, benefits, reminders, announcements, announcementsHtml, dashboard, auth, layout] = await Promise.all([
  readFile('public/cms.html', 'utf8'),
  readFile('public/js/cms.js', 'utf8'),
  readFile('public/js/cms-block-editor.js', 'utf8'),
  readFile('public/js/cms-block-renderer.js', 'utf8'),
  readFile('public/css/cms.css', 'utf8'),
  readFile('public/css/knowledge.css', 'utf8'),
  readFile('public/knowledge.html', 'utf8'),
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createAssetUploadHarness() {
  const inputs = [];
  const sourceStart = editor.indexOf('function assetUpload(');
  const sourceEnd = editor.indexOf('\n\nfunction defaultBlock', sourceStart);
  const source = editor.slice(sourceStart, sourceEnd);
  const element = (tag, attributes = {}, children = []) => {
    const node = {
      tag,
      ...attributes,
      children,
      files: [],
      disabled: false,
      value: '',
      listeners: {},
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      },
    };
    if (tag === 'input') inputs.push(node);
    return node;
  };
  const context = {
    FormData: class {
      constructor() {
        this.parts = [];
      }

      append(name, value) {
        this.parts.push([name, value]);
      }
    },
    element,
    fetchImpl: () => { throw new Error('fetchImpl not configured'); },
    fetchAPI: (...args) => context.fetchImpl(...args),
    toasts: [],
    showToast: message => context.toasts.push(message),
  };
  vm.runInNewContext(`${source}\nglobalThis.assetUpload = assetUpload;`, context, { filename: 'cms-block-editor.js' });
  return { assetUpload: context.assetUpload, inputs, context };
}

function createRemindersLoaderHarness() {
  const sourceStart = reminders.indexOf('async function loadReminders(');
  const sourceEnd = reminders.indexOf('\n\nasync function loadDeliveryManager', sourceStart);
  const source = reminders.slice(sourceStart, sourceEnd);
  const context = {
    canManage: false,
    PAGE_SIZE: 50,
    page: 0,
    reminders: [],
    remindersRequest: 0,
    totalReminders: 0,
    fetchImpl: () => { throw new Error('fetchImpl not configured'); },
    fetchAPIPage: (...args) => context.fetchImpl(...args),
    tableStates: [],
    tableState: (...args) => context.tableStates.push(args),
    rendered: [],
    pagination: [],
    renderTable: () => {
      context.rendered.push({
        ids: context.reminders.map(reminder => reminder.id),
        page: context.page,
        total: context.totalReminders,
      });
      context.pagination.push({ page: context.page, total: context.totalReminders });
    },
  };
  vm.runInNewContext(`${source}\nglobalThis.loadReminders = loadReminders;`, context, { filename: 'reminders.js' });
  return { context, loadReminders: context.loadReminders };
}

function startAssetUpload(harness, label, block, onChange, onUploadBusy, canApplyUpload) {
  const settings = harness.assetUpload(label, 'image/png', block, onChange, onUploadBusy, canApplyUpload);
  const input = settings.children[1];
  input.files = [{ name: 'asset.png' }];
  return { input, pending: input.listeners.change() };
}

test('CMS entry point is authenticated, linked from admin, and has responsive editor regions', () => {
  assert.match(cmsHtml, /<script src="\.\/js\/auth-shell\.js"><\/script>/);
  assert.match(cmsHtml, /type="module" src="\.\/js\/router-bootstrap\.js"/);
  assert.match(cmsHtml, /id="content-types"/);
  assert.match(cmsHtml, /id="editor-root"/);
  assert.match(cmsHtml, /id="inspector-type"/);
  assert.match(cmsHtml, /id="inspector-block-settings"/);
  assert.match(cmsHtml, /id="publish-document"/);
  assert.match(cmsHtml, /id="document-pagination"/);
  assert.match(admin, /href="\.\/cms\.html"[^>]*>.*Editor CMS/s);
  assert.match(cms, /export function mount\(page\)/);
  assert.match(cms, /const user = page\.user/);
  for (const permission of ['manageKnowledge', 'manageAcademy', 'manageBenefits', 'manageReminders']) assert.match(cms, new RegExp(permission));
  assert.match(css, /grid-template-columns:/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /overflow-x: auto/);
});

test('CMS initialization has the save status element used by the editor runtime', () => {
  assert.match(cms, /const saveState = document\.getElementById\('save-state'\)/);
  assert.match(cmsHtml, /<span id="save-state" class="cms-save-state" role="status" aria-live="polite">/);
});

test('CMS editor exposes all approved block types, native drag/drop, and keyboard fallback controls', () => {
  for (const type of ['heading', 'paragraph', 'list', 'callout', 'image', 'divider', 'link', 'pdf', 'video']) assert.match(editor, new RegExp(`['"]${type}['"]`));
  assert.match(editor, /draggable: 'true'/);
  assert.match(editor, /dataTransfer\?\.setData\('text\/plain'/);
  assert.match(editor, /ArrowUp/);
  assert.match(editor, /Mover.*para cima/);
  assert.match(editor, /Mover.*para baixo/);
  assert.match(editor, /serializeBlocks/);
  assert.match(editor, /request\('\/api\/cms\/assets'/);
  assert.match(editor, /FormData/);
});

test('CMS asset uploads propagate busy state and release it before success changes', () => {
  assert.match(editor, /function assetUpload\(label, accept, block, onChange, onUploadBusy = \(\) => \{\}, canApplyUpload = \(\) => true, page\)/);
  assert.match(editor, /onUploadBusy\(true\)/);
  const uploadResponse = editor.indexOf("const asset = await request('/api/cms/assets'");
  const applyGuard = editor.indexOf('if (!canApplyUpload()) return;', uploadResponse);
  const blockMutation = editor.indexOf('delete block.url;', uploadResponse);
  assert.ok(uploadResponse >= 0 && applyGuard > uploadResponse && blockMutation > applyGuard);
  assert.doesNotMatch(editor.slice(applyGuard, blockMutation), /onChange|showToast/);
  assert.match(editor, /if \(uploadPending && \(!page \|\| page.active\)\) onUploadBusy\(false, true\)/);
  const uploadCatch = editor.indexOf('} catch {', uploadResponse);
  const uploadFinally = editor.indexOf('} finally {', uploadCatch);
  assert.doesNotMatch(editor.slice(uploadCatch, uploadFinally), /setSaveState|setError|markDirty/);
  const release = editor.indexOf('onUploadBusy(false);');
  const successChange = editor.indexOf('onChange();', release);
  assert.ok(release >= 0 && successChange > release);
  assert.match(editor, /function fieldsFor\(block, onChange, onUploadBusy, canApplyUpload, page\)/);
  assert.match(editor, /assetUpload\('imagem',[\s\S]*onUploadBusy, canApplyUpload, page\)/);
  assert.match(editor, /createBlockSettings\(block, onChange, onUploadBusy, canApplyUpload, page\)/);
  assert.match(cms, /let assetUploading = 0/);
  assert.match(cms, /let assetUploadVersion = 0/);
  assert.match(cms, /let editorGeneration = 0/);
  assert.match(cms, /function setAssetUploading\(busy, rearmAutosave = false\) \{[\s\S]*assetUploading = Math\.max\(0, assetUploading \+ \(busy \? 1 : -1\)\)[\s\S]*syncBusyState\(\)/);
  assert.match(cms, /if \(busy\) assetUploadVersion \+= 1/);
  assert.match(cms, /if \(rearmAutosave && assetUploading === 0\) scheduleAutosave\(\)/);
  assert.match(cms, /const generation = \+\+editorGeneration/);
  assert.match(cms, /const renderToken = selectionToken/);
  assert.match(cms, /generation === editorGeneration[\s\S]*renderToken === selectionToken \&\& renderDocument === selectedDocument/);
  assert.match(cms, /function renderEditor\(blocks = \[\], expectedAssetUploadVersion = assetUploadVersion\) \{\s*if \(expectedAssetUploadVersion !== assetUploadVersion \|\| assetUploading > 0\) return false;/);
  assert.doesNotMatch(cms, /const currentEditor = \(\) => editorInstance === editor/);
  assert.match(cms, /let blockSelectionToken = 0/);
  assert.match(cms, /const selection = \+\+blockSelectionToken/);
  assert.match(cms, /currentEditor\(\) \&\& blockSelectionToken === selection/);
  assert.match(cms, /createBlockSettings\(block, \(\) => \{[\s\S]*setAssetUploading, canApplyUpload, page\)/);
});

test('CMS assetUpload handles deferred success, failure, and stale responses behaviorally', async () => {
  const success = createAssetUploadHarness();
  const successDeferred = deferred();
  const successOrder = [];
  const successBusy = [];
  const successCalls = [];
  const successBlock = { url: 'old-url', asset_id: '' };
  success.context.fetchImpl = (url, options) => {
    successOrder.push('fetch');
    successCalls.push({ url, options });
    return successDeferred.promise;
  };
  const successUpload = startAssetUpload(success, 'Imagem', successBlock, () => {
    successOrder.push('change');
    assert.equal(successBusy.at(-1).busy, false);
    assert.equal(successBlock.asset_id, 'success-id');
  }, (busy, rearm) => {
    successBusy.push({ busy, rearm });
    successOrder.push(busy ? 'busy:start' : 'busy:end');
  }, () => {
    successOrder.push('canApply');
    assert.deepEqual(successBlock, { url: 'old-url', asset_id: '' });
    return true;
  });
  const successFile = successUpload.input.files[0];
  await Promise.resolve();
  assert.deepEqual(successBlock, { url: 'old-url', asset_id: '' });
  assert.deepEqual(successOrder, ['busy:start', 'fetch']);
  assert.equal(successCalls.length, 1);
  assert.equal(successCalls[0].url, '/api/cms/assets');
  assert.equal(successCalls[0].options.method, 'POST');
  assert.deepEqual(successCalls[0].options.body.parts, [['asset', successFile]]);
  assert.equal(successUpload.input.disabled, true);
  successDeferred.resolve({ id: 'success-id' });
  await successUpload.pending;
  assert.deepEqual(successOrder, ['busy:start', 'fetch', 'canApply', 'busy:end', 'change']);
  assert.deepEqual(successBusy, [{ busy: true, rearm: undefined }, { busy: false, rearm: undefined }]);
  assert.deepEqual(successBlock, { asset_id: 'success-id' });
  assert.deepEqual(success.context.toasts, ['Imagem enviado.']);
  assert.equal(successUpload.input.disabled, false);

  const failure = createAssetUploadHarness();
  const failureDeferred = deferred();
  const failureOrder = [];
  const failureBusy = [];
  let dirty = true;
  let saveTimer = null;
  const failureBlock = { url: 'keep-url', asset_id: 'keep-id' };
  failure.context.fetchImpl = () => {
    failureOrder.push('fetch');
    return failureDeferred.promise;
  };
  const failureUpload = startAssetUpload(failure, 'Imagem', failureBlock, () => {
    failureOrder.push('change');
  }, (busy, rearm) => {
    failureBusy.push({ busy, rearm });
    failureOrder.push(busy ? 'busy:start' : 'busy:end');
    if (!busy && rearm && dirty && saveTimer === null) saveTimer = 'rearmed';
  }, () => true);
  await Promise.resolve();
  failureDeferred.reject(new Error('upload failed'));
  await failureUpload.pending;
  assert.deepEqual(failureOrder, ['busy:start', 'fetch', 'busy:end']);
  assert.deepEqual(failureBusy, [{ busy: true, rearm: undefined }, { busy: false, rearm: true }]);
  assert.equal(dirty, true);
  assert.equal(saveTimer, 'rearmed');
  assert.deepEqual(failureBlock, { url: 'keep-url', asset_id: 'keep-id' });
  assert.deepEqual(failure.context.toasts, ['Não foi possível enviar imagem.']);

  const stale = createAssetUploadHarness();
  const staleDeferred = deferred();
  const staleOrder = [];
  const staleBlock = { url: 'stale-url', asset_id: 'stale-id' };
  const newerTimer = { id: 'newer-timer' };
  let staleTimer = newerTimer;
  stale.context.fetchImpl = () => {
    staleOrder.push('fetch');
    return staleDeferred.promise;
  };
  const staleUpload = startAssetUpload(stale, 'Imagem', staleBlock, () => {
    staleOrder.push('change');
  }, (busy, rearm) => {
    staleOrder.push(busy ? 'busy:start' : 'busy:end');
    if (!busy && rearm && staleTimer === null) staleTimer = { id: 'rearmed' };
  }, () => {
    staleOrder.push('canApply');
    return false;
  });
  await Promise.resolve();
  staleDeferred.resolve({ id: 'ignored-id' });
  await staleUpload.pending;
  assert.deepEqual(staleOrder, ['busy:start', 'fetch', 'canApply', 'busy:end']);
  assert.deepEqual(staleBlock, { url: 'stale-url', asset_id: 'stale-id' });
  assert.equal(staleTimer, newerTimer);
  assert.deepEqual(stale.context.toasts, []);
});

test('reminder reloads ignore deferred responses that finish out of order', async () => {
  const harness = createRemindersLoaderHarness();
  const pending = [];
  harness.context.fetchImpl = url => new Promise((resolve, reject) => pending.push({ url, resolve, reject }));

  harness.context.page = 1;
  const first = harness.loadReminders();
  const second = harness.loadReminders(true);
  await Promise.resolve();
  assert.deepEqual(pending.map(({ url }) => url), [
    '/api/reminders?limit=50&offset=50',
    '/api/reminders?limit=50&offset=0',
  ]);

  pending[1].resolve({ data: [{ id: 'new' }], total: 1 });
  await second;
  pending[0].resolve({ data: [{ id: 'old' }], total: 99 });
  await first;

  assert.deepEqual(harness.context.reminders, [{ id: 'new' }]);
  assert.equal(harness.context.totalReminders, 1);
  assert.deepEqual(harness.context.rendered, [{ ids: ['new'], page: 0, total: 1 }]);
  assert.equal(harness.context.tableStates.length, 2);

  harness.context.page = 2;
  const fallback = harness.loadReminders();
  await Promise.resolve();
  assert.equal(pending[2].url, '/api/reminders?limit=50&offset=100');
  pending[2].resolve({ data: [], total: 75 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending[3].url, '/api/reminders?limit=50&offset=50');
  pending[3].resolve({ data: [{ id: 'last-valid-page' }], total: 75 });
  await fallback;

  assert.equal(harness.context.page, 1);
  assert.deepEqual(harness.context.reminders, [{ id: 'last-valid-page' }]);
  assert.equal(harness.context.totalReminders, 75);
  assert.deepEqual(harness.context.rendered, [
    { ids: ['new'], page: 0, total: 1 },
    { ids: ['last-valid-page'], page: 1, total: 75 },
  ]);
  assert.deepEqual(harness.context.pagination, [
    { page: 0, total: 1 },
    { page: 1, total: 75 },
  ]);
  assert.equal(harness.context.tableStates.length, 4);
});

test('safe renderer validates the allowlist and never uses raw HTML sinks', () => {
  assert.match(renderer, /export const BLOCK_TYPES/);
  assert.match(renderer, /export function validateBlocks/);
  assert.match(renderer, /MAX_CMS_PAYLOAD_BYTES = 5 \* 1024 \* 1024/);
  assert.match(renderer, /TextEncoder\(\)\.encode\(JSON\.stringify\(blocks\)\)/);
  assert.match(renderer, /textContent/);
  assert.match(renderer, /fetchAPIAsset/);
  assert.match(renderer, /\/api\/cms\/assets\//);
  assert.doesNotMatch(renderer, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(editor, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('knowledge articles support compact search and private PDF attachments', () => {
  assert.match(knowledgeHtml, /href="\.\/css\/knowledge\.css"/);
  assert.match(knowledgeHtml, /id="f-pdf"[^>]*type="file"[^>]*accept="application\/pdf"/);
  assert.match(knowledgeHtml, /id="f-pdf-remove"/);
  assert.match(knowledgeCss, /\.knowledge-search\s*\{/);
  assert.match(knowledgeCss, /@media \(max-width: 700px\)/);
  assert.match(knowledge, /FormData/);
  assert.match(knowledge, /pdf_asset_id/);
  assert.match(knowledge, /pdf_title/);
  assert.match(knowledge, /pdfUploadPromise/);
  assert.match(renderer, /iframe/);
  assert.match(renderer, /Abrir PDF em nova aba/);
  assert.match(renderer, /URL\.revokeObjectURL/);
});

test('Knowledge accepts PDF attachments up to 100 MB', () => {
  assert.equal((knowledge.match(/file\.size > 100 \* 1024 \* 1024/g) || []).length, 2);
  assert.equal((knowledge.match(/O PDF deve ter no máximo 100 MB\./g) || []).length, 2);
});

test('CMS actions use the existing API contracts and keep generic failure states visible', () => {
  for (const endpoint of ['/api/cms/documents', '/draft', '/publish', '/schedule', '/unpublish']) assert.match(cms, new RegExp(endpoint.replace('/', '\\/')));
  assert.match(cms, /method: 'DELETE'/);
  assert.match(cms, /Salvando rascunho/);
  assert.match(cms, /Não foi possível salvar o rascunho/);
  assert.match(cmsHtml, /revision-history/);
  assert.match(cmsHtml, /revision-history-pagination/);
  assert.match(cmsHtml, /load-history/);
  assert.match(cmsHtml, /horário local/);
  assert.match(cms, /documents\/\$\{encodeURIComponent\(documentId\)\}\/revisions/);
  assert.match(cms, /requestToken !== selectionToken \|\| documentId !== selectedDocument/);
  assert.match(cms, /if \(requestToken === selectionToken && documentId === selectedDocument && historyToken === historyRequestToken\)/);
  assert.match(cms, /const type = selectedType/);
  assert.match(cms, /const DOCUMENT_PAGE_SIZE = 50/);
  assert.match(cms, /result\.total/);
  assert.match(cms, /requestOffset !== documentOffset/);
  assert.match(cms, /clear\(documentPagination\)/);
  assert.match(cms, /documentPagination\.querySelectorAll\('button'\)/);
  assert.match(cms, /const requestToken = \+\+selectionToken/);
  assert.match(cms, /documentsByType\.set\(type, \[\]\)/);
  assert.match(cms, /const listSnapshot = \{/);
  assert.match(cms, /restoreDocumentList\(type, listSnapshot\)/);
  const postIndex = cms.indexOf("fetchAPI('/api/cms/documents'");
  const resetIndex = cms.indexOf('documentsByType.set(type, []);', postIndex);
  assert.ok(postIndex >= 0 && resetIndex > postIndex);
  assert.match(cms, /if \(!newDocumentForm\.hidden\) void loadSources\(\)/);
  assert.match(cms, /fetchAPIPage\(`\/api\/cms\/documents\/\$\{encodeURIComponent\(documentId\)\}\/revisions\?limit=\$\{HISTORY_PAGE_SIZE\}&offset=\$\{historyOffset\}`\)/);
  assert.match(cms, /for \(let offset = sources\.length; offset < total; offset \+= 100\)/);
  assert.match(cms, /new Date\(value\)/);
});

test('CMS revision history clamps pagination before loading another page', () => {
  assert.match(cms, /historyOffset = Math\.max\(0, historyOffset - HISTORY_PAGE_SIZE\)/);
  assert.match(cms, /const finalHistoryOffset = Math\.max\(0, Math\.floor\(\(total - 1\) \/ HISTORY_PAGE_SIZE\) \* HISTORY_PAGE_SIZE\)/);
  assert.match(cms, /historyOffset = Math\.min\(finalHistoryOffset, historyOffset \+ HISTORY_PAGE_SIZE\)/);
});

test('optional pagination containers stay null-safe on list and detail pages', async () => {
  const [pagination, announcements] = await Promise.all([
    readFile('public/js/pagination.js', 'utf8'),
    readFile('public/js/announcements.js', 'utf8'),
  ]);
  assert.match(pagination, /if \(!node\) return/);
  assert.match(announcements, /pagination\?\.replaceChildren\(\)/);
});

test('autosave coalesces in-flight edits and rejects stale document responses', () => {
  assert.match(cms, /let saveQueued = false/);
  assert.match(cms, /let saveInFlight = null/);
  assert.match(cms, /let editVersion = 0/);
  assert.match(cms, /let creatingDocument = false/);
  assert.match(cms, /function editorInteractionBusy\(\) \{\s*return creatingDocument \|\| actionBusy \|\| loading \|\| documentsLoading \|\| assetUploading > 0;/);
  assert.match(cms, /function editorSavePending\(\) \{\s*return dirty \|\| saveQueued \|\| saving \|\| saveInFlight \|\| saveTimer !== null \|\| assetUploading > 0;/);
  assert.match(cms, /const saveInProgress = saving \|\| saveInFlight/);
  assert.match(cms, /const editorBusy = editorInteractionBusy\(\)/);
  assert.match(cms, /editorRoot\.inert = editorBusy/);
  assert.match(cms, /editorRoot\.setAttribute\('aria-busy', String\(editorBusy\)\)/);
  assert.match(cms, /blockSettings\.inert = editorBusy/);
  assert.match(cms, /blockSettings\.setAttribute\('aria-busy', String\(editorBusy\)\)/);
  assert.match(cms, /inspectorRoot\.inert = editorBusy/);
  assert.match(cms, /inspectorRoot\.setAttribute\('aria-busy', String\(editorBusy\)\)/);
  assert.match(cms, /newDocumentForm\.inert = editorBusy/);
  assert.match(cms, /newDocumentForm\.setAttribute\('aria-busy', String\(editorBusy\)\)/);
  assert.match(cms, /function markDirty\(nextBlocks\) \{\s*if \(editorInteractionBusy\(\)\) return;/);
  assert.match(cms, /newDocumentForm\.addEventListener\('input', \(\) => \{\s*if \(editorInteractionBusy\(\)\) return;/);
  assert.match(cms, /if \(saving\) \{\s*saveQueued = true/);
  assert.match(cms, /return saveInFlight \|\| null/);
  assert.match(cms, /savedResult = queuedResult/);
  const saveInFlightClear = cms.indexOf('saveInFlight = null;');
  const saveInFlightSync = cms.indexOf('syncBusyState();', saveInFlightClear);
  assert.ok(saveInFlightClear >= 0 && saveInFlightSync > saveInFlightClear);
  assert.match(cms, /if \(creatingDocument \|\| assetUploading > 0 \|\| !documentView \|\| !editor\) return null/);
  assert.match(cms, /function scheduleAutosave\(\) \{\s*if \(!dirty \|\| !documentView \|\| !editor \|\| editorInteractionBusy\(\) \|\| saveQueued \|\| saving \|\| saveInFlight \|\| saveTimer !== null\) return;/);
  assert.match(cms, /async function saveDraft\(\) \{\s*if \(creatingDocument \|\| assetUploading > 0 \|\| !documentView \|\| !editor\) return null;\s*clearTimeout\(saveTimer\);\s*saveTimer = null;\s*if \(saving\)/);
  assert.match(cms, /async function saveBeforeAction\(\) \{[\s\S]*clearTimeout\(saveTimer\);[\s\S]*return await saveDraft\(\);[\s\S]*clearTimeout\(saveTimer\)/);
  assert.equal((cms.match(/const saved = await saveBeforeAction\(\)/g) || []).length, 2);
  assert.match(cms, /publishButton\.disabled = !active \|\| saveInProgress/);
  assert.match(cms, /scheduleButton\.disabled = !active \|\| saveInProgress/);
  assert.match(cms, /async function publishDocument\(\) \{\s*if \(!documentView \|\| editorInteractionBusy\(\) \|\| saving \|\| saveInFlight\) return;/);
  assert.match(cms, /async function scheduleDocument\(event\) \{\s*event\.preventDefault\(\);\s*if \(!documentView \|\| editorInteractionBusy\(\) \|\| saving \|\| saveInFlight\) return;/);
  assert.match(cms, /revision_id: saved\.revision\.id/);
  assert.match(cms, /const active = !!doc \&\& !editorInteractionBusy\(\)/);
  assert.match(cms, /unpublishButton\.disabled = !active \|\| savePending \|\| !doc\.published_revision_id/);
  assert.match(cms, /unscheduleButton\.disabled = !active \|\| savePending \|\| !doc\.scheduled_revision_id/);
  assert.match(cms, /if \(!documentView\?\.document\?\.published_revision_id \|\| mutationBusy\(\) \|\| creatingDocument \|\| editorSavePending\(\)\) return/);
  assert.match(cms, /if \(!documentView\?\.document\?\.scheduled_revision_id \|\| mutationBusy\(\) \|\| creatingDocument \|\| editorSavePending\(\)\) return/);
  assert.match(cms, /async function publishDocument\(\) \{[\s\S]*clearTimeout\(saveTimer\);\s*saveTimer = null;\s*actionBusy = true/);
  assert.match(cms, /async function scheduleDocument\(event\) \{[\s\S]*clearTimeout\(saveTimer\);\s*saveTimer = null;\s*actionBusy = true/);
  assert.match(cms, /requestVersion = editVersion/);
  assert.match(cms, /editVersion !== requestVersion/);
  assert.match(cms, /requestToken !== selectionToken/);
  assert.match(cms, /actionBusy = true/);
  assert.match(cms, /publishButton\.disabled = !active/);
});

test('CMS list loading and creation failures keep cached state coherent', () => {
  const loaderStart = cms.indexOf('async function loadDocuments');
  const loaderEnd = cms.indexOf('async function loadSources');
  const createStart = cms.indexOf("newDocumentForm.addEventListener('submit'");
  const createEnd = cms.indexOf('saveDraftButton.addEventListener', createStart);
  const loadDocumentStart = cms.indexOf('async function loadDocument');
  const loadDocumentEnd = cms.indexOf('async function saveDraft', loadDocumentStart);
  const loader = cms.slice(loaderStart, loaderEnd);
  const create = cms.slice(createStart, createEnd);
  const loadDocument = cms.slice(loadDocumentStart, loadDocumentEnd);
  const typeNav = cms.slice(cms.indexOf('function renderTypeNav'), cms.indexOf('function renderDocumentList'));
  const unscheduleStart = cms.indexOf('async function unscheduleDocument');
  const unscheduleEnd = cms.indexOf('newDocumentButton.addEventListener', unscheduleStart);
  const unschedule = cms.slice(unscheduleStart, unscheduleEnd);
  const pageChangeStart = cms.indexOf('function changeDocumentPage');
  const pageChangeEnd = cms.indexOf('function updateInspector', pageChangeStart);
  const pageChange = cms.slice(pageChangeStart, pageChangeEnd);
  assert.match(cms, /let documentsLoading = false/);
  assert.match(cms, /let documentsRequestToken = 0/);
  assert.match(cms, /let creationRequestToken = 0/);
  assert.match(cms, /return saving \|\| actionBusy \|\| loading \|\| documentsLoading \|\| assetUploading > 0/);
  assert.match(loader, /const requestToken = \+\+documentsRequestToken/);
  assert.match(loader, /const selectionRequestToken = selectionToken/);
  assert.match(loader, /documentsLoading = true/);
  assert.match(loader, /return true/);
  assert.match(loader, /return false/);
  assert.match(loader, /if \(requestToken === documentsRequestToken\) \{[\s\S]*documentsLoading = false/);
  assert.match(pageChange, /documentOffset = offset;\s*loadDocuments\(\)/);
  assert.match(pageChange, /if \(navigationBusy\(\)\) return;/);
  assert.doesNotMatch(pageChange, /selectionToken/);
  assert.match(typeNav, /clearTimeout\(saveTimer\);\s*saveTimer = null;\s*saveQueued = false/);
  assert.match(create, /if \(mutationBusy\(\) \|\| editorInteractionBusy\(\)\) return/);
  assert.match(create, /if \(editorSavePending\(\)\) \{[\s\S]*Salve as alterações do editor/);
  const creationGuard = create.indexOf('if (editorSavePending())');
  const timerClear = create.indexOf('clearTimeout(saveTimer);', creationGuard);
  const postIndex = create.indexOf("fetchAPI('/api/cms/documents'");
  assert.ok(creationGuard >= 0 && timerClear > creationGuard && postIndex > timerClear);
  assert.match(create, /creatingDocument = true;[\s\S]*fetchAPI\('\/api\/cms\/documents'/);
  assert.match(create, /const requestToken = \+\+creationRequestToken/);
  assert.doesNotMatch(create, /\+\+selectionToken/);
  assert.match(create, /requestToken !== creationRequestToken/);
  assert.match(create, /finally \{\s*creatingDocument = false;\s*actionBusy = false;/);
  assert.match(create, /const refreshed = await loadDocuments\(\)/);
  assert.match(create, /if \(!refreshed\) \{[\s\S]*restoreDocumentList\(type, listSnapshot\)[\s\S]*Documento criado/);
  assert.match(create, /if \(requestToken !== creationRequestToken \|\| type !== selectedType\) return/);
  assert.match(loadDocument, /const requestAssetUploadVersion = assetUploadVersion/);
  assert.match(loadDocument, /requestToken !== selectionToken \|\| selectedDocument !== id[\s\S]*requestAssetUploadVersion !== assetUploadVersion[\s\S]*assetUploading > 0\) return false;/);
  assert.equal((loadDocument.match(/requestAssetUploadVersion !== assetUploadVersion/g) || []).length, 2);
  const loadIdentityGuard = loadDocument.indexOf('assetUploading > 0) return false;');
  const loadMutation = loadDocument.indexOf('documentView = view;');
  assert.ok(loadIdentityGuard >= 0 && loadMutation > loadIdentityGuard);
  const loadCatch = loadDocument.indexOf('} catch {');
  const loadCatchGuard = loadDocument.indexOf('assetUploading > 0) return false;', loadCatch);
  const loadEditorClear = loadDocument.indexOf('editor = null;', loadCatch);
  assert.ok(loadCatch >= 0 && loadCatchGuard > loadCatch && loadEditorClear > loadCatchGuard);
  assert.match(loadDocument, /renderEditor\(blocks, requestAssetUploadVersion\)/);
  assert.match(unschedule, /const requestAssetUploadVersion = assetUploadVersion/);
  assert.match(unschedule, /requestDocument !== selectedDocument[\s\S]*requestAssetUploadVersion !== assetUploadVersion[\s\S]*assetUploading > 0\) return;/);
  const unscheduleMutation = unschedule.indexOf('documentView.document = result.document;');
  const unscheduleEditorRender = unschedule.indexOf('if (!renderEditor(documentView.draft?.blocks || [], requestAssetUploadVersion)) return;');
  const unscheduleIdentityGuard = unschedule.indexOf('assetUploading > 0) return;');
  assert.ok(unscheduleIdentityGuard >= 0 && unscheduleMutation > unscheduleIdentityGuard && unscheduleEditorRender > unscheduleMutation);
  assert.match(loadDocument, /if \(!newDocumentForm\.hidden && !newDocumentDirty\) \{[\s\S]*newDocumentForm\.reset\(\);[\s\S]*newDocumentForm\.hidden = true;/);
  assert.match(loadDocument, /if \(navigationBusy\(\)\) return false/);
  assert.match(loadDocument, /showState\(editorRoot, 'Não foi possível abrir este documento\.', \(\) => loadDocument\(id\)\)/);
  assert.match(loadDocument, /return true;/);
  assert.match(loadDocument, /return false;/);
  assert.match(create, /const loaded = await loadDocument\(result\.document\.id\);[\s\S]*if \(!loaded\) \{[\s\S]*Documento criado, mas não foi possível abrir/);
  const loadResult = create.indexOf('const loaded = await loadDocument(result.document.id);');
  const successToast = create.indexOf("showToast('Documento criado como rascunho.')");
  assert.ok(loadResult >= 0 && successToast > loadResult && create.slice(loadResult, successToast).includes('if (!loaded)'));
  const unscheduleGuard = unschedule.indexOf('if (!documentView?.document?.scheduled_revision_id');
  const renderEditor = unschedule.indexOf('renderEditor(documentView.draft?.blocks || [], requestAssetUploadVersion)');
  assert.ok(unscheduleGuard >= 0 && renderEditor > unscheduleGuard);
});

test('CMS navigation links are permission-gated before the API remains authoritative', () => {
  assert.match(auth, /dataset\.cmsAccess/);
  assert.match(auth, /manageKnowledge.*manageAcademy.*manageBenefits.*manageReminders/s);
  assert.match(layout, /\.cms-link, \.cms-entry-link \{ display: none/);
  assert.match(layout, /html\[data-auth-state="ready"\]\[data-cms-access="true"\] \.cms-link/);
  assert.match(css, /\.cms-block\.cms-link,\s*\.cms-pdf-link \{ display: inline-flex; margin-bottom: 14px; \}/);
  assert.match(admin, /class="cms-entry-link/);
  assert.match(cms, /\.filter\(\(\[, , permission\]\) => can\(user, permission\)\)/);
});

test('reminder content uses the safe renderer while retaining description fallback', () => {
  assert.match(reminders, /renderBlocks\(content, reminder\.content_blocks/);
  assert.match(reminders, /fallbackText: reminder\.description/);
  assert.match(dashboard, /renderBlocks\(copy, blocks/);
  assert.match(dashboard, /fallbackText: description/);
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

test('dirty CMS navigation uses the lifecycle guard and protects reload/close without blocking editor actions', () => {
  assert.match(cms, /page\.listen\(window, 'beforeunload'/);
  assert.match(cms, /page\.beforeLeave\(/);
  assert.match(cms, /window\.confirm\('Há alterações do CMS/);
  assert.match(cms, /event\.preventDefault\(\)/);
  assert.match(cms, /if \(saving \|\| actionBusy \|\| creatingDocument \|\| assetUploading \|\| saveInFlight\)/);
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
