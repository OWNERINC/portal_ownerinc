import { requireAuth, renderUserInTopbar, showToast, fetchAPI } from './auth.js';

const user = await requireAuth();
if (!user) throw new Error('not authenticated');
renderUserInTopbar(user);
if (user.role === 'admin') {
  document.getElementById('admin-link').style.display = '';
  document.getElementById('btn-new').style.display = '';
}

let articles = [];
let activeCategory = 'all';
let editingId = null;

async function loadArticles() {
  articles = await fetchAPI('/api/knowledge');
  renderCategories();
  renderList();
}

function renderCategories() {
  const cats = ['all', ...new Set(articles.map(a => a.category).filter(Boolean))];
  document.getElementById('categories').innerHTML = cats.map(c => `
    <button class="badge ${c === activeCategory ? 'badge-gold' : 'badge-gray'}"
      style="cursor:pointer; border:none; padding:6px 14px; font-size:12px"
      onclick="window.__setCategory('${c}')">
      ${c === 'all' ? 'Todos' : c}
    </button>
  `).join('');
}

window.__setCategory = cat => {
  activeCategory = cat;
  renderCategories();
  renderList();
};

function renderList() {
  const search = document.getElementById('search').value.toLowerCase();
  const filtered = articles.filter(a => {
    const matchCat = activeCategory === 'all' || a.category === activeCategory;
    const matchSearch = !search || a.title?.toLowerCase().includes(search) || a.content?.toLowerCase().includes(search);
    return matchCat && matchSearch;
  });

  const container = document.getElementById('articles-list');
  if (filtered.length === 0) {
    container.innerHTML = '<p class="empty-state">Nenhum artigo encontrado.</p>';
    return;
  }
  container.innerHTML = filtered.map(a => `
    <div class="card" style="cursor:pointer" onclick="window.__openArticle('${a.id}')">
      <div class="card-title">${a.title}</div>
      <span class="badge badge-gold" style="margin-bottom:8px">${a.category || 'Geral'}</span>
      <p style="font-size:13px; color:var(--text-secondary); overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical">
        ${a.content?.substring(0, 120) || ''}
      </p>
    </div>
  `).join('');
}

window.__openArticle = id => {
  const a = articles.find(x => x.id === id);
  if (!a) return;
  document.getElementById('articles-list').style.display = 'none';
  document.getElementById('categories').style.display = 'none';
  const view = document.getElementById('article-view');
  view.style.display = '';
  document.getElementById('article-title').textContent = a.title;
  document.getElementById('article-category').textContent = a.category || 'Geral';
  document.getElementById('article-content').textContent = a.content;

  const adminBar = document.getElementById('article-admin-bar');
  if (user.role === 'admin') {
    adminBar.style.display = 'flex';
    adminBar.innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="window.__editArticle('${a.id}')">Editar</button>
      <button class="btn btn-danger btn-sm" onclick="window.__deleteArticle('${a.id}')">Excluir</button>
    `;
  } else {
    adminBar.style.display = 'none';
  }
};

document.getElementById('btn-back').addEventListener('click', () => {
  document.getElementById('article-view').style.display = 'none';
  document.getElementById('articles-list').style.display = '';
  document.getElementById('categories').style.display = 'flex';
});

document.getElementById('btn-new').addEventListener('click', () => {
  editingId = null;
  document.getElementById('modal-article-title').textContent = 'Novo Artigo';
  document.getElementById('f-title').value = '';
  document.getElementById('f-category').value = '';
  document.getElementById('f-content').value = '';
  document.getElementById('modal-article').classList.remove('hidden');
});

window.__editArticle = id => {
  const a = articles.find(x => x.id === id);
  editingId = id;
  document.getElementById('modal-article-title').textContent = 'Editar Artigo';
  document.getElementById('f-title').value = a.title;
  document.getElementById('f-category').value = a.category;
  document.getElementById('f-content').value = a.content;
  document.getElementById('modal-article').classList.remove('hidden');
};

window.__deleteArticle = async id => {
  if (!confirm('Excluir este artigo?')) return;
  await fetchAPI(`/api/knowledge/${id}`, { method: 'DELETE' });
  showToast('Artigo excluído.');
  document.getElementById('article-view').style.display = 'none';
  document.getElementById('articles-list').style.display = '';
  document.getElementById('categories').style.display = 'flex';
  await loadArticles();
};

document.getElementById('modal-article-save').addEventListener('click', async () => {
  const title    = document.getElementById('f-title').value.trim();
  const category = document.getElementById('f-category').value.trim();
  const content  = document.getElementById('f-content').value.trim();
  if (!title || !content) { showToast('Título e conteúdo são obrigatórios.'); return; }

  try {
    if (editingId) {
      await fetchAPI(`/api/knowledge/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify({ title, category, content }),
      });
    } else {
      await fetchAPI('/api/knowledge', {
        method: 'POST',
        body: JSON.stringify({ title, category, content }),
      });
    }
    document.getElementById('modal-article').classList.add('hidden');
    showToast(editingId ? 'Artigo atualizado.' : 'Artigo criado.');
    await loadArticles();
  } catch (err) {
    showToast('Erro: ' + err.message);
  }
});

['modal-article-close', 'modal-article-cancel'].forEach(id =>
  document.getElementById(id).addEventListener('click', () =>
    document.getElementById('modal-article').classList.add('hidden')
  )
);

document.getElementById('search').addEventListener('input', renderList);
loadArticles();
