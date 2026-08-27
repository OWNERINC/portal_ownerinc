import { requireAuth, getCachedUserSnapshot, fetchAPI, updateAuthDisplayName } from './auth.js';
import { auth } from './firebase-config.js';
import { protectForm } from './ui.js';
import { DEFAULT_MEDIA_CROP, cropRenderStyle, dragMediaCrop, normalizeMediaCrop } from '../autocard/crop.js';

const cachedUser = getCachedUserSnapshot();
const user = cachedUser || {};
const MAX_PHOTO_SIZE = 500 * 1024;
const profileForm = document.getElementById('profile-form');
const saveButton = document.getElementById('btn-save');
const avatarButton = document.getElementById('avatar-circle');
const photoInput = document.getElementById('photo-input');
const avatarHint = document.getElementById('avatar-hint');
const photoFeedback = document.getElementById('photo-feedback');
const profileFeedback = document.getElementById('profile-feedback');
const adjustPhotoButton = document.getElementById('adjust-photo');
const removePhotoButton = document.getElementById('remove-photo');
const resetPasswordButton = document.getElementById('btn-reset-pw');
const resetPasswordFeedback = document.getElementById('pw-feedback');
const cropDialog = document.getElementById('photo-crop-dialog');
const cropFrame = document.getElementById('photo-crop-frame');
const cropImage = document.getElementById('photo-crop-img');
const cropCloseButton = document.getElementById('photo-crop-close');
const cropResetButton = document.getElementById('photo-crop-reset');
const cropApplyButton = document.getElementById('photo-crop-apply');
const profileActionButtons = [saveButton, avatarButton, adjustPhotoButton, removePhotoButton, resetPasswordButton, cropCloseButton, cropResetButton, cropApplyButton].filter(Boolean);
let profileActionBusy = false;
let cropDraft = null;
let cropDrag = null;
let cropOpener = null;
let profileCrop = normalizeMediaCrop(user.photo_crop);

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

function setProfileActionsBusy(busy) {
  profileActionButtons.forEach(button => { button.disabled = busy; });
}

async function runProfileAction(action) {
  if (profileActionBusy) return false;
  profileActionBusy = true;
  setProfileActionsBusy(true);
  try {
    await action();
    return true;
  } finally {
    profileActionBusy = false;
    setProfileActionsBusy(false);
  }
}


// ── Avatar ────────────────────────────────────────────────────────────────────

function avatarPhotoUrl(photoURL) {
  if (typeof photoURL !== 'string' || !photoURL) return null;
  try {
    const url = new URL(photoURL, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function avatarMetrics() {
  return {
    frameWidth: avatarButton?.clientWidth || 0,
    frameHeight: avatarButton?.clientHeight || 0,
    imageWidth: document.getElementById('avatar-img')?.naturalWidth || 0,
    imageHeight: document.getElementById('avatar-img')?.naturalHeight || 0,
  };
}

function applyAvatarCropStyle() {
  const image = document.getElementById('avatar-img');
  const style = cropRenderStyle(profileCrop, avatarMetrics());
  if (image && style) image.setAttribute('style', `display:block;${style}`);
}

function renderAvatar(photoURL, name) {
  const img      = document.getElementById('avatar-img');
  const initials = document.getElementById('avatar-initials');
  const safePhoto = avatarPhotoUrl(photoURL);
  if (safePhoto) {
    img.alt = `Foto de perfil de ${name || 'usuário'}`;
    img.src = safePhoto;
    img.style.display = '';
    initials.style.display = 'none';
    adjustPhotoButton.hidden = false;
    removePhotoButton.hidden = false;
    if (img.complete) applyAvatarCropStyle();
    else img.addEventListener('load', applyAvatarCropStyle, { once: true });
  } else {
    img.style.display = 'none';
    initials.textContent = (name || user.email || '?').charAt(0).toUpperCase();
    initials.style.display = '';
    adjustPhotoButton.hidden = true;
    removePhotoButton.hidden = !avatarPhotoUrl(user.photo_url);
  }
}

// ── Upload de foto ────────────────────────────────────────────────────────────

function setFeedback(target, message, tone = '') {
  if (!target) return;
  target.textContent = message;
  target.style.color = tone ? `var(--${tone})` : '';
}

function validPhotoFile(file) {
  return file && file.size <= MAX_PHOTO_SIZE
    && (!file.type || ['image/jpeg', 'image/png', 'image/webp'].includes(file.type));
}

if (Object.keys(user).length) {
  applyProfileFields(user);
  renderAvatar(user.photo_url, user.name);
}
const verifiedUser = await requireAuth();
if (!verifiedUser) throw new Error('not authenticated');
Object.assign(user, verifiedUser);
profileCrop = normalizeMediaCrop(user.photo_crop);

async function responseError(response, fallback) {
  const body = await response.json().catch(() => ({}));
  const error = body.error || fallback;
  const requestId = body.requestId ? ` (referência ${body.requestId})` : '';
  return new Error(`${error}${requestId}`);
}

avatarButton.addEventListener('click', () => photoInput.click());
document.getElementById('avatar-img').addEventListener('error', () => {
  document.getElementById('avatar-img').style.display = 'none';
  document.getElementById('avatar-initials').textContent = (user.name || user.email || '?').charAt(0).toUpperCase();
  document.getElementById('avatar-initials').style.display = '';
  adjustPhotoButton.hidden = true;
  removePhotoButton.hidden = !avatarPhotoUrl(user.photo_url);
  setFeedback(photoFeedback, 'Não foi possível carregar a foto. Você ainda pode removê-la.', 'danger');
});

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  if (!file) return;

  if (!validPhotoFile(file)) {
    setFeedback(photoFeedback, 'Escolha uma imagem JPEG, PNG ou WebP de até 500 KB.', 'danger');
    avatarButton.focus();
    return;
  }

  avatarHint.textContent = 'Enviando…';
  avatarHint.className   = 'avatar-uploading';
  setFeedback(photoFeedback, 'Enviando foto…');

  await runProfileAction(async () => {
    try {
      await auth.authStateReady();
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Sessão encerrada.');

      const formData = new FormData();
      formData.append('photo', file);

      const res = await fetch('/api/upload/photo', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) throw await responseError(res, 'O servidor recusou o arquivo. Use JPEG, PNG ou WebP de até 500 KB.');
      const { url } = await res.json();

      Object.assign(user, { photo_url: url, photo_crop: { ...DEFAULT_MEDIA_CROP } });
      profileCrop = normalizeMediaCrop(user.photo_crop);
      renderAvatar(user.photo_url, document.getElementById('p-name').value);
      setFeedback(photoFeedback, 'Foto atualizada.', 'success');
    } catch (err) {
      setFeedback(photoFeedback, `Não foi possível enviar a foto: ${err.message}`, 'danger');
    }
  });
  avatarHint.textContent = 'JPEG, PNG ou WebP de até 500 KB';
  avatarHint.className = 'avatar-hint';
  photoInput.value = '';
});

removePhotoButton.addEventListener('click', async () => {
  let removed = false;
  setFeedback(photoFeedback, 'Removendo foto…');
  await runProfileAction(async () => {
    try {
      await fetchAPI('/api/upload/photo', { method: 'DELETE' });
      Object.assign(user, { photo_url: '', photo_crop: { ...DEFAULT_MEDIA_CROP } });
      profileCrop = normalizeMediaCrop(user.photo_crop);
      renderAvatar('', document.getElementById('p-name').value);
      removed = true;
      setFeedback(photoFeedback, 'Foto removida.', 'success');
    } catch (err) {
      setFeedback(photoFeedback, `Não foi possível remover a foto: ${err.message}`, 'danger');
    }
  });
  if (removed) avatarButton.focus();
});

applyProfileFields(user);
renderAvatar(user.photo_url, user.name);
const markProfileClean = protectForm(profileForm);

// ── Salvar ────────────────────────────────────────────────────────────────────

profileForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) {
    const invalid = event.currentTarget.querySelector(':invalid');
    setFeedback(profileFeedback, invalid?.validationMessage || 'Revise os campos destacados.', 'danger');
    invalid?.focus();
    return;
  }
  const btn          = saveButton;
  const name        = document.getElementById('p-name').value.trim();
  const bio         = document.getElementById('p-bio').value.trim();
  const phone       = document.getElementById('p-phone').value.trim();
  const linkedin_url = document.getElementById('p-linkedin').value.trim();

  btn.textContent = 'Salvando…';
  setFeedback(profileFeedback, 'Salvando…');

  await runProfileAction(async () => {
    try {
      const updatedUser = await fetchAPI('/api/users/me', {
        method: 'PUT',
        body: JSON.stringify({ name, bio, phone, linkedin_url }),
      });
      Object.assign(user, updatedUser);
      applyProfileFields(user);
      markProfileClean();
      try {
        await updateAuthDisplayName(name);
        setFeedback(profileFeedback, 'Perfil atualizado com sucesso.', 'success');
      } catch {
        setFeedback(profileFeedback, 'Perfil salvo. O nome de acesso será sincronizado no próximo login.', 'focus');
      }
    } catch (err) {
      setFeedback(profileFeedback, `Não foi possível salvar o perfil: ${err.message}`, 'danger');
    }
  });
  btn.textContent = 'Salvar perfil';
});

// ── Redefinir senha ───────────────────────────────────────────────────────────

resetPasswordButton.addEventListener('click', async () => {
  const btn      = resetPasswordButton;
  const feedback = resetPasswordFeedback;

  btn.textContent = 'Enviando…';
  feedback.textContent = 'Enviando link…';
  feedback.style.color = '';
  await runProfileAction(async () => {
    try {
      const response = await fetch('/api/auth/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });
      if (response.status === 429) throw new Error('rate-limited');
      if (!response.ok) throw new Error('delivery-failed');
      feedback.style.color = 'var(--success)';
      feedback.textContent = `Link enviado para ${user.email}. Verifique sua caixa de entrada.`;
    } catch (error) {
      feedback.style.color = 'var(--danger)';
      feedback.textContent = error.message === 'rate-limited'
        ? 'Limite atingido. Tente novamente mais tarde.'
        : 'Não foi possível enviar o link. Tente novamente.';
    }
  });
  btn.textContent = 'Enviar link de redefinição de senha';
});

function cropMetrics() {
  return {
    frameWidth: cropFrame?.clientWidth || 0,
    frameHeight: cropFrame?.clientHeight || 0,
    imageWidth: cropImage?.naturalWidth || 0,
    imageHeight: cropImage?.naturalHeight || 0,
  };
}

function updateCropPreview() {
  if (!cropDraft || !cropImage) return;
  const style = cropRenderStyle(cropDraft, cropMetrics());
  if (style) cropImage.setAttribute('style', style);
}

function closeCropDialog() {
  cropDraft = null;
  cropDrag = null;
  if (cropDialog?.open) cropDialog.close();
  cropOpener?.focus?.();
  cropOpener = null;
}

function openCropDialog() {
  const photoURL = avatarPhotoUrl(user.photo_url);
  if (!photoURL || !cropDialog || !cropFrame || !cropImage) return;
  cropOpener = document.activeElement;
  cropDraft = { ...profileCrop };
  cropImage.src = photoURL;
  cropDialog.showModal();
  updateCropPreview();
}

function moveCrop(dx, dy) {
  if (!cropDraft) return;
  cropDraft = dragMediaCrop(cropDraft, { ...cropMetrics(), dx, dy });
  updateCropPreview();
}

function handleCropPointerDown(event) {
  if (!cropDraft) return;
  cropDrag = { x: event.clientX, y: event.clientY, draft: { ...cropDraft } };
  cropFrame.setPointerCapture?.(event.pointerId);
}

function handleCropPointerMove(event) {
  if (!cropDrag) return;
  const { dx, dy } = { dx: event.clientX - cropDrag.x, dy: event.clientY - cropDrag.y };
  cropDraft = dragMediaCrop(cropDrag.draft, { ...cropMetrics(), dx, dy });
  updateCropPreview();
}

function handleCropPointerEnd(event) {
  if (!cropDrag) return;
  cropFrame.releasePointerCapture?.(event.pointerId);
  cropDrag = null;
}

function handleCropKeydown(event) {
  const distance = event.shiftKey ? 10 : 2;
  const movement = {
    ArrowLeft: [-distance, 0], ArrowRight: [distance, 0],
    ArrowUp: [0, -distance], ArrowDown: [0, distance],
  }[event.key];
  if (!movement) return;
  event.preventDefault();
  moveCrop(...movement);
}

async function saveCrop() {
  if (!cropDraft) return;
  let saved = false;
  cropApplyButton.textContent = 'Salvando…';
  await runProfileAction(async () => {
    try {
      const photo_crop = normalizeMediaCrop(cropDraft);
      const updatedUser = await fetchAPI('/api/users/me', {
        method: 'PUT',
        body: JSON.stringify({ photo_crop }),
      });
      Object.assign(user, updatedUser);
      profileCrop = normalizeMediaCrop(user.photo_crop);
      renderAvatar(user.photo_url, user.name);
      saved = true;
      setFeedback(photoFeedback, 'Enquadramento salvo.', 'success');
    } catch (error) {
      setFeedback(photoFeedback, `Não foi possível salvar o enquadramento: ${error.message}`, 'danger');
    }
  });
  cropApplyButton.textContent = 'Salvar enquadramento';
  if (saved) closeCropDialog();
}

adjustPhotoButton.addEventListener('click', openCropDialog);
cropCloseButton.addEventListener('click', closeCropDialog);
cropResetButton.addEventListener('click', () => {
  cropDraft = { ...DEFAULT_MEDIA_CROP };
  updateCropPreview();
});
cropApplyButton.addEventListener('click', saveCrop);
cropImage.addEventListener('load', updateCropPreview);
cropFrame.addEventListener('pointerdown', handleCropPointerDown);
cropFrame.addEventListener('pointermove', handleCropPointerMove);
cropFrame.addEventListener('pointerup', handleCropPointerEnd);
cropFrame.addEventListener('pointercancel', handleCropPointerEnd);
cropFrame.addEventListener('lostpointercapture', () => { cropDrag = null; });
cropFrame.addEventListener('keydown', handleCropKeydown);
cropDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeCropDialog();
});
