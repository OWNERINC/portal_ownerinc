import { renderBlocks, cleanupRenderedBlocks, validateBlocks } from '../cms-block-renderer.js';
import { element } from '../ui.js';
import { getNewsPresentation, normalizeEditorial, estimateNewsReadTime } from './model.js';

// The caller disposes the previous rendering before reusing its root.
export function renderNewsArticle(root, article, { signal, preview = false } = {}) {
  // Validate before deriving CSS classes or separating media from their blocks.
  const blocks = validateBlocks(article.content_blocks || []) || [];
  const editorial = normalizeEditorial(article.editorial);
  const presentation = getNewsPresentation({ ...article, content_blocks: blocks, editorial });
  const containers = [];
  const controller = new AbortController();
  const mediaOptions = { signal: controller.signal };
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    signal?.removeEventListener('abort', dispose);
    containers.forEach(cleanupRenderedBlocks);
    root.replaceChildren();
  };
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) { dispose(); return dispose; }
  root.replaceChildren();
  root.classList.add('news-article');
  const hero = element('header', { className: 'news-article-hero' });
  if (presentation.cover) {
    const media = element('div', { className: 'news-article-cover' });
    hero.append(media); containers.push(media);
    const { asset_id, alt } = presentation.cover;
    renderBlocks(media, [{ type: 'image', asset_id, alt }], mediaOptions);
  } else hero.classList.add('news-article-hero--no-cover');
  hero.append(element('div', { className: 'news-article-heading' }, [
    element('p', { className: 'news-eyebrow', text: article.category || 'Ownerinc' }),
    element(preview ? 'h2' : 'h1', { id: preview ? 'news-preview-title' : 'news-reader-title', text: article.title }),
  ]));
  const byline = element('aside', { className: 'news-article-byline' }, [
    element('p', { text: `Por ${presentation.author}` }),
  ]);
  if (presentation.sourceLabel) byline.append(element('p', { text: presentation.sourceLabel }));
  if (article.published_at && Number.isFinite(Date.parse(article.published_at))) {
    const date = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date(article.published_at));
    byline.append(element('p', { text: `Publicado no Portal: ${date}` }));
  }
  if (presentation.sourceDate) {
    const date = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${presentation.sourceDate}T12:00:00Z`));
    byline.append(element('p', { text: `Publicado na fonte: ${date}` }));
  }
  const minutes = article.read_time_minutes ?? estimateNewsReadTime(blocks, editorial);
  if (Number.isInteger(minutes) && minutes > 0) byline.append(element('p', { text: `${minutes} min de leitura` }));
  else if (editorial?.kind === 'edition' || (!editorial && blocks.some(block => block.type === 'pdf'))) {
    byline.append(element('p', { text: 'Edição em PDF' }));
  }
  const introduction = element('section', { className: 'news-article-introduction' }, [
    element('p', { className: 'news-article-lead', text: presentation.summary }), byline,
  ]);
  const body = element('div', { className: 'news-article-body' });
  root.append(hero);
  if (presentation.cover?.caption || presentation.cover?.credit) {
    root.append(element('p', { className: 'news-article-cover-credit',
      text: [presentation.cover.caption, presentation.cover.credit].filter(Boolean).join(' · ') }));
  }
  root.append(introduction, body);
  for (const block of presentation.body) {
    // The legacy model retains its first image in body for existing consumers.
    if (block === presentation.cover) continue;
    const holder = element('div', { className: `news-block news-block--${block.layout || 'content'} news-block--${block.typography || 'serif'}` });
    const shown = block.type === 'heading' && block.level === 1 ? { ...block, level: 2 } : block;
    body.append(holder); containers.push(holder); renderBlocks(holder, [shown], mediaOptions);
  }
  if (presentation.companion) {
    const companion = element('details', { className: 'news-companion' }, [
      element('summary', { text: 'Consultar edição completa em PDF' }),
    ]);
    const media = element('div'); companion.append(media); root.append(companion); containers.push(media);
    let loaded = false;
    companion.addEventListener('toggle', () => {
      if (companion.open && !loaded && !disposed) {
        loaded = true; renderBlocks(media, [presentation.companion], mediaOptions);
      }
    }, { signal: controller.signal });
  }
  return dispose;
}
