import { requireAuth, can, fetchAPI, fetchAPIPage, showToast } from './auth.js';
import { clear, element, showState } from './ui.js';
import { createBlockEditor, createBlockSettings, serializeBlocks } from './cms-block-editor.js';
import { renderBlocks } from './cms-block-renderer.js';

const user = await requireAuth(true);
if (!user) throw new Error('Administrator access required');

const TYPES = [
  ['knowledge', 'Knowledge', 'manageKnowledge'],
  ['academy', 'Academy', 'manageAcademy'],
  ['benefit', 'Benefícios', 'manageBenefits'],
  ['announcement', 'Anúncios', 'manageKnowledge'],
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
const newDocumentButton = document.getElementById('new-document');
const newDocumentForm = document.getElementById('new-document-form');
const sourceField = document.getElementById('new-source-field');
const sourceSelect = document.getElementById('new-source');
const editorRoot = document.getElementById('editor-root');
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

let selectedType = TYPES[0]?.[0] || null;
let selectedDocument = null;
let documentView = null;
let editor = null;
let saveTimer = null;
let saving = false;
let saveQueued = false;
let dirty = false;
let editVersion = 0;
let selectionToken = 0;
let actionBusy = false;
let loading = false;
let newDocumentDirty = false;
let navigationConfirmed = false;
let historyOffset = 0;
let historyRequestToken = 0;
const HISTORY_PAGE_SIZE = 50;
const documentsByType = new Map();
const sourcesByType = new Map();

function setError(message = '') {
  errorNode.hidden = !message;
  errorNode.textContent = message;
}

function setSaveState(message) {
  saveState.textContent = message;
}

function mutationBusy() {
  return saving || actionBusy || loading;
}

function navigationBusy() {
  return mutationBusy() || dirty || newDocumentDirty;
}

function cmsNavigationProtected() {
  return !navigationConfirmed && (navigationBusy() || saveQueued);
}

document.addEventListener('click', event => {
  if (!cmsNavigationProtected() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download') || anchor.getAttribute('href')?.startsWith('#')) return;
  if (anchor.origin && anchor.origin !== location.origin) return;
  if (!window.confirm('Há alterações do CMS que ainda não foram salvas. Sair mesmo assim?')) {
    event.preventDefault();
    return;
  }
  navigationConfirmed = true;
});

window.addEventListener('beforeunload', event => {
  if (!cmsNavigationProtected()) return;
  event.preventDefault();
  event.returnValue = '';
});

function syncBusyState() {
  newDocumentButton.disabled = !TYPES.length || navigationBusy();
  contentTypes.querySelectorAll('button').forEach(button => { button.disabled = navigationBusy(); });
  documentList.querySelectorAll('button').forEach(button => { button.disabled = navigationBusy(); });
  updateInspector();
}

function statusFor(doc) {
  if (doc?.draft_revision_id) return ['Rascunho', 'badge-gold'];
  if (doc?.scheduled_revision_id) return ['Agendado', 'badge-gold'];
  if (doc?.published_revision_id) return ['Publicado', 'badge-green'];
  return ['Arquivado', 'badge-gray'];
}

function statusBadge(doc) {
  const [label, className] = statusFor(doc);
  return element('span', { className: `badge ${className}`, text: label });
}

function renderTypeNav() {
  clear(contentTypes);
  TYPES.forEach(([type, label]) => contentTypes.append(element('button', {
    className: 'cms-content-type', type: 'button', text: label,
    'aria-current': String(type === selectedType),
    ...(navigationBusy() ? { disabled: '' } : {}),
    on: { click: () => {
      if (navigationBusy()) return;
      selectionToken += 1;
      clearTimeout(saveTimer);
      saveQueued = false;
      dirty = false;
      newDocumentDirty = false;
      editVersion = 0;
      selectedType = type;
      selectedDocument = null;
      documentView = null;
      newDocumentForm.hidden = true;
      editor = null;
      showState(editorRoot, 'Selecione um documento na coluna ao lado.');
      showState(previewRoot, 'A prévia aparecerá aqui.');
      showState(blockSettings, 'Selecione um bloco para editar suas configurações.');
       renderTypeNav();
       renderDocumentList();
       updateInspector();
       if (!newDocumentForm.hidden) void loadSources();
       loadDocuments();
    } },
  })));
}

function renderDocumentList() {
  const docs = documentsByType.get(selectedType) || [];
  clear(documentList);
  if (!docs.length) {
    documentList.append(element('p', { className: 'empty-state', text: 'Nenhum documento nesta área.' }));
    return;
  }
  docs.forEach(doc => documentList.append(element('button', {
    className: 'cms-document-item', type: 'button', 'aria-current': String(doc.id === selectedDocument),
    ...(navigationBusy() ? { disabled: '' } : {}),
    on: { click: () => loadDocument(doc.id) },
  }, [element('span', { className: 'cms-document-title', text: doc.title }), element('span', { className: 'cms-document-meta' }, [statusBadge(doc), element('span', { text: doc.category || 'Sem categoria' })])] )));
}

function updateInspector() {
  const doc = documentView?.document;
  if (!doc) showState(blockSettings, 'Selecione um bloco para editar suas configurações.');
  const [status] = statusFor(doc);
  editorHeading.textContent = doc?.title || 'Selecione um documento';
  editorStatus.className = `badge ${status === 'Publicado' ? 'badge-green' : status === 'Rascunho' || status === 'Agendado' ? 'badge-gold' : 'badge-gray'}`;
  editorStatus.textContent = doc ? status : 'Nenhum';
  selectedTypeNode.textContent = doc ? TYPE_LABELS[doc.content_type] || doc.content_type : '—';
  categoryNode.textContent = doc?.category || '—';
  publishedNode.textContent = doc?.published_at ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(doc.published_at)) : '—';
  const active = !!doc && !mutationBusy();
  saveDraftButton.disabled = !active;
  publishButton.disabled = !active;
  unpublishButton.disabled = !active || !doc.published_revision_id;
  scheduleButton.disabled = !active;
  unscheduleButton.disabled = !active || !doc.scheduled_revision_id;
  loadHistoryButton.disabled = !doc || mutationBusy();
}

async function loadRevisionHistory(documentId = selectedDocument) {
  if (!documentId) return;
  const requestToken = selectionToken;
  const historyToken = ++historyRequestToken;
  historyNode.replaceChildren(element('li', { className: 'empty-state', text: 'Carregando histórico…' }));
  try {
    const result = await fetchAPIPage(`/api/cms/documents/${encodeURIComponent(documentId)}/revisions?limit=${HISTORY_PAGE_SIZE}&offset=${historyOffset}`);
    if (requestToken !== selectionToken || documentId !== selectedDocument || historyToken !== historyRequestToken) return;
    const revisions = result.data || [];
    clear(historyNode);
    if (!revisions.length) {
      historyNode.append(element('li', { className: 'empty-state', text: 'Nenhuma revisão encontrada.' }));
      clear(historyPagination);
      return;
    }
    revisions.forEach(revision => historyNode.append(element('li', {}, [
      element('strong', { text: `v${revision.version} · ${revision.status}` }),
      element('span', { text: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(revision.created_at)) }),
    ])));
    clear(historyPagination);
    const total = result.total ?? revisions.length;
    if (total > HISTORY_PAGE_SIZE) {
      historyPagination.append(
        element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Anterior', disabled: historyOffset === 0, on: { click: () => { historyOffset -= HISTORY_PAGE_SIZE; loadRevisionHistory(); } } }),
        element('span', { text: `Página ${Math.floor(historyOffset / HISTORY_PAGE_SIZE) + 1} de ${Math.ceil(total / HISTORY_PAGE_SIZE)}` }),
        element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Próxima', disabled: historyOffset + HISTORY_PAGE_SIZE >= total, on: { click: () => { historyOffset += HISTORY_PAGE_SIZE; loadRevisionHistory(); } } }),
      );
    }
  } catch {
    if (requestToken === selectionToken && documentId === selectedDocument && historyToken === historyRequestToken) {
      historyNode.replaceChildren(element('li', { className: 'empty-state', text: 'Não foi possível carregar o histórico.' }));
      clear(historyPagination);
    }
  }
}

function markDirty(nextBlocks) {
  editVersion += 1;
  dirty = true;
  setSaveState(serializeBlocks(nextBlocks) ? 'Alterações pendentes' : 'Corrija os campos do bloco');
  syncBusyState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDraft(), 900);
  renderBlocks(previewRoot, nextBlocks, { fallbackText: 'A prévia será exibida após corrigir os blocos.' });
}

function renderEditor(blocks = []) {
  if (editor) editor = null;
  editor = createBlockEditor({
    root: editorRoot,
    initialBlocks: blocks,
    onSelect(index, block) {
      if (!block) {
        showState(blockSettings, 'Selecione um bloco para editar suas configurações.');
        return;
      }
      clear(blockSettings).append(createBlockSettings(block, () => {
        markDirty(editor.getBlocks());
      }));
      blockSettings.dataset.selectedIndex = String(index);
    },
    onChange(nextBlocks) {
      markDirty(nextBlocks);
    },
  });
  renderBlocks(previewRoot, blocks, { fallbackText: 'Adicione blocos para visualizar a prévia.' });
}

async function loadDocuments() {
  if (!selectedType) return;
  const type = selectedType;
  const requestToken = selectionToken;
  showState(documentList, 'Carregando documentos…');
  try {
    const result = await fetchAPIPage(`/api/cms/documents?type=${encodeURIComponent(type)}&limit=100&offset=0`);
    if (requestToken !== selectionToken || type !== selectedType) return;
    documentsByType.set(type, result.data || []);
    renderDocumentList();
    setError('');
  } catch {
    if (requestToken !== selectionToken || type !== selectedType) return;
    showState(documentList, 'Não foi possível carregar os documentos.', loadDocuments);
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
  if (navigationBusy()) return;
  const requestToken = ++selectionToken;
  selectedDocument = id;
  documentView = null;
  loading = true;
  updateInspector();
  syncBusyState();
  setSaveState('Carregando…');
  try {
    const view = await fetchAPI(`/api/cms/documents/${encodeURIComponent(id)}`);
    if (requestToken !== selectionToken || selectedDocument !== id) return;
    dirty = false;
    newDocumentDirty = false;
    editVersion = 0;
    saveQueued = false;
    documentView = view;
    historyOffset = 0;
    const blocks = view.draft?.blocks || view.schedule?.revision?.blocks || view.published?.blocks || [];
    renderEditor(blocks);
    updateInspector();
    renderDocumentList();
    setSaveState('Salvo');
    loadRevisionHistory(id);
    setError('');
  } catch {
    if (requestToken !== selectionToken || selectedDocument !== id) return;
    setError('Não foi possível abrir este documento. Tente novamente.');
    setSaveState('Erro ao carregar');
  } finally {
    if (requestToken === selectionToken) {
      loading = false;
      syncBusyState();
    }
  }
}

async function saveDraft() {
  if (!documentView || !editor) return null;
  if (saving) {
    saveQueued = true;
    return null;
  }
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  const requestVersion = editVersion;
  const blocks = serializeBlocks(editor.getBlocks());
  if (!blocks) {
    setSaveState('Corrija os campos do bloco');
    return null;
  }
  saving = true;
  syncBusyState();
  setSaveState('Salvando rascunho…');
  let savedResult = null;
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/draft`, {
      method: 'PUT', body: JSON.stringify({ blocks }),
    });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument) return null;
    documentView.document = result.document;
    documentView.draft = result.revision;
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
      if (!queuedResult) savedResult = null;
    }
  }
  return savedResult;
}

async function publishDocument() {
  if (!documentView || mutationBusy()) return;
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  actionBusy = true;
  syncBusyState();
  const saved = await saveDraft();
  try {
    if (!saved || requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/publish`, { method: 'POST', body: JSON.stringify({}) });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    documentView.document = result.document;
    documentView.published = result.revision;
    documentView.draft = null;
    updateInspector();
    renderDocumentList();
    setSaveState('Publicado');
    showToast('Documento publicado.');
  } catch {
    if (requestToken === selectionToken && requestDocument === selectedDocument) setError('Não foi possível publicar o documento.');
  } finally {
    actionBusy = false;
    syncBusyState();
  }
}

async function unpublishDocument() {
  if (!documentView?.document?.published_revision_id || mutationBusy()) return;
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  actionBusy = true;
  syncBusyState();
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/unpublish`, { method: 'POST', body: JSON.stringify({}) });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    documentView.document = result.document;
    documentView.published = null;
    updateInspector();
    renderDocumentList();
    setSaveState('Despublicado');
    showToast('Documento despublicado.');
  } catch {
    if (requestToken === selectionToken && requestDocument === selectedDocument) setError('Não foi possível despublicar o documento.');
  } finally {
    actionBusy = false;
    syncBusyState();
  }
}

async function scheduleDocument(event) {
  event.preventDefault();
  if (!documentView || mutationBusy()) return;
  const value = document.getElementById('scheduled-at').value;
  if (!value) return;
  const scheduledAt = new Date(value);
  if (!Number.isFinite(scheduledAt.valueOf())) {
    setError('Informe uma data futura válida para o agendamento.');
    return;
  }
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  actionBusy = true;
  syncBusyState();
  const saved = await saveDraft();
  try {
    if (!saved || requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/schedule`, {
      method: 'POST', body: JSON.stringify({ scheduled_at: scheduledAt.toISOString() }),
    });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    documentView.document = result.document;
    documentView.schedule = { revision_id: result.revision.id, scheduled_at: result.document.scheduled_at, revision: result.revision };
    documentView.draft = null;
    updateInspector();
    renderDocumentList();
    setSaveState('Agendado');
    showToast('Documento agendado.');
  } catch {
    if (requestToken === selectionToken && requestDocument === selectedDocument) setError('Não foi possível agendar o documento. Escolha uma data futura.');
  } finally {
    actionBusy = false;
    syncBusyState();
  }
}

async function unscheduleDocument() {
  if (!documentView?.document?.scheduled_revision_id || mutationBusy()) return;
  const requestToken = selectionToken;
  const requestDocument = selectedDocument;
  actionBusy = true;
  syncBusyState();
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(requestDocument)}/schedule`, { method: 'DELETE' });
    if (requestToken !== selectionToken || requestDocument !== selectedDocument) return;
    documentView.document = result.document;
    documentView.draft = documentView.schedule?.revision || null;
    documentView.schedule = null;
    renderEditor(documentView.draft?.blocks || []);
    updateInspector();
    renderDocumentList();
    setSaveState('Agendamento cancelado');
    showToast('Agendamento cancelado.');
  } catch {
    if (requestToken === selectionToken && requestDocument === selectedDocument) setError('Não foi possível cancelar o agendamento.');
  } finally {
    actionBusy = false;
    syncBusyState();
  }
}

newDocumentButton.addEventListener('click', async () => {
  if (navigationBusy()) return;
  newDocumentForm.hidden = false;
  newDocumentDirty = false;
  await loadSources();
  document.getElementById('new-title').focus();
});
loadHistoryButton.addEventListener('click', () => loadRevisionHistory());
newDocumentForm.addEventListener('input', () => {
  newDocumentDirty = true;
  syncBusyState();
});
document.getElementById('cancel-new-document').addEventListener('click', () => {
  newDocumentDirty = false;
  newDocumentForm.hidden = true;
  syncBusyState();
});
newDocumentForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (mutationBusy()) return;
  if (!newDocumentForm.reportValidity()) return;
  const body = { type: selectedType, title: document.getElementById('new-title').value.trim(), category: document.getElementById('new-category').value.trim() };
  if (SOURCE_ENDPOINTS[selectedType]) body.source_id = sourceSelect.value;
  try {
    const result = await fetchAPI('/api/cms/documents', { method: 'POST', body: JSON.stringify(body) });
    newDocumentForm.reset();
    newDocumentDirty = false;
    newDocumentForm.hidden = true;
    syncBusyState();
    await loadDocuments();
    await loadDocument(result.document.id);
    showToast('Documento criado como rascunho.');
  } catch {
    setError('Não foi possível criar o documento. Verifique o registro vinculado.');
  }
});
saveDraftButton.addEventListener('click', () => saveDraft());
publishButton.addEventListener('click', publishDocument);
unpublishButton.addEventListener('click', unpublishDocument);
scheduleForm.addEventListener('submit', scheduleDocument);
unscheduleButton.addEventListener('click', unscheduleDocument);

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
