import { createPageLifecycle } from '../js/page-lifecycle.js';
import { createPagesAPI } from './api.js';
import { catalog, readPage } from './catalog.js';
import { el, showError } from './dom.js';
import { focusSection } from './renderer.js';

export function mountPages(page) {
  const root = document.getElementById('pages-root'); if (!root) return;
  let scope, sequence = 0, documentURL;
  const locationKey = () => { const url = new URL(page.location.href); return url.pathname + url.search; };
  function navigate(params) {
    if (page.busy || !page.canLeave()) return;
    const url = new URL('./pages.html', page.location.href); url.search = new URLSearchParams(params);
    page.history.pushState({ ...window.history.state }, '', url); void render();
  }
  async function render() {
    documentURL = locationKey();
    const generation = ++sequence; scope?.dispose();
    scope = createPageLifecycle({ user: page.user }); const current = scope;
    // Keep reads/mutations visible to the owning shell's lifecycle too.
    const api = createPagesAPI({ bindAPI: page.bindAPI, signal: current.signal });
    root.replaceChildren(el('p', { role: 'status', text: 'Carregando Pages…' }));
    try {
      const params = new URL(page.location.href).searchParams;
      if (params.has('id')) await readPage({ root, page: current, api, params });
      else await catalog({ root, page: current, api, params, navigate });
      if (page.active && current.active && generation === sequence) focusSection(root);
    } catch (error) { if (page.active && current.active && generation === sequence && error.name !== 'AbortError') showError(root, error, render); }
  }
  page.listen(window, 'popstate', () => { if (documentURL === locationKey()) { focusSection(root); return; } void render(); });
  page.listen(window, 'hashchange', () => { if (documentURL === locationKey()) focusSection(root); });
  page.cleanup(() => { ++sequence; scope?.dispose(); });
  void render();
}
