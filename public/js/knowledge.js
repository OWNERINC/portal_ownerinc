import { requireAuth, renderUserInTopbar, showToast, can, fetchAPI } from './auth.js';
import { clear, closeDialog, element, openDialog, showState } from './ui.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');
renderUserInTopbar(user);
const canManage = can(user, 'manageKnowledge');
if (user.role === 'admin') {
  document.getElementById('admin-link').style.display = '';
}
if (canManage) {
  document.getElementById('btn-new').style.display = '';
}

const searchInput = document.getElementById('search');
const categoriesNode = document.getElementById('categories');
const listNode = document.getElementById('articles-list');
const articleView = document.getElementById('article-view');
const modal = document.getElementById('modal-article');
const form = document.getElementById('article-form');
let articles = [];
let editingId = null;

function params() {
  return new URLSearchParams(location.search);
}

function updateUrl(changes, push = false) {
  const url = new URL(location.href);
  Object.entries(changes).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  history[push ? 'pushState' : 'replaceState']({}, '', url);
}

function renderCategories() {
  const active = params().get('category') || 'all';
  const categories = ['all', ...new Set(articles.map(article => article.category).filter(Boolean))];
  clear(categoriesNode);
  categories.forEach(category => {
    categoriesNode.append(element('button', {
      className: `badge category-filter ${category === active ? 'badge-gold' : 'badge-gray'}`,
      type: 'button',
      text: category === 'all' ? 'Todos' : category,
      'aria-pressed': String(category === active),
      on: { click: () => { updateUrl({ category: category === 'all' ? '' : category }, true); render(); } },
    }));
  });
}

function openArticle(id, push = true) {
  const article = articles.find(item => String(item.id) === String(id));
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
  document.getElementById('article-content').textContent = article.content || '';
  const adminBar = clear(document.getElementById('article-admin-bar'));
  adminBar.hidden = !canManage;
  if (canManage) {
    adminBar.append(
      element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', on: { click: () => editArticle(article) } }),
      element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Excluir', on: { click: () => deleteArticle(article.id) } }),
    );
  }
  document.getElementById('article-title').focus();
}

function render() {
  renderCategories();
  const query = (params().get('q') || '').toLocaleLowerCase('pt-BR');
  const category = params().get('category') || 'all';
  searchInput.value = params().get('q') || '';
  const filtered = articles.filter(article => {
    const matchesCategory = category === 'all' || article.category === category;
    const haystack = `${article.title || ''} ${article.content || ''}`.toLocaleLowerCase('pt-BR');
    return matchesCategory && (!query || haystack.includes(query));
  });
  articleView.hidden = true;
  listNode.hidden = false;
  categoriesNode.hidden = false;
  if (!filtered.length) showState(listNode, 'Nenhum artigo encontrado. Ajuste a busca ou a categoria.');
  else {
    clear(listNode);
    filtered.forEach(article => {
      const button = element('button', { className: 'card article-card', type: 'button', on: { click: () => openArticle(article.id) } }, [
        element('span', { className: 'card-title', text: article.title }),
        element('span', { className: 'badge badge-gold', text: article.category || 'Geral' }),
        element('span', { className: 'article-excerpt', text: (article.content || '').slice(0, 120) }),
      ]);
      listNode.append(button);
    });
  }
  const articleId = params().get('article');
  if (articleId) openArticle(articleId, false);
}

async function loadArticles() {
  showState(listNode, 'Carregando artigos…');
  try {
    articles = await fetchAPI('/api/knowledge');
    render();
  } catch {
    showState(listNode, 'Não foi possível carregar os artigos. Verifique sua conexão.', loadArticles);
  }
}

function newArticle() {
  editingId = null;
  form.reset();
  document.getElementById('modal-article-title').textContent = 'Novo Artigo';
  openDialog(modal, document.getElementById('f-title'));
}

function editArticle(article) {
  editingId = article.id;
  document.getElementById('modal-article-title').textContent = 'Editar Artigo';
  document.getElementById('f-title').value = article.title || '';
  document.getElementById('f-category').value = article.category || '';
  document.getElementById('f-content').value = article.content || '';
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
  if (!form.reportValidity()) return;
  const data = {
    title: document.getElementById('f-title').value.trim(),
    category: document.getElementById('f-category').value.trim(),
    content: document.getElementById('f-content').value.trim(),
  };
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
document.getElementById('modal-article-close').addEventListener('click', () => closeDialog(modal));
document.getElementById('modal-article-cancel').addEventListener('click', () => closeDialog(modal));
searchInput.addEventListener('input', () => { updateUrl({ q: searchInput.value.trim() }); render(); });
window.addEventListener('popstate', render);
loadArticles();
