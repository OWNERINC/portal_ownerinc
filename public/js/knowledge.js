import { requireAuth, showToast, can, fetchAPI, fetchAPIPage } from './auth.js';
import { clear, closeDialog, element, openDialog, showState } from './ui.js';
import { readOffset, renderPagination } from './pagination.js';
import { renderBlocks } from './cms-block-renderer.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');
const canManage = can(user, 'manageKnowledge');
if (canManage) {
  document.getElementById('btn-new').style.display = '';
}

const searchInput = document.getElementById('search');
const categoriesNode = document.getElementById('categories');
const listNode = document.getElementById('articles-list');
const articleView = document.getElementById('article-view');
const modal = document.getElementById('modal-article');
const form = document.getElementById('article-form');
const pdfInput = document.getElementById('f-pdf');
const pdfStatus = document.getElementById('f-pdf-status');
const pdfRemove = document.getElementById('f-pdf-remove');
let articles = [];
let categories = [];
let articlesRequest = 0;
let articleRequest = 0;
let total = 0;
let editingId = null;
let selectedPdf = null;
let currentPdf = null;
let pdfChanged = false;
let pdfUploadRequest = 0;
let pdfUploadPromise = null;
const PAGE_SIZE = 20;

function params() {
  return new URLSearchParams(location.search);
}

function updateUrl(changes, push = false) {
  const url = new URL(location.href);
  Object.entries(changes).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  history[push ? 'pushState' : 'replaceState']({}, '', url);
}

function pdfBlock(article) {
  return Array.isArray(article?.content_blocks)
    ? article.content_blocks.find(block => block.type === 'pdf') || null
    : null;
}

function updatePdfField() {
  const pdf = selectedPdf || currentPdf;
  pdfRemove.hidden = !pdf;
  if (selectedPdf) {
    pdfStatus.textContent = `Selecionado: ${selectedPdf.title}. Será anexado ao salvar.`;
  } else if (currentPdf) {
    pdfStatus.textContent = `PDF atual: ${currentPdf.title}. Escolha outro arquivo para substituir.`;
  } else {
    pdfStatus.textContent = 'Opcional. O arquivo será exibido dentro do artigo após o salvamento.';
  }
}

async function uploadPdf(file) {
  if (file.type !== 'application/pdf') {
    pdfInput.value = '';
    pdfStatus.textContent = 'Selecione um arquivo PDF válido.';
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    pdfInput.value = '';
    pdfStatus.textContent = 'O PDF deve ter no máximo 50 MB.';
    return;
  }
  const request = ++pdfUploadRequest;
  const body = new FormData();
  body.append('asset', file);
  pdfInput.disabled = true;
  pdfRemove.disabled = true;
  document.getElementById('modal-article-save').disabled = true;
  document.getElementById('modal-article-close').disabled = true;
  document.getElementById('modal-article-cancel').disabled = true;
  pdfStatus.textContent = 'Enviando PDF…';
  try {
    const asset = await fetchAPI('/api/cms/assets', { method: 'POST', body });
    if (request !== pdfUploadRequest) return;
    selectedPdf = { id: asset.id, title: asset.original_name.slice(0, 200) };
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
      pdfInput.disabled = false;
      pdfRemove.disabled = false;
      document.getElementById('modal-article-save').disabled = false;
      document.getElementById('modal-article-close').disabled = false;
      document.getElementById('modal-article-cancel').disabled = false;
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

function renderCategories() {
  const active = params().get('category') || 'all';
  clear(categoriesNode);
  ['all', ...categories].forEach(category => {
    categoriesNode.append(element('button', {
      className: `badge category-filter ${category === active ? 'badge-gold' : 'badge-gray'}`,
      type: 'button',
      text: category === 'all' ? 'Todos' : category,
      'aria-pressed': String(category === active),
      on: { click: () => { updateUrl({ category: category === 'all' ? '' : category, offset: '' }, true); loadArticles(); } },
    }));
  });
}

async function openArticle(id, push = true) {
  const requestToken = ++articleRequest;
  let article = articles.find(item => String(item.id) === String(id));
  if (!article) {
    try { article = await fetchAPI(`/api/knowledge/${encodeURIComponent(id)}`); } catch { article = null; }
  }
  if (requestToken !== articleRequest) return;
  if (!article) {
    updateUrl({ article: '' });
    showToast('O artigo solicitado não foi encontrado.');
    return render();
  }
  if (push) updateUrl({ article: article.id }, true);
  listNode.hidden = true;
  categoriesNode.hidden = true;
  articleView.hidden = false;
  document.getElementById('article-title').textContent = article.title;
  document.getElementById('article-category').textContent = article.category || 'Geral';
  const articleContent = document.getElementById('article-content');
  const blocks = Array.isArray(article.content_blocks) ? article.content_blocks : [];
  const rendered = renderBlocks(articleContent, blocks, { fallbackText: article.content || '' });
  if (!rendered) {
    articleContent.textContent = article.content || '';
  } else if (blocks.some(block => block.type === 'pdf')
    && !blocks.some(block => ['heading', 'paragraph', 'list', 'callout'].includes(block.type))
    && article.content) {
    articleContent.prepend(element('p', { className: 'article-legacy-content', text: article.content }));
  }
  const adminBar = clear(document.getElementById('article-admin-bar'));
  adminBar.hidden = !canManage;
  if (canManage) {
    adminBar.append(
      element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', 'aria-label': `Editar artigo: ${article.title}`, on: { click: () => editArticle(article) } }),
      element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Excluir', 'aria-label': `Excluir artigo: ${article.title}`, on: { click: () => deleteArticle(article.id) } }),
    );
  }
  document.getElementById('article-title').focus();
}

function render() {
  renderCategories();
  const query = (params().get('q') || '').toLocaleLowerCase('pt-BR');
  const category = params().get('category') || 'all';
  searchInput.value = params().get('q') || '';
  articleView.hidden = true;
  listNode.hidden = false;
  categoriesNode.hidden = false;
  if (!articles.length) showState(listNode, query || category !== 'all' ? 'Nenhum artigo encontrado. Ajuste a busca ou a categoria.' : 'Nenhum artigo disponível.');
  else {
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
        element('span', { className: 'article-excerpt', text: (article.content || '').slice(0, 140) || (pdf ? 'Material em PDF disponível para leitura.' : 'Consulte este artigo para ver os detalhes.') }),
      ]);
      listNode.append(button);
    });
  }
  renderPagination(document.getElementById('articles-pagination'), total, readOffset(params(), PAGE_SIZE), PAGE_SIZE, offset => {
    updateUrl({ offset: offset || '' });
    loadArticles();
  });
  const articleId = params().get('article');
  if (articleId) void openArticle(articleId, false);
  else articleRequest += 1;
}

async function loadArticles() {
  const requestToken = ++articlesRequest;
  articleRequest += 1;
  showState(listNode, 'Carregando artigos…');
  try {
    const query = params();
    const offset = readOffset(query, PAGE_SIZE);
    const search = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (query.get('q')) search.set('q', query.get('q'));
    if (query.get('category')) search.set('category', query.get('category'));
    const [result, categoryList] = await Promise.all([
      fetchAPIPage(`/api/knowledge?${search}`),
      fetchAPI('/api/knowledge/categories'),
    ]);
    if (requestToken !== articlesRequest) return;
    articles = result.data;
    total = result.total ?? articles.length;
    categories = categoryList;
    render();
  } catch {
    if (requestToken === articlesRequest) showState(listNode, 'Não foi possível carregar os artigos. Verifique sua conexão.', loadArticles);
  }
}

function newArticle() {
  editingId = null;
  resetPdfField();
  form.reset();
  document.getElementById('modal-article-title').textContent = 'Novo Artigo';
  openDialog(modal, document.getElementById('f-title'));
}

function editArticle(article) {
  editingId = article.id;
  resetPdfField();
  const pdf = pdfBlock(article);
  currentPdf = pdf ? { id: pdf.asset_id, title: pdf.title } : null;
  document.getElementById('modal-article-title').textContent = 'Editar Artigo';
  document.getElementById('f-title').value = article.title || '';
  document.getElementById('f-category').value = article.category || '';
  document.getElementById('f-content').value = article.content || '';
  updatePdfField();
  openDialog(modal, document.getElementById('f-title'));
}

async function deleteArticle(id) {
  if (!confirm('Excluir este artigo?')) return;
  try {
    await fetchAPI(`/api/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' });
    updateUrl({ article: '' });
    showToast('Artigo excluído.');
    await loadArticles();
  } catch (error) {
    showToast(`Não foi possível excluir: ${error.message}`);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (pdfUploadPromise) {
    showToast('Aguarde o envio do PDF terminar.');
    return;
  }
  if (!form.reportValidity()) return;
  const data = {
    title: document.getElementById('f-title').value.trim(),
    category: document.getElementById('f-category').value.trim(),
    content: document.getElementById('f-content').value.trim(),
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
  save.disabled = true;
  save.textContent = 'Salvando…';
  try {
    await fetchAPI(editingId ? `/api/knowledge/${encodeURIComponent(editingId)}` : '/api/knowledge', {
      method: editingId ? 'PUT' : 'POST', body: JSON.stringify(data),
    });
    closeDialog(modal, true);
    showToast(editingId ? 'Artigo atualizado.' : 'Artigo criado.');
    await loadArticles();
  } catch (error) {
    showToast(`Não foi possível salvar: ${error.message}`);
  } finally {
    save.disabled = false;
    save.textContent = 'Salvar';
  }
});

document.getElementById('btn-back').addEventListener('click', () => { updateUrl({ article: '' }, true); render(); });
document.getElementById('btn-new').addEventListener('click', newArticle);
document.getElementById('modal-article-close').addEventListener('click', () => {
  if (pdfUploadPromise) return showToast('Aguarde o envio do PDF terminar.');
  closeDialog(modal);
});
document.getElementById('modal-article-cancel').addEventListener('click', () => {
  if (pdfUploadPromise) return showToast('Aguarde o envio do PDF terminar.');
  closeDialog(modal);
});
pdfInput.addEventListener('change', () => {
  const file = pdfInput.files?.[0];
  if (!file) return;
  const promise = uploadPdf(file);
  pdfUploadPromise = promise;
  void promise.finally(() => { if (pdfUploadPromise === promise) pdfUploadPromise = null; });
});
pdfRemove.addEventListener('click', () => {
  if (selectedPdf) {
    selectedPdf = null;
    pdfChanged = Boolean(currentPdf);
  } else {
    currentPdf = null;
    pdfChanged = true;
  }
  updatePdfField();
});
searchInput.addEventListener('input', () => { updateUrl({ q: searchInput.value.trim(), offset: '' }); loadArticles(); });
window.addEventListener('popstate', loadArticles);
loadArticles();
