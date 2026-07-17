import { auth } from './firebase-config.js';
import { signOut, updateProfile }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

export async function fetchAPI(path, options = {}) {
  await auth.authStateReady();
  if (!auth.currentUser) throw new Error('Não autenticado.');
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
    throw new Error(body.error || `Erro HTTP ${res.status}`);
  }
  return res.json();
}

export async function getCurrentUserDoc() {
  await auth.authStateReady();
  if (!auth.currentUser) return null;
  try {
    return await fetchAPI('/api/users/me');
  } catch {
    return null;
  }
}

export async function requireAuth(requireAdmin = false) {
  const user = await getCurrentUserDoc();
  if (!user) { window.location.href = './login.html'; return null; }
  if (requireAdmin && user.role !== 'admin') {
    window.location.href = './dashboard.html';
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
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

export function can(user, perm) {
  return !!(user.permissions?.superAdmin || user.permissions?.[perm]);
}

export function updateAuthDisplayName(name) {
  if (auth.currentUser) return updateProfile(auth.currentUser, { displayName: name });
}
