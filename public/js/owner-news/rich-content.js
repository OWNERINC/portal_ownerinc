import { validateRichNodes } from './content-contract.js';

export function renderRichContent(root, nodes) {
  const validated = validateRichNodes(nodes);
  const doc = root.ownerDocument;
  const marks = { bold: 'strong', italic: 'em', underline: 'u', code: 'code' };
  function appendInline(parent, children) {
    for (const node of children) {
      if (node.type === 'break') { parent.append(doc.createElement('br')); continue; }
      if (node.type === 'link') {
        const link = doc.createElement('a'); link.setAttribute('href', node.url);
        if (node.new_tab) { link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer'); }
        appendInline(link, node.children); parent.append(link); continue;
      }
      let content = doc.createTextNode(node.text);
      for (const mark of [...node.marks].reverse()) {
        const wrapper = doc.createElement(marks[mark]); wrapper.append(content); content = wrapper;
      }
      parent.append(content);
    }
  }
  const elements = validated.map(node => {
    const block = doc.createElement(node.type === 'heading' ? `h${node.level}` : node.type === 'list' ? (node.ordered ? 'ol' : 'ul') : 'p');
    block.className = node.type === 'heading' ? 'cms-block cms-heading' : node.type === 'list' ? 'cms-block cms-list' : 'cms-block';
    if (node.type === 'list') node.items.forEach(items => { const li = doc.createElement('li'); appendInline(li, items); block.append(li); });
    else appendInline(block, node.children);
    return block;
  });
  root.replaceChildren(...elements);
}
