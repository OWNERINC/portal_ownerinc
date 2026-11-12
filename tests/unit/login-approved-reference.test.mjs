import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createFeedbackHarness, TestEvent, drain } from '../helpers/frontend-feedback-harness.mjs';

async function createLoginHarness({ responseStatus = 200, responseBody = {}, signInError, fetchImpl, signInImpl } = {}) {
  const h = await createFeedbackHarness('login', { mount: false });
  const requests = [];
  for (const form of h.doc.querySelectorAll('form')) {
    form.reportValidity = () => true;
    form.reset = () => { for (const input of form.querySelectorAll('input')) input.value = ''; };
  }
  Object.assign(h.context, {
    location: h.window.location,
    auth: { currentUser: null, async authStateReady() {} },
    async signInWithEmailAndPassword(...args) {
      if (signInImpl) return signInImpl(...args);
      throw signInError || { code: 'auth/invalid-credential' };
    },
    async signOut() {},
    async fetch(path, options) {
      requests.push({ path, options });
      if (fetchImpl) return fetchImpl(path, options);
      return { status: responseStatus, ok: responseStatus >= 200 && responseStatus < 300, async json() { return responseBody; } };
    },
  });
  vm.runInContext((await readFile('public/js/portal-destination.js', 'utf8')).replace(/^export /gm, ''), h.context);
  const source = (await readFile('public/js/login.js', 'utf8')).replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '');
  await vm.runInContext(`(async () => { ${source} })()`, h.context, { filename: 'public/js/login.js' });
  return {
    ...h,
    requests,
    async click(id) { h.node(id).click(); await drain(); },
    async submit(id) { h.node(id).dispatchEvent(new TestEvent('submit')); await drain(); },
  };
}

test('approved login uses the original responsive brand as h1 and keeps the welcome phrase as h2', async () => {
  const h = await createLoginHarness();
  const heading = h.doc.querySelector('h1');
  assert.equal(h.doc.querySelectorAll('h1').length, 1);
  const image = heading.querySelector('img');
  assert.equal(image.getAttribute('alt'), 'Conecta Ownerinc');
  assert.equal(image.getAttribute('src'), './assets/conecta/logo.svg');
  assert.equal(image.getAttribute('width'), '320');
  assert.equal(heading.querySelector('source').getAttribute('srcset'), './assets/conecta/symbol.svg');
  assert.equal(h.doc.querySelector('.brand-headline').tagName, 'H2');
  assert.equal(h.doc.querySelector('.brand-headline').textContent, 'Boas conexões começam aqui.');
  assert.equal(h.doc.querySelector('.form-panel').getAttribute('aria-label'), 'Acesso ao portal');
  assert.equal(h.node('login-title').tagName, 'H2');
  assert.equal(h.node('login-title').hidden, true);
  assert.doesNotMatch(h.html, /Entrar no Conecta/);
});

test('initial login starts with the email field and preserves instructions in secondary flows', async () => {
  const h = await createLoginHarness();
  assert.doesNotMatch(h.html, /Acesse com o e-mail cadastrado no portal\./);
  assert.equal(h.doc.querySelector('.login-form-wrap').firstElementChild.id, 'login-form');
  assert.equal(h.node('login-form').querySelector('.form-label').textContent, 'E-mail');
  assert.match(h.node('reset-section').querySelector('.login-intro').textContent, /redefinição de senha/);
  assert.match(h.node('register-section').querySelector('.login-intro').textContent, /solicitar acesso/);
  assert.match(h.node('reset-section').querySelector('.login-intro').textContent, /cadastro antigo/);
  assert.equal(h.doc.getElementById('registration-password-section'), null);
});

test('mobile centers the complete login composition while allowing natural vertical growth', async () => {
  const css = await readFile('public/css/login.css', 'utf8');
  const mobile = css.match(/@media \(max-width: 768px\)\s*\{\s*\.login-split\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(mobile, /justify-content:\s*center/);
  assert.match(mobile, /min-height:\s*100svh/);
  assert.match(mobile, /padding-block:\s*max\(24px, env\(safe-area-inset-top\)\) max\(24px, env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(mobile, /(?:^|;)\s*height:|overflow:\s*hidden|position:\s*(?:fixed|absolute)/);
});

test('PodFalar has an independent card below the access card and outside every form', async () => {
  const h = await createLoginHarness();
  const links = h.doc.querySelectorAll('.podfalar-link');
  assert.equal(links.length, 1);
  const link = links[0];
  assert.equal(link.closest('form'), null);
  assert.equal(link.getAttribute('href'), 'https://app.denouncefy.com/portal/canaldedenunciaownerinc');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(link.getAttribute('aria-label'), 'PodFalar (abre em nova aba)');
  const logo = link.querySelector('img');
  assert.ok(logo);
  assert.equal(logo.getAttribute('src'), './assets/podfalar/logo-horizontal.svg');
  assert.equal(logo.getAttribute('alt'), 'PodFalar');
  assert.equal(logo.getAttribute('width'), '108');
  const panel = h.doc.querySelector('.podfalar-panel');
  assert.equal(panel.closest('.form-panel') === null, true);
  assert.equal(panel.closest('.brand-panel') === null, true);
  const stack = h.doc.querySelector('.access-stack');
  assert.ok(stack);
  assert.equal(panel.parentElement === stack, true);
  assert.equal(stack.children[0] === h.doc.querySelector('.form-panel'), true);
  assert.equal(stack.children.at(-1) === panel, true);
  assert.match(panel.textContent, /Canal de denúncias/);
  assert.match(panel.textContent, /Disponível sem login\./);
  assert.equal(h.requests.length, 0);
});

test('PodFalar card stays outside the access card in all secondary states', async () => {
  const h = await createLoginHarness();
  for (const trigger of ['forgot-link', 'back-link', 'register-link']) {
    await h.click(trigger);
    const panel = h.doc.querySelector('.podfalar-panel');
    assert.equal(panel.closest('.form-panel') === null, true);
    assert.equal(panel.closest('form'), null);
    assert.equal(h.doc.querySelectorAll('.podfalar-link').length, 1);
    assert.equal(panel.hidden, false);
  }
});

test('password is chosen inside Cadastre-se and abandoning it clears secrets and restores focus', async () => {
  const h = await createLoginHarness();
  await h.click('register-link');
  assert.equal(h.node('login-title').textContent, 'Cadastre-se');
  assert.equal(h.node('login-title').hidden, false);
  assert.equal(h.doc.activeElement, h.node('login-title'));
  assert.equal(h.node('register-section').classList.contains('active'), true);
  for (const id of ['register-password', 'register-password-confirm']) {
    assert.equal(h.node(id).closest('form'), h.node('register-section'));
    assert.equal(h.node(id).getAttribute('autocomplete'), 'new-password');
    assert.equal(h.node(id).getAttribute('minlength'), '12');
    assert.equal(h.node(id).getAttribute('maxlength'), '128');
    h.node(id).value = 'senha escolhida';
  }
  await h.click('register-back-link');
  assert.equal(h.node('register-password').value, '');
  assert.equal(h.node('register-password-confirm').value, '');
  assert.equal(h.node('login-title').hidden, true);
  assert.equal(h.doc.activeElement, h.node('register-link'));
  assert.equal(h.doc.querySelector('.login-form-wrap').classList.contains('hidden'), false);
});

test('recovery returns to the untitled login and restores focus to Esqueci minha senha', async () => {
  const h = await createLoginHarness();
  await h.click('forgot-link');
  assert.equal(h.node('login-title').textContent, 'Redefinir senha');
  assert.equal(h.node('login-title').hidden, false);
  assert.equal(h.node('reset-section').classList.contains('active'), true);
  h.node('reset-email').value = 'person@example.test';
  h.node('reset-error').textContent = 'Erro anterior';
  await h.click('back-link');
  assert.equal(h.node('login-title').hidden, true);
  assert.equal(h.node('login-title').textContent, '');
  assert.equal(h.node('reset-section').classList.contains('active'), false);
  assert.equal(h.node('reset-email').value, '');
  assert.equal(h.node('reset-error').textContent, '');
  assert.equal(h.doc.activeElement, h.node('forgot-link'));
});

test('registration sends its unmodified password once and clears both fields without a verification step', async () => {
  const h = await createLoginHarness({ responseStatus: 202, responseBody: { status: 'accepted', state: 'received' } });
  await h.click('register-link');
  h.node('register-name').value = 'Pessoa de teste';
  h.node('register-email').value = 'person@example.test';
  h.node('register-password').value = '  senha com espaços  ';
  h.node('register-password-confirm').value = '  senha com espaços  ';
  await h.submit('register-section');
  assert.equal(h.requests[0].path, '/api/auth/register');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { name: 'Pessoa de teste', email: 'person@example.test', password: '  senha com espaços  ' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.node('register-password').value, '');
  assert.equal(h.node('register-password-confirm').value, '');
  assert.match(h.node('register-success').textContent, /aguarde a aprovação/);
  assert.doesNotMatch(h.node('register-success').textContent, /confirmar|Criar senha do cadastro/);
});

test('recovery keeps anti-enumeration and login failure leaves its primary action retryable', async () => {
  const h = await createLoginHarness();
  await h.click('forgot-link');
  h.node('reset-email').value = 'person@example.test';
  await h.submit('reset-section');
  assert.equal(h.requests[0].path, '/api/auth/password-reset');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { email: 'person@example.test' });
  assert.match(h.node('reset-success').textContent, /Se a conta estiver ativa/);
  await h.click('back-link');
  await h.submit('login-form');
  assert.equal(h.node('submit-btn').disabled, false);
  assert.equal(h.node('submit-btn').textContent, 'Entrar no portal');
  assert.equal(h.node('error-msg').textContent, 'E-mail ou senha incorretos.');
  assert.equal(h.node('login-title').hidden, true);
});

test('failed registration preserves name/email for retry but never retains passwords', async () => {
  const h = await createLoginHarness({ responseStatus: 503 });
  await h.click('register-link');
  h.node('register-name').value = 'Pessoa de teste';
  h.node('register-email').value = 'person@example.test';
  h.node('register-password').value = 'senha escolhida';
  h.node('register-password-confirm').value = 'senha escolhida';
  await h.submit('register-section');
  assert.match(h.node('register-error').textContent, /Não foi possível concluir/);
  assert.equal(h.node('register-btn').disabled, false);
  assert.equal(h.node('register-success').style.display, 'none');
  assert.equal(h.node('register-name').value, 'Pessoa de teste');
  assert.equal(h.node('register-email').value, 'person@example.test');
  assert.equal(h.node('register-password').value, '');
  assert.equal(h.node('register-password-confirm').value, '');
});

test('registration checks invalid and mismatched passwords even when native validation is bypassed', async () => {
  for (const [password, confirmation] of [['', ''], ['a'.repeat(11), 'a'.repeat(11)], ['a'.repeat(129), 'a'.repeat(129)], [' '.repeat(12), ' '.repeat(12)], ['senha escolhida', 'outra senha escolhida']]) {
    const h = await createLoginHarness();
    await h.click('register-link');
    h.node('register-password').value = password;
    h.node('register-password-confirm').value = confirmation;
    await h.submit('register-section');
    assert.equal(h.requests.length, 0);
    assert.ok(h.node('register-error').textContent);
    assert.equal(h.node('register-password').value, '');
    assert.equal(h.node('register-password-confirm').value, '');
    assert.equal(h.doc.activeElement, h.node('register-password'));
  }
});

test('registration guards duplicate submits and navigation throughout a deferred request', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = await createLoginHarness({ fetchImpl: () => pending });
  await h.click('register-link');
  h.node('register-name').value = 'Pessoa de teste';
  h.node('register-email').value = 'person@example.test';
  h.node('register-password').value = 'senha escolhida';
  h.node('register-password-confirm').value = 'senha escolhida';
  await h.submit('register-section');
  assert.equal(h.node('register-password').value, '');
  assert.equal(h.node('register-back-link').disabled, true);
  assert.equal(h.node('register-name').disabled, true);
  await h.submit('register-section');
  // A synthetic event can reach the hidden login controls; showView must guard it too.
  await h.click('forgot-link');
  assert.equal(h.node('register-section').classList.contains('active'), true);
  assert.equal(h.node('register-name').value, 'Pessoa de teste');
  assert.equal(h.requests.length, 1);
  resolve({ status: 202, async json() { return { status: 'accepted', state: 'received' }; } });
  await drain();
  assert.equal(h.node('register-back-link').disabled, false);
  await h.click('register-back-link');
  assert.equal(h.doc.activeElement, h.node('register-link'));
});

test('registration rejects unexpected success contracts without claiming approval', async () => {
  for (const [status, body] of [[200, { status: 'accepted', state: 'received' }], [202, { status: 'accepted' }], [202, { status: 'accepted', state: 'received', uid: 'private' }]]) {
    const h = await createLoginHarness({ responseStatus: status, responseBody: body });
    await h.click('register-link');
    h.node('register-password').value = 'senha escolhida';
    h.node('register-password-confirm').value = 'senha escolhida';
    await h.submit('register-section');
    assert.match(h.node('register-error').textContent, /Não foi possível concluir/);
    assert.equal(h.node('register-success').style.display, 'none');
    assert.equal(h.node('register-password').value, '');
  }
});
