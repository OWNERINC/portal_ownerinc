import { el, button } from './dom.js';

export function openPagesDialog({ page, title, content, confirmText, action, className = '' }) {
  const feedback = el('p', { role: 'alert' });
  const opener = document.activeElement;
  let busy = false, closed = false;
  const dialog = el('dialog', { className: `pages-dialog ${className}`.trim(), 'aria-label': title, 'data-page-overlay': '' });
  const close = () => { if (!busy && !closed) {
    closed = true; window.removeEventListener('popstate', close); dialog.close(); dialog.remove();
    if (page.active && opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus();
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
  window.addEventListener('popstate', close);
  page.cleanup(() => { window.removeEventListener('popstate', close); closed = true; dialog.close(); dialog.remove(); });
  return dialog;
}
