const MARK_ORDER = Object.freeze(['bold', 'italic', 'underline', 'code']);
const MARK_TAGS = Object.freeze({ bold: 'strong', italic: 'em', underline: 'u', code: 'code' });

function appendInline(document, parent, inline) {
  if (inline.type === 'break') {
    parent.append(document.createElement('br'));
    return;
  }
  if (inline.type === 'text') {
    let node = document.createTextNode(inline.text);
    const marks = MARK_ORDER.filter(mark => inline.marks.includes(mark));
    for (let index = marks.length - 1; index >= 0; index--) {
      const wrapper = document.createElement(MARK_TAGS[marks[index]]);
      wrapper.append(node);
      node = wrapper;
    }
    parent.append(node);
    return;
  }
  const link = document.createElement('a');
  link.setAttribute('href', inline.url);
  if (inline.new_tab) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  inline.children.forEach(child => appendInline(document, link, child));
  if (inline.new_tab) {
    const cue = document.createElement('span');
    cue.className = 'contents-new-tab-cue';
    cue.textContent = 'Abre em nova aba';
    link.append(cue);
  }
  parent.append(link);
}

export function renderRichText(document, nodes) {
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    if (node.type === 'paragraph' || node.type === 'heading') {
      const element = document.createElement(node.type === 'paragraph' ? 'p' : `h${node.level}`);
      node.children.forEach(child => appendInline(document, element, child));
      fragment.append(element);
      continue;
    }
    const list = document.createElement(node.ordered ? 'ol' : 'ul');
    for (const item of node.items) {
      const li = document.createElement('li');
      item.forEach(child => appendInline(document, li, child));
      list.append(li);
    }
    fragment.append(list);
  }
  return fragment;
}
