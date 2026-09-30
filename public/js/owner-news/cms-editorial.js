import { element } from '../ui.js';
import { normalizeEditorial } from './model.js';

export function createEditorialFields({ root, value, onChange, page }) {
  let current = value === null ? null : structuredClone(value);
  let disposed = false;
  let removeListeners = [];
  const listen = (node, type, callback) => {
    const handler = page.listen(node, type, () => { if (!disposed) callback(); });
    removeListeners.push(() => node.removeEventListener(type, handler));
  };
  function render() {
    removeListeners.forEach(remove => remove()); removeListeners = [];
    root.replaceChildren();
    if (current === null) {
      const prepare = element('button', { type: 'button', className: 'btn btn-ghost', text: 'Preparar matéria editorial' });
      listen(prepare, 'click', () => {
        current = { version: 1, kind: 'article', summary: '', author: '', source_label: '', source_date: null };
        render(); onChange();
      });
      root.append(prepare);
      return;
    }
    for (const [name, label, tag, max] of [
      ['summary', 'Resumo', 'textarea', 1000], ['author', 'Autoria', 'input', 200],
      ['source_label', 'Origem', 'input', 200], ['source_date', 'Data da fonte', 'input'],
      ['kind', 'Formato', 'select'],
    ]) {
      const field = element(tag, { name, className: 'form-input',
        ...(tag === 'input' ? { type: name === 'source_date' ? 'date' : 'text' } : {}),
        ...(max ? { maxlength: String(max) } : {}), ...(tag === 'textarea' ? { rows: '3' } : {}) });
      if (name === 'kind') field.append(element('option', { value: 'article', text: 'Matéria' }), element('option', { value: 'edition', text: 'Edição em PDF' }));
      field.value = current[name] ?? '';
      listen(field, 'input', () => {
        current[name] = name === 'source_date' && !field.validity?.badInput ? field.value || null : field.value;
        onChange();
      });
      root.append(element('label', { className: 'cms-field' }, [element('span', { className: 'form-label', text: label }), field]));
    }
  }
  render();
  return {
    getValue: () => current === null ? null : structuredClone(current),
    setValue(next) { if (!disposed) { current = next === null ? null : structuredClone(next); render(); } },
    dispose() { disposed = true; removeListeners.forEach(remove => remove()); root.replaceChildren(); },
  };
}

export function editorialPublicationError(editorial, blocks) {
  if (blocks.filter(block => block.type === 'image' && block.usage === 'cover').length > 1) return 'Escolha apenas uma imagem como capa.';
  if (blocks.filter(block => block.type === 'pdf' && block.usage === 'edition').length > 1) return 'Escolha apenas um PDF complementar da edição.';
  if (editorial === null) return '';
  const value = normalizeEditorial(editorial);
  if (!value) return 'Revise Resumo, Autoria, Origem, Data da fonte e Formato. Use texto sem HTML e uma data válida.';
  if (value.kind === 'article' && !value.summary) return 'Preencha o Resumo antes de publicar a matéria.';
  if (value.kind === 'article' && !blocks.some(block => ['paragraph', 'list', 'quote', 'profile'].includes(block.type)
    && (block.type === 'list' ? block.items?.length > 0 : Boolean(block.text?.trim())))) return 'Adicione texto ao corpo da matéria antes de publicar.';
  if (value.kind === 'edition' && !blocks.some(block => block.type === 'pdf')) return 'Adicione o PDF da edição antes de publicar.';
  return '';
}
