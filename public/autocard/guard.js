import { fetchAPI, requireAuth } from '../js/auth.js';

export async function requireAutoCard() {
  const user = await requireAuth();
  if (!user) return false;
  try {
    const access = await fetchAPI('/api/autocard/access');
    if (access.allowed) return true;
  } catch {}
  const main = document.getElementById('main-content') || document.querySelector('main') || document.body;
  const message = Object.assign(document.createElement('section'), { className: 'empty-state', tabIndex: -1 });
  message.append(
    Object.assign(document.createElement('h1'), { textContent: 'Acesso restrito' }),
    Object.assign(document.createElement('p'), { textContent: 'O AutoCard está disponível somente para cargos do DHO.' }),
    Object.assign(document.createElement('a'), { className: 'secondary-button', href: './dashboard.html', textContent: 'Voltar ao Portal' }),
  );
  main.replaceChildren(message);
  main.focus();
  return false;
}
