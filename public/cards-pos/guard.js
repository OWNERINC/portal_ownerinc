import { fetchAPI, requireAuth } from '../js/auth.js';

function showDeniedState() {
  const main = document.getElementById('main-content') || document.querySelector('main') || document.body;
  const message = document.createElement('section');
  message.className = 'empty-state pos-cards-access-denied';
  message.tabIndex = -1;
  message.setAttribute('role', 'alert');
  message.setAttribute('aria-labelledby', 'posCardsAccessTitle');
  const title = document.createElement('h1');
  title.id = 'posCardsAccessTitle';
  title.textContent = 'Acesso restrito';
  const description = document.createElement('p');
  description.textContent = 'Os Cards Pós estão disponíveis somente para usuários autorizados.';
  const dashboard = document.createElement('a');
  dashboard.className = 'secondary-button';
  dashboard.href = './dashboard.html';
  dashboard.textContent = 'Voltar ao Portal';
  message.append(title, description, dashboard);
  main.replaceChildren(message);
  message.focus();
}

export async function requirePosCards() {
  const user = await requireAuth();
  if (!user) return false;
  try {
    const access = await fetchAPI('/api/pos-cards/access');
    if (access?.allowed === true) return true;
  } catch {}
  showDeniedState();
  window.setTimeout(() => window.location.assign('./dashboard.html'), 1500);
  return false;
}
