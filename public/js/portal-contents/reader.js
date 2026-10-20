import { validatePortalPageDTO } from './dto.js';
import { renderRichText } from './rich-text.js';

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendPublication(document, parent, publishedAt) {
  if (publishedAt === null) return;
  const time = element(document, 'time', 'contents-published-date', new Date(publishedAt).toLocaleDateString('pt-BR'));
  time.setAttribute('datetime', publishedAt);
  parent.append(time);
}

function addCaption(document, figure, caption) {
  if (caption === undefined) return;
  figure.append(element(document, 'figcaption', 'contents-caption', caption));
}

function mediaBlock(document, block, dto, blockIndex, media) {
  if (block.type === 'image') {
    const figure = element(document, 'figure', 'contents-media contents-media-image');
    const host = element(document, 'div', 'contents-media-host contents-image-host');
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', `Imagem: ${block.alt}`);
    figure.append(host);
    addCaption(document, figure, block.caption);
    media.push({ kind: 'image', dto, host, assetId: block.asset_id, alt: block.alt,
      ...(Object.hasOwn(block, 'caption') ? { caption: block.caption } : {}), eager: true });
    return figure;
  }
  if (block.type === 'gallery') {
    const figure = element(document, 'figure', 'contents-media contents-media-gallery');
    const host = element(document, 'div', 'contents-media-host contents-gallery-host');
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', `Galeria com ${block.images.length} imagens`);
    const list = element(document, 'div', 'contents-gallery-placeholders');
    block.images.forEach(image => {
      const tile = element(document, 'figure', 'contents-gallery-placeholder');
      const imageHost = element(document, 'div', 'contents-media-host contents-image-host');
      imageHost.setAttribute('role', 'img');
      imageHost.setAttribute('aria-label', `Imagem: ${image.alt}`);
      tile.append(imageHost);
      addCaption(document, tile, image.caption);
      list.append(tile);
    });
    host.append(list);
    figure.append(host);
    media.push({ kind: 'gallery', dto, host, images: block.images, blockIndex });
    return figure;
  }
  if (block.type === 'video' || block.type === 'pdf') {
    const type = block.type === 'video' ? 'Vídeo' : 'Documento PDF';
    const figure = element(document, 'figure', `contents-media contents-media-${block.type}`);
    const host = element(document, 'div', `contents-media-host contents-${block.type}-host`);
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', `${type}: ${block.title}`);
    host.textContent = `${type}: ${block.title}`;
    figure.append(host, element(document, 'figcaption', 'contents-caption', block.title));
    media.push({ kind: block.type, dto, host, assetId: block.asset_id, title: block.title });
    return figure;
  }
  const figure = element(document, 'figure', 'contents-media contents-media-embed');
  const host = element(document, 'div', 'contents-media-host contents-embed-host');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', `Vídeo incorporado: ${block.title}`);
  host.textContent = `Vídeo incorporado: ${block.title}`;
  figure.append(host, element(document, 'figcaption', 'contents-caption', block.title));
  media.push({ kind: 'embed', dto, host, provider: block.provider, url: block.url, title: block.title });
  return figure;
}

function renderBlock(document, block, dto, blockIndex, media) {
  const layout = block.layout || 'content';
  const section = element(document, 'section', `contents-block contents-layout-${layout}`);
  if (block.type === 'heading') {
    section.append(element(document, `h${block.level}`, '', block.text));
  } else if (block.type === 'rich_text') {
    section.append(renderRichText(document, block.nodes));
  } else if (['image', 'gallery', 'video', 'pdf', 'embed'].includes(block.type)) {
    section.append(mediaBlock(document, block, dto, blockIndex, media));
  } else if (block.type === 'callout') {
    const labels = { info: 'Informação', warning: 'Atenção', success: 'Sucesso' };
    const aside = element(document, 'aside', `contents-callout contents-callout-${block.tone}`);
    const label = element(document, 'p', 'contents-callout-label', labels[block.tone]);
    aside.append(label);
    if (block.title) aside.append(element(document, 'h2', '', block.title));
    aside.append(element(document, 'p', 'contents-callout-text', block.text));
    section.append(aside);
  } else if (block.type === 'link') {
    const link = element(document, 'a', `contents-block-link contents-link-${block.style}`, block.label);
    link.setAttribute('href', block.url);
    if (block.new_tab) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      const cue = element(document, 'span', 'contents-new-tab-cue', 'Abre em nova aba');
      link.append(cue);
    }
    section.append(link);
  } else {
    section.append(document.createElement('hr'));
  }
  return section;
}

export function renderReader(root, input, { returnHref = '/contents.html' } = {}, context = {}) {
  const dto = validatePortalPageDTO(input);
  const document = root.ownerDocument;
  const view = element(document, 'div', 'contents-reader');
  const heading = element(document, 'h1', 'contents-title', dto.title);
  heading.id = 'contents-title';
  heading.setAttribute('tabindex', '-1');
  const top = element(document, 'header', 'contents-reader-header');
  const back = element(document, 'a', 'contents-back-link', 'Voltar ao catálogo');
  back.setAttribute('href', returnHref);
  top.append(back, heading);
  if (dto.summary) top.append(element(document, 'p', 'contents-summary', dto.summary));
  if (dto.categories.length) {
    const categories = element(document, 'p', 'contents-reader-categories');
    categories.setAttribute('aria-label', 'Categorias');
    categories.textContent = dto.categories.map(category => category.name).join(', ');
    top.append(categories);
  }
  appendPublication(document, top, dto.published_at);
  const article = element(document, 'article', 'contents-article');
  article.setAttribute('aria-labelledby', heading.id);
  const media = [];
  if (dto.cover) {
    const cover = element(document, 'figure', 'contents-media contents-cover');
    const host = element(document, 'div', 'contents-media-host contents-image-host');
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', `Imagem de capa: ${dto.cover.alt}`);
    cover.append(host);
    media.push({ kind: 'image', dto, host, assetId: dto.cover.asset_id, alt: dto.cover.alt, eager: true });
    top.append(cover);
  }
  dto.content_blocks.forEach((block, index) => article.append(renderBlock(document, block, dto, index, media)));
  view.append(top, article);
  root.replaceChildren(view);
  root.removeAttribute('aria-busy');
  void context;
  return { heading, media, dispose() {} };
}
