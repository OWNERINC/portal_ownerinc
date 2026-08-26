import { requireAuth, getCachedUserSnapshot, showToast, fetchAPI, updateAuthDisplayName } from './auth.js';
import { auth } from './firebase-config.js';
import { protectForm } from './ui.js';

const cachedUser = getCachedUserSnapshot();
const user = cachedUser || {};

function applyProfileFields(profile) {
  document.getElementById('p-name').value = profile.name || '';
  document.getElementById('p-bio').value = profile.bio || '';
  document.getElementById('p-phone').value = profile.phone || '';
  document.getElementById('p-linkedin').value = profile.linkedin_url || '';
  const jobTitle = document.getElementById('profile-job-title');
  if (jobTitle) {
    jobTitle.textContent = profile.job_title ? `Cargo: ${profile.job_title}` : '';
    jobTitle.hidden = !profile.job_title;
  }
  document.getElementById('profile-email').textContent = profile.email || '';
}

if (Object.keys(user).length) applyProfileFields(user);
if (Object.keys(user).length) renderAvatar(user.photo_url, user.name);
const verifiedUser = await requireAuth();
if (!verifiedUser) throw new Error('not authenticated');
Object.assign(user, verifiedUser);


// ── Avatar ────────────────────────────────────────────────────────────────────

function renderAvatar(photoURL, name) {
  const img      = document.getElementById('avatar-img');
  const initials = document.getElementById('avatar-initials');
  let safePhoto = null;
  try {
    const url = new URL(photoURL, location.origin);
    if (['http:', 'https:'].includes(url.protocol)) safePhoto = url.href;
  } catch {}
  if (safePhoto) {
    img.src = safePhoto;
    img.style.display = '';
    initials.style.display = 'none';
  } else {
    img.style.display = 'none';
    initials.textContent = (name || user.email || '?').charAt(0).toUpperCase();
    initials.style.display = '';
  }
  document.getElementById('remove-photo').hidden = !safePhoto;
}

// ── Upload de foto ────────────────────────────────────────────────────────────

const photoInput = document.getElementById('photo-input');
const avatarHint = document.getElementById('avatar-hint');
const photoFeedback = document.getElementById('photo-feedback');
const profileFeedback = document.getElementById('profile-feedback');

function setFeedback(target, message, tone = '') {
  if (!target) return;
  target.textContent = message;
  target.style.color = tone ? `var(--${tone})` : '';
}

async function responseError(response, fallback) {
  const body = await response.json().catch(() => ({}));
  const error = body.error || fallback;
  const requestId = body.requestId ? ` (referência ${body.requestId})` : '';
  return new Error(`${error}${requestId}`);
}

document.getElementById('avatar-circle').addEventListener('click', () => photoInput.click());
document.getElementById('avatar-img').addEventListener('error', () => renderAvatar('', document.getElementById('p-name').value));

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  if (!file) return;

  if (file.size > 3 * 1024 * 1024) {
    setFeedback(photoFeedback, 'Foto muito grande. O limite é 3 MB.', 'danger');
    document.getElementById('avatar-circle').focus();
    return;
  }

  avatarHint.textContent = 'Enviando…';
  avatarHint.className   = 'avatar-uploading';
  setFeedback(photoFeedback, 'Enviando foto…');

  try {
    await auth.authStateReady();
    const token = await auth.currentUser.getIdToken();

    const formData = new FormData();
    formData.append('photo', file);

    const res = await fetch('/api/upload/photo', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) throw await responseError(res, 'O servidor recusou o arquivo. Use JPEG, PNG ou WebP de até 3 MB.');
    const { url } = await res.json();

    renderAvatar(url, document.getElementById('p-name').value);
    setFeedback(photoFeedback, 'Foto atualizada.', 'success');
  } catch (err) {
    setFeedback(photoFeedback, `Não foi possível enviar a foto: ${err.message}`, 'danger');
  } finally {
    avatarHint.textContent = 'Clique na foto para atualizar';
    avatarHint.className   = 'avatar-hint';
    photoInput.value       = '';
  }
});

document.getElementById('remove-photo').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  setFeedback(photoFeedback, 'Removendo foto…');
  try {
    await fetchAPI('/api/upload/photo', { method: 'DELETE' });
    renderAvatar('', document.getElementById('p-name').value);
    setFeedback(photoFeedback, 'Foto removida.', 'success');
  } catch (err) {
    setFeedback(photoFeedback, `Não foi possível remover a foto: ${err.message}`, 'danger');
  } finally {
    event.currentTarget.disabled = false;
  }
});

// ── Preencher formulário ──────────────────────────────────────────────────────

applyProfileFields(user);

renderAvatar(user.photo_url, user.name);
const markProfileClean = protectForm(document.getElementById('profile-form'));

// ── Salvar ────────────────────────────────────────────────────────────────────

document.getElementById('profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) {
    const invalid = event.currentTarget.querySelector(':invalid');
    setFeedback(profileFeedback, invalid?.validationMessage || 'Revise os campos destacados.', 'danger');
    invalid?.focus();
    return;
  }
  const btn         = document.getElementById('btn-save');
  const name        = document.getElementById('p-name').value.trim();
  const bio         = document.getElementById('p-bio').value.trim();
  const phone       = document.getElementById('p-phone').value.trim();
  const linkedin_url = document.getElementById('p-linkedin').value.trim();

  btn.disabled    = true;
  btn.textContent = 'Salvando…';
  setFeedback(profileFeedback, 'Salvando…');

  try {
    await fetchAPI('/api/users/me', {
      method: 'PUT',
      body: JSON.stringify({ name, bio, phone, linkedin_url }),
    });
    markProfileClean();
    try {
      await updateAuthDisplayName(name);
    } catch {
      setFeedback(profileFeedback, 'Perfil salvo. O nome de acesso será sincronizado no próximo login.', 'danger');
      return;
    }
    setFeedback(profileFeedback, 'Perfil atualizado com sucesso.', 'success');
  } catch (err) {
    setFeedback(profileFeedback, `Não foi possível salvar o perfil: ${err.message}`, 'danger');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Salvar perfil';
  }
});

// ── Redefinir senha ───────────────────────────────────────────────────────────

document.getElementById('btn-reset-pw').addEventListener('click', async () => {
  const btn      = document.getElementById('btn-reset-pw');
  const feedback = document.getElementById('pw-feedback');

  btn.disabled = true;
  btn.textContent = 'Enviando…';
  feedback.textContent = 'Enviando link…';
  feedback.style.color = '';
  try {
    const response = await fetch('/api/auth/password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email }),
    });
    if (!response.ok) throw new Error('delivery-failed');
    feedback.style.color = 'var(--success)';
    feedback.textContent = `Link enviado para ${user.email}. Verifique sua caixa de entrada.`;
    btn.textContent = 'Link enviado';
  } catch {
    feedback.style.color = 'var(--danger)';
    feedback.textContent = 'Não foi possível enviar o link. Tente novamente.';
    btn.disabled = false;
    btn.textContent = 'Enviar link de redefinição de senha';
  }
});

document.getElementById('btn-export-data').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Preparando…';
  try {
    const data = await fetchAPI('/api/users/me/export');
    const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = `ownerinc-meus-dados-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(href);
    showToast('Arquivo de dados gerado.');
  } catch (error) {
    showToast(`Não foi possível exportar seus dados: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Baixar meus dados';
  }
});
