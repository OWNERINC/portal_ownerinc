import { auth } from './firebase-config.js';
import { fetchAPI, getCurrentUserDoc, logout } from './auth.js';
import { safeDestination } from './portal-destination.js';
import { createEthicsReader } from './ethics-reader.js';

const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
const node = id => elements[id];
const destination = safeDestination(new URLSearchParams(location.search).get('next'));
let term;
let reader;
let uid;
let loading = false;
let mustReload = false;

function isCurrent() { return uid && auth.currentUser?.uid === uid; }
function enterPortal() {
  if (isCurrent()) window.location.replace(destination);
}

async function loadTerm() {
  if (loading) return;
  loading = true;
  mustReload = false;
  reader?.destroy();
  reader = null;
  term = null;
  node('ethics-checkbox').checked = false;
  node('ethics-checkbox').disabled = true;
  node('ethics-accept').disabled = true;
  node('ethics-content').hidden = true;
  node('ethics-loading').hidden = false;
  node('ethics-retry').hidden = true;
  node('ethics-error').textContent = '';
  try {
    const user = await getCurrentUserDoc({ allowPendingEthics: true });
    if (!user) {
      window.location.replace(`./login.html?${new URLSearchParams({ next: destination })}`);
      return;
    }
    uid = user.uid;
    if (user.ethics_accepted === true) return enterPortal();
    const data = await fetchAPI('/api/ethics');
    if (!isCurrent()) return;
    if (data.accepted === true) return enterPortal();
    term = data.term;
    node('ethics-notice').textContent = term.notice;
    node('ethics-version').textContent = `Versão ${term.version}${term.mock ? ' · Demonstração' : ''}`;
    const sections = term.sections.map(section => {
      const element = document.createElement('section');
      const title = document.createElement('h2');
      title.textContent = section.title;
      element.append(title);
      for (const paragraph of section.paragraphs) {
        const text = document.createElement('p');
        text.textContent = paragraph;
        element.append(text);
      }
      return element;
    });
    node('ethics-document').replaceChildren(...sections);
    node('ethics-content').hidden = false;
    node('ethics-reader').scrollTop = 0;
    node('ethics-reading-status').textContent = 'Role o termo até o final para liberar a confirmação.';
    reader = createEthicsReader({ reader: node('ethics-reader'), checkbox: node('ethics-checkbox'), button: node('ethics-accept'), status: node('ethics-reading-status'), form: node('ethics-form') });
  } catch (error) {
    if (error.name === 'AbortError' || error.status === 401 || error.status === 403) return;
    node('ethics-error').textContent = 'Não foi possível carregar o termo. Verifique sua conexão e tente novamente.';
    node('ethics-retry').hidden = false;
  } finally {
    loading = false;
    node('ethics-loading').hidden = true;
  }
}

node('ethics-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!term || !reader?.canAccept() || !isCurrent()) return;
  reader.setBusy(true);
  node('ethics-error').textContent = '';
  node('ethics-accept').textContent = 'Registrando aceite…';
  try {
    const result = await fetchAPI('/api/ethics/accept', {
      method: 'POST', body: JSON.stringify({ version: term.version, contentHash: term.contentHash, accepted: true }),
    });
    if (!isCurrent()) return;
    if (result.accepted !== true || result.version !== term.version || result.contentHash !== term.contentHash) throw new Error('Acceptance not confirmed');
    enterPortal();
  } catch (error) {
    if (error.name === 'AbortError' || !isCurrent()) return;
    mustReload = error.status === 409;
    if (mustReload) {
      node('ethics-error').textContent = 'O termo foi atualizado. Recarregue e leia a nova versão antes de aceitar.';
      node('ethics-retry').textContent = 'Carregar termo atualizado';
      node('ethics-retry').hidden = false;
    } else {
      node('ethics-error').textContent = 'Não foi possível confirmar o aceite. Tente novamente. Seu acesso ainda não foi liberado.';
    }
  } finally {
    reader?.setBusy(mustReload);
    node('ethics-accept').textContent = 'Aceitar e entrar no portal';
  }
});

node('ethics-retry').addEventListener('click', loadTerm);
node('ethics-logout').addEventListener('click', async () => {
  reader?.setBusy(true);
  try { await logout(); } catch {
    node('ethics-error').textContent = 'Não foi possível sair. Tente novamente.';
    reader?.setBusy(mustReload);
  }
});
window.addEventListener('pagehide', () => reader?.destroy());
// BFCache restores the DOM without rerunning this module. Revalidate the session
// and current term with a fresh document instead of keeping a disposed reader or
// an obsolete acceptance choice from the history snapshot.
window.addEventListener('pageshow', event => {
  if (event.persisted) window.location.reload();
});
loadTerm();
