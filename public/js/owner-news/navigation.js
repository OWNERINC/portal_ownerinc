import { openDialog, closeDialog, setDialogCloseGuard } from '../ui.js';

function articleURL(location, id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('id', id); else url.searchParams.delete('id');
  return url;
}

export function createNewsNavigation({ page, overlay, onRoute }) {
  let disposed = false, closing = false, version = 0;
  let interaction = 0;
  let returnState = null;
  let wasReader = false;
  function validReturn(value) {
    if (!value || typeof value.returnHref !== 'string') return null;
    try {
      const url = new URL(value.returnHref, page.location.href);
      if (url.origin !== page.location.origin || url.pathname !== '/announcements.html' || url.searchParams.has('id') || url.hash) return null;
      if (typeof value.cardId !== 'string' || !value.cardId.startsWith('news-card-') || !Number.isFinite(value.catalogY) || value.catalogY < 0) return null;
      return value;
    } catch { return null; }
  }
  async function sync() {
    if (disposed || !page.active) return;
    const token = ++version;
    closing = false;
    const query = new URL(page.location.href).searchParams;
    const id = query.get('id') || null;
    const returning = !id && wasReader;
    const saved = returnState;
    wasReader = Boolean(id);
    if (id) {
      returnState = validReturn(window.history.state?.ownerNews);
      // The router forcibly closes page dialogs before local popstate listeners.
      // Reconcile the DOM even for the same article ID (including Forward).
      if (overlay.classList.contains('hidden')) openDialog(overlay, document.getElementById('news-reader-close'));
    } else if (!overlay.classList.contains('hidden')) closeDialog(overlay, true);
    const interactionAtStart = interaction;
    await onRoute({ id, category: query.get('category') || '', offset: query.get('offset') || '0' });
    if (disposed || !page.active || token !== version || !returning) return;
    returnState = null;
    // The router may focus main while onRoute settles for an ID-less card link.
    // Only subsequent user input, not automatic focus movement, cancels our return.
    if (interaction !== interactionAtStart) return;
    const target = (saved && document.getElementById(saved.cardId)?.querySelector('a')) || document.getElementById('news-catalog-title');
    target?.focus({ preventScroll: true });
    if (saved) window.scrollTo(0, saved.catalogY);
  }
  async function open(id) {
    if (disposed || !page.active || closing || !id) return;
    if (new URL(page.location.href).searchParams.has('id')) return jump(id);
    const url = articleURL(page.location, id);
    const ownerNews = { returnHref: page.location.href, cardId: `news-card-${id}`, catalogY: window.scrollY };
    page.history.pushState({ ...window.history.state, ownerNews }, '', url);
    overlay.scrollTop = 0;
    return sync();
  }
  async function jump(id) {
    if (disposed || !page.active || closing || !id) return;
    page.history.replaceState({ ...window.history.state }, '', articleURL(page.location, id));
    overlay.scrollTop = 0;
    return sync();
  }
  function close() {
    if (disposed || !page.active || closing || !new URL(page.location.href).searchParams.has('id')) return;
    closing = true;
    if (validReturn(window.history.state?.ownerNews)) window.history.back();
    else {
      const state = { ...window.history.state }; delete state.ownerNews;
      page.history.replaceState(state, '', articleURL(page.location, null));
      void sync();
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; ++version;
    setDialogCloseGuard(overlay, null);
    if (!overlay.classList.contains('hidden')) closeDialog(overlay, true);
  }
  setDialogCloseGuard(overlay, () => { close(); return false; }, { canLeave: () => true });
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) page.listen(window, type, () => { ++interaction; }, { capture: true, passive: true });
  page.listen(window, 'popstate', () => { void sync(); });
  page.cleanup(dispose);
  return { open, jump, close, sync, dispose };
}
