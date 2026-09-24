import { auth } from './firebase-config.js';
import { onAuthStateChanged, signOut, updateProfile }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const AUTH_SNAPSHOT_KEY = 'ownerinc-auth-snapshot';
const AUTH_REDIRECT_REASONS = new Set(['email-not-verified', 'pending-approval', 'enable-pending', 'account-disabled']);
const INVALID_TOKEN_CODES = new Set(['auth/user-token-expired', 'auth/invalid-user-token', 'auth/user-disabled', 'auth/user-not-found']);
let authStateKnown = false;
let sessionUid;
let sessionEpoch = 0;
let sessionDenied = false;
let pendingValidation = null;
let visualSnapshot = null;

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
  // Visual hints only: no profile fields or token, and no authorization lifetime.
  visualSnapshot = {
    version: 2,
    uid: user.uid,
    firebaseStorageKey: `firebase:authUser:${auth.app.options.apiKey}:${auth.app.name}`,
    savedAt: Date.now(),
    role: user.role,
    permissions: Object.fromEntries(Object.entries(user.permissions || {}).filter(([, value]) => value === true)),
    user: { uid: user.uid },
    autocardAccess: user?.autocard_access === true,
    posCardsAccess: user?.pos_cards_access === true,
    cmsAccess: ['manageKnowledge', 'manageAcademy', 'manageBenefits', 'manageReminders']
      .some(permission => can(user, permission)),
  };
  try {
    sessionStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(visualSnapshot));
  } catch (_) {
    // The API remains authoritative when session storage is unavailable.
  }
}

function readAuthSnapshot() {
  try {
    const snapshot = visualSnapshot || JSON.parse(sessionStorage.getItem(AUTH_SNAPSHOT_KEY) || 'null');
    if (snapshot?.version !== 2 || typeof snapshot.uid !== 'string' || !snapshot.uid
      || snapshot.user?.uid !== snapshot.uid || !Number.isFinite(snapshot.savedAt)
      || !['admin', 'viewer'].includes(snapshot.role)) return null;
    return snapshot;
  } catch (_) {
    return null;
  }
}

function snapshotNavigation(snapshot) {
  return {
    uid: snapshot.uid,
    role: snapshot.role,
    permissions: { ...snapshot.permissions },
    autocard_access: snapshot.autocardAccess === true,
    pos_cards_access: snapshot.posCardsAccess === true,
  };
}

function applyNavigation(user) {
  applyVerifiedRole(user);
  applyAutoCardNavigation(user);
  applyPosCardsNavigation(user);
  applyCmsNavigation(user);
  document.documentElement.dataset.authSnapshot = 'true';
}

function clearVerifiedRole() {
  sessionEpoch += 1;
  sessionDenied = true;
  pendingValidation = null;
  visualSnapshot = null;
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

function syncSession() {
  const uid = auth.currentUser?.uid || null;
  if (sessionUid === uid) return;
  const previousUid = sessionUid;
  const wasDenied = sessionDenied;
  const snapshot = readAuthSnapshot();
  sessionUid = uid;
  if (previousUid !== undefined || !uid || snapshot?.uid !== uid) clearVerifiedRole();
  sessionDenied = !uid;
  if (uid) {
    setAuthState('pending');
    if (previousUid === undefined && snapshot?.uid === uid) applyNavigation(snapshotNavigation(snapshot));
  }
  if (previousUid && !wasDenied) {
    // Firebase also reports logout/account changes made in another tab.
    document.querySelector('main')?.replaceChildren();
    redirectToLogin('session');
  }
}

async function readySession() {
  if (!authStateKnown) {
    await auth.authStateReady();
    authStateKnown = true;
  }
  syncSession();
  return { uid: sessionUid, epoch: sessionEpoch };
}

function assertCurrentSession(session) {
  syncSession();
  if (sessionDenied || session.uid !== sessionUid || session.epoch !== sessionEpoch) {
    throw new DOMException('A sessão mudou durante a solicitação.', 'AbortError');
  }
}

function currentDestination() {
  const url = new URL(window.location.href);
  if (url.pathname.endsWith('/login.html')) return '';
  return `${url.pathname}${url.search}${url.hash}`;
}

function redirectToLogin(reason) {
  const params = new URLSearchParams({ reason });
  const destination = currentDestination();
  if (destination) params.set('next', destination);
  window.location.replace(`./login.html?${params.toString()}`);
}

function authRedirectReason(path, response, body) {
  if (response.status === 401) return 'session';
  if (response.status !== 403) return null;
  if (body?.reason === 'email-not-verified') return 'email';
  if (AUTH_REDIRECT_REASONS.has(body?.reason)) return body.reason;
  path = new URL(path, window.location.href).pathname;
  return path === '/api/users/me' ? 'access' : null;
}

async function endSession(reason) {
  const uid = sessionUid;
  clearVerifiedRole();
  document.querySelector('main')?.replaceChildren();
  await signOut(auth).catch(() => {});
  // Do not redirect a different account that signed in while signOut settled.
  if (!auth.currentUser || (auth.currentUser.uid === uid && sessionDenied)) redirectToLogin(reason);
}

async function handleAuthenticationFailure(path, response) {
  if (response.status !== 401 && response.status !== 403) return false;
  const session = { uid: sessionUid, epoch: sessionEpoch };
  const body = await response.clone().json().catch(() => ({}));
  assertCurrentSession(session);
  const reason = authRedirectReason(path, response, body);
  if (!reason) return false;
  await endSession(reason);
  throw new APIError(body.error || `A solicitação falhou (${response.status}).`, response.status, body.reason);
}

// Guards the token/request against account changes. Raw Response consumers must
// still respect their page lifecycle while asynchronously decoding the body.
export async function authenticatedFetch(path, options = {}) {
  const session = await readySession();
  return fetchForSession(path, options, session);
}

async function fetchForSession(path, options, session) {
  syncSession();
  if (!session.uid || sessionDenied) {
    redirectToLogin('session');
    throw new APIError('Sessão encerrada.', 401, 'session');
  }
  assertCurrentSession(session);
  let token;
  try {
    token = await auth.currentUser.getIdToken();
  } catch (error) {
    assertCurrentSession(session);
    if (!INVALID_TOKEN_CODES.has(error.code)) throw error;
    await endSession('session');
    throw new APIError('Sessão encerrada.', 401, 'session');
  }
  assertCurrentSession(session);
  const headers = {
    ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {}),
  };
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (error) {
    assertCurrentSession(session);
    throw error;
  }
  assertCurrentSession(session);
  await handleAuthenticationFailure(path, response);
  assertCurrentSession(session);
  return response;
}

async function requestAPI(path, options = {}, session) {
  session = session || await readySession();
  const res = await fetchForSession(path, options, session);
  assertCurrentSession(session);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    assertCurrentSession(session);
    throw new APIError(body.error || `A solicitação falhou (${res.status}).`, res.status, body.reason);
  }
  const data = res.status === 204 ? null : await res.json();
  assertCurrentSession(session);
  const totalHeader = res.headers.get('X-Total-Count');
  return { data, total: totalHeader === null ? null : Number(totalHeader) };
}

export async function fetchAPIAsset(path, options = {}) {
  const session = await readySession();
  const response = await fetchForSession(path, options, session);
  assertCurrentSession(session);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    assertCurrentSession(session);
    const requestId = body.requestId ? ` (referência ${body.requestId})` : '';
    throw new APIError(`${body.error || `A solicitação falhou (${response.status}).`}${requestId}`, response.status, body.reason);
  }
  const blob = await response.blob();
  assertCurrentSession(session);
  return URL.createObjectURL(blob);
}

export async function fetchAPI(path, options = {}) {
  return (await requestAPI(path, options)).data;
}

export function fetchAPIPage(path, options = {}) {
  return requestAPI(path, options);
}

export class APIError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// Always validates /users/me (only in-flight work is shared). Updates navigation
// on success, never falls back to storage or renders a transient error view.
// Returns null without a live session; rejects on errors/stale work. Definitive
// session denial clears content and redirects, just like other API requests.
export async function getCurrentUserDoc() {
  const session = await readySession();
  if (!session.uid || sessionDenied) return null;
  assertCurrentSession(session);
  if (!pendingValidation) {
    setAuthState('pending');
    const validation = (async () => {
      try {
        const { data: user } = await requestAPI('/api/users/me', {}, session);
        assertCurrentSession(session);
        if (!user || user.uid !== session.uid) {
          await endSession('session');
          throw new APIError('A identidade da sessão não corresponde ao perfil.', 401, 'identity-mismatch');
        }
        if (!['admin', 'viewer'].includes(user.role)) throw new APIError('Perfil inválido.', 502);
        applyNavigation(user);
        cacheAuthSnapshot(user);
        setAuthState('ready');
        return user;
      } catch (error) {
        syncSession();
        if (session.epoch === sessionEpoch && session.uid === sessionUid) setAuthState('error');
        throw error;
      } finally {
        if (pendingValidation === validation) pendingValidation = null;
      }
    })();
    pendingValidation = validation;
  }
  const user = await pendingValidation;
  assertCurrentSession(session);
  return user;
}

// Synchronous VISUAL navigation hints only, after Firebase confirms the same UID.
// No personal profile fields; Admin may paint tabs, but content/actions must await
// requireAuth/getCurrentUserDoc and the API still authorizes every request.
export function getCachedUserSnapshot() {
  if (!authStateKnown) return null;
  syncSession();
  if (!sessionUid || sessionDenied) return null;
  const snapshot = readAuthSnapshot();
  return snapshot?.uid === sessionUid ? snapshotNavigation(snapshot) : null;
}

// Direct-load guard: null on denied/unavailable access, error view on transient
// failure. Routers can use getCurrentUserDoc to keep the current view during retry.
export async function requireAuth(requireAdmin = false) {
  const session = await readySession();
  if (!session.uid || sessionDenied) {
    redirectToLogin('session');
    return null;
  }
  let user;
  try {
    user = await getCurrentUserDoc();
    assertCurrentSession(session);
    if (!user) return null;
  } catch (error) {
    syncSession();
    if (error.status === 401 || error.status === 403) return null;
    if (error.name === 'AbortError' || session.epoch !== sessionEpoch) return null;
    renderAuthUnavailable();
    return null;
  }
  if (requireAdmin && user.role !== 'admin') {
    window.location.replace('./dashboard.html');
    return null;
  }
  return user;
}

export async function logout() {
  const uid = auth.currentUser?.uid;
  clearVerifiedRole();
  document.querySelector('main')?.replaceChildren();
  await signOut(auth);
  if (!auth.currentUser || (auth.currentUser.uid === uid && sessionDenied)) window.location.href = './login.html';
}

// One subscription for the persistent module, including Firebase's cross-tab
// persistence events. Inspect an already loaded UID immediately for mismatches.
if (auth.currentUser) syncSession();
onAuthStateChanged(auth, () => {
  authStateKnown = true;
  syncSession();
});

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
