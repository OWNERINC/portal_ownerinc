import { validateBlocks } from '../cms-block-renderer.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed, required = allowed) => record(value)
  && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const assert = value => { if (!value) throw new Error('invalid_rich_text'); };
const count = budget => assert(++budget.nodes <= 10000);
const bounded = value => assert(new TextEncoder().encode(JSON.stringify(value)).byteLength <= 5 * 1024 * 1024);

// The v2 wire dialect, not Lexical JSON. Validate everything before creating DOM.
export function validateRichNodes(value, budget = { nodes: 0 }) {
  assert(Array.isArray(value));
  function inline(node, depth = 1, inLink = false) {
    assert(depth <= 4); count(budget); assert(record(node));
    if (node.type === 'text') {
      assert(keys(node, ['type', 'text', 'marks']) && typeof node.text === 'string'
        && Array.isArray(node.marks) && new Set(node.marks).size === node.marks.length
        && node.marks.every(mark => ['bold', 'italic', 'underline', 'code'].includes(mark)));
      return { type: 'text', text: node.text, marks: [...node.marks] };
    }
    if (node.type === 'break') { assert(keys(node, ['type'])); return { type: 'break' }; }
    assert(node.type === 'link' && !inLink && keys(node, ['type', 'url', 'new_tab', 'children'])
      && typeof node.url === 'string' && node.url.length <= 2048
      && typeof node.new_tab === 'boolean' && Array.isArray(node.children));
    let url; try { url = new URL(node.url); } catch { throw new Error('invalid_rich_text'); }
    assert(url.protocol === 'https:' && url.hostname && !url.username && !url.password);
    return { type: 'link', url: url.href, new_tab: node.new_tab, children: node.children.map(child => inline(child, depth + 1, true)) };
  }
  const nodes = value.map(node => {
    count(budget); assert(record(node));
    if (node.type === 'list') {
      assert(keys(node, ['type', 'ordered', 'items']) && typeof node.ordered === 'boolean' && Array.isArray(node.items));
      return { type: 'list', ordered: node.ordered, items: node.items.map(items => {
        count(budget); assert(Array.isArray(items)); return items.map(item => inline(item));
      }) };
    }
    assert(['paragraph', 'heading'].includes(node.type)
      && keys(node, node.type === 'heading' ? ['type', 'level', 'children'] : ['type', 'children']) && Array.isArray(node.children));
    if (node.type === 'heading') assert(Number.isInteger(node.level) && node.level >= 2 && node.level <= 6);
    return { type: node.type, ...(node.type === 'heading' ? { level: node.level } : {}), children: node.children.map(item => inline(item)) };
  });
  bounded(nodes);
  return nodes;
}

export function validateNewsBlocks(value, version = 1) {
  if (version === 1) return validateBlocks(value);
  if (version !== 2 || !Array.isArray(value) || value.length > 100) return null;
  try {
    const budget = { nodes: 0 };
    const blocks = value.map(block => {
      count(budget); assert(record(block));
      if (block.type !== 'rich_text') {
        // v2 rejects ambiguous video sources; legacy normalization stays unchanged.
        assert(!(block.type === 'video' && 'url' in block && 'asset_id' in block));
        const normalized = validateBlocks([block]); assert(normalized); return normalized[0];
      }
      assert(keys(block, ['type', 'nodes', 'layout', 'typography'], ['type', 'nodes']));
      if ('layout' in block) assert(['content', 'wide', 'full', 'left', 'right'].includes(block.layout));
      if ('typography' in block) assert(['serif', 'sans'].includes(block.typography));
      return { ...block, nodes: validateRichNodes(block.nodes, budget) };
    });
    assert(blocks.filter(b => b.type === 'image' && b.usage === 'cover').length <= 1
      && blocks.filter(b => b.type === 'pdf' && b.usage === 'edition').length <= 1);
    bounded(blocks); return blocks;
  } catch { return null; }
}

const inlineText = nodes => nodes.map(node => node.type === 'text' ? node.text : node.type === 'break' ? '\n' : inlineText(node.children)).join('');
export function newsBlocksToText(blocks) {
  const normalized = validateNewsBlocks(blocks, 2);
  if (!normalized) return '';
  return normalized.flatMap(block => {
    if (block.type === 'rich_text') return block.nodes.map(node => node.type === 'list' ? node.items.map(inlineText).join(' ') : inlineText(node.children));
    if (['heading', 'paragraph', 'quote', 'profile', 'callout'].includes(block.type)) return block.text || '';
    if (block.type === 'list') return block.items;
    return [];
  }).join(' ').trim();
}
