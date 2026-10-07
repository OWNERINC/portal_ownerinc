import { auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// Deliberately raw fetch: authentication failure must never recurse into logout.
let revoking;
export function waitForEditorialRevocation() { return revoking || Promise.resolve(); }
export function revokeEditorialSession() {
  if (!revoking) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    revoking = fetch('/api/cms/session', { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Não foi possível confirmar o encerramento editorial.'); })
      .finally(() => { clearTimeout(timeout); revoking = null; });
  }
  return revoking;
}

export function watchEditorialSession({ onState }) {
  let stopped = false, suspended = false, generation = 0, timer, controller, known = false;
  let expectedUid, expectedExpiry, requestTimeout;
  const state = (status, message = '') => { if (!stopped) onState({ status, message }); };
  async function revalidate() {
    if (stopped || suspended) return;
    const version = ++generation;
    clearTimeout(timer); clearTimeout(requestTimeout); controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    const current = () => !stopped && version === generation;
    // A known UID change/expiry hides private content BEFORE network completion.
    const lost = known && expectedUid !== undefined && (auth.currentUser?.uid || null) !== expectedUid;
    state(lost || expectedExpiry <= Date.now() ? 'denied' : 'checking', lost ? 'A conta do Portal mudou. Entre novamente pelo Portal.' : '');
    try {
      await auth.authStateReady();
      if (!current()) return;
      known = true;
      const uid = auth.currentUser?.uid || null;
      if (expectedUid !== undefined && uid !== expectedUid) {
        await revokeEditorialSession();
        if (current()) state('denied', 'A conta do Portal mudou. Entre novamente pelo Portal.');
        return;
      }
      const requestController = controller;
      requestTimeout = setTimeout(() => requestController.abort(), 10000);
      const response = await fetch('/api/cms/session', { credentials: 'same-origin', cache: 'no-store', signal });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) {
        state('denied', 'A sessão editorial expirou ou a permissão foi removida. Entre novamente pelo Portal.');
        return;
      }
      if (!response.ok) throw new Error('unavailable');
      const session = await response.json();
      if (!current()) return;
      if ((auth.currentUser?.uid || null) !== uid) { void revalidate(); return; }
      if (!uid || uid !== session.uid) {
        await revokeEditorialSession();
        if (current()) state('denied', 'A conta do Portal não corresponde à sessão editorial. Entre novamente pelo Portal.');
        return;
      }
      const remaining = Date.parse(session.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) { state('denied', 'A sessão editorial expirou. Entre novamente pelo Portal.'); return; }
      expectedUid = uid;
      expectedExpiry = Date.parse(session.expiresAt);
      state('ready');
      // The server's original fixed expiry is never extended here.
      timer = setTimeout(revalidate, Math.min(remaining, 60000));
    } catch {
      if (current()) state('error', 'Não foi possível validar ou encerrar a sessão editorial. O conteúdo foi ocultado. Tente novamente.');
    } finally { if (current()) clearTimeout(requestTimeout); }
  }
  const unsubscribe = onAuthStateChanged(auth, () => { if (known) void revalidate(); });
  const focus = () => { void revalidate(); };
  const visibility = () => { if (document.visibilityState === 'visible') void revalidate(); };
  const hide = () => {
    suspended = true; generation++; controller?.abort(); clearTimeout(timer); clearTimeout(requestTimeout);
    state('denied', 'Validando a sessão editorial ao retornar…');
  };
  const restore = event => { if (event.persisted) { suspended = false; void revalidate(); } };
  window.addEventListener('focus', focus);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', restore);
  document.addEventListener('visibilitychange', visibility);
  void revalidate();
  return { revalidate, stop() { stopped = true; generation++; clearTimeout(timer); clearTimeout(requestTimeout); controller?.abort(); unsubscribe();
    window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', restore);
    document.removeEventListener('visibilitychange', visibility); } };
}
