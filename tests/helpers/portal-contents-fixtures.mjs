// Canonical public-wire fixtures. CMS authoring cases below intentionally retain
// a few noncanonical values so normalization-vs-reader strictness stays visible.
export const PAGE_ID = '018f47a2-7b3c-7a11-8a2c-1234567890ab';
export const REVISION_ID = '018f47a2-7b3c-7a11-8a2c-1234567890ac';
export const ASSET_ID = '018f47a2-7b3c-7a11-8a2c-1234567890ad';

export function blockFixtures() {
  return [
    { type: 'heading', text: 'Política', level: 2 },
    { type: 'rich_text', nodes: [{ type: 'paragraph', children: [
      { type: 'text', text: 'Leia com atenção', marks: ['bold', 'italic'] },
      { type: 'break' },
      { type: 'link', url: 'https://example.test/policy', new_tab: true,
        children: [{ type: 'text', text: 'Documento', marks: [] }] },
    ] }] },
    { type: 'image', asset_id: ASSET_ID, alt: 'Diagrama do processo', caption: 'Fluxo\ncompleto' },
    { type: 'gallery', images: [
      { asset_id: ASSET_ID, alt: 'Primeira imagem' },
      { asset_id: ASSET_ID, alt: 'Segunda imagem', caption: 'Outra descrição' },
    ] },
    { type: 'video', asset_id: ASSET_ID, title: 'Apresentação' },
    { type: 'pdf', asset_id: ASSET_ID, title: 'Manual' },
    { type: 'embed', provider: 'youtube', url: 'https://www.youtube.com/embed/Abc123_-xyz', title: 'Orientação' },
    { type: 'callout', tone: 'info', text: 'Leia\nantes de começar', title: 'Importante' },
    { type: 'link', label: 'Referência', url: 'https://example.test/policy', new_tab: true, style: 'primary' },
    { type: 'divider' },
  ];
}

export function pageFixture(overrides = {}) {
  return {
    id: PAGE_ID, slug: 'published-policy', title: 'Política publicada', summary: 'Resumo', cover: null,
    categories: [], published_at: '2026-10-20T12:00:00.000Z', content_version: 1,
    asset_scope: 'portal-pages', content_blocks: blockFixtures(),
    revision: { id: REVISION_ID, status: 'published' }, ...overrides,
  };
}

export function richBlockFixtures() {
  const blocks = [];
  for (let level = 2; level <= 6; level++) {
    blocks.push({ type: 'rich_text', nodes: [{ type: 'heading', level, children: [{ type: 'text', text: `Heading ${level}`, marks: [] }] }] });
  }
  blocks.push(
    { type: 'rich_text', nodes: [{ type: 'list', ordered: true, items: [
      [{ type: 'text', text: 'one', marks: [] }], [],
    ] }] },
    { type: 'rich_text', nodes: [{ type: 'list', ordered: false, items: [] }] },
    { type: 'rich_text', nodes: [{ type: 'paragraph', children: [] }, { type: 'paragraph', children: [
      { type: 'text', text: '', marks: [] },
    ] }] },
    { type: 'embed', provider: 'vimeo', url: 'https://player.vimeo.com/video/123', title: 'Vídeo' },
    { type: 'callout', tone: 'warning', text: 'Atenção' },
    { type: 'callout', tone: 'success', text: 'Concluído' },
    { type: 'link', label: 'Secundário', url: 'https://example.test/other', new_tab: false, style: 'secondary' },
  );
  return blocks;
}

export function clone(value) { return structuredClone(value); }

export function layoutCases() {
  const layouts = [undefined, 'content', 'wide', 'full', 'left', 'right'];
  const cases = [];
  for (const layout of layouts) {
    for (const block of blockFixtures()) {
      cases.push(pageFixture({ content_blocks: [layout === undefined ? block : { ...block, layout }] }));
    }
  }
  return cases;
}

export function categoryFixtures(count = 20) {
  return Array.from({ length: count }, (_, index) => ({
    id: `018f47a2-7b3c-7a11-8a2c-${String(index + 1).padStart(12, '0')}`,
    slug: `category-${index + 1}`, name: `Category ${index + 1}`,
  }));
}
