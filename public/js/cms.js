import { can, fetchAPI, fetchAPIPage } from './auth.js';
import { clear, element, showState } from './ui.js';
import { renderPagination } from './pagination.js';
import { createBlockEditor, createBlockSettings, serializeBlocks, STANDARD_BLOCK_TYPES } from './cms-block-editor.js';
import { renderBlocks, cleanupRenderedBlocks, BLOCK_TYPES } from './cms-block-renderer.js';
import { createEditorialFields, editorialPublicationError } from './owner-news/cms-editorial.js';
import { mountNewsHomeEditor } from './owner-news/cms-home.js';
import { mountNewsPollManager } from './owner-news/cms-polls.js';
import { renderNewsArticle } from './owner-news/reader-view.js';
import { estimateNewsReadTime, normalizeEditorial } from './owner-news/model.js';

const REVISION_STATUS_LABELS = new Map([
  ['draft', 'Rascunho'],
  ['published', 'Publicado'],
  ['scheduled', 'Agendado'],
  ['archived', 'Arquivado'],
]);

const requests = { fetchAPI, fetchAPIPage };
const renderContent = renderBlocks;
export function mount(page) {
const user = page.user;
const { fetchAPI, fetchAPIPage } = page.bindAPI(requests);
const showToast = page.toast;
const setTimeout = page.timeout;
const renderBlocks = (node, blocks, options) => renderContent(node, blocks, { ...options, signal: page.signal });

const TYPES = [
  ['knowledge', 'Base de Conhecimento', 'manageKnowledge'],
  ['academy', 'Academy', 'manageAcademy'],
  ['benefit', 'Benefícios', 'manageBenefits'],
  ['announcement', 'Owner News', 'manageKnowledge'],
  ['reminder', 'Lembretes', 'manageReminders'],
].filter(([, , permission]) => can(user, permission));

const TYPE_LABELS = Object.fromEntries(TYPES.map(([type, label]) => [type, label]));
const SOURCE_ENDPOINTS = {
  knowledge: '/api/knowledge?limit=100&offset=0',
  academy: '/api/academy?all=true&limit=100&offset=0',
  benefit: '/api/benefits?all=true&limit=100&offset=0',
  reminder: '/api/reminders?all=true&limit=100&offset=0',
};

const contentTypes = document.getElementById('content-types');
const documentList = document.getElementById('document-list');
const documentPagination = document.getElementById('document-pagination');
const newDocumentButton = document.getElementById('new-document');
const newDocumentForm = document.getElementById('new-document-form');
const sourceField = document.getElementById('new-source-field');
const sourceSelect = document.getElementById('new-source');
const editorRoot = document.getElementById('editor-root');
const inspectorRoot = document.querySelector('.cms-inspector');
const previewRoot = document.getElementById('preview-root');
const editorHeading = document.getElementById('editor-heading');
const editorStatus = document.getElementById('editor-status');
const saveState = document.getElementById('save-state');
const errorNode = document.getElementById('cms-error');
const selectedTypeNode = document.getElementById('inspector-type');
const categoryNode = document.getElementById('inspector-category');
const publishedNode = document.getElementById('inspector-published');
const blockSettings = document.getElementById('inspector-block-settings');
const historyNode = document.getElementById('revision-history');
const historyPagination = document.getElementById('revision-history-pagination');
const loadHistoryButton = document.getElementById('load-history');
const saveDraftButton = document.getElementById('save-draft');
const publishButton = document.getElementById('publish-document');
const unpublishButton = document.getElementById('unpublish-document');
const scheduleForm = document.getElementById('schedule-form');
const scheduleButton = document.getElementById('schedule-document');
const unscheduleButton = document.getElementById('unschedule-document');
const editorialRoot = document.getElementById('cms-editorial-fields');
const newsSections = document.getElementById('owner-news-sections');
const newsSettings = document.getElementById('owner-news-settings');
const editorColumn = document.querySelector('.cms-editor-column');
let editorialFields = null;
let previewCleanup = null;
let newsSection = 'articles';
let homeEditor = null;
let homeDirty = false;
let homeBusy = false;

let selectedType = TYPES[0]?.[0] || null;
let selectedDocument = null;
let documentView = null;
let editor = null;
let saveTimer = null;
let saving = false;
let saveQueued = false;
let saveInFlight = null;
let dirty = false;
let editVersion = 0;
let selectionToken = 0;
let actionBusy = false;
let loading = false;
let documentsLoading = false;
let newDocumentDirty = false;
let creatingDocument = false;
let assetUploading = 0;
let assetUploadVersion = 0;
let editorGeneration = 0;
let creationRequestToken = 0;
let navigationConfirmed = false;
let historyOffset = 0;
let historyRequestToken = 0;
let documentsRequestToken = 0;
const HISTORY_PAGE_SIZE = 50;
const DOCUMENT_PAGE_SIZE = 50;
const documentsByType = new Map();
const sourcesByType = new Map();
let documentOffset = 0;
let documentTotal = 0;
page.beforeLeave(() => {
  if (homeEditor && !homeEditor.canLeave()) return false;
  if (saving || actionBusy || creatingDocument || assetUploading || saveInFlight) {
    showToast('Aguarde a operação do CMS terminar.');
    return false;
  }
  return !(dirty || newDocumentDirty || saveQueued)
    || window.confirm('Há alterações do CMS que ainda não foram salvas. Sair mesmo assim?');
});
page.cleanup(() => {
  previewCleanup?.(); editorialFields?.dispose(); homeEditor?.dispose();
  ++selectionToken; ++documentsRequestToken; ++historyRequestToken;
  ++creationRequestToken; ++editorGeneration;
  clearTimeout(saveTimer); saveTimer = null; saveQueued = false;
});

function setError(message = '') {
  errorNode.hidden = !message;
  errorNode.textContent = message;
}

function setSaveState(message) {
  saveState.textContent = message;
}

function mutationBusy() {
  return saving || actionBusy || loading || documentsLoading || assetUploading > 0;
}

function editorInteractionBusy() {
  return creatingDocument || actionBusy || loading || documentsLoading || assetUploading > 0;
}

function editorSavePending() {
  return dirty || saveQueued || saving || saveInFlight || saveTimer !== null || assetUploading > 0;
}

function scheduleAutosave() {
  if (!dirty || !documentView || !editor || editorInteractionBusy() || saveQueued || saving || saveInFlight || saveTimer !== null) return;
  const timer = setTimeout(() => {
    if (saveTimer !== timer) return;
    saveTimer = null;
    void saveDraft();
  }, 900);
  saveTimer = timer;
}

function setAssetUploading(busy, rearmAutosave = false) {
  if (busy) assetUploadVersion += 1;
  assetUploading = Math.max(0, assetUploading + (busy ? 1 : -1));
  syncBusyState();
  if (rearmAutosave && assetUploading === 0) scheduleAutosave();
}

function navigationBusy() {
  return mutationBusy() || dirty || newDocumentDirty;
}

function cmsNavigationProtected() {
  return !navigationConfirmed && (navigationBusy() || saveQueued || homeDirty || homeBusy);
}

page.listen(window, 'beforeunload', event => {
  if (!cmsNavigationProtected()) return;
  event.preventDefault();
  event.returnValue = '';
});

function syncBusyState() {
  if (!page.active) return;
  const editorBusy = editorInteractionBusy();
  const navigationBlocked = navigationBusy() || creatingDocument;
  editorRoot.inert = editorBusy;
  if (editorialRoot) editorialRoot.inert = editorBusy;
  editorRoot.setAttribute('aria-busy', String(editorBusy));
  blockSettings.inert = editorBusy;
  blockSettings.setAttribute('aria-busy', String(editorBusy));
  inspectorRoot.inert = editorBusy;
  inspectorRoot.setAttribute('aria-busy', String(editorBusy));
  newDocumentForm.inert = editorBusy;
  newDocumentForm.setAttribute('aria-busy', String(editorBusy));
  newDocumentButton.disabled = !TYPES.length || navigationBlocked || newsSection !== 'articles';
  contentTypes.querySelectorAll('button').forEach(button => { button.disabled = navigationBlocked; });
  documentList.querySelectorAll('button').forEach(button => { button.disabled = navigationBlocked; });
  documentPagination.querySelectorAll('button').forEach(button => { button.disabled = navigationBlocked; });
  updateInspector();
}

function statusFor(doc) {
  if (doc?.draft_revision_id && doc?.scheduled_revision_id) return ['Rascunho · agendado', 'badge-gold'];
  if (doc?.draft_revision_id) return ['Rascunho', 'badge-gold'];
  if (doc?.scheduled_revision_id) return ['Agendado', 'badge-gold'];
  if (doc?.published_revision_id) return ['Publicado', 'badge-green'];
  return ['Arquivado', 'badge-gray'];
}

function syncListedDocument(document) {
  if (!document) return;
  const documents = documentsByType.get(document.content_type) || [];
  const index = documents.findIndex(item => item.id === document.id);
  if (index >= 0) documents[index] = document;
}

function mutationError(error, fallback) {
  if (error?.status === 409) return 'O rascunho mudou em outra sessão. Recarregue o documento antes de publicar ou agendar.';
  if (error?.status === 400) return 'Revise os blocos e os arquivos anexados antes de continuar.';
  return fallback;
}

function statusBadge(doc) {
  const [label, className] = statusFor(doc);
  return element('span', { className: `badge ${className}`, text: label });
}

// Call only after navigation guards accept the transition. Mutation ownership
// (saving, saveInFlight, actionBusy and uploads) must never be cleared here.
function resetSelection() {
  editorialFields?.dispose(); editorialFields = null;
  if (editorialRoot) editorialRoot.hidden = true;
  previewCleanup?.(); previewCleanup = null;
  previewRoot.classList.remove('news-editorial-preview', 'news-article');
  ++editorGeneration;
  ++historyRequestToken;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveQueued = false;
  dirty = false;
  newDocumentDirty = false;
  editVersion = 0;
  selectedDocument = null;
  documentView = null;
  editor = null;
  historyOffset = 0;
  showState(editorRoot, 'Selecione um documento na coluna ao lado.');
  // Removing preview children alone does not release the renderer's assets.
  renderBlocks(previewRoot, [], { fallbackText: 'A prévia aparecerá aqui.' });
  delete blockSettings.dataset.selectedIndex;
  showState(blockSettings, 'Selecione um bloco para editar suas configurações.');
  historyNode.replaceChildren(element('li', { className: 'empty-state', text: 'Selecione um documento.' }));
  clear(historyPagination);
  scheduleForm.reset();
  setError('');
  setSaveState('Selecione um documento');
  updateInspector();
}

function renderTypeNav() {
  syncNewsSections();
  clear(contentTypes);
  TYPES.forEach(([type, label]) => contentTypes.append(element('button', {
    className: 'cms-content-type', type: 'button', text: label,
    'aria-current': String(type === selectedType),
    ...(navigationBusy() ? { disabled: '' } : {}),
    on: { click: () => {
      if (!page.active || navigationBusy()) return;
      if (homeEditor && !homeEditor.canLeave()) return;
      homeEditor?.dispose(); homeEditor = null; newsSection = 'articles';
      selectionToken += 1;
      resetSelection();
      documentOffset = 0;
      documentTotal = 0;
      selectedType = type;
      documentsByType.set(type, []);
      newDocumentForm.hidden = true;
      renderTypeNav();
      renderDocumentList();
      if (!newDocumentForm.hidden) void loadSources();
      loadDocuments();
    } },
  })));
}

function syncNewsSections() {
  const news = selectedType === 'announcement';
  const home = news && newsSection !== 'articles';
  if (newsSections) {
    newsSections.hidden = !news;
    newsSections.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.newsSection === newsSection)));
  }
  if (newsSettings) newsSettings.hidden = !home;
  if (editorColumn) editorColumn.hidden = home;
  if (inspectorRoot) inspectorRoot.hidden = home;
  documentList.hidden = home;
  documentPagination.hidden = home;
  newDocumentButton.hidden = home;
}

newsSections?.querySelectorAll('button').forEach(button => page.listen(button, 'click', () => {
  const next = button.dataset.newsSection;
  if (next === newsSection || selectedType !== 'announcement' || !newsSettings) return;
  if (mutationBusy() || creatingDocument || saveInFlight) { showToast('Aguarde a operação do CMS terminar.'); return; }
  if (homeEditor && !homeEditor.canLeave()) return;
  if ((dirty || newDocumentDirty || saveQueued) && !window.confirm('Há alterações do CMS que ainda não foram salvas. Sair mesmo assim?')) return;
  homeEditor?.dispose(); homeEditor = null;
  ++selectionToken;
  resetSelection();
  newDocumentForm.hidden = true;
  newsSection = next;
  syncNewsSections();
  if (next === 'home') homeEditor = mountNewsHomeEditor({ root: newsSettings, page, onDirty(value, busy) { homeDirty = value; homeBusy = busy; } });
  else if (next === 'polls') homeEditor = mountNewsPollManager({ root: newsSettings, page, onDirty(value, busy) { homeDirty = value; homeBusy = busy; } });
  else { renderDocumentList(); syncBusyState(); }
}));

function renderDocumentList() {
  const docs = documentsByType.get(selectedType) || [];
  clear(documentList);
  if (!docs.length) {
    documentList.append(element('p', { className: 'empty-state', text: 'Nenhum documento nesta área.' }));
    renderPagination(documentPagination, documentTotal, documentOffset, DOCUMENT_PAGE_SIZE, changeDocumentPage);
    return;
  }
  docs.forEach(doc => documentList.append(element('button', {
    className: 'cms-document-item', type: 'button', 'aria-current': String(doc.id === selectedDocument),
    ...(navigationBusy() ? { disabled: '' } : {}),
    on: { click: () => loadDocument(doc.id) },
  }, [element('span', { className: 'cms-document-title', text: doc.title }), element('span', { className: 'cms-document-meta' }, [statusBadge(doc), element('span', { text: doc.category || 'Sem categoria' })])] )));
  renderPagination(documentPagination, documentTotal, documentOffset, DOCUMENT_PAGE_SIZE, changeDocumentPage);
}

function restoreDocumentList(type, snapshot) {
  if (snapshot.hadDocuments) documentsByType.set(type, snapshot.documents);
  else documentsByType.delete(type);
  documentOffset = snapshot.offset;
  documentTotal = snapshot.total;
  renderDocumentList();
}

function changeDocumentPage(offset) {
  if (navigationBusy()) return;
  documentOffset = offset;
  loadDocuments();
}

function updateInspector() {
  const doc = documentView?.document;
  if (!doc) showState(blockSettings, 'Selecione um bloco para editar suas configurações.');
  const [status] = statusFor(doc);
  editorHeading.textContent = doc?.title || 'Selecione um documento';
  editorStatus.className = `badge ${status === 'Publicado' ? 'badge-green' : status.includes('Rascunho') || status.includes('agendado') ? 'badge-gold' : 'badge-gray'}`;
  editorStatus.textContent = doc ? status : 'Nenhum';
  selectedTypeNode.textContent = doc ? TYPE_LABELS[doc.content_type] || doc.content_type : '—';
  categoryNode.textContent = doc?.category || '—';
  publishedNode.textContent = doc?.published_at ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(doc.published_at)) : '—';
  const active = !!doc && !editorInteractionBusy();
  const savePending = editorSavePending();
  const saveInProgress = saving || saveInFlight;
  saveDraftButton.disabled = !active || saving;
  publishButton.disabled = !active || saveInProgress;
  unpublishButton.disabled = !active || savePending || !doc.published_revision_id;
  scheduleButton.disabled = !active || saveInProgress;
  unscheduleButton.disabled = !active || savePending || !doc.scheduled_revision_id;
  loadHistoryButton.disabled = !doc || mutationBusy() || creatingDocument;
}

async function loadRevisionHistory(documentId = selectedDocument) {
  if (!page.active || !documentView || !documentId || documentId !== selectedDocument) return;
  const requestToken = selectionToken;
  const historyToken = ++historyRequestToken;
  const currentHistory = () => page.active && requestToken === selectionToken
    && documentId === selectedDocument && historyToken === historyRequestToken;
  historyNode.replaceChildren(element('li', { className: 'empty-state', text: 'Carregando histórico…' }));
  clear(historyPagination);
  try {
    const result = await fetchAPIPage(`/api/cms/documents/${encodeURIComponent(documentId)}/revisions?limit=${HISTORY_PAGE_SIZE}&offset=${historyOffset}`);
    if (!page.active || requestToken !== selectionToken || documentId !== selectedDocument || historyToken !== historyRequestToken) return;
    const revisions = result.data || [];
    clear(historyNode);
    if (!revisions.length) {
      historyNode.append(element('li', { className: 'empty-state', text: 'Nenhuma revisão encontrada.' }));
      clear(historyPagination);
      return;
    }
    revisions.forEach(revision => historyNode.append(element('li', {}, [
      element('strong', { text: `v${revision.version} · ${REVISION_STATUS_LABELS.get(revision.status) ?? revision.status}` }),
      element('span', { text: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(revision.created_at)) }),
    ])));
    clear(historyPagination);
    const total = result.total ?? revisions.length;
    if (total > HISTORY_PAGE_SIZE) {
      const finalHistoryOffset = Math.max(0, Math.floor((total - 1) / HISTORY_PAGE_SIZE) * HISTORY_PAGE_SIZE);
      historyPagination.append(
        element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Anterior', disabled: historyOffset === 0, on: { click: () => {
          if (!currentHistory() || mutationBusy() || creatingDocument) return;
          historyOffset = Math.max(0, historyOffset - HISTORY_PAGE_SIZE); loadRevisionHistory(documentId);
        } } }),
        element('span', { text: `Página ${Math.floor(historyOffset / HISTORY_PAGE_SIZE) + 1} de ${Math.ceil(total / HISTORY_PAGE_SIZE)}` }),
        element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Próxima', disabled: historyOffset + HISTORY_PAGE_SIZE >= total, on: { click: () => {
          if (!currentHistory() || mutationBusy() || creatingDocument) return;
          historyOffset = Math.min(finalHistoryOffset, historyOffset + HISTORY_PAGE_SIZE); loadRevisionHistory(documentId);
        } } }),
      );
    }
  } catch {
    if (page.active && requestToken === selectionToken && documentId === selectedDocument && historyToken === historyRequestToken) {
      historyNode.replaceChildren(element('li', { className: 'empty-state', text: 'Não foi possível carregar o histórico.' }));
      clear(historyPagination);
    }
  }
}

function renderPreview(blocks, fallbackText) {
  if (assetUploading > 0) return;
  previewCleanup?.(); previewCleanup = null;
  cleanupRenderedBlocks(previewRoot);
  const news = documentView?.document?.content_type === 'announcement';
  previewRoot.classList.toggle('news-editorial-preview', news);
  if (news) {
    const content = serializeBlocks(blocks);
    if (!content) { showState(previewRoot, fallbackText); return; }
    const editorial = editorialFields?.getValue() ?? null;
    previewCleanup = renderNewsArticle(previewRoot, { ...documentView.document, content_blocks: content, editorial,
      read_time_minutes: estimateNewsReadTime(content, editorial) }, { preview: true, signal: page.signal });
  } else renderBlocks(previewRoot, blocks, { fallbackText });
}

function mountEditorial(value) {
  editorialFields?.dispose(); editorialFields = null;
  if (!editorialRoot) return;
  editorialRoot.hidden = documentView?.document?.content_type !== 'announcement';
  if (editorialRoot.hidden) return;
  const token = selectionToken;
  editorialFields = createEditorialFields({ root: editorialRoot, value, page, onChange() {
    if (page.active && token === selectionToken && editor) markDirty(editor.getBlocks());
  } });
}

function validPublication() {
  if (documentView?.document?.content_type !== 'announcement') return true;
  const message = editorialPublicationError(editorialFields?.getValue() ?? null, editor?.getBlocks() || []);
  if (message) setError(message);
  return !message;
}

function markDirty(nextBlocks) {
  if (editorInteractionBusy()) return;
  editVersion += 1;
  dirty = true;
  setSaveState(serializeBlocks(nextBlocks) ? 'Alterações pendentes' : 'Corrija os campos do bloco');
  syncBusyState();
  clearTimeout(saveTimer);
  saveTimer = null;
  scheduleAutosave();
  renderPreview(nextBlocks, 'A prévia será exibida após corrigir os blocos.');
}

function renderEditor(blocks = [], expectedAssetUploadVersion = assetUploadVersion) {
  if (expectedAssetUploadVersion !== assetUploadVersion || assetUploading > 0) return false;
  if (editor) editor = null;
  const generation = ++editorGeneration;
  const renderToken = selectionToken;
  const renderDocument = selectedDocument;
  let editorInstance;
  const currentEditor = () => page.active && generation === editorGeneration
    && renderToken === selectionToken && renderDocument === selectedDocument;
  let blockSelectionToken = 0;
  editorInstance = createBlockEditor({
    root: editorRoot,
    initialBlocks: blocks,
    allowedTypes: selectedType === 'announcement' ? BLOCK_TYPES : STANDARD_BLOCK_TYPES,
    onSelect(index, block) {
      if (!currentEditor()) return;
      const selection = ++blockSelectionToken;
      if (!block) {
        delete blockSettings.dataset.selectedIndex;
        showState(blockSettings, 'Selecione um bloco para editar suas configurações.');
        return;
      }
      const canApplyUpload = () => currentEditor() && blockSelectionToken === selection;
      clear(blockSettings).append(createBlockSettings(block, () => {
        if (!canApplyUpload()) return;
        markDirty(editorInstance.getBlocks());
      }, setAssetUploading, canApplyUpload, page, { editorial: selectedType === 'announcement' }));
      blockSettings.dataset.selectedIndex = String(index);
    },
    onChange(nextBlocks) {
      if (!currentEditor()) return;
      markDirty(nextBlocks);
    },
  });
  editor = editorInstance;
  renderPreview(blocks, 'Adicione blocos para visualizar a prévia.');
  return true;
}

async function loadDocuments() {
  if (!selectedType) return false;
  const type = selectedType;
  const requestToken = ++documentsRequestToken;
  const selectionRequestToken = selectionToken;
  const requestOffset = documentOffset;
  documentsLoading = true;
  syncBusyState();
  showState(documentList, 'Carregando documentos…');
  clear(documentPagination);
  try {
    const result = await fetchAPIPage(`/api/cms/documents?type=${encodeURIComponent(type)}&limit=${DOCUMENT_PAGE_SIZE}&offset=${requestOffset}`);
    if (requestToken !== documentsRequestToken || selectionRequestToken !== selectionToken
      || type !== selectedType || requestOffset !== documentOffset) return false;
    documentsByType.set(type, result.data || []);
    documentTotal = result.total ?? result.data?.length ?? 0;
    renderDocumentList();
    setError('');
    return true;
  } catch {
    if (requestToken === documentsRequestToken && selectionRequestToken === selectionToken && type === selectedType) {
      showState(documentList, 'Não foi possível carregar os documentos.', loadDocuments);
    }
    return false;
  } finally {
    if (requestToken === documentsRequestToken) {
      documentsLoading = false;
      syncBusyState();
    }
  }
}

async function loadSources() {
  const type = selectedType;
  const requestToken = selectionToken;
  if (!SOURCE_ENDPOINTS[type]) {
    sourceField.hidden = true;
    sourceSelect.required = false;
    return;
  }
  sourceField.hidden = false;
  sourceSelect.required = true;
  sourceSelect.replaceChildren(element('option', { value: '', text: 'Selecione um registro' }));
  try {
    const result = await fetchAPIPage(SOURCE_ENDPOINTS[type]);
    if (requestToken !== selectionToken || type !== selectedType) return;
    const sources = [...(result.data || [])];
    const total = result.total ?? sources.length;
    for (let offset = sources.length; offset < total; offset += 100) {
      const page = await fetchAPIPage(SOURCE_ENDPOINTS[type].replace(/offset=\d+/, `offset=${offset}`));
      if (requestToken !== selectionToken || type !== selectedType) return;
      sources.push(...(page.data || []));
    }
    sourcesByType.set(type, sources);
    sources.forEach(source => sourceSelect.append(element('option', {
      value: source.id,
      text: source.title || source.company || source.name || source.description?.slice(0, 80) || source.id,
    })));
  } catch {
    if (requestToken === selectionToken && type === selectedType) {
      sourceSelect.replaceChildren(element('option', { value: '', text: 'Não foi possível carregar registros' }));
    }
  }
}

async function loadDocument(id) {
  if (!page.active || navigationBusy()) return false;
  if (!newDocumentForm.hidden && !newDocumentDirty) {
    newDocumentForm.reset();
    newDocumentForm.hidden = true;
  }
  const requestAssetUploadVersion = assetUploadVersion;
  const requestToken = ++selectionToken;
  resetSelection();
  selectedDocument = id;
  loading = true;
  showState(editorRoot, 'Carregando documento…');
  renderDocumentList();
  syncBusyState();
  setSaveState('Carregando…');
  try {
    const view = await fetchAPI(`/api/cms/documents/${encodeURIComponent(id)}`);
    if (!page.active || requestToken !== selectionToken || selectedDocument !== id
      || requestAssetUploadVersion !== assetUploadVersion || assetUploading > 0) return false;
    documentView = view;
    syncListedDocument(view.document);
    const working = view.draft || view.schedule?.revision || view.published;
    const blocks = working?.blocks || [];
    mountEditorial(working?.editorial ?? null);
    if (!renderEditor(blocks, requestAssetUploadVersion)) return false;
    updateInspector();
    renderDocumentList();
    setSaveState('Salvo');
    loadRevisionHistory(id);
    setError('');
    return true;
  } catch {
    if (!page.active || requestToken !== selectionToken || selectedDocument !== id
      || requestAssetUploadVersion !== assetUploadVersion || assetUploading > 0) return false;
    resetSelection();
    selectedDocument = id;
    showState(editorRoot, 'Não foi possível abrir este documento.', () => {
      if (page.active && requestToken === selectionToken && selectedDocument === id) loadDocument(id);
    });
    showState(blockSettings, 'Selecione um documento para editar suas configurações.');
    setError('Não foi possível abrir este documento. Tente novamente.');
    setSaveState('Erro ao carregar');
    return false;
  } finally {
    if (requestToken === selectionToken) {
      loading = false;
      syncBusyState();
    }
  }
}

async function saveDraft() {
  if (creatingDocument || assetUploading > 0 || !documentView || !editor) return null;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saving) {
    saveQueued = true;
    return saveInFlight || null;
  }
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  const requestVersion = editVersion;
  const blocks = serializeBlocks(editor.getBlocks());
  const editorial = editorialFields?.getValue() ?? null;
  if (editorial !== null && !normalizeEditorial(editorial)) {
    setSaveState('Corrija os metadados da matéria');
    setError('Revise os metadados: use texto sem HTML e uma data da fonte válida.');
    return null;
  }
  if (!blocks) {
    setSaveState('Corrija os campos do bloco');
    return null;
  }
  let resolveSave;
  saveInFlight = new Promise(resolve => { resolveSave = resolve; });
  saving = true;
  syncBusyState();
  setSaveState('Salvando rascunho…');
  let savedResult = null;
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/draft`, {
      method: 'PUT', body: JSON.stringify({ blocks, ...(selectedType === 'announcement' ? { editorial } : {}) }),
    });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument) return null;
    documentView.document = result.document;
    documentView.draft = result.revision;
    syncListedDocument(result.document);
    updateInspector();
    renderDocumentList();
    if (editVersion === requestVersion) {
      dirty = false;
      setSaveState('Rascunho salvo');
    } else {
      dirty = true;
      saveQueued = true;
      setSaveState('Alterações pendentes');
    }
    setError('');
    savedResult = result;
  } catch {
    if (requestToken === selectionToken && requestDocument === selectedDocument) {
      if (editVersion !== requestVersion) saveQueued = true;
      setSaveState('Não foi possível salvar o rascunho');
      setError('Não foi possível salvar o rascunho. Suas alterações continuam na tela.');
    }
  } finally {
    saving = false;
    syncBusyState();
    if (saveQueued && requestToken === selectionToken && requestDocument === selectedDocument) {
      saveQueued = false;
      const queuedResult = await saveDraft();
      savedResult = queuedResult;
    }
    resolveSave(savedResult);
    saveInFlight = null;
    syncBusyState();
  }
  return savedResult;
}

async function saveBeforeAction() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    return await saveDraft();
  } finally {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

async function publishDocument() {
  if (!documentView || editorInteractionBusy() || saving || saveInFlight) return;
  if (!validPublication()) return;
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  clearTimeout(saveTimer);
  saveTimer = null;
  actionBusy = true;
  syncBusyState();
  try {
    const saved = await saveBeforeAction();
    if (!saved || requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/publish`, {
      method: 'POST', body: JSON.stringify({ revision_id: saved.revision.id }),
    });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    documentView.document = result.document;
    documentView.published = result.revision;
    documentView.draft = null;
    documentView.schedule = null;
    syncListedDocument(result.document);
    updateInspector();
    renderDocumentList();
    setSaveState('Publicado');
    showToast('Documento publicado.');
  } catch (error) {
    if (requestToken === selectionToken && requestDocument === selectedDocument) setError(mutationError(error, 'Não foi possível publicar o documento.'));
  } finally {
    actionBusy = false;
    syncBusyState();
  }
}

async function unpublishDocument() {
  if (!documentView?.document?.published_revision_id || mutationBusy() || creatingDocument || editorSavePending()) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  actionBusy = true;
  syncBusyState();
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/unpublish`, { method: 'POST', body: JSON.stringify({}) });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    documentView.document = result.document;
    documentView.published = null;
    documentView.schedule = null;
    syncListedDocument(result.document);
    updateInspector();
    renderDocumentList();
    setSaveState('Despublicado');
    showToast('Documento despublicado.');
  } catch (error) {
    if (requestToken === selectionToken && requestDocument === selectedDocument) setError(mutationError(error, 'Não foi possível despublicar o documento.'));
  } finally {
    actionBusy = false;
    syncBusyState();
  }
}

async function scheduleDocument(event) {
  event.preventDefault();
  if (!documentView || editorInteractionBusy() || saving || saveInFlight) return;
  if (!validPublication()) return;
  const value = document.getElementById('scheduled-at').value;
  if (!value) return;
  const scheduledAt = new Date(value);
  if (!Number.isFinite(scheduledAt.valueOf())) {
    setError('Informe uma data futura válida para o agendamento.');
    return;
  }
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  clearTimeout(saveTimer);
  saveTimer = null;
  actionBusy = true;
  syncBusyState();
  try {
    const saved = await saveBeforeAction();
    if (!saved || requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/schedule`, {
      method: 'POST', body: JSON.stringify({ revision_id: saved.revision.id, scheduled_at: scheduledAt.toISOString() }),
    });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    documentView.document = result.document;
    documentView.schedule = { revision_id: result.revision.id, scheduled_at: result.document.scheduled_at, revision: result.revision };
    documentView.draft = null;
    syncListedDocument(result.document);
    updateInspector();
    renderDocumentList();
    setSaveState('Agendado');
    showToast('Documento agendado.');
  } catch (error) {
    if (requestToken === selectionToken && requestDocument === selectedDocument) setError(mutationError(error, 'Não foi possível agendar o documento. Escolha uma data futura.'));
  } finally {
    actionBusy = false;
    syncBusyState();
  }
}

async function unscheduleDocument() {
  if (!documentView?.document?.scheduled_revision_id || mutationBusy() || creatingDocument || editorSavePending()) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  const requestAssetUploadVersion = assetUploadVersion;
  actionBusy = true;
  syncBusyState();
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/schedule`, { method: 'DELETE' });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument
      || requestAssetUploadVersion !== assetUploadVersion || assetUploading > 0) return;
    documentView.document = result.document;
    documentView.draft = result.draft || null;
    documentView.schedule = null;
    mountEditorial(documentView.draft?.editorial ?? null);
    if (!renderEditor(documentView.draft?.blocks || [], requestAssetUploadVersion)) return;
    syncListedDocument(result.document);
    updateInspector();
    renderDocumentList();
    setSaveState('Agendamento cancelado');
    showToast('Agendamento cancelado.');
  } catch (error) {
    if (requestToken === selectionToken && requestDocument === selectedDocument) setError(mutationError(error, 'Não foi possível cancelar o agendamento.'));
  } finally {
    actionBusy = false;
    syncBusyState();
  }
}

newDocumentButton.addEventListener('click', async () => {
  if (navigationBusy() || editorInteractionBusy()) return;
  newDocumentForm.hidden = false;
  newDocumentDirty = false;
  await loadSources();
  if (!page.active) return;
  document.getElementById('new-title').focus();
});
loadHistoryButton.addEventListener('click', () => loadRevisionHistory());
newDocumentForm.addEventListener('input', () => {
  if (editorInteractionBusy()) return;
  newDocumentDirty = true;
  syncBusyState();
});
document.getElementById('cancel-new-document').addEventListener('click', () => {
  if (editorInteractionBusy()) return;
  newDocumentDirty = false;
  newDocumentForm.hidden = true;
  syncBusyState();
});
newDocumentForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (mutationBusy() || editorInteractionBusy()) return;
  if (editorSavePending()) {
    setError('Salve as alterações do editor antes de criar um documento.');
    return;
  }
  if (!newDocumentForm.reportValidity()) return;
  const type = selectedType;
  const listSnapshot = {
    hadDocuments: documentsByType.has(type),
    documents: documentsByType.get(type),
    offset: documentOffset,
    total: documentTotal,
  };
  const requestToken = ++creationRequestToken;
  const body = { type, title: document.getElementById('new-title').value.trim(), category: document.getElementById('new-category').value.trim() };
  if (SOURCE_ENDPOINTS[type]) body.source_id = sourceSelect.value;
  clearTimeout(saveTimer);
  saveTimer = null;
  creatingDocument = true;
  actionBusy = true;
  syncBusyState();
  try {
    const result = await fetchAPI('/api/cms/documents', { method: 'POST', body: JSON.stringify(body) });
    if (requestToken !== creationRequestToken || type !== selectedType) return;
    documentOffset = 0;
    documentTotal = 0;
    documentsByType.set(type, []);
    clear(documentPagination);
    newDocumentForm.reset();
    newDocumentDirty = false;
    newDocumentForm.hidden = true;
    const refreshed = await loadDocuments();
    if (requestToken !== creationRequestToken || type !== selectedType) return;
    if (!refreshed) {
      restoreDocumentList(type, listSnapshot);
      setError('Documento criado, mas não foi possível atualizar a lista. O documento foi criado; tente recarregar.');
      return;
    }
    actionBusy = false;
    syncBusyState();
    const loaded = await loadDocument(result.document.id);
    if (!loaded) {
      setError('Documento criado, mas não foi possível abrir o documento. Use o botão "Tentar novamente" ou selecione-o na lista.');
      return;
    }
    showToast('Documento criado como rascunho.');
  } catch {
    if (requestToken === creationRequestToken && type === selectedType) {
      restoreDocumentList(type, listSnapshot);
      setError('Não foi possível criar o documento. Verifique o registro vinculado.');
    }
  } finally {
    creatingDocument = false;
    actionBusy = false;
    syncBusyState();
  }
});
saveDraftButton.addEventListener('click', () => saveDraft());
publishButton.addEventListener('click', publishDocument);
unpublishButton.addEventListener('click', unpublishDocument);
scheduleForm.addEventListener('submit', scheduleDocument);
unscheduleButton.addEventListener('click', unscheduleDocument);

resetSelection();
if (!TYPES.length) {
  newDocumentButton.disabled = true;
  setError('Você não possui permissão para editar nenhuma área do CMS.');
  setSaveState('Acesso restrito');
  showState(documentList, 'Nenhuma permissão editorial configurada.');
} else {
  renderTypeNav();
  renderDocumentList();
  loadDocuments();
  updateInspector();
}
}
