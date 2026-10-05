import { element } from '../ui.js';
import { renderBlocks, cleanupRenderedBlocks } from '../cms-block-renderer.js';
import { getNewsPresentation, estimateNewsReadTime } from './model.js';

export function composeNewsFeed(articles, pollNode, { offset = 0, category = '' } = {}) {
  const items = [...articles];
  if (pollNode && offset === 0 && !category) items.splice(Math.min(3, items.length), 0, pollNode);
  return items;
}

export function renderNewsCard(article, { index = 0, signal } = {}) {
  const cover = element('div', { className: 'news-card-cover' });
  const presentation = getNewsPresentation(article);
  const date = article.published_at && Number.isFinite(Date.parse(article.published_at))
    ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(article.published_at)) : '';
  const minutes = article.read_time_minutes ?? estimateNewsReadTime(article.content_blocks || [], article.editorial);
  const node = element('article', { className: 'news-card', id: `news-card-${article.id}`, 'data-variant': String(index % 8) }, [
    element('a', { href: `./announcements.html?id=${encodeURIComponent(article.id)}` }, [
      cover, element('h2', { text: article.title }),
    ]),
    element('p', { className: 'news-meta', text: [article.category, date,
      Number.isInteger(minutes) && minutes > 0 ? `${minutes} min de leitura` : ''].filter(Boolean).join(' · ') }),
  ]);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    cleanupRenderedBlocks(cover);
  };
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  else if (presentation.cover) {
    const { asset_id, alt } = presentation.cover;
    renderBlocks(cover, [{ type: 'image', asset_id, alt }], { signal, assetScope: article.asset_scope });
  } else cover.append(element('span', { className: 'news-card-brand', text: 'Owner News', 'aria-hidden': 'true' }));
  return { node, dispose };
}

export function renderNewsCategories(root, { total = 0, categories = [] }, selectedCategory = '') {
  if (!root) return;
  const focused = root.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
  const values = [{ name: '', count: total }, ...categories];
  if (selectedCategory && !categories.some(item => item.name === selectedCategory)) values.push({ name: selectedCategory, count: 0 });
  root.replaceChildren();
  values.forEach(({ name, count }) => {
    const query = new URLSearchParams();
    if (name) query.set('category', name);
    root.append(element('a', {
      href: `./announcements.html${query.toString() ? `?${query}` : ''}`,
      text: `${name || 'Todas'} (${count})`, ...(name === selectedCategory ? { 'aria-current': 'page' } : {}),
    }));
  });
  if (focused) [...root.querySelectorAll('a')].find(link => link.getAttribute('href') === focused)?.focus();
}

export function renderNewsOpening(root, home) {
  if (!root) return;
  root.replaceChildren(
    element('p', { className: 'news-eyebrow', text: home.eyebrow }),
    element('h1', { text: home.headline }),
    element('p', { className: 'news-opening-summary', text: home.summary }),
  );
}
