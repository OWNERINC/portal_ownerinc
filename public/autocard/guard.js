import { fetchAPI, requireAuth } from '../js/auth.js';

export async function requireAutoCard() {
  const user = await requireAuth();
  if (!user) return false;
  try {
    const access = await fetchAPI('/api/autocard/access');
    if (access.allowed) return true;
  } catch {}
  const main = Object.assign(document.createElement('main'), { className: 'empty-state', tabIndex: -1 });
  main.append(
    Object.assign(document.createElement('h1'), { textContent: 'Acesso restrito' }),
    Object.assign(document.createElement('p'), { textContent: 'O AutoCard está disponível somente para cargos do DHO.' }),
    Object.assign(document.createElement('a'), { className: 'secondary-button', href: '/dashboard.html', textContent: 'Voltar ao Portal' }),
  );
  document.body.replaceChildren(main);
  main.focus();
  return false;
}
