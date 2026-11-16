// The document is data, never HTML. Keep paragraphs, list items and table cells
// literal, in source order, so the text being accepted matches the server hash.
export function renderEthicsDocument(host, term) {
  const doc = host.ownerDocument;
  const fragment = doc.createDocumentFragment();
  const textElement = (tag, text) => {
    const element = doc.createElement(tag);
    element.textContent = text;
    return element;
  };
  const cover = doc.createElement('header');
  cover.className = 'ethics-document-cover';
  for (const line of term.preamble) cover.append(textElement('p', line));
  fragment.append(cover);
  for (const section of term.sections) {
    const element = doc.createElement('section');
    element.append(textElement('h2', section.title));
    for (const block of section.blocks) {
      if (block.type === 'paragraph') {
        element.append(textElement('p', block.text));
      } else if (block.type === 'list') {
        const list = doc.createElement('ul');
        for (const item of block.items) list.append(textElement('li', item));
        element.append(list);
      } else if (block.type === 'table') {
        const table = doc.createElement('table');
        table.setAttribute('aria-label', section.title);
        const body = doc.createElement('tbody');
        const head = block.header === 'column' ? doc.createElement('thead') : null;
        block.rows.forEach((cells, rowIndex) => {
          const row = doc.createElement('tr');
          cells.forEach((text, columnIndex) => {
            const isColumnHeader = block.header === 'column' && rowIndex === 0;
            const isRowHeader = block.header === 'row' && columnIndex === 0;
            const cell = textElement(isColumnHeader || isRowHeader ? 'th' : 'td', text);
            if (isColumnHeader || isRowHeader) cell.setAttribute('scope', isColumnHeader ? 'col' : 'row');
            row.append(cell);
          });
          (head && rowIndex === 0 ? head : body).append(row);
        });
        if (head) table.append(head);
        table.append(body);
        element.append(table);
      } else {
        // Never silently omit part of a term and then allow it to be accepted.
        throw new Error('Formato de conteúdo do Código de Ética não suportado.');
      }
    }
    fragment.append(element);
  }
  host.replaceChildren(fragment);
}
