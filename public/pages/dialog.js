import { el, button } from './dom.js';
import { watchVisualViewport, visibleFocusTarget } from './editor-panels.js';

// Shared native modal lifecycle for forms whose actions stay open after save.
export function mountPagesDialog({ page, dialog, opener = document.activeElement, canClose = () => true, onClose = () => {} }) {
  let closed = false, stopViewport;
  const close = (restoreFocus = true, force = false) => {
    if (closed || (!force && !canClose())) return;
    closed = true; stopViewport?.(); window.removeEventListener('popstate', back); window.removeEventListener('keydown', escape); dialog.close(); dialog.remove(); onClose();
    const target = opener?.disabled ? [...(opener.parentElement?.querySelectorAll('button:not(:disabled), summary, a[href]') || [])]
      .find(node => node.getClientRects().length && !node.closest('[hidden], [inert]')) : opener;
    if (restoreFocus && page.active && target?.isConnected && !target.closest('[hidden], [inert]')) target.focus();
  };
  const back = () => close();
  const escape = event => {
    if (event.key !== 'Escape' || event.isComposing || [...document.querySelectorAll('dialog[open]')].at(-1) !== dialog) return;
    event.preventDefault(); close();
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  window.addEventListener('popstate', back);
  window.addEventListener('keydown', escape);
  page.cleanup(() => close(false, true));
  document.body.append(dialog); dialog.showModal();
  stopViewport = watchVisualViewport(dialog);
  return { close };
}

export function openPagesDialog({ page, title, content, confirmText, action, className = '' }) {
  const feedback = el('p', { role: 'alert' });
  const opener = document.activeElement;
  let busy = false, closed = false, stopViewport;
  const dialog = el('dialog', { className: `pages-dialog ${className}`.trim(), 'aria-label': title, 'data-page-overlay': '' });
  const close = () => { if (!busy && !closed) {
    closed = true; stopViewport?.(); window.removeEventListener('popstate', close); dialog.close(); dialog.remove();
    if (page.active && visibleFocusTarget(opener)) opener.focus({ preventScroll: true });
  } };
  const cancel = button('Cancelar', close);
  const confirm = button(confirmText, async () => {
    if (busy) return; busy = true; confirm.disabled = true; cancel.disabled = true;
    try { await action(feedback); if (page.active) { busy = false; close(); } }
    catch (error) { if (page.active) { feedback.textContent = error.message; busy = false; confirm.disabled = false; cancel.disabled = false; } }
  }, { className: 'btn btn-primary' });
  dialog.append(el('h2', { text: title }), content, feedback, el('div', { className: 'pages-actions' }, cancel, confirm));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.body.append(dialog); dialog.showModal(); cancel.focus();
  stopViewport = watchVisualViewport(dialog);
  window.addEventListener('popstate', close);
  page.cleanup(() => { stopViewport?.(); window.removeEventListener('popstate', close); closed = true; dialog.close(); dialog.remove(); });
  return dialog;
}
