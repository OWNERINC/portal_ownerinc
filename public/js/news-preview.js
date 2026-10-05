import { can, fetchAPI } from './auth.js';
import { element, showState } from './ui.js';
import { renderNewsArticle } from './owner-news/reader-view.js';
import { validateNewsBlocks } from './owner-news/content-contract.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function parameters(search) {
  const query = new URLSearchParams(search);
  if ([...query.keys()].some(key => !['id', 'version', 'source'].includes(key) || query.getAll(key).length !== 1)
    || !uuid(query.get('id')) || !uuid(query.get('version'))
    || (query.has('source') && !['payload', 'legacy'].includes(query.get('source')))) return null;
  return { id: query.get('id').toLowerCase(), version: query.get('version').toLowerCase(), source: query.get('source') || 'payload' };
}
function banner(article, query) {
  const revision = article.preview_revision;
  if (revision !== undefined && (!revision || Object.keys(revision).some(key => !['id', 'source', 'status'].includes(key))
    || revision.id !== query.version || revision.source !== query.source
    || !['draft', 'published', 'scheduled', 'archived'].includes(revision.status))) throw new Error('invalid_preview_revision');
  const status = { draft: 'Conteúdo não publicado', published: 'Revisão salva como publicada',
    scheduled: 'Revisão salva com publicação agendada', archived: 'Revisão arquivada' }[revision?.status] || 'Revisão salva';
  return [query.source === 'legacy' ? 'Histórico anterior à migração' : '', status,
    'Esta prévia mostra a revisão solicitada, não necessariamente a publicação atual.'].filter(Boolean).join(' · ');
}

export function mountNewsPreview(page) {
  const root = document.getElementById('news-preview-content');
  const status = document.getElementById('news-preview-status');
  if (!root || !status) return;
  const api = page.bindAPI({ fetchAPI });
  let controller, disposeArticle, generation = 0;
  function reset() { controller?.abort(); disposeArticle?.(); disposeArticle = null; root.replaceChildren(); }
  page.cleanup(() => { generation++; reset(); status.replaceChildren(); });
  async function load() {
    if (!page.active) return;
    const current = ++generation; reset();
    controller = new AbortController(); const signal = controller.signal;
    const active = () => page.active && !signal.aborted && current === generation;
    const query = parameters(page.location.search);
    if (!query) { status.textContent = 'Parâmetros de prévia inválidos. Abra uma revisão salva no editorial.'; return; }
    if (!page.user || !can(page.user, 'manageKnowledge')) { status.textContent = 'Você não possui permissão editorial para esta prévia.'; return; }
    status.textContent = 'Carregando revisão salva…';
    try {
      // fetchAPI guards the account epoch after JSON decoding as well as headers.
      const user = await api.fetchAPI('/api/users/me', { signal });
      if (!active() || user?.uid !== page.user.uid) return;
      if (!can(user, 'manageKnowledge')) throw Object.assign(new Error('forbidden'), { status: 403 });
      const search = new URLSearchParams({ version: query.version, source: query.source });
      const article = await api.fetchAPI(`/api/announcements/preview/${query.id}?${search}`, { signal });
      if (!active()) return;
      if (article?.id !== query.id || !validateNewsBlocks(article.content_blocks, article.content_version)
        || (article.asset_scope !== 'owner-news-preview' && !(query.source === 'legacy' && article.asset_scope === undefined && (article.content_version === undefined || article.content_version === 1)))) throw new Error('invalid_preview');
      const message = banner(article, query);
      disposeArticle = renderNewsArticle(root, article, { signal, preview: true });
      status.replaceChildren(element('p', { text: message }));
    } catch (error) {
      if (!active() || error.name === 'AbortError') return;
      reset();
      if (error.status === 403 || error.status === 401) status.textContent = 'Você não possui permissão editorial para esta prévia.';
      else if (error.status === 404) status.textContent = 'Esta revisão salva não está disponível.';
      else showState(status, 'Não foi possível carregar a prévia da revisão salva.', () => {
        if (!page.active) return;
        // The retry button is about to be removed; retain keyboard focus locally.
        status.tabIndex = -1; status.focus({ preventScroll: true }); void load();
      });
    }
  }
  page.listen(window, 'focus', load);
  page.listen(window, 'popstate', load);
  void load();
}

export function mount(page) { return mountNewsPreview(page); }
