import { openDialog, closeDialog, setDialogCloseGuard } from '../ui.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES = new Set(['legacy', 'payload']);

function identity(value) {
  if (!value || !SOURCES.has(value.source) || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id)) return null;
  return { source: value.source, id: value.id.toLowerCase() };
}

function routeIdentity(query) {
  const id = query.get('id');
  if (!id) return { value: null, invalid: query.has('source') };
  const source = query.has('source') ? query.get('source') : 'legacy';
  const value = identity({ source, id });
  return { value, invalid: !value };
}

function cardId(value) { return `news-card-${value.source}-${value.id}`; }

function articleURL(location, value) {
  const url = new URL(location.href);
  if (value) {
    url.searchParams.set('id', value.id);
    url.searchParams.set('source', value.source);
  } else {
    url.searchParams.delete('id');
    url.searchParams.delete('source');
  }
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
      if (!/^news-card-(legacy|payload)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.cardId)
        || !Number.isFinite(value.catalogY) || value.catalogY < 0) return null;
      return value;
    } catch { return null; }
  }
  async function sync() {
    if (disposed || !page.active) return;
    const token = ++version;
    closing = false;
    const query = new URL(page.location.href).searchParams;
    const parsed = routeIdentity(query);
    const selected = parsed.value;
    if (parsed.invalid) {
      wasReader = false;
      if (!overlay.classList.contains('hidden')) closeDialog(overlay, true);
      return;
    }
    const returning = !selected && wasReader;
    const saved = returnState;
    wasReader = Boolean(selected);
    if (selected) {
      returnState = validReturn(window.history.state?.ownerNews);
      // The router forcibly closes page dialogs before local popstate listeners.
      // Reconcile the DOM even for the same public identity (including Forward).
      if (overlay.classList.contains('hidden')) openDialog(overlay, document.getElementById('news-reader-close'));
    } else if (!overlay.classList.contains('hidden')) closeDialog(overlay, true);
    const interactionAtStart = interaction;
    await onRoute({ source: selected?.source || null, id: selected?.id || null,
      invalidIdentity: parsed.invalid, category: query.get('category') || '', cursor: query.get('cursor') || null });
    if (disposed || !page.active || token !== version || !returning) return;
    returnState = null;
    // The router may focus main while onRoute settles for an ID-less card link.
    // Only subsequent user input, not automatic focus movement, cancels our return.
    if (interaction !== interactionAtStart) return;
    const target = (saved && document.getElementById(saved.cardId)?.querySelector('a')) || document.getElementById('news-catalog-title');
    target?.focus({ preventScroll: true });
    if (saved) window.scrollTo(0, saved.catalogY);
  }
  async function open(value) {
    const selected = identity(value);
    if (disposed || !page.active || closing || !selected) return;
    if (routeIdentity(new URL(page.location.href).searchParams).value) return jump(selected);
    const url = articleURL(page.location, selected);
    const ownerNews = { returnHref: page.location.href, cardId: cardId(selected), catalogY: window.scrollY };
    page.history.pushState({ ...window.history.state, ownerNews }, '', url);
    overlay.scrollTop = 0;
    return sync();
  }
  async function jump(value) {
    const selected = identity(value);
    if (disposed || !page.active || closing || !selected) return;
    page.history.replaceState({ ...window.history.state }, '', articleURL(page.location, selected));
    overlay.scrollTop = 0;
    return sync();
  }
  function close() {
    if (disposed || !page.active || closing || !routeIdentity(new URL(page.location.href).searchParams).value) return;
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
