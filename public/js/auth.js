import { auth } from './firebase-config.js';
import { signOut, updateProfile }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const AUTH_SNAPSHOT_KEY = 'ownerinc-auth-snapshot';

function setAuthState(state) {
  document.documentElement.dataset.authState = state;
}

function renderAuthUnavailable() {
  const main = document.querySelector('main') || document.body;
  const status = document.createElement('section');
  status.className = 'empty-state auth-error-state';
  status.setAttribute('role', 'alert');
  status.setAttribute('aria-live', 'assertive');
  const title = document.createElement('h1');
  title.textContent = 'Portal temporariamente indisponível';
  const text = document.createElement('p');
  text.textContent = 'Não foi possível validar sua sessão. Tente novamente sem sair desta página.';
  const retry = document.createElement('button');
  retry.className = 'btn btn-ghost';
  retry.type = 'button';
  retry.textContent = 'Tentar novamente';
  retry.addEventListener('click', () => window.location.reload());
  status.append(title, text, retry);
  main.replaceChildren(status);
}

function applyVerifiedRole(user) {
  document.documentElement.dataset.portalRole = user.role;
  try {
    sessionStorage.setItem('ownerinc-verified-role', user.role);
  } catch (_) {
    // Authorization remains enforced by the API when storage is unavailable.
  }
}

function applyAutoCardNavigation(user) {
  document.documentElement.dataset.autocardAccess = String(user?.autocard_access === true);
}

function applyPosCardsNavigation(user) {
  document.documentElement.dataset.posCardsAccess = String(user?.pos_cards_access === true);
}

function applyCmsNavigation(user) {
  const cmsPermissions = ['manageKnowledge', 'manageAcademy', 'manageBenefits', 'manageReminders'];
  document.documentElement.dataset.cmsAccess = String(cmsPermissions.some(permission => can(user, permission)));
}

function cacheAuthSnapshot(user) {
  try {
    sessionStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      role: user.role,
      permissions: Object.fromEntries(Object.entries(user.permissions || {}).filter(([, value]) => value === true)),
      user: {
        uid: user.uid,
        email: user.email,
        name: user.name,
        bio: user.bio,
        phone: user.phone,
        linkedin_url: user.linkedin_url,
        photo_url: user.photo_url,
        job_title: user.job_title,
      },
      autocardAccess: user?.autocard_access === true,
      posCardsAccess: user?.pos_cards_access === true,
      cmsAccess: ['manageKnowledge', 'manageAcademy', 'manageBenefits', 'manageReminders']
        .some(permission => can(user, permission)),
    }));
  } catch (_) {
    // The API remains authoritative when session storage is unavailable.
  }
}

function clearVerifiedRole() {
  delete document.documentElement.dataset.portalRole;
  delete document.documentElement.dataset.authSnapshot;
  delete document.documentElement.dataset.autocardAccess;
  delete document.documentElement.dataset.cmsAccess;
  delete document.documentElement.dataset.posCardsAccess;
  setAuthState('error');
  try {
    sessionStorage.removeItem('ownerinc-verified-role');
    sessionStorage.removeItem(AUTH_SNAPSHOT_KEY);
  } catch (_) {
    // Nothing else is required when storage is unavailable.
  }
}

async function authenticatedFetch(path, options = {}) {
  await auth.authStateReady();
  if (!auth.currentUser) throw new APIError('Sessão encerrada.', 401);
  const token = await auth.currentUser.getIdToken();
  const headers = {
    ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {}),
  };
  return fetch(path, {
    ...options,
    headers,
  });
}

async function requestAPI(path, options = {}) {
  const res = await authenticatedFetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new APIError(body.error || `A solicitação falhou (${res.status}).`, res.status);
  }
  const data = res.status === 204 ? null : await res.json();
  const totalHeader = res.headers.get('X-Total-Count');
  return { data, total: totalHeader === null ? null : Number(totalHeader) };
}

export async function fetchAPIAsset(path, options = {}) {
  const response = await authenticatedFetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const requestId = body.requestId ? ` (referência ${body.requestId})` : '';
    throw new APIError(`${body.error || `A solicitação falhou (${response.status}).`}${requestId}`, response.status);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
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

export function getCachedUserSnapshot() {
  try {
    const snapshot = JSON.parse(sessionStorage.getItem(AUTH_SNAPSHOT_KEY) || 'null');
    if (!snapshot || snapshot.version !== 1 || !Number.isFinite(snapshot.savedAt)
      || Date.now() - snapshot.savedAt >= 10 * 60 * 1000 || !snapshot.user) return null;
    return {
      ...snapshot.user,
      role: snapshot.role,
      permissions: snapshot.permissions || {},
      autocard_access: snapshot.autocardAccess === true,
      pos_cards_access: snapshot.posCardsAccess === true,
    };
  } catch (_) {
    return null;
  }
}

export async function requireAuth(requireAdmin = false) {
  await auth.authStateReady();
  if (!auth.currentUser) {
    clearVerifiedRole();
    window.location.replace('./login.html');
    return null;
  }
  let user;
  try {
    user = await getCurrentUserDoc();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      clearVerifiedRole();
      await signOut(auth).catch(() => {});
      window.location.replace(`./login.html?reason=${error.status === 403 ? 'access' : 'session'}`);
      return null;
    }
    clearVerifiedRole();
    renderAuthUnavailable();
    return null;
  }
  applyVerifiedRole(user);
  applyAutoCardNavigation(user);
  applyPosCardsNavigation(user);
  applyCmsNavigation(user);
  cacheAuthSnapshot(user);
  setAuthState('ready');
  if (requireAdmin && user.role !== 'admin') {
    window.location.replace('./dashboard.html');
    return null;
  }
  return user;
}

export async function logout() {
  clearVerifiedRole();
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
