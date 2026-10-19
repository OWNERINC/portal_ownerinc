const MiB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LAYOUTS = new Set(['content', 'wide', 'full', 'left', 'right']);
const MARKS = new Set(['bold', 'italic', 'underline', 'code']);
const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/webm': 'webm',
});

function unavailable(status = 503, code = 'portal_pages_unavailable') {
  return Object.assign(new Error(code), { status, code });
}
function assert(value) { if (!value) throw unavailable(); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasKeys(value, required, optional = []) {
  return record(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
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
function canonicalSlug(value) { return typeof value === 'string' && value.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value); }
function safeURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\p{Cc}\s\\]/u.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}
function isoDate(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function validateInline(value, budget, inLink = false) {
  budget.nodes++;
  assert(budget.nodes <= 10_000 && record(value));
  if (value.type === 'text') {
    assert(hasKeys(value, ['type', 'text', 'marks']) && plain(value.text, 5 * MiB, { preserve: true }) && Array.isArray(value.marks));
    assert(new Set(value.marks).size === value.marks.length && value.marks.every(mark => MARKS.has(mark)));
    return;
  }
  if (value.type === 'break') { assert(hasKeys(value, ['type'])); return; }
  assert(value.type === 'link' && !inLink && hasKeys(value, ['type', 'url', 'new_tab', 'children']) && safeURL(value.url)
    && typeof value.new_tab === 'boolean' && Array.isArray(value.children));
  for (const child of value.children) {
    assert(record(child) && child.type !== 'link');
    validateInline(child, budget, true);
  }
}

function validateRichNode(value, budget) {
  budget.nodes++;
  assert(budget.nodes <= 10_000 && record(value));
  if (value.type === 'paragraph') {
    assert(hasKeys(value, ['type', 'children']) && Array.isArray(value.children));
    value.children.forEach(child => validateInline(child, budget));
    return;
  }
  if (value.type === 'heading') {
    assert(hasKeys(value, ['type', 'level', 'children']) && Number.isInteger(value.level) && value.level >= 2 && value.level <= 6
      && Array.isArray(value.children));
    value.children.forEach(child => validateInline(child, budget));
    return;
  }
  assert(value.type === 'list' && hasKeys(value, ['type', 'ordered', 'items']) && typeof value.ordered === 'boolean' && Array.isArray(value.items));
  for (const item of value.items) {
    budget.nodes++;
    assert(budget.nodes <= 10_000 && Array.isArray(item));
    item.forEach(child => validateInline(child, budget));
  }
}

function validateBlock(block, budget) {
  budget.nodes++;
  assert(budget.nodes <= 10_000 && record(block) && typeof block.type === 'string');
  if (Object.hasOwn(block, 'layout')) assert(LAYOUTS.has(block.layout));
  const fields = (...required) => hasKeys(block, ['type', ...required], [
    'layout', ...(block.type === 'image' ? ['caption'] : []), ...(block.type === 'callout' ? ['title'] : []),
  ]);
  switch (block.type) {
    case 'heading':
      assert(fields('text', 'level') && plain(block.text, 200, { min: 1 }) && Number.isInteger(block.level) && [2, 3, 4].includes(block.level));
      return;
    case 'rich_text':
      assert(fields('nodes') && Array.isArray(block.nodes));
      block.nodes.forEach(node => validateRichNode(node, budget));
      return;
    case 'image':
      assert(fields('asset_id', 'alt') && uuid(block.asset_id) && plain(block.alt, 300, { min: 1 }));
      if (Object.hasOwn(block, 'caption')) assert(plain(block.caption, 1000, { multiline: true }));
      return;
    case 'gallery':
      assert(fields('images') && Array.isArray(block.images) && block.images.length >= 2 && block.images.length <= 20);
      for (const image of block.images) {
        assert(hasKeys(image, ['asset_id', 'alt'], ['caption']) && uuid(image.asset_id) && plain(image.alt, 300, { min: 1 }));
        if (Object.hasOwn(image, 'caption')) assert(plain(image.caption, 1000, { multiline: true }));
      }
      return;
    case 'video':
    case 'pdf':
      assert(fields('asset_id', 'title') && uuid(block.asset_id) && plain(block.title, 200, { min: 1 }));
      return;
    case 'embed': {
      assert(fields('provider', 'url', 'title') && ['youtube', 'vimeo'].includes(block.provider) && plain(block.title, 200, { min: 1 }));
      const pattern = block.provider === 'youtube'
        ? /^https:\/\/www\.youtube\.com\/embed\/[A-Za-z0-9_-]{11}$/u
        : /^https:\/\/player\.vimeo\.com\/video\/[1-9][0-9]*$/u;
      assert(typeof block.url === 'string' && pattern.test(block.url));
      return;
    }
    case 'callout':
      assert(fields('tone', 'text') && ['info', 'warning', 'success'].includes(block.tone) && plain(block.text, 2000, { min: 1, multiline: true }));
      if (Object.hasOwn(block, 'title')) assert(plain(block.title, 200));
      return;
    case 'link':
      assert(fields('label', 'url', 'new_tab', 'style') && plain(block.label, 200, { min: 1 }) && safeURL(block.url)
        && typeof block.new_tab === 'boolean' && ['primary', 'secondary'].includes(block.style));
      return;
    case 'divider': assert(fields()); return;
    default: throw unavailable();
  }
}

function validatePortalPageDTO(value, expectedScope) {
  assert(hasKeys(value, ['id', 'slug', 'title', 'summary', 'cover', 'categories', 'published_at', 'content_version',
    'asset_scope', 'content_blocks', 'revision']));
  assert(uuid(value.id) && canonicalSlug(value.slug) && plain(value.title, 200, { min: 1 })
    && plain(value.summary, 1000, { multiline: true }) && isoDate(value.published_at));
  assert(value.content_version === 1 && value.asset_scope === expectedScope);
  assert(hasKeys(value.revision, ['id', 'status']) && uuid(value.revision.id));
  if (expectedScope === 'portal-pages') assert(value.revision.status === 'published');
  else assert(['draft', 'published'].includes(value.revision.status));
  if (value.cover !== null) assert(hasKeys(value.cover, ['asset_id', 'alt']) && uuid(value.cover.asset_id) && plain(value.cover.alt, 300, { min: 1 }));
  assert(Array.isArray(value.categories) && value.categories.length <= 20);
  for (const category of value.categories) {
    assert(hasKeys(category, ['id', 'slug', 'name']) && uuid(category.id) && canonicalSlug(category.slug) && plain(category.name, 100, { min: 1 }));
  }
  assert(Array.isArray(value.content_blocks) && value.content_blocks.length <= 100);
  const budget = { nodes: 0 };
  value.content_blocks.forEach(block => validateBlock(block, budget));
  assert(Buffer.byteLength(JSON.stringify(value.content_blocks), 'utf8') <= 5 * MiB);
  return value;
}

function readPortalPageList(value, input) {
  assert(hasKeys(value, ['rows', 'count']) && Array.isArray(value.rows) && value.rows.length <= input.limit
    && Number.isSafeInteger(value.count) && value.count >= value.rows.length && value.count <= 100_000);
  value.rows.forEach(row => validatePortalPageDTO(row, 'portal-pages'));
  assert(new Set(value.rows.map(row => row.id)).size === value.rows.length);
  assert(Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16 * MiB);
  return value;
}

function readPortalPageCategories(value) {
  assert(Array.isArray(value) && value.length <= 10_000);
  for (const category of value) assert(hasKeys(category, ['id', 'slug', 'name', 'count']) && uuid(category.id)
    && canonicalSlug(category.slug) && plain(category.name, 100, { min: 1 }) && Number.isSafeInteger(category.count) && category.count > 0);
  assert(new Set(value.map(category => category.id)).size === value.length && new Set(value.map(category => category.slug)).size === value.length);
  assert(Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16 * MiB);
  return value;
}

function readPortalPageResult(action, value, input) {
  if (action === 'list') return readPortalPageList(value, input);
  if (action === 'categories') return readPortalPageCategories(value);
  if (value === null) return null;
  const scope = action === 'preview' ? 'portal-pages-preview' : 'portal-pages';
  const page = validatePortalPageDTO(value, scope);
  if (action === 'detail') assert(page.slug === input.slug);
  if (action === 'preview') assert(page.id === input.pageId && page.revision.id === input.versionId);
  assert(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 6 * MiB);
  return page;
}

module.exports = {
  MIME_EXTENSIONS, readPortalPageCategories, readPortalPageList, readPortalPageResult,
  validatePortalPageDTO, unavailable,
};
