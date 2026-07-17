import { requireAuth, renderUserInTopbar, showToast, fetchAPI, updateAuthDisplayName } from './auth.js';
import { auth } from './firebase-config.js';
import { sendPasswordResetEmail }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const user = await requireAuth();
if (!user) throw new Error('not authenticated');

renderUserInTopbar(user);
if (user.role === 'admin') document.getElementById('admin-link').style.display = '';

// ── Avatar ────────────────────────────────────────────────────────────────────

function renderAvatar(photoURL, name) {
  const img      = document.getElementById('avatar-img');
  const initials = document.getElementById('avatar-initials');
  if (photoURL) {
    img.src = photoURL;
    img.style.display = '';
    initials.style.display = 'none';
  } else {
    img.style.display = 'none';
    initials.textContent = (name || user.email || '?').charAt(0).toUpperCase();
    initials.style.display = '';
  }
}

// ── Upload de foto ────────────────────────────────────────────────────────────

const photoInput = document.getElementById('photo-input');
const avatarHint = document.getElementById('avatar-hint');

document.getElementById('avatar-circle').addEventListener('click', () => photoInput.click());

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  if (!file) return;

  if (file.size > 3 * 1024 * 1024) {
    showToast('Foto muito grande. Máximo 3 MB.');
    return;
  }

  avatarHint.textContent = 'Enviando...';
  avatarHint.className   = 'avatar-uploading';

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
    if (!res.ok) throw new Error('Falha no upload');
    const { url } = await res.json();

    renderAvatar(url, document.getElementById('p-name').value);
    showToast('Foto atualizada!');
  } catch (err) {
    showToast('Erro ao enviar foto: ' + err.message);
  } finally {
    avatarHint.textContent = 'Clique na foto para atualizar';
    avatarHint.className   = 'avatar-hint';
    photoInput.value       = '';
  }
});

// ── Preencher formulário ──────────────────────────────────────────────────────

document.getElementById('p-name').value     = user.name        || '';
document.getElementById('p-bio').value      = user.bio         || '';
document.getElementById('p-phone').value    = user.phone       || '';
document.getElementById('p-linkedin').value = user.linkedin_url || '';
document.getElementById('profile-email').textContent = user.email;

renderAvatar(user.photo_url, user.name);

// ── Salvar ────────────────────────────────────────────────────────────────────

document.getElementById('btn-save').addEventListener('click', async () => {
  const btn         = document.getElementById('btn-save');
  const name        = document.getElementById('p-name').value.trim();
  const bio         = document.getElementById('p-bio').value.trim();
  const phone       = document.getElementById('p-phone').value.trim();
  const linkedin_url = document.getElementById('p-linkedin').value.trim();

  if (!name) { showToast('Nome é obrigatório.'); return; }

  btn.disabled    = true;
  btn.textContent = 'Salvando...';

  try {
    await fetchAPI('/api/users/me', {
      method: 'PUT',
      body: JSON.stringify({ name, bio, phone, linkedin_url }),
    });
    await updateAuthDisplayName(name);
    document.getElementById('topbar-user-name').textContent = name;
    showToast('Perfil atualizado com sucesso!');
  } catch (err) {
    showToast('Erro ao salvar: ' + err.message);
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
  try {
    await sendPasswordResetEmail(auth, user.email);
    feedback.style.color = 'var(--success)';
    feedback.textContent = `Link enviado para ${user.email}. Verifique sua caixa de entrada.`;
  } catch {
    feedback.style.color = 'var(--danger)';
    feedback.textContent = 'Erro ao enviar. Tente novamente.';
    btn.disabled = false;
  }
});
