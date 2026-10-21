import { PAGE_SIZE, MAX_OFFSET, validateCategories, validateList } from './dto.js';

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dateNode(document, publishedAt) {
  if (publishedAt === null) return null;
  const time = element(document, 'time', 'contents-published-date', new Date(publishedAt).toLocaleDateString('pt-BR'));
  time.setAttribute('datetime', publishedAt);
  return time;
}

function categoryLinks(root, categories, currentCategory) {
  const document = root.ownerDocument;
  const nav = element(document, 'nav', 'contents-categories');
  nav.id = 'contents-categories';
  nav.setAttribute('aria-label', 'Filtrar por categoria');
  const list = element(document, 'ul', 'contents-category-list');
  const all = element(document, 'a', '', 'Todas');
  all.setAttribute('href', '/contents.html');
  if (!currentCategory) all.setAttribute('aria-current', 'page');
  const allItem = element(document, 'li'); allItem.append(all); list.append(allItem);
  for (const category of categories) {
    const link = element(document, 'a', '', `${category.name} (${category.count})`);
    const query = new URLSearchParams({ category: category.slug });
    link.setAttribute('href', `/contents.html?${query.toString()}`);
    if (currentCategory === category.slug) link.setAttribute('aria-current', 'page');
    const item = element(document, 'li'); item.append(link); list.append(item);
  }
  nav.append(list);
  return nav;
}

export function renderCategories(root, input, currentCategory, context = {}) {
  const categories = validateCategories(input);
  const nav = categoryLinks(root, categories, currentCategory);
  root.replaceChildren(...nav.childNodes);
  root.setAttribute('aria-label', 'Filtrar por categoria');
  void context;
}

function card(document, dto, media) {
  const article = element(document, 'article', 'contents-card');
  const heading = element(document, 'h2', 'contents-card-title');
  const link = element(document, 'a', '', dto.title);
  link.id = `contents-card-${dto.id.toLowerCase()}`;
  link.setAttribute('href', `/contents.html?slug=${dto.slug}`);
  heading.append(link);
  article.append(heading);
  if (dto.cover) {
    const cover = element(document, 'div', 'contents-card-cover contents-media-host');
    cover.setAttribute('role', 'img');
    cover.setAttribute('aria-label', `Imagem de capa: ${dto.cover.alt}`);
    article.append(cover);
    media.push({ kind: 'image', dto, host: cover, assetId: dto.cover.asset_id, alt: dto.cover.alt, eager: false });
  }
  if (dto.summary) article.append(element(document, 'p', 'contents-card-summary contents-multiline', dto.summary));
  if (dto.categories.length) {
    article.append(element(document, 'p', 'contents-card-categories', dto.categories.map(category => category.name).join(', ')));
  }
  const date = dateNode(document, dto.published_at);
  if (date) article.append(date);
  return article;
}

function pagination(document, { total, category, page }) {
  const nav = element(document, 'nav', 'contents-pagination');
  nav.id = 'contents-pagination';
  nav.setAttribute('aria-label', 'Paginação');
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hrefFor = targetPage => {
    const query = new URLSearchParams();
    if (category) query.set('category', category);
    if (targetPage > 1) query.set('page', String(targetPage));
    const serialized = query.toString();
    return `/contents.html${serialized ? `?${serialized}` : ''}`;
  };
  const previousOffset = (page - 2) * PAGE_SIZE;
  if (page > 1 && Number.isSafeInteger(previousOffset) && previousOffset <= MAX_OFFSET) {
    const previous = element(document, 'a', 'contents-page-previous', 'Anterior');
    previous.setAttribute('href', hrefFor(page - 1)); nav.append(previous);
  }
  const current = element(document, 'span', 'contents-page-current', `Página ${page} de ${totalPages}`);
  current.setAttribute('aria-current', 'page'); nav.append(current);
  const nextOffset = page * PAGE_SIZE;
  if (page < totalPages && Number.isSafeInteger(nextOffset) && nextOffset <= MAX_OFFSET) {
    const next = element(document, 'a', 'contents-page-next', 'Próxima');
    next.setAttribute('href', hrefFor(page + 1)); nav.append(next);
  }
  return nav;
}

export function renderCatalog(root, { data, total, category = null, page = 1 }, context = {}) {
  const checked = validateList(data, total, PAGE_SIZE);
  const document = root.ownerDocument;
  const view = element(document, 'div', 'contents-catalog');
  const heading = element(document, 'h1', 'contents-title', 'Conteúdos');
  heading.id = 'contents-title';
  heading.setAttribute('tabindex', '-1');
  view.append(heading, categoryLinks(root, [], category));
  const media = [];
  if (checked.data.length) {
    const list = element(document, 'ul', 'contents-card-list');
    checked.data.forEach(dto => {
      const item = element(document, 'li', 'contents-card-item');
      item.append(card(document, dto, media));
      list.append(item);
    });
    view.append(list);
  }
  view.append(pagination(document, { total: checked.total, category, page }));
  root.replaceChildren(view);
  root.removeAttribute('aria-busy');
  void context;
  return { heading, media, dispose() {} };
}
