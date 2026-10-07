const { uuid } = require('../route-utils');
const { validateBlocks } = require('../cms/blocks');
const { normalizeEditorial } = require('./editorial');
const { normalizeHome } = require('./home');
const MiB = 1024 * 1024;
const unavailable = () => Object.assign(new Error('news_unavailable'), { status: 503, code: 'news_unavailable' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names, required = names) => record(value) && Object.keys(value).every(key => names.includes(key)) && required.every(key => Object.hasOwn(value, key));
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max, empty = true) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
const date = value => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
const plain = value => !/[\r\n]|<\/?[a-z][^>]*>|<\s*(script|style|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:/iu.test(value);
const kind = value => ['article', 'edition'].includes(value);
function assert(value) { if (!value) throw unavailable(); }
function validActor(value) {
  return keys(value, ['uid', 'email', 'name', 'canManageNews']) && typeof value.uid === 'string' && value.uid.length > 0 && value.uid.length <= 128
    && typeof value.email === 'string' && value.email.length > 0 && value.email.length <= 320 && (value.name === null || typeof value.name === 'string') && typeof value.canManageNews === 'boolean';
}
function validInput(action, value) {
  const optional = (name, validate) => !Object.hasOwn(value, name) || validate(value[name]);
  if (!record(value)) return false;
  switch (action) {
    case 'list': return keys(value, ['limit', 'offset', 'category', 'kind'], ['limit', 'offset']) && integer(value.limit, 1, 100) && integer(value.offset, 0, 1000000) && optional('category', v => text(v, 100)) && optional('kind', kind);
    case 'detail': return keys(value, ['id']) && uuid(value.id);
    case 'categories': return keys(value, ['kind', 'withCounts'], ['withCounts']) && typeof value.withCounts === 'boolean' && optional('kind', kind);
    case 'navigation': return keys(value, ['id', 'category'], ['id']) && uuid(value.id) && optional('category', v => text(v, 100));
    case 'home': return keys(value, []);
    case 'preview': return keys(value, ['id', 'versionId', 'source']) && uuid(value.id) && uuid(value.versionId) && ['payload', 'legacy'].includes(value.source);
    case 'asset': return keys(value, ['id', 'preview', 'range']) && uuid(value.id) && typeof value.preview === 'boolean' && (value.range === null || text(value.range, 200));
    default: return false;
  }
}
function https(value) {
  assert(text(value, 2048, false));
  let url; try { url = new URL(value); } catch { throw unavailable(); }
  assert(url.protocol === 'https:' && url.hostname && !url.username && !url.password);
}
function readRich(block, budget) {
  assert(keys(block, ['type', 'nodes', 'layout', 'typography'], ['type', 'nodes']) && Array.isArray(block.nodes));
  if ('layout' in block) assert(['content', 'wide', 'full', 'left', 'right'].includes(block.layout));
  if ('typography' in block) assert(['serif', 'sans'].includes(block.typography));
  const count = () => assert(++budget.nodes <= 10000);
  function inline(n, inLink = false) {
    count(); assert(record(n));
    if (n.type === 'text') assert(keys(n, ['type', 'text', 'marks']) && typeof n.text === 'string' && Array.isArray(n.marks) && new Set(n.marks).size === n.marks.length && n.marks.every(m => ['bold', 'italic', 'underline', 'code'].includes(m)));
    else if (n.type === 'break') assert(keys(n, ['type']));
    else {
      assert(n.type === 'link' && !inLink && keys(n, ['type', 'url', 'new_tab', 'children']) && typeof n.new_tab === 'boolean' && Array.isArray(n.children));
      https(n.url); n.children.forEach(child => inline(child, true));
    }
  }
  for (const n of block.nodes) {
    count(); assert(record(n));
    if (n.type === 'list') {
      assert(keys(n, ['type', 'ordered', 'items']) && typeof n.ordered === 'boolean' && Array.isArray(n.items));
      for (const items of n.items) { count(); assert(Array.isArray(items)); items.forEach(item => inline(item)); }
    } else {
      assert(['paragraph', 'heading'].includes(n.type) && keys(n, n.type === 'heading' ? ['type', 'level', 'children'] : ['type', 'children']) && Array.isArray(n.children));
      if (n.type === 'heading') assert(integer(n.level, 2, 6));
      n.children.forEach(item => inline(item));
    }
  }
  return block;
}
function readNewsDTO(json) {
  const required = ['id', 'title', 'category', 'published_at', 'editorial', 'content_version', 'asset_scope', 'content_blocks', 'read_time_minutes'];
  assert(keys(json, [...required, 'preview_revision'], required));
  if (Object.hasOwn(json, 'preview_revision')) {
    const revision = json.preview_revision;
    assert(json.asset_scope === 'owner-news-preview' && keys(revision, ['id', 'source', 'status']) && uuid(revision.id)
      && ['payload', 'legacy'].includes(revision.source) && ['draft', 'published', 'scheduled', 'archived'].includes(revision.status)
      && (revision.source !== 'payload' || ['draft', 'published'].includes(revision.status)));
  }
  assert(uuid(json.id) && text(json.title, 200) && text(json.category, 100) && date(json.published_at));
  assert(plain(json.title) && plain(json.category));
  assert(json.content_version === 2 && ['owner-news', 'owner-news-preview'].includes(json.asset_scope));
  assert(json.editorial === null || normalizeEditorial(json.editorial));
  assert(json.read_time_minutes === null || integer(json.read_time_minutes, 1));
  assert(Array.isArray(json.content_blocks) && json.content_blocks.length <= 100);
  const budget = { nodes: 0 };
  for (const block of json.content_blocks) {
    assert(++budget.nodes <= 10000 && record(block));
    if (block.type === 'rich_text') readRich(block, budget);
    else {
      assert(!(block.type === 'video' && 'url' in block && 'asset_id' in block));
      assert(validateBlocks([block]));
    }
  }
  assert(Buffer.byteLength(JSON.stringify({ blocks: json.content_blocks, editorial: json.editorial })) <= 5 * MiB);
  assert(json.content_blocks.filter(b => b.type === 'image' && b.usage === 'cover').length <= 1 && json.content_blocks.filter(b => b.type === 'pdf' && b.usage === 'edition').length <= 1);
  return json;
}
function readNewsPage(json) {
  assert(keys(json, ['rows', 'count']) && Array.isArray(json.rows) && json.rows.length <= 100 && integer(json.count, json.rows.length));
  json.rows.forEach(readNewsDTO); return json;
}
function readResult(action, json, input) {
  if (action === 'list') { readNewsPage(json); assert(json.rows.length <= input.limit && json.rows.every(row => row.asset_scope === 'owner-news')); }
  else if (action === 'detail' || action === 'preview') {
    readNewsDTO(json); assert(json.id === input.id && json.asset_scope === (action === 'preview' ? 'owner-news-preview' : 'owner-news'));
    if (json.preview_revision) assert(json.preview_revision.id === input.versionId && json.preview_revision.source === input.source);
  }
  else if (action === 'navigation') {
    assert(keys(json, ['previous', 'next']));
    for (const v of Object.values(json)) assert(v === null || (keys(v, ['id', 'title']) && uuid(v.id) && text(v.title, 200)));
  } else if (action === 'home') {
    assert(keys(json, ['content'])); const v = json.content;
    assert(v === null || (keys(v, ['version', 'eyebrow', 'headline', 'summary']) && normalizeHome(v)));
  } else if (action === 'categories') {
    const values = input.withCounts ? json.categories : json;
    if (input.withCounts) assert(keys(json, ['total', 'categories']) && integer(json.total, 0));
    assert(Array.isArray(values) && values.length <= 10000);
    const names = values.map(v => {
      if (input.withCounts) assert(keys(v, ['name', 'count']) && integer(v.count, 1, json.total));
      const name = input.withCounts ? v.name : v; assert(text(name, 100, false)); return name;
    });
    assert(new Set(names).size === names.length);
  } else throw unavailable();
  return json;
}
module.exports = { readNewsDTO, readNewsPage, readResult, validInput, validActor, unavailable };
