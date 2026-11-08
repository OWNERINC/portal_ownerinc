import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile('public/js/profile.js', 'utf8');

test('profile locks the label file input during a deferred action and ignores a late chooser without stale progress', async () => {
  const listeners = new Map();
  const input = { disabled: false, value: '', files: [], addEventListener(type, listener) { listeners.set(type, listener); } };
  const avatar = { disabled: false, isConnected: true, style: {}, focus() {} };
  const feedback = { textContent: 'Foto anterior preservada.', style: {} };
  const hint = { textContent: 'JPEG, PNG ou WebP de até 500 KB', className: 'avatar-hint' };
  const page = { active: true };
  let finishSave;
  const save = new Promise(resolve => { finishSave = resolve; });
  const uploads = [];
  const context = {
    page, photoInput: input, avatarButton: avatar, photoFeedback: feedback, avatarHint: hint,
    saveButton: { disabled: false }, adjustPhotoButton: null, removePhotoButton: null,
    resetPasswordButton: null, cropCloseButton: null, cropResetButton: null, cropApplyButton: null,
    profileForm: { setAttribute() {} }, cropFrame: null, cropFrameTabIndex: 0, cropFramePointerEvents: '',
    document: { activeElement: avatar, body: {}, getElementById() { return { value: 'Marina' }; }, querySelector() { return null; } },
    MAX_PHOTO_SIZE: 500 * 1024, FormData, DEFAULT_MEDIA_CROP: { x: .5, y: .5, zoom: 1 }, user: {},
    normalizeMediaCrop(value) { return value; }, renderAvatar() {},
    authenticatedFetch: async (path, options) => { uploads.push({ path, options }); return { ok: true, json: async () => ({ url: '/uploads/profile.webp' }) }; },
  };
  const controls = source.slice(source.indexOf('const profileActionButtons'), source.indexOf('const cropFrameTabIndex'));
  const actions = source.slice(source.indexOf('function setProfileActionsBusy'), source.indexOf('// ── Avatar'));
  const feedbackHelpers = source.slice(source.indexOf('function setFeedback'), source.indexOf('if (Object.keys(user).length)'));
  const upload = source.slice(source.indexOf("photoInput.addEventListener('change'"), source.indexOf("removePhotoButton.addEventListener('click'"));
  vm.runInNewContext(`let profileActionBusy = false, cropDrag = null, profileCrop; ${controls}\n${actions}\n${feedbackHelpers}\n${upload}\nglobalThis.runProfileAction = runProfileAction;`, context);

  const pending = context.runProfileAction(() => save);
  assert.equal(input.disabled, true, 'native label cannot activate its disabled control');
  assert.equal(avatar.disabled, true);
  input.files = [new Blob(['fixture'], { type: 'image/png' })];
  input.value = 'late-selection.png';
  await listeners.get('change')();
  assert.equal(uploads.length, 0);
  assert.equal(feedback.textContent, 'Foto anterior preservada.');
  assert.equal(hint.className, 'avatar-hint');
  assert.equal(input.value, '');

  finishSave();
  await pending;
  assert.equal(input.disabled, false);
  await listeners.get('change')();
  assert.equal(uploads.length, 1, 'a new selection works after the action settles');
  assert.equal(uploads[0].path, '/api/upload/photo');
  assert.equal(feedback.textContent, 'Foto atualizada.');
  assert.equal(input.disabled, false);

  page.active = false;
  await listeners.get('change')();
  assert.equal(uploads.length, 1, 'late file change after disposal cannot upload');
});
