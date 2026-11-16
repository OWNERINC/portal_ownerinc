// Private, state-free PM grammar shared by legacy and v3 validators. Callers own
// their budgets, allowed marks, error type and meaningful-content accounting.
function createRichTextValidator({ fail, object, keys, text, marks, onText, countNode }) {
  return function pm(node, parent, listDepth = 0, depth = 0) {
    countNode();
    if (depth > 12) fail();
    keys(node, ['type'], ['content', 'attrs', 'text', 'marks']);
    const inline = parent === 'paragraph' || parent === 'heading';
    if (node.type === 'text') {
      if (!inline || Object.hasOwn(node, 'content') || Object.hasOwn(node, 'attrs')) fail();
      text(node.text, 100000); if (!node.text.length) fail();
      onText(node.text);
      marks(node.marks);
      return;
    }
    if (node.type === 'hard_break') {
      if (!inline || node.text !== undefined || node.content !== undefined || node.attrs !== undefined) fail(); marks(node.marks); return;
    }
    if (node.text !== undefined || node.marks !== undefined) fail();
    const content = node.content === undefined ? [] : node.content;
    if (!Array.isArray(content)) fail();
    if (node.type === 'doc') { if (parent || !content.length) fail(); }
    else if (node.type === 'paragraph' || node.type === 'heading') {
      if (!['doc', 'list_item'].includes(parent)) fail();
      if (node.type === 'heading') { keys(node.attrs, ['level']); if (![2, 3].includes(node.attrs.level)) fail(); }
    } else if (['bullet_list', 'ordered_list'].includes(node.type)) {
      if (!['doc', 'list_item'].includes(parent) || ++listDepth > 2 || !content.length) fail();
      if (node.type === 'ordered_list' && node.attrs !== undefined) {
        keys(node.attrs, ['order']); if (!Number.isInteger(node.attrs.order) || node.attrs.order < 1 || node.attrs.order > 100000) fail();
      }
    } else if (node.type === 'list_item') {
      if (!['bullet_list', 'ordered_list'].includes(parent) || content[0]?.type !== 'paragraph') fail();
    } else fail();
    if (!['heading', 'ordered_list'].includes(node.type) && node.attrs !== undefined) fail();
    if (content.some(n => !object(n))) fail();
    if (['bullet_list', 'ordered_list'].includes(node.type) && content.some(n => n.type !== 'list_item')) fail();
    if (['doc', 'list_item'].includes(node.type) && content.some(n => !['paragraph', 'heading', 'bullet_list', 'ordered_list'].includes(n.type))) fail();
    if (['paragraph', 'heading'].includes(node.type) && content.some(n => !['text', 'hard_break'].includes(n.type))) fail();
    content.forEach(n => pm(n, node.type, listDepth, depth + 1));
  };
}

module.exports = { createRichTextValidator };
