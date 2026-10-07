import { authenticatedFetch } from './auth.js';
import { auth } from './firebase-config.js';
import { waitForEditorialRevocation } from './editorial-session-watch.js';

export function mount(page) {
  const button = document.getElementById('editorial-enter');
  const recheck = document.getElementById('editorial-recheck');
  const status = document.getElementById('editorial-entry-status');
  let busy = false;
  let availabilityToken = 0;
  let availability = null;
  page.beforeLeave(() => !busy);

  function availabilityMessage(value) {
    if (!value?.activated && !value?.runtimeReady) {
      return 'Owner News ainda não foi ativada no Payload e o runtime não respondeu à verificação. A entrada está desativada.';
    }
    if (!value?.activated) {
      return 'O runtime do Payload respondeu, mas Owner News ainda não foi ativada como fonte editorial. A entrada está desativada.';
    }
    if (!value?.runtimeReady) {
      return 'Owner News está ativa no Payload, mas o runtime não respondeu à verificação. A entrada está desativada.';
    }
    return 'Owner News está ativa no Payload e o runtime respondeu à verificação. O painel pode ser aberto.';
  }

  async function checkAvailability({ keepDisabled = false } = {}) {
    const requestToken = ++availabilityToken;
    button.disabled = true;
    button.hidden = true;
    recheck.disabled = true;
    recheck.hidden = true;
    status.textContent = 'Verificando fonte editorial e runtime do Payload…';
    try {
      const response = await authenticatedFetch('/api/cms/session/availability', { cache: 'no-store' });
      const result = await response.json().catch(() => null);
      if (!page.active || requestToken !== availabilityToken) return null;
      if (!response.ok) {
        availability = null;
        status.textContent = response.status === 403
          ? 'Sua conta não tem permissão para abrir o painel editorial.'
          : 'Não foi possível confirmar a fonte editorial e a disponibilidade do Payload. A entrada está desativada.';
        recheck.hidden = false;
        return null;
      }
      availability = result;
      const canEnter = result?.activated === true && result?.runtimeReady === true
        && result?.canEnter === true && ['payload', 'payload_frozen'].includes(result?.mode);
      status.textContent = availabilityMessage(result);
      button.hidden = !canEnter;
      button.disabled = !canEnter || keepDisabled;
      recheck.hidden = canEnter;
      return canEnter ? result : null;
    } catch {
      if (page.active && requestToken === availabilityToken) {
        availability = null;
        status.textContent = 'Não foi possível confirmar a fonte editorial e a disponibilidade do Payload. A entrada está desativada.';
        recheck.hidden = false;
      }
      return null;
    } finally {
      if (page.active && requestToken === availabilityToken) recheck.disabled = false;
    }
  }

  async function enter() {
    if (busy || !page.active) return;
    busy = true; button.disabled = true; recheck.disabled = true;
    const uid = page.user.uid;
    try {
      // Wait for any in-flight account-change revocation before issuing a cookie.
      await waitForEditorialRevocation();
      if (!page.active || auth.currentUser?.uid !== uid) return;
      const currentAvailability = await checkAvailability({ keepDisabled: true });
      if (!currentAvailability || !page.active || auth.currentUser?.uid !== uid) return;
      status.textContent = 'Abrindo o painel editorial…';
      const response = await authenticatedFetch('/api/cms/session', { method: 'POST', body: '{}' });
      const session = await response.json().catch(() => null);
      if (!page.active || auth.currentUser?.uid !== uid) return;
      if (!response.ok) {
        if (response.status === 409 || response.status === 503) {
          await checkAvailability();
          return;
        }
        if (response.status === 403) {
          status.textContent = 'Sua conta não tem permissão para abrir o painel editorial.';
          button.hidden = true;
          recheck.hidden = false;
          return;
        }
        throw new Error('session');
      }
      if (session?.uid !== uid) throw new Error('session');
      window.location.assign('/editorial/admin');
    } catch {
      if (page.active) {
        status.textContent = 'Não foi possível abrir o painel. Verifique sua permissão e tente novamente.';
        button.hidden = true;
        recheck.hidden = false;
      }
    } finally {
      busy = false;
      if (page.active) {
        button.disabled = availability?.canEnter !== true || availability?.runtimeReady !== true || availability?.activated !== true;
        recheck.disabled = false;
      }
    }
  }

  page.listen(button, 'click', () => void enter());
  page.listen(recheck, 'click', () => void checkAvailability());
  page.cleanup(() => { availabilityToken += 1; });
  void checkAvailability();
}
