import { el, button } from './dom.js';

// Native modal semantics handle inert background, focus containment and Escape.
// The panel belongs to one workspace; rebuilding it explicitly closes the panel.
export function openEditorPanel({ page, title, anchor, content, className = '' }) {
  const opener = anchor || document.activeElement;
  const dialog = el('dialog', { className: `pages-dialog pages-editor-panel ${className}`, 'aria-label': title, 'data-page-overlay': '' });
  let closed = false;
  const close = (restore = true) => {
    if (closed) return;
    closed = true; window.removeEventListener('popstate', onHistory);
    dialog.close(); dialog.remove();
    if (restore && page.active && opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus();
  };
  const onHistory = () => close();
  const dismiss = button('×', () => close(), { className: 'btn btn-ghost pages-icon-button', 'aria-label': `Fechar ${title}` });
  dialog.append(el('div', { className: 'pages-panel-heading' }, el('h2', { text: title }), dismiss), content);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
  document.body.append(dialog); dialog.showModal();
  if (anchor && window.innerWidth >= 1100) {
    const box = anchor.getBoundingClientRect();
    dialog.style.setProperty('--panel-left', `${Math.max(16, Math.min(box.left, window.innerWidth - 416))}px`);
    dialog.style.setProperty('--panel-top', `${Math.min(box.bottom + 8, Math.max(16, window.innerHeight - 300))}px`);
  }
  (content.querySelector('input, select, button') || dismiss).focus();
  window.addEventListener('popstate', onHistory);
  page.cleanup(() => close(false));
  return { close, dialog };
}
