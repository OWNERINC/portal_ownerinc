import { can, fetchAPI, fetchAPIPage } from './auth.js';
import { canCloseDialog, clear, closeDialog, element, openDialog, setBusy, setDialogCloseGuard, showState } from './ui.js';
import { readOffset, renderPagination, setPaginationBusy } from './pagination.js';
import { blocksToText, renderBlocks } from './cms-block-renderer.js';

const requests = { fetchAPI, fetchAPIPage };
const renderContent = renderBlocks;
export function mount(page) {
const user = page.user;
const { fetchAPI, fetchAPIPage } = page.bindAPI(requests);
const showToast = page.toast;
const renderBlocks = (node, blocks, options) => renderContent(node, blocks, { ...options, signal: page.signal });
const history = page.history;
const location = page.location;
page.cleanup(() => { ++articlesRequest; ++articleRequest; ++articleDeleteRequest; ++pdfUploadRequest; });
page.beforeLeave(() => !articleDeleteInFlight && !articleSaveInFlight && !pdfUploadPromise && !pdfCleanupPromise);
const canManage = can(user, 'manageKnowledge');
if (canManage) {
  document.getElementById('btn-new').style.display = '';
}

const searchInput = document.getElementById('search');
const categoriesNode = document.getElementById('categories');
const listNode = document.getElementById('articles-list');
const articlesPagination = document.getElementById('articles-pagination');
const articleView = document.getElementById('article-view');
const modal = document.getElementById('modal-article');
const form = document.getElementById('article-form');
const pdfInput = document.getElementById('f-pdf');
const pdfStateInput = document.getElementById('f-pdf-state');
const pdfStatus = document.getElementById('f-pdf-status');
const pdfRemove = document.getElementById('f-pdf-remove');
const legacyContentInput = document.getElementById('f-content');
let articles = [];
let categories = [];
let articlesRequest = 0;
let articleRequest = 0;
let articleDeleteRequest = 0;
let articleDeleteInFlight = false;
let total = 0;
let editingId = null;
let selectedPdf = null;
let currentPdf = null;
let pdfChanged = false;
const createdPdfAssets = new Map();
let pdfUploadRequest = 0;
let pdfUploadPromise = null;
let pdfCleanupPromise = null;
let pdfRemoveFocusPending = false;
let articleSaveInFlight = false;
let editingCmsManaged = false;
let lastKnownUrl = location.href;
const PAGE_SIZE = 20;
if (modal) setDialogCloseGuard(modal, canCloseArticleDialog, {
  canLeave: () => !pdfUploadPromise && !pdfCleanupPromise && !articleSaveInFlight,
  discard: () => createdPdfAssets.size ? cleanupCreatedPdfAssets() : true,
});

function params() {
  return new URLSearchParams(location.search);
}

function updateUrl(changes, push = false) {
  const url = new URL(location.href);
  Object.entries(changes).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  history[push ? 'pushState' : 'replaceState']({}, '', url);
  lastKnownUrl = url.href;
}

function normalizeCategories(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter(category => typeof category === 'string')
    .map(category => category.trim())
    .filter(Boolean))];
}

function categoryLabel(category) {
  return ['all', 'todos'].includes(category.toLocaleLowerCase('pt-BR')) ? `${category} (categoria)` : category;
}

function focusDescriptor(node) {
  if (!node?.isConnected) return null;
  if (node === document.getElementById('article-title') || node.closest?.('#article-view')) return { kind: 'article-detail', node };
  if (node.closest?.('#categories')) return { kind: 'category', value: node.dataset.category || '', node };
  if (node.closest?.('#articles-pagination')) return { kind: 'pagination', label: node.textContent.trim(), node };
  return null;
}

function hasInertAncestor(node) {
  let current = node?.parentNode;
  while (current) {
    if (current.inert) return true;
    current = current.parentNode;
  }
  return false;
}

function visibleFocusTarget(node) {
  return Boolean(node && node !== document.body && node.isConnected !== false
    && !node.hidden && !node.disabled && !node.inert && !hasInertAncestor(node) && node.style?.display !== 'none'
    && !node.closest?.('[hidden], .hidden, [aria-hidden="true"]'));
}

function focusVisibleTarget(target) {
  if (!target) return;
  if (/^H[1-6]$/.test(target.tagName) || ['heading', 'status', 'alert'].includes(target.getAttribute?.('role'))) {
    target.tabIndex = -1;
  }
  target.focus();
}

function focusListFallback(state) {
  const target = [
    categoriesNode?.querySelector('button'),
    searchInput,
    listNode?.querySelector('a, button'),
    listNode?.querySelector('h1, h2, h3, [role="heading"]'),
    state?.querySelector('button'),
    state,
    document.querySelector('main h1, main h2, main h3, main [role="heading"]'),
  ].find(node => visibleFocusTarget(node));
  focusVisibleTarget(target);
}

function captureListFocusDestination() {
  const target = [
    categoriesNode?.querySelector('button'),
    listNode?.querySelector('a, button'),
    listNode?.querySelector('h1, h2, h3, [role="heading"]'),
    document.querySelector('main h1, main h2, main h3, main [role="heading"]'),
  ].find(node => visibleFocusTarget(node));
  return target ? { kind: 'target', node: target } : null;
}

function restoreListFocus(descriptor, state) {
  if (!descriptor) return;
  if (descriptor.kind === 'article-detail') {
    const current = document.activeElement;
    if (!visibleFocusTarget(current) || current === descriptor.node) focusListFallback(state);
    return;
  }
  if (descriptor.kind === 'target') {
    if (visibleFocusTarget(descriptor.node)) focusVisibleTarget(descriptor.node);
    else focusListFallback(state);
    return;
  }
  const current = document.activeElement;
  if (current?.isConnected && current !== document.body && current !== descriptor.node) return;
  if (descriptor.kind === 'category') {
    const target = [...categoriesNode.querySelectorAll('button')].find(button => button.dataset.category === descriptor.value && visibleFocusTarget(button))
      || [...categoriesNode.querySelectorAll('button')].find(visibleFocusTarget);
    if (target) focusVisibleTarget(target);
    else focusListFallback(state);
  } else {
    const target = [...(articlesPagination?.querySelectorAll('button') || [])]
      .find(button => button.textContent.trim() === descriptor.label && visibleFocusTarget(button));
    if (target) focusVisibleTarget(target);
    else focusListFallback(state);
  }
}

function paginationStillCurrent(requestToken, offset) {
  return requestToken === articlesRequest && readOffset(params(), PAGE_SIZE) === offset;
}

function setArticleDeleteBusy(busy) {
  articleDeleteInFlight = busy;
  const adminBar = document.getElementById('article-admin-bar');
  setBusy(adminBar, busy);
  adminBar?.querySelectorAll('button').forEach(button => { button.disabled = busy; });
}

function invalidateArticleDelete() {
  articleDeleteRequest += 1;
  if (articleDeleteInFlight) setArticleDeleteBusy(false);
}

function setCategoriesBusy(busy) {
  setBusy(categoriesNode, busy);
  categoriesNode?.querySelectorAll('button').forEach(button => { button.disabled = busy; });
}

function focusStateRetry(state, descriptor) {
  if (!state) return;
  const current = document.activeElement;
  if (descriptor?.kind === 'article-detail' || !visibleFocusTarget(current)) {
    const target = state.querySelector('button') || state;
    if (visibleFocusTarget(target)) focusVisibleTarget(target);
    else focusListFallback(state);
  }
}

function focusListDestination() {
  focusListFallback();
}

function prepareArticleNavigation() {
  if (modal.classList.contains('hidden')) return true;
  if (!canCloseDialog(modal)) return false;
  closeDialog(modal, true);
  return true;
}

function pdfBlock(article) {
  return Array.isArray(article?.content_blocks)
    ? article.content_blocks.find(block => block.type === 'pdf') || null
    : null;
}

function articleBody(article) {
  return Array.isArray(article?.content_blocks) ? blocksToText(article.content_blocks) : article?.content || '';
}

function visiblePdfFocusTarget(node) {
  return Boolean(node && node !== document.body && node.isConnected !== false
    && !node.hidden && !node.disabled && !node.inert && !hasInertAncestor(node) && node.style?.display !== 'none'
    && !node.closest?.('[hidden], .hidden, [aria-hidden="true"]'));
}

function pdfFocusTarget() {
  const title = document.getElementById('modal-article-title');
  if (title && title.tabIndex < 0) title.tabIndex = -1;
  return [
    pdfInput,
    document.querySelector('label[for="f-pdf"]'),
    document.getElementById('f-title'),
    title,
  ].find(visiblePdfFocusTarget);
}

function flushPdfRemoveFocus() {
  if (!pdfRemoveFocusPending) return;
  const active = document.activeElement;
  if (active !== pdfRemove && visiblePdfFocusTarget(active)) {
    pdfRemoveFocusPending = false;
    return;
  }
  const target = pdfFocusTarget();
  if (target) {
    pdfRemoveFocusPending = false;
    target.focus();
  }
}

function syncPdfState() {
  if (!pdfStateInput) return;
  pdfStateInput.value = JSON.stringify({
    selected: selectedPdf?.id || null,
    current: currentPdf?.id || null,
    changed: pdfChanged,
    pending: Boolean(pdfUploadPromise || pdfCleanupPromise || articleSaveInFlight || createdPdfAssets.size),
  });
}

async function deletePdfAsset(assetId) {
  try {
    const result = await fetchAPI(`/api/cms/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
    if (result?.reason === 'pending' || result?.reason === 'already_deleting') {
      pdfStatus.textContent = 'A remoção do PDF ainda está pendente. Tente novamente em instantes.';
      return false;
    }
    return true;
  } catch (error) {
    if (error?.status === 404) return true;
    if (error?.status === 409 && error?.reason === 'referenced') {
      pdfStatus.textContent = 'O PDF já está referenciado e foi preservado.';
      return true;
    }
    if (error?.status === 409 && error?.reason === 'already_deleting') {
      pdfStatus.textContent = 'A remoção do PDF já está em andamento. Tente novamente em instantes.';
      return false;
    }
    pdfStatus.textContent = `Não foi possível remover o PDF: ${error.message}`;
    return false;
  }
}

function pdfAssetTitle(asset) {
  return String(asset?.original_name || 'PDF').slice(0, 200);
}

function trackCreatedPdfAsset(asset) {
  const tracked = { id: asset.id, title: pdfAssetTitle(asset) };
  createdPdfAssets.set(tracked.id, tracked);
  return tracked;
}

async function cleanupStalePdfAsset(asset) {
  const tracked = trackCreatedPdfAsset(asset);
  if (await deletePdfAsset(tracked.id)) createdPdfAssets.delete(tracked.id);
  syncPdfState();
}

function cleanupCreatedPdfAssets({ onlyIds = null, keepIds = new Set(), closeAfter = false } = {}) {
  if (pdfCleanupPromise) return pdfCleanupPromise;
  const ids = [...createdPdfAssets.keys()].filter(id => (!onlyIds || onlyIds.includes(id)) && !keepIds.has(id));
  if (!ids.length) {
    if (closeAfter) closeDialog(modal, true);
    return Promise.resolve(true);
  }

  const promise = Promise.resolve().then(async () => {
    setArticleEditorBusy(true);
    let cleaned = true;
    try {
      for (const assetId of ids) {
        if (!createdPdfAssets.has(assetId)) continue;
        if (!await deletePdfAsset(assetId)) {
          cleaned = false;
          continue;
        }
        createdPdfAssets.delete(assetId);
        if (selectedPdf?.id === assetId) {
          selectedPdf = null;
          pdfChanged = false;
          updatePdfField();
        }
      }
      return cleaned;
    } finally {
      if (pdfCleanupPromise === promise) pdfCleanupPromise = null;
      setArticleEditorBusy(false);
      syncPdfState();
      flushPdfRemoveFocus();
      if (page.active && cleaned && closeAfter) closeDialog(modal, true);
    }
  });
  pdfCleanupPromise = promise;
  void promise.then(
    () => { if (pdfCleanupPromise === promise) pdfCleanupPromise = null; },
    () => { if (pdfCleanupPromise === promise) pdfCleanupPromise = null; },
  );
  return promise;
}

function canCloseArticleDialog() {
  if (pdfUploadPromise || pdfCleanupPromise || articleSaveInFlight) {
    showToast('Aguarde a operação do artigo terminar.');
    return false;
  }
  if (createdPdfAssets.size) {
    showToast('Removendo o PDF antes de fechar…');
    void cleanupCreatedPdfAssets({ closeAfter: true });
    return false;
  }
  return true;
}

function setArticleEditorBusy(busy) {
  if (!page.active) return;
  [
    document.getElementById('f-title'),
    document.getElementById('f-category'),
    legacyContentInput,
    pdfInput,
    pdfRemove,
    document.getElementById('modal-article-save'),
    document.getElementById('modal-article-close'),
    document.getElementById('modal-article-cancel'),
  ].filter(Boolean).forEach(field => { field.disabled = busy; });
  if (!busy) syncLegacyContentField();
  syncPdfState();
  if (!busy) flushPdfRemoveFocus();
}

function syncLegacyContentField() {
  legacyContentInput.disabled = editingCmsManaged;
  legacyContentInput.required = !editingCmsManaged;
  legacyContentInput.placeholder = editingCmsManaged
    ? 'O corpo é gerenciado pelo Editor CMS.'
    : 'Conteúdo em texto simples…';
}

function updatePdfField() {
  const removeWasFocused = document.activeElement === pdfRemove;
  const pdf = selectedPdf || currentPdf;
  pdfRemove.hidden = !pdf;
  if (selectedPdf) {
    pdfStatus.textContent = `Selecionado: ${selectedPdf.title}. Será anexado ao salvar.`;
  } else if (currentPdf) {
    pdfStatus.textContent = `PDF atual: ${currentPdf.title}. Escolha outro arquivo para substituir.`;
  } else {
    pdfStatus.textContent = 'Opcional. O arquivo será exibido dentro do artigo após o salvamento.';
  }
  if (removeWasFocused && pdfRemove.hidden) {
    pdfRemoveFocusPending = true;
    if (!pdfCleanupPromise) flushPdfRemoveFocus();
  }
  syncPdfState();
}

function invalidatePdfUpload(message = '', requestToken = ++pdfUploadRequest) {
  const pending = pdfUploadPromise;
  pdfInput.value = '';
  if (message) pdfStatus.textContent = message;
  const release = () => {
    if (requestToken === pdfUploadRequest && !pdfUploadPromise) setArticleEditorBusy(false);
  };
  if (pending) void pending.finally(release);
  else release();
}

async function uploadPdf(file) {
  const request = ++pdfUploadRequest;
  if (file.type !== 'application/pdf') {
    invalidatePdfUpload('Selecione um arquivo PDF válido.', request);
    return;
  }
  if (file.size > 100 * 1024 * 1024) {
    invalidatePdfUpload('O PDF deve ter no máximo 100 MB.', request);
    return;
  }
  const previousPdfId = selectedPdf?.id;
  const previousPdfWasCreated = createdPdfAssets.has(previousPdfId);
  const body = new FormData();
  body.append('asset', file);
  setArticleEditorBusy(true);
  pdfStatus.textContent = 'Enviando PDF…';
  try {
    const asset = await fetchAPI('/api/cms/assets', { method: 'POST', body });
    if (request !== pdfUploadRequest) {
      await cleanupStalePdfAsset(asset);
      return;
    }
    if (previousPdfWasCreated) {
      await cleanupCreatedPdfAssets({ onlyIds: [previousPdfId] });
    }
    const tracked = trackCreatedPdfAsset(asset);
    selectedPdf = { ...tracked };
    pdfChanged = true;
    pdfInput.value = '';
    updatePdfField();
  } catch (error) {
    if (request === pdfUploadRequest) {
      pdfInput.value = '';
      pdfStatus.textContent = `Não foi possível enviar o PDF: ${error.message}`;
    }
  } finally {
    if (request === pdfUploadRequest) {
      setArticleEditorBusy(false);
    }
  }
}

function resetPdfField() {
  pdfUploadRequest += 1;
  pdfInput.value = '';
  pdfInput.disabled = false;
  pdfRemove.disabled = false;
  selectedPdf = null;
  currentPdf = null;
  pdfChanged = false;
  updatePdfField();
}

function renderCategories(requestToken = articlesRequest) {
  const active = params().get('category')?.trim() || '';
  clear(categoriesNode);
  [{ value: '', label: 'Todos' }, ...categories.map(value => ({ value, label: categoryLabel(value) }))].forEach(({ value, label }) => {
    categoriesNode.append(element('button', {
      className: `badge category-filter ${value === active ? 'badge-gold' : 'badge-gray'}`,
      type: 'button',
      text: label,
      'data-category': value,
      'aria-pressed': String(value === active),
      on: { click: () => {
        if (requestToken !== articlesRequest) return;
        updateUrl({ category: value, offset: '' }, true);
        loadArticles();
      } },
    }));
  });
  setCategoriesBusy(false);
}

async function openArticle(id, push = true) {
  if (push && !prepareArticleNavigation()) return;
  invalidateArticleDelete();
  const requestToken = ++articleRequest;
  const articleContent = document.getElementById('article-content');
  const articleTitle = document.getElementById('article-title');
  if (push) updateUrl({ article: id }, true);
  listNode.hidden = true;
  categoriesNode.hidden = true;
  if (articlesPagination) articlesPagination.hidden = true;
  articleView.hidden = false;
  articleTitle.textContent = 'Carregando artigo…';
  document.getElementById('article-category').textContent = '';
  clear(document.getElementById('article-admin-bar')).hidden = true;
  setBusy(articleContent, true);
  if (!articleContent.hasChildNodes()) showState(articleContent, 'Carregando artigo…');
  articleTitle.focus();

  const focusStillBelongsToArticle = () => {
    const current = document.activeElement;
    return current === articleTitle || current === document.body || !current?.isConnected;
  };

  let article;
  try {
    article = await fetchAPI(`/api/knowledge/${encodeURIComponent(id)}`);
  } catch (error) {
    if (requestToken !== articleRequest) return;
    if (error?.status === 404) {
      const restoreFocus = focusStillBelongsToArticle();
      updateUrl({ article: '' });
      showToast('O artigo solicitado não foi encontrado.');
      setBusy(articleContent, false);
      render();
      if (restoreFocus) focusListDestination();
      return;
    }
    articleTitle.textContent = 'Não foi possível carregar o artigo.';
    const state = showState(articleContent, 'Não foi possível carregar o artigo. Verifique sua conexão.', () => openArticle(id, false));
    if (focusStillBelongsToArticle()) state?.querySelector('button')?.focus();
    setBusy(articleContent, false);
    return;
  }
  if (requestToken !== articleRequest) return;
  if (!article) {
    const restoreFocus = focusStillBelongsToArticle();
    updateUrl({ article: '' });
    showToast('O artigo solicitado não foi encontrado.');
    setBusy(articleContent, false);
    render();
    if (restoreFocus) focusListDestination();
    return;
  }
  if (!push) updateUrl({ article: article.id });
  articleTitle.textContent = article.title;
  document.getElementById('article-category').textContent = article.category || 'Geral';
  const blocks = Array.isArray(article.content_blocks) ? article.content_blocks : [];
  renderBlocks(articleContent, blocks, { fallbackText: article.cms_managed ? '' : article.content || '' });
  const adminBar = clear(document.getElementById('article-admin-bar'));
  adminBar.hidden = !canManage;
  if (canManage) {
    adminBar.append(
      element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', 'aria-label': `Editar artigo: ${article.title}`, on: { click: () => editArticle(article) } }),
      element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Excluir', 'aria-label': `Excluir artigo: ${article.title}`, on: { click: () => deleteArticle(article.id) } }),
    );
  }
  if (focusStillBelongsToArticle()) articleTitle.focus();
  setBusy(articleContent, false);
}

function render(requestToken = articlesRequest) {
  renderCategories(requestToken);
  const query = (params().get('q') || '').toLocaleLowerCase('pt-BR');
  const category = params().get('category')?.trim() || '';
  searchInput.value = params().get('q') || '';
  articleView.hidden = true;
  listNode.hidden = false;
  categoriesNode.hidden = false;
  if (articlesPagination) articlesPagination.hidden = false;
  const state = !articles.length
    ? showState(listNode, query || category ? 'Nenhum artigo encontrado. Ajuste a busca ou a categoria.' : 'Nenhum artigo disponível.')
    : null;
  if (articles.length) {
    clear(listNode);
    articles.forEach(article => {
      const pdf = pdfBlock(article);
      const metadata = [
        element('span', { className: 'badge badge-gold', text: article.category || 'Geral' }),
        ...(pdf ? [element('span', { className: 'badge badge-gray', text: 'PDF' })] : []),
      ];
      const button = element('button', { className: 'card article-card', type: 'button', on: { click: () => openArticle(article.id) } }, [
        element('span', { className: 'article-card-heading' }, [
          element('span', { className: 'card-title', text: article.title }),
          element('span', { className: 'article-card-arrow', 'aria-hidden': 'true', text: '→' }),
        ]),
        element('span', { className: 'article-card-meta' }, metadata),
         element('span', { className: 'article-excerpt', text: articleBody(article).slice(0, 140) || (pdf ? 'Material em PDF disponível para leitura.' : 'Consulte este artigo para ver os detalhes.') }),
      ]);
      listNode.append(button);
    });
  }
  const currentOffset = readOffset(params(), PAGE_SIZE);
  renderPagination(articlesPagination, total, currentOffset, PAGE_SIZE, offset => {
    if (!paginationStillCurrent(requestToken, currentOffset)) return;
    updateUrl({ offset: offset || '' });
    loadArticles();
  });
  const articleId = params().get('article');
  if (articleId) void openArticle(articleId, false);
  else articleRequest += 1;
  return state;
}

async function loadArticles(focusOverride = null) {
  const requestedFocus = focusOverride || focusDescriptor(document.activeElement);
  const requestToken = ++articlesRequest;
  articleRequest += 1;
  setBusy(listNode, true);
  setCategoriesBusy(true);
  setPaginationBusy(articlesPagination, true);
  try {
    const query = params();
    const offset = readOffset(query, PAGE_SIZE);
    if (query.get('offset') !== (offset ? String(offset) : '')) updateUrl({ offset: offset || '' });
    const search = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (query.get('q')) search.set('q', query.get('q'));
    if (query.get('category')?.trim()) search.set('category', query.get('category').trim());
    const [result, categoryList] = await Promise.all([
      fetchAPIPage(`/api/knowledge?${search}`),
      fetchAPI('/api/knowledge/categories'),
    ]);
    if (requestToken !== articlesRequest) return;
    articles = Array.isArray(result.data) ? result.data : [];
    total = result.total ?? articles.length;
    categories = normalizeCategories(categoryList);
    if (!articles.length && offset > 0) {
      updateUrl({ offset: '' });
      return loadArticles();
    }
    const state = render(requestToken);
    if (!params().get('article')) restoreListFocus(requestedFocus, state);
  } catch {
    if (requestToken === articlesRequest) {
      focusStateRetry(showState(listNode, 'Não foi possível carregar os artigos. Verifique sua conexão.', loadArticles), requestedFocus);
    }
  } finally {
    if (requestToken === articlesRequest) {
      setBusy(listNode, false);
      setCategoriesBusy(false);
      setPaginationBusy(articlesPagination, false);
    }
  }
}

function newArticle() {
  if (!canCloseArticleDialog()) return;
  editingId = null;
  editingCmsManaged = false;
  resetPdfField();
  form.reset();
  syncLegacyContentField();
  document.getElementById('modal-article-title').textContent = 'Novo Artigo';
  openDialog(modal, document.getElementById('f-title'));
}

function editArticle(article) {
  editingId = article.id;
  editingCmsManaged = article.cms_managed === true;
  resetPdfField();
  const pdf = pdfBlock(article);
  currentPdf = pdf ? { id: pdf.asset_id, title: pdf.title } : null;
  document.getElementById('modal-article-title').textContent = 'Editar Artigo';
  document.getElementById('f-title').value = article.title || '';
  document.getElementById('f-category').value = article.category || '';
  legacyContentInput.value = editingCmsManaged ? '' : article.content || '';
  syncLegacyContentField();
  updatePdfField();
  openDialog(modal, document.getElementById('f-title'));
}

async function deleteArticle(id) {
  if (articleDeleteInFlight) return;
  if (!confirm('Excluir este artigo?')) return;
  const requestToken = ++articleDeleteRequest;
  const focusDestination = captureListFocusDestination();
  setArticleDeleteBusy(true);
  try {
    await fetchAPI(`/api/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (requestToken !== articleDeleteRequest || params().get('article') !== id) return;
    updateUrl({ article: '' });
    showToast('Artigo excluído.');
    await loadArticles(focusDestination);
  } catch (error) {
    if (requestToken === articleDeleteRequest) showToast(`Não foi possível excluir: ${error.message}`);
  } finally {
    if (requestToken === articleDeleteRequest) setArticleDeleteBusy(false);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (articleSaveInFlight || pdfCleanupPromise) return;
  if (pdfUploadPromise) {
    showToast('Aguarde o envio do PDF terminar.');
    return;
  }
  if (!form.reportValidity()) return;
  const data = {
    title: document.getElementById('f-title').value.trim(),
    category: document.getElementById('f-category').value.trim(),
    ...(editingCmsManaged ? {} : { content: legacyContentInput.value.trim() }),
  };
  if (pdfChanged) {
    if (selectedPdf) {
      data.pdf_asset_id = selectedPdf.id;
      data.pdf_title = selectedPdf.title;
    } else if (editingId) {
      data.pdf_asset_id = null;
    }
  }
  const save = document.getElementById('modal-article-save');
  save.textContent = 'Salvando…';
  articleSaveInFlight = true;
  setArticleEditorBusy(true);
  syncPdfState();
  const persistedPdfId = pdfChanged && selectedPdf?.id ? selectedPdf.id : null;
  const wasEditing = Boolean(editingId);
  try {
    const result = await fetchAPI(editingId ? `/api/knowledge/${encodeURIComponent(editingId)}` : '/api/knowledge', {
      method: editingId ? 'PUT' : 'POST', body: JSON.stringify(data),
    });
    if (!wasEditing) {
      if (!result?.id) throw new Error('A API não retornou o identificador do artigo criado.');
      editingId = result.id;
      document.getElementById('modal-article-title').textContent = 'Editar Artigo';
    }
    articleSaveInFlight = false;
    if (persistedPdfId) createdPdfAssets.delete(persistedPdfId);
    if (!await cleanupCreatedPdfAssets()) {
      showToast('Artigo salvo, mas um PDF temporário não pôde ser removido. Tente novamente.');
      return;
    }
    resetPdfField();
    closeDialog(modal, true);
    showToast(wasEditing ? 'Artigo atualizado.' : 'Artigo criado.');
    await loadArticles();
  } catch (error) {
    showToast(`Não foi possível salvar: ${error.message}`);
  } finally {
    articleSaveInFlight = false;
    setArticleEditorBusy(false);
    syncPdfState();
    save.textContent = 'Salvar';
  }
});

document.getElementById('btn-back').addEventListener('click', () => {
  const restoreFocus = document.activeElement?.closest?.('#article-view') || document.activeElement === document.body || !document.activeElement?.isConnected;
  if (!prepareArticleNavigation()) return;
  invalidateArticleDelete();
  updateUrl({ article: '' }, true);
  render();
  if (restoreFocus) focusListDestination();
});
document.getElementById('btn-new').addEventListener('click', newArticle);
document.getElementById('modal-article-close').addEventListener('click', () => {
  closeDialog(modal);
});
document.getElementById('modal-article-cancel').addEventListener('click', () => {
  closeDialog(modal);
});
pdfInput.addEventListener('change', () => {
  const file = pdfInput.files?.[0];
  if (!file) {
    invalidatePdfUpload();
    return;
  }
  if (file.type !== 'application/pdf') {
    invalidatePdfUpload('Selecione um arquivo PDF válido.');
    return;
  }
  if (file.size > 100 * 1024 * 1024) {
    invalidatePdfUpload('O PDF deve ter no máximo 100 MB.');
    return;
  }
  const promise = uploadPdf(file);
  pdfUploadPromise = promise;
  void promise.finally(() => { if (pdfUploadPromise === promise) pdfUploadPromise = null; });
});
pdfRemove.addEventListener('click', async () => {
  if (pdfCleanupPromise || pdfUploadPromise || articleSaveInFlight) return;
  if (createdPdfAssets.size) {
    await cleanupCreatedPdfAssets();
    return;
  }
  if (selectedPdf) {
    selectedPdf = null;
    pdfChanged = false;
  } else {
    currentPdf = null;
    pdfChanged = true;
  }
  updatePdfField();
});
searchInput.addEventListener('input', () => { invalidateArticleDelete(); updateUrl({ q: searchInput.value.trim(), offset: '' }); loadArticles(); });
page.listen(window, 'popstate', () => {
  if (!modal.classList.contains('hidden') && !canCloseDialog(modal)) {
    history.pushState({}, '', lastKnownUrl);
    return;
  }
  invalidateArticleDelete();
  if (!modal.classList.contains('hidden')) closeDialog(modal, true);
  lastKnownUrl = location.href;
  articleView.hidden = true;
  listNode.hidden = false;
  categoriesNode.hidden = false;
  if (articlesPagination) articlesPagination.hidden = false;
  loadArticles();
});
loadArticles();
}
