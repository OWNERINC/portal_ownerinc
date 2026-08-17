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
const documentsByType = new Map();
const sourcesByType = new Map();

function setError(message = '') {
  errorNode.hidden = !message;
  errorNode.textContent = message;
}

function setSaveState(message) {
  saveState.textContent = message;
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
    on: { click: () => { selectedType = type; selectedDocument = null; documentView = null; newDocumentForm.hidden = true; editor = null; showState(editorRoot, 'Selecione um documento na coluna ao lado.'); showState(previewRoot, 'A prévia aparecerá aqui.'); renderTypeNav(); renderDocumentList(); updateInspector(); loadDocuments(); } },
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
  const active = !!doc;
  saveDraftButton.disabled = !active;
  publishButton.disabled = !active;
  unpublishButton.disabled = !active || !doc.published_revision_id;
  scheduleButton.disabled = !active;
  unscheduleButton.disabled = !active || !doc.scheduled_revision_id;
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
        setSaveState('Alterações pendentes');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveDraft(), 900);
        renderBlocks(previewRoot, editor.getBlocks(), { fallbackText: 'A prévia será exibida após corrigir os blocos.' });
      }));
      blockSettings.dataset.selectedIndex = String(index);
    },
    onChange(nextBlocks) {
      setSaveState(serializeBlocks(nextBlocks) ? 'Alterações pendentes' : 'Corrija os campos do bloco');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveDraft(), 900);
      renderBlocks(previewRoot, nextBlocks, { fallbackText: 'A prévia será exibida após corrigir os blocos.' });
    },
  });
  renderBlocks(previewRoot, blocks, { fallbackText: 'Adicione blocos para visualizar a prévia.' });
}

async function loadDocuments() {
  if (!selectedType) return;
  showState(documentList, 'Carregando documentos…');
  try {
    const result = await fetchAPIPage(`/api/cms/documents?type=${encodeURIComponent(selectedType)}&limit=100&offset=0`);
    documentsByType.set(selectedType, result.data || []);
    renderDocumentList();
    setError('');
  } catch {
    showState(documentList, 'Não foi possível carregar os documentos.', loadDocuments);
  }
}

async function loadSources() {
  if (!SOURCE_ENDPOINTS[selectedType]) {
    sourceField.hidden = true;
    sourceSelect.required = false;
    return;
  }
  sourceField.hidden = false;
  sourceSelect.required = true;
  sourceSelect.replaceChildren(element('option', { value: '', text: 'Selecione um registro' }));
  try {
    const result = await fetchAPIPage(SOURCE_ENDPOINTS[selectedType]);
    const sources = result.data || [];
    sourcesByType.set(selectedType, sources);
    sources.forEach(source => sourceSelect.append(element('option', {
      value: source.id,
      text: source.title || source.company || source.name || source.description?.slice(0, 80) || source.id,
    })));
  } catch {
    sourceSelect.replaceChildren(element('option', { value: '', text: 'Não foi possível carregar registros' }));
  }
}

async function loadDocument(id) {
  setSaveState('Carregando…');
  try {
    const view = await fetchAPI(`/api/cms/documents/${encodeURIComponent(id)}`);
    selectedDocument = id;
    documentView = view;
    const blocks = view.draft?.blocks || view.schedule?.revision?.blocks || view.published?.blocks || [];
    renderEditor(blocks);
    updateInspector();
    renderDocumentList();
    setSaveState('Salvo');
    setError('');
  } catch {
    setError('Não foi possível abrir este documento. Tente novamente.');
    setSaveState('Erro ao carregar');
  }
}

async function saveDraft() {
  if (!documentView || !editor || saving) return null;
  const blocks = serializeBlocks(editor.getBlocks());
  if (!blocks) {
    setSaveState('Corrija os campos do bloco');
    return null;
  }
  saving = true;
  setSaveState('Salvando rascunho…');
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(selectedDocument)}/draft`, {
      method: 'PUT', body: JSON.stringify({ blocks }),
    });
    documentView.document = result.document;
    documentView.draft = result.revision;
    updateInspector();
    renderDocumentList();
    setSaveState('Rascunho salvo');
    setError('');
    return result;
  } catch {
    setSaveState('Não foi possível salvar o rascunho');
    setError('Não foi possível salvar o rascunho. Suas alterações continuam na tela.');
    return null;
  } finally {
    saving = false;
  }
}

async function publishDocument() {
  const saved = await saveDraft();
  if (!saved) return;
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(selectedDocument)}/publish`, { method: 'POST', body: JSON.stringify({}) });
    documentView.document = result.document;
    documentView.published = result.revision;
    documentView.draft = null;
    updateInspector();
    renderDocumentList();
    setSaveState('Publicado');
    showToast('Documento publicado.');
  } catch {
    setError('Não foi possível publicar o documento.');
  }
}

async function unpublishDocument() {
  if (!documentView?.document?.published_revision_id) return;
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(selectedDocument)}/unpublish`, { method: 'POST', body: JSON.stringify({}) });
    documentView.document = result.document;
    documentView.published = null;
    updateInspector();
    renderDocumentList();
    setSaveState('Despublicado');
    showToast('Documento despublicado.');
  } catch {
    setError('Não foi possível despublicar o documento.');
  }
}

async function scheduleDocument(event) {
  event.preventDefault();
  if (!documentView) return;
  const value = document.getElementById('scheduled-at').value;
  if (!value) return;
  const scheduledAt = new Date(`${value}:00Z`);
  if (!Number.isFinite(scheduledAt.valueOf())) {
    setError('Informe uma data futura válida para o agendamento.');
    return;
  }
  const saved = await saveDraft();
  if (!saved) return;
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(selectedDocument)}/schedule`, {
      method: 'POST', body: JSON.stringify({ scheduled_at: scheduledAt.toISOString() }),
    });
    documentView.document = result.document;
    documentView.schedule = { revision_id: result.revision.id, scheduled_at: result.document.scheduled_at, revision: result.revision };
    documentView.draft = null;
    updateInspector();
    renderDocumentList();
    setSaveState('Agendado');
    showToast('Documento agendado.');
  } catch {
    setError('Não foi possível agendar o documento. Escolha uma data futura.');
  }
}

async function unscheduleDocument() {
  if (!documentView?.document?.scheduled_revision_id) return;
  try {
    const result = await fetchAPI(`/api/cms/documents/${encodeURIComponent(selectedDocument)}/schedule`, { method: 'DELETE' });
    documentView.document = result.document;
    documentView.draft = documentView.schedule?.revision || null;
    documentView.schedule = null;
    renderEditor(documentView.draft?.blocks || []);
    updateInspector();
    renderDocumentList();
    setSaveState('Agendamento cancelado');
    showToast('Agendamento cancelado.');
  } catch {
    setError('Não foi possível cancelar o agendamento.');
  }
}

newDocumentButton.addEventListener('click', async () => {
  newDocumentForm.hidden = false;
  await loadSources();
  document.getElementById('new-title').focus();
});
document.getElementById('cancel-new-document').addEventListener('click', () => { newDocumentForm.hidden = true; });
newDocumentForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!newDocumentForm.reportValidity()) return;
  const body = { type: selectedType, title: document.getElementById('new-title').value.trim(), category: document.getElementById('new-category').value.trim() };
  if (SOURCE_ENDPOINTS[selectedType]) body.source_id = sourceSelect.value;
  try {
    const result = await fetchAPI('/api/cms/documents', { method: 'POST', body: JSON.stringify(body) });
    newDocumentForm.reset();
    newDocumentForm.hidden = true;
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
