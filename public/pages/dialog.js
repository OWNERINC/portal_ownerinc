import { el, button } from './dom.js';
import { watchVisualViewport, visibleFocusTarget } from './editor-panels.js';

// Shared native modal lifecycle for forms whose actions stay open after save.
export function mountPagesDialog({ page, dialog, opener = document.activeElement, canClose = () => true, onClose = () => {} }) {
  let closed = false, stopViewport, composing = false;
  dialog.addEventListener('compositionstart', () => { composing = true; });
  dialog.addEventListener('compositionend', () => { queueMicrotask(() => { composing = false; }); });
  const close = (restoreFocus = true, force = false) => {
    if (closed || (!force && (composing || !canClose()))) return;
    closed = true; stopViewport?.(); window.removeEventListener('popstate', back); window.removeEventListener('keydown', escape); dialog.close(); dialog.remove(); onClose();
    const target = opener?.disabled ? [...(opener.parentElement?.querySelectorAll('button:not(:disabled), summary, a[href]') || [])]
      .find(visibleFocusTarget) : opener;
    if (restoreFocus && page.active && visibleFocusTarget(target)) target.focus({ preventScroll: true });
  };
  const back = () => close();
  const escape = event => {
    if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || [...document.querySelectorAll('dialog[open]')].at(-1) !== dialog) return;
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

export function openPagesDialog({ page, title, content, confirmText, action, className = '', opener = document.activeElement }) {
  const feedback = el('p', { role: 'alert' });
  let busy = false, closed = false, composing = false, completed = false, modal;
  const dialog = el('dialog', { className: `pages-dialog pages-task-dialog ${className}`.trim(), 'aria-label': title, 'data-page-overlay': '' });
  dialog.addEventListener('compositionstart', () => { composing = true; });
  dialog.addEventListener('compositionend', () => { queueMicrotask(() => { composing = false; if (completed) queueMicrotask(() => modal.close()); }); });
  const close = () => modal.close();
  const dismiss = button('×', close, { className: 'btn btn-ghost pages-icon-button', 'aria-label': `Fechar ${title}` });
  const cancel = button('Cancelar', close);
  const confirm = button(confirmText, async () => {
    if (busy || closed || composing || completed) return;
    busy = true; confirm.disabled = true; cancel.disabled = true; dismiss.disabled = true; dialog.setAttribute('aria-busy', 'true');
    try { await action(feedback); if (page.active && !closed) { busy = false; completed = true; close(); } }
    catch (error) { if (page.active && !closed) { feedback.textContent = error.message; busy = false; confirm.disabled = false; cancel.disabled = false; dismiss.disabled = false; dialog.setAttribute('aria-busy', 'false'); } }
  }, { className: 'btn btn-primary' });
  const body = el('div', { className: 'pages-dialog-body' }, content, feedback);
  body.addEventListener('focusin', event => event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  dialog.append(el('div', { className: 'pages-panel-heading' }, el('h2', { text: title }), dismiss), body, el('div', { className: 'pages-actions' }, cancel, confirm));
  modal = mountPagesDialog({ page, dialog, opener, canClose: () => !busy, onClose: () => { closed = true; } });
  cancel.focus();
  return dialog;
}
