import { auth } from './firebase-config.js';
import { signOut, updateProfile }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

async function requestAPI(path, options = {}) {
  await auth.authStateReady();
  if (!auth.currentUser) throw new APIError('Sessão encerrada.', 401);
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new APIError(body.error || `A solicitação falhou (${res.status}).`, res.status);
  }
  const data = res.status === 204 ? null : await res.json();
  const totalHeader = res.headers.get('X-Total-Count');
  return { data, total: totalHeader === null ? null : Number(totalHeader) };
}

export async function fetchAPI(path, options = {}) {
  return (await requestAPI(path, options)).data;
}

export function fetchAPIPage(path, options = {}) {
  return requestAPI(path, options);
}

export class APIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function getCurrentUserDoc() {
  await auth.authStateReady();
  if (!auth.currentUser) return null;
  return fetchAPI('/api/users/me');
}

export async function requireAuth(requireAdmin = false) {
  await auth.authStateReady();
  if (!auth.currentUser) {
    window.location.replace('./login.html');
    return null;
  }
  let user;
  try {
    user = await getCurrentUserDoc();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      await signOut(auth).catch(() => {});
      window.location.replace(`./login.html?reason=${error.status === 403 ? 'access' : 'session'}`);
      return null;
    }
    const main = document.querySelector('main') || document.body;
    main.replaceChildren();
    const status = document.createElement('div');
    status.className = 'empty-state';
    status.setAttribute('role', 'alert');
    const text = document.createElement('p');
    text.textContent = 'Não foi possível conectar ao Portal. Verifique sua conexão e tente novamente.';
    const retry = document.createElement('button');
    retry.className = 'btn btn-ghost';
    retry.type = 'button';
    retry.textContent = 'Tentar novamente';
    retry.addEventListener('click', () => window.location.reload());
    status.append(text, retry);
    main.append(status);
    return null;
  }
  const adminLink = document.getElementById('admin-link');
  if (adminLink) adminLink.style.visibility = user.role === 'admin' ? 'visible' : 'hidden';
  if (requireAdmin && user.role !== 'admin') {
    window.location.replace('./dashboard.html');
    return null;
  }
  return user;
}

export function renderUserInTopbar(user) {
  const el = document.getElementById('topbar-user-name');
  if (el) el.textContent = user.name || user.email;
}

export async function logout() {
  await signOut(auth);
  window.location.href = './login.html';
}

export function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

export function can(user, perm) {
  return !!(user.permissions?.superAdmin || user.permissions?.[perm]);
}

export function updateAuthDisplayName(name) {
  if (auth.currentUser) return updateProfile(auth.currentUser, { displayName: name });
}
