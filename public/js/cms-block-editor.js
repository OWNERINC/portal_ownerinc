import { BLOCK_TYPES, validateBlocks } from './cms-block-renderer.js';
import { fetchAPI, showToast } from './auth.js';
import { clear, element } from './ui.js';

const LABELS = {
  heading: 'Título', paragraph: 'Parágrafo', list: 'Lista', callout: 'Destaque', image: 'Imagem',
  divider: 'Separador', link: 'Link', pdf: 'PDF', video: 'Vídeo',
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function input(label, value, onInput, { tag = 'input', type = 'text', options = [], ...attributes } = {}) {
  const field = element(tag, { className: 'form-input', ...(tag === 'input' ? { type } : {}), ...attributes });
  if (tag === 'select') options.forEach(([optionValue, text]) => field.append(element('option', { value: optionValue, text })));
  field.value = value ?? '';
  field.addEventListener('input', event => onInput(event.target.value, event));
  field.addEventListener('change', event => onInput(event.target.value, event));
  return element('label', { className: 'cms-field' }, [element('span', { className: 'form-label', text: label }), field]);
}

function checkbox(label, checked, onChange, name) {
  const field = element('input', { type: 'checkbox', ...(name ? { name } : {}) });
  field.checked = checked === true;
  field.addEventListener('change', () => onChange(field.checked));
  return element('label', { className: 'cms-checkbox' }, [field, element('span', { text: label })]);
}

function assetUpload(label, accept, block, onChange) {
  const field = element('input', { className: 'form-input', type: 'file', name: 'asset', accept });
  field.addEventListener('change', async () => {
    const file = field.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.append('asset', file);
    field.disabled = true;
    try {
      const asset = await fetchAPI('/api/cms/assets', { method: 'POST', body });
      delete block.url;
      block.asset_id = asset.id;
      onChange();
      showToast(`${label} enviado.`);
    } catch {
      showToast(`Não foi possível enviar ${label.toLocaleLowerCase('pt-BR')}.`);
    } finally {
      field.disabled = false;
      field.value = '';
    }
  });
  return element('label', { className: 'cms-field' }, [element('span', { className: 'form-label', text: `Enviar ${label}` }), field]);
}

function defaultBlock(type) {
  if (type === 'heading') return { type, text: 'Novo título', level: 2 };
  if (type === 'paragraph') return { type, text: 'Escreva o texto do bloco.' };
  if (type === 'list') return { type, items: ['Primeiro item'], ordered: false };
  if (type === 'callout') return { type, tone: 'info', text: 'Escreva o destaque.' };
  if (type === 'image') return { type, asset_id: '', alt: '' };
  if (type === 'divider') return { type };
  if (type === 'link') return { type, label: 'Abrir link', url: 'https://', new_tab: true };
  if (type === 'pdf') return { type, asset_id: '', title: '' };
  return { type, url: 'https://', title: '' };
}

function setField(block, key, value, onChange) {
  block[key] = value;
  onChange();
}

function fieldsFor(block, onChange) {
  const fields = [];
  if (block.type === 'heading') {
    fields.push(input('Texto', block.text, value => setField(block, 'text', value, onChange), { name: 'text' }));
    fields.push(input('Nível', block.level, value => setField(block, 'level', Number(value), onChange), { name: 'level', type: 'number', min: '1', max: '6', inputmode: 'numeric' }));
  }
  if (block.type === 'paragraph') fields.push(input('Texto', block.text, value => setField(block, 'text', value, onChange), { name: 'text', tag: 'textarea', rows: '5' }));
  if (block.type === 'list') {
    fields.push(input('Itens, um por linha', block.items?.join('\n'), value => setField(block, 'items', value.split(/\r?\n/), onChange), { name: 'items', tag: 'textarea', rows: '5' }));
    fields.push(checkbox('Lista ordenada', block.ordered, value => setField(block, 'ordered', value, onChange), 'ordered'));
  }
  if (block.type === 'callout') {
    fields.push(input('Tom', block.tone, value => setField(block, 'tone', value, onChange), { name: 'tone', tag: 'select', options: [['info', 'Informação'], ['warning', 'Alerta'], ['success', 'Sucesso']] }));
    fields.push(input('Título opcional', block.title, value => setField(block, 'title', value, onChange), { name: 'title' }));
    fields.push(input('Texto', block.text, value => setField(block, 'text', value, onChange), { name: 'text', tag: 'textarea', rows: '4' }));
  }
  if (block.type === 'image') {
    fields.push(input('ID do arquivo', block.asset_id, value => setField(block, 'asset_id', value, onChange), { name: 'asset_id', autocomplete: 'off' }));
    fields.push(input('Texto alternativo', block.alt, value => setField(block, 'alt', value, onChange), { name: 'alt', autocomplete: 'off' }));
    fields.push(assetUpload('imagem', 'image/jpeg,image/png,image/webp', block, onChange));
  }
  if (block.type === 'link') {
    fields.push(input('Rótulo', block.label, value => setField(block, 'label', value, onChange), { name: 'label', autocomplete: 'off' }));
    fields.push(input('URL HTTPS', block.url, value => setField(block, 'url', value, onChange), { name: 'url', autocomplete: 'url', inputmode: 'url' }));
    fields.push(checkbox('Abrir em nova aba', block.new_tab, value => setField(block, 'new_tab', value, onChange), 'new_tab'));
  }
  if (block.type === 'pdf') {
    fields.push(input('ID do arquivo', block.asset_id, value => setField(block, 'asset_id', value, onChange), { name: 'asset_id', autocomplete: 'off' }));
    fields.push(input('Título', block.title, value => setField(block, 'title', value, onChange), { name: 'title', autocomplete: 'off' }));
    fields.push(assetUpload('PDF', 'application/pdf', block, onChange));
  }
  if (block.type === 'video') {
    fields.push(input('URL HTTPS ou ID do arquivo', block.url || block.asset_id, value => {
      if (UUID_PATTERN.test(value.trim())) {
        delete block.url;
        setField(block, 'asset_id', value.trim(), onChange);
      } else {
        delete block.asset_id;
        setField(block, 'url', value, onChange);
      }
    }, { name: 'url', autocomplete: 'url', inputmode: 'url' }));
    fields.push(input('Título opcional', block.title, value => setField(block, 'title', value, onChange), { name: 'title', autocomplete: 'off' }));
    fields.push(assetUpload('vídeo', 'video/mp4,video/webm,video/quicktime', block, onChange));
  }
  return fields;
}

function blockSummary(block) {
  return block.type === 'divider' ? 'Separador visual' : block.text || block.title || block.label || block.url || block.asset_id || 'Configure este bloco no inspector.';
}

export function serializeBlocks(blocks) {
  return validateBlocks(blocks);
}

export function createBlockSettings(block, onChange) {
  const container = element('div', { className: 'cms-inspector-block-fields' });
  container.append(...fieldsFor(block, onChange));
  return container;
}

export function createBlockEditor({ root, initialBlocks = [], onChange = () => {}, onSelect = () => {} }) {
  let blocks = Array.isArray(initialBlocks) ? structuredClone(initialBlocks) : [];
  if (!validateBlocks(blocks)) blocks = [];
  let dragIndex = null;
  let selectedIndex = 0;

  function changed() {
    onChange(structuredClone(blocks));
  }

  function selectBlock(index) {
    selectedIndex = index;
    root.querySelectorAll('.cms-block-select').forEach((button, buttonIndex) => {
      button.setAttribute('aria-pressed', String(buttonIndex === selectedIndex));
    });
    onSelect(index, blocks[index]);
  }

  function move(from, to) {
    if (to < 0 || to >= blocks.length || from === to) return;
    selectedIndex = to;
    const [block] = blocks.splice(from, 1);
    blocks.splice(to, 0, block);
    render();
    changed();
  }

  function renderToolbar() {
    const toolbar = element('div', { className: 'cms-editor-toolbar', role: 'toolbar', 'aria-label': 'Adicionar bloco' });
    BLOCK_TYPES.forEach(type => toolbar.append(element('button', {
      className: 'btn btn-ghost btn-sm', type: 'button', text: `+ ${LABELS[type]}`,
      on: { click: () => { blocks.push(defaultBlock(type)); render(); changed(); } },
    })));
    return toolbar;
  }

  function renderBlock(block, index) {
    const row = element('article', {
      className: 'cms-editor-block', draggable: 'true', 'data-block-index': String(index),
      'aria-label': `${LABELS[block.type]}, bloco ${index + 1}`, tabindex: '0',
    });
    row.addEventListener('dragstart', event => {
      dragIndex = index;
      event.dataTransfer?.setData('text/plain', String(index));
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => { dragIndex = null; row.classList.remove('is-dragging'); });
    row.addEventListener('dragover', event => { event.preventDefault(); row.classList.add('is-drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
    row.addEventListener('drop', event => {
      event.preventDefault();
      row.classList.remove('is-drop-target');
      const source = dragIndex ?? Number(event.dataTransfer?.getData('text/plain'));
      if (Number.isInteger(source)) move(source, index);
    });
    row.addEventListener('keydown', event => {
      if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        selectBlock(index);
        return;
      }
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
    });
    row.addEventListener('click', event => {
      if (event.target === row) {
        selectBlock(index);
      }
    });

    const actions = element('div', { className: 'cms-block-actions' }, [
      element('span', { className: 'cms-drag-handle', text: 'Arraste para reordenar' }),
      element('span', { className: 'cms-block-type', text: LABELS[block.type] }),
      element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Subir', 'aria-label': `Mover ${LABELS[block.type]} para cima`, disabled: index === 0 ? '' : null, on: { click: () => move(index, index - 1) } }),
      element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Descer', 'aria-label': `Mover ${LABELS[block.type]} para baixo`, disabled: index === blocks.length - 1 ? '' : null, on: { click: () => move(index, index + 1) } }),
      element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Duplicar', on: { click: () => { blocks.splice(index + 1, 0, structuredClone(block)); render(); changed(); } } }),
      element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Remover', 'aria-label': `Remover ${LABELS[block.type]}`, on: { click: () => { blocks.splice(index, 1); render(); changed(); } } }),
    ]);
    row.append(actions);
    row.append(element('button', {
      className: 'cms-block-select', type: 'button', 'aria-pressed': String(selectedIndex === index),
      'aria-label': `Editar configurações de ${LABELS[block.type]} ${index + 1}`, text: blockSummary(block),
      on: { click: () => selectBlock(index) },
    }));
    return row;
  }

  function render() {
    clear(root).append(renderToolbar());
    const list = element('div', { className: 'cms-editor-list', 'aria-live': 'polite' });
    if (!blocks.length) list.append(element('p', { className: 'empty-state', text: 'Adicione um bloco para começar.' }));
    blocks.forEach((block, index) => list.append(renderBlock(block, index)));
    root.append(list);
    if (blocks.length) onSelect(Math.min(selectedIndex, blocks.length - 1), blocks[Math.min(selectedIndex, blocks.length - 1)]);
    else onSelect(-1, null);
  }

  render();
  return {
    getBlocks: () => structuredClone(blocks),
    setBlocks(nextBlocks) {
      blocks = Array.isArray(nextBlocks) && validateBlocks(nextBlocks) ? structuredClone(nextBlocks) : [];
      render();
    },
    focus() { root.querySelector('button, input, textarea, select')?.focus(); },
  };
}
