const MiB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MARKS = new Set(['bold', 'italic', 'underline', 'code']);
export const PAGE_SIZE = 12;
export const MAX_OFFSET = 1000000;
export const MAX_TOTAL = 100000;
export const MAX_BLOCKS = 100;
export const MAX_NODES = 10000;
export const MAX_CONTENT_BYTES = 5 * MiB;
export const MAX_DETAIL_BYTES = 6 * MiB;
export const MAX_COLLECTION_BYTES = 16 * MiB;
export const LAYOUTS = Object.freeze(['content', 'wide', 'full', 'left', 'right']);

function assertValid(condition) {
  if (!condition) throw Object.assign(new Error('Conteúdo inválido.'), { code: 'invalid_contents' });
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function hasKeys(value, required, optional = []) {
  return isRecord(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
  return true;
}

function isUUID(value) { return typeof value === 'string' && UUID.test(value); }

function safeMarkup(value) {
  return !/<\s*\/?\s*[a-z][\w:-]*(?:\s|\/?>|$)|<\s*!\s*(?:--|doctype)|\bon[a-z0-9_-]+\s*=|javascript\s*:/iu.test(value);
}

function plain(value, max, { min = 0, multiline = false, preserve = false } = {}) {
  if (typeof value !== 'string' || Array.from(value).length > max || !safeMarkup(value)) return false;
  if (Array.from(value).some(character => /\p{Cc}/u.test(character) && !(multiline && ['\r', '\n'].includes(character)))) return false;
  if (!multiline && /[\r\n]/u.test(value)) return false;
  if (!preserve && value !== value.trim()) return false;
  return Array.from(preserve ? value : value.trim()).length >= min;
}

export function isCanonicalSlug(value) {
  return typeof value === 'string' && value.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function safeURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\p{Cc}\s\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isoDate(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function countNode(budget) {
  budget.nodes += 1;
  assertValid(budget.nodes <= MAX_NODES);
}

function validateInline(value, budget, insideLink = false) {
  countNode(budget);
  assertValid(isRecord(value) && Object.hasOwn(value, 'type'));
  if (value.type === 'text') {
    assertValid(hasKeys(value, ['type', 'text', 'marks']) && plain(value.text, 5 * MiB, { preserve: true })
      && isDenseArray(value.marks));
    assertValid(new Set(value.marks).size === value.marks.length && value.marks.every(mark => MARKS.has(mark)));
    return;
  }
  if (value.type === 'break') {
    assertValid(hasKeys(value, ['type']));
    return;
  }
  assertValid(value.type === 'link' && !insideLink
    && hasKeys(value, ['type', 'url', 'new_tab', 'children']) && safeURL(value.url)
    && typeof value.new_tab === 'boolean' && isDenseArray(value.children));
  for (const child of value.children) {
    assertValid(isRecord(child) && child.type !== 'link');
    validateInline(child, budget, true);
  }
}

function validateRichNode(value, budget) {
  countNode(budget);
  assertValid(isRecord(value) && Object.hasOwn(value, 'type'));
  if (value.type === 'paragraph') {
    assertValid(hasKeys(value, ['type', 'children']) && isDenseArray(value.children));
    value.children.forEach(child => validateInline(child, budget));
    return;
  }
  if (value.type === 'heading') {
    assertValid(hasKeys(value, ['type', 'level', 'children']) && Number.isInteger(value.level)
      && value.level >= 2 && value.level <= 6 && isDenseArray(value.children));
    value.children.forEach(child => validateInline(child, budget));
    return;
  }
  assertValid(value.type === 'list' && hasKeys(value, ['type', 'ordered', 'items'])
    && typeof value.ordered === 'boolean' && isDenseArray(value.items));
  for (const item of value.items) {
    countNode(budget);
    assertValid(isDenseArray(item));
    item.forEach(child => validateInline(child, budget));
  }
}

function validateGalleryImage(image) {
  assertValid(hasKeys(image, ['asset_id', 'alt'], ['caption']) && isUUID(image.asset_id)
    && plain(image.alt, 300, { min: 1 }));
  if (Object.hasOwn(image, 'caption')) assertValid(plain(image.caption, 1000, { multiline: true }));
}

function validateBlock(block, budget) {
  countNode(budget);
  assertValid(isRecord(block) && typeof block.type === 'string' && Object.hasOwn(block, 'type'));
  if (Object.hasOwn(block, 'layout')) assertValid(LAYOUTS.includes(block.layout));
  const fields = (...required) => hasKeys(block, ['type', ...required], [
    'layout', ...(block.type === 'image' ? ['caption'] : []), ...(block.type === 'callout' ? ['title'] : []),
  ]);
  switch (block.type) {
    case 'heading':
      assertValid(fields('text', 'level') && plain(block.text, 200, { min: 1 })
        && Number.isInteger(block.level) && [2, 3, 4].includes(block.level));
      return;
    case 'rich_text':
      assertValid(fields('nodes') && isDenseArray(block.nodes));
      block.nodes.forEach(node => validateRichNode(node, budget));
      return;
    case 'image':
      assertValid(fields('asset_id', 'alt') && isUUID(block.asset_id) && plain(block.alt, 300, { min: 1 }));
      if (Object.hasOwn(block, 'caption')) assertValid(plain(block.caption, 1000, { multiline: true }));
      return;
    case 'gallery':
      assertValid(fields('images') && isDenseArray(block.images) && block.images.length >= 2 && block.images.length <= 20);
      block.images.forEach(validateGalleryImage);
      return;
    case 'video':
    case 'pdf':
      assertValid(fields('asset_id', 'title') && isUUID(block.asset_id) && plain(block.title, 200, { min: 1 }));
      return;
    case 'embed': {
      assertValid(fields('provider', 'url', 'title') && ['youtube', 'vimeo'].includes(block.provider)
        && plain(block.title, 200, { min: 1 }));
      const pattern = block.provider === 'youtube'
        ? /^https:\/\/www\.youtube\.com\/embed\/[A-Za-z0-9_-]{11}$/u
        : /^https:\/\/player\.vimeo\.com\/video\/[1-9][0-9]*$/u;
      assertValid(typeof block.url === 'string' && pattern.test(block.url));
      return;
    }
    case 'callout':
      assertValid(fields('tone', 'text') && ['info', 'warning', 'success'].includes(block.tone)
        && plain(block.text, 2000, { min: 1, multiline: true }));
      if (Object.hasOwn(block, 'title')) assertValid(plain(block.title, 200));
      return;
    case 'link':
      assertValid(fields('label', 'url', 'new_tab', 'style') && plain(block.label, 200, { min: 1 })
        && safeURL(block.url) && typeof block.new_tab === 'boolean' && ['primary', 'secondary'].includes(block.style));
      return;
    case 'divider':
      assertValid(fields());
      return;
    default:
      assertValid(false);
  }
}

function serializedBytes(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

export function validatePortalPageDTO(value) {
  assertValid(hasKeys(value, ['id', 'slug', 'title', 'summary', 'cover', 'categories', 'published_at',
    'content_version', 'asset_scope', 'content_blocks', 'revision']));
  assertValid(isUUID(value.id) && isCanonicalSlug(value.slug) && plain(value.title, 200, { min: 1 })
    && plain(value.summary, 1000, { multiline: true }) && isoDate(value.published_at));
  assertValid(value.content_version === 1 && value.asset_scope === 'portal-pages');
  assertValid(hasKeys(value.revision, ['id', 'status']) && isUUID(value.revision.id)
    && value.revision.status === 'published');
  if (value.cover !== null) {
    assertValid(hasKeys(value.cover, ['asset_id', 'alt']) && isUUID(value.cover.asset_id)
      && plain(value.cover.alt, 300, { min: 1 }));
  }
  assertValid(isDenseArray(value.categories) && value.categories.length <= 20);
  for (const category of value.categories) {
    assertValid(hasKeys(category, ['id', 'slug', 'name']) && isUUID(category.id)
      && isCanonicalSlug(category.slug) && plain(category.name, 100, { min: 1 }));
  }
  assertValid(isDenseArray(value.content_blocks) && value.content_blocks.length <= MAX_BLOCKS);
  const budget = { nodes: 0 };
  value.content_blocks.forEach(block => validateBlock(block, budget));
  assertValid(serializedBytes(value.content_blocks) <= MAX_CONTENT_BYTES);
  return value;
}

export function validateDetail(value, slug) {
  const dto = validatePortalPageDTO(value);
  assertValid(dto.slug === slug && serializedBytes(dto) <= MAX_DETAIL_BYTES);
  return dto;
}

export function validateList(data, total, limit) {
  assertValid(isDenseArray(data) && Number.isSafeInteger(limit) && limit >= 0 && limit <= 50 && data.length <= limit);
  assertValid(Number.isSafeInteger(total) && total >= data.length && total <= MAX_TOTAL);
  data.forEach(validatePortalPageDTO);
  assertValid(new Set(data.map(row => row.id)).size === data.length);
  assertValid(serializedBytes({ rows: data, count: total }) <= MAX_COLLECTION_BYTES);
  return { data, total };
}

export function validateCategories(value) {
  assertValid(isDenseArray(value) && value.length <= 10000);
  for (const category of value) {
    assertValid(hasKeys(category, ['id', 'slug', 'name', 'count']) && isUUID(category.id)
      && isCanonicalSlug(category.slug) && plain(category.name, 100, { min: 1 })
      && Number.isSafeInteger(category.count) && category.count > 0);
  }
  assertValid(new Set(value.map(category => category.id)).size === value.length
    && new Set(value.map(category => category.slug)).size === value.length);
  assertValid(serializedBytes(value) <= MAX_COLLECTION_BYTES);
  return value;
}
