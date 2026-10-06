import { authenticatedFetch } from './auth.js';
import { auth } from './firebase-config.js';
import { waitForEditorialRevocation } from './editorial-session-watch.js';

export function mount(page) {
  const button = document.getElementById('editorial-enter');
  const status = document.getElementById('editorial-entry-status');
  let busy = false;
  page.beforeLeave(() => !busy);
  async function enter() {
    if (busy || !page.active) return;
    busy = true; button.disabled = true; status.textContent = 'Abrindo o painel editorial…';
    const uid = page.user.uid;
    try {
      // Wait for any in-flight account-change revocation before issuing a cookie.
      await waitForEditorialRevocation();
      if (!page.active || auth.currentUser?.uid !== uid) return;
      const response = await authenticatedFetch('/api/cms/session', { method: 'POST', body: '{}' });
      const session = await response.json();
      if (!page.active || auth.currentUser?.uid !== uid) return;
      if (!response.ok || session.uid !== uid) throw new Error('session');
      window.location.assign('/editorial/admin');
    } catch {
      if (page.active) status.textContent = 'Não foi possível abrir o painel. Verifique sua permissão e tente novamente.';
    } finally { busy = false; if (page.active) button.disabled = false; }
  }
  page.listen(button, 'click', () => void enter());
}
