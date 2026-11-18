import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await readFile('public/js/login.js', 'utf8')).replace(/^import[\s\S]*?;\r?\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function harness(fetch) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, style: {}, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      focus() {},
      reportValidity() { return true; },
      querySelectorAll() {
        return ['register-name', 'register-email', 'register-password', 'register-password-confirm', 'register-btn', 'register-back-link'].map(element);
      },
      reset() {
        for (const input of this.querySelectorAll()) input.value = '';
      },
    });
    return elements.get(id);
  }
  await new AsyncFunction('document', 'auth', 'location', 'fetch', source)(
    { getElementById: element, querySelector: () => null },
    { authStateReady: async () => {}, currentUser: null },
    { search: '' }, fetch,
  );
  async function submit() {
    element('register-name').value = 'Pessoa Teste';
    element('register-email').value = 'person@example.test';
    element('register-password').value = '  senha com espaços  ';
    element('register-password-confirm').value = '  senha com espaços  ';
    const form = element('register-section');
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
  }
  return { element, submit };
}

for (const scenario of [
  { status: 429, retry: '125', match: /Muitas solicitações.*Aguarde 3 minutos/ },
  { status: 429, retry: '1', match: /Aguarde 1 segundo/ },
  { status: 429, retry: 'invalid', match: /Aguarde alguns minutos/ },
  { status: 429, retry: null, match: /Aguarde alguns minutos/ },
  { status: 503, retry: '5', reason: 'registration_busy', match: /muitas solicitações no momento.*Aguarde 5 segundos/ },
  { status: 503, match: /temporariamente indisponível.*Tente novamente em instantes/ },
  { status: 400, match: /Confira nome, e-mail e senha/ },
  { status: 502, match: /Não foi possível confirmar o recebimento/ },
]) {
  test(`registration form explains HTTP ${scenario.status}, retry ${scenario.retry} without exposing the server body`, async () => {
    let calls = 0;
    const h = await harness(async () => {
      calls++;
      return {
        status: scenario.status,
        headers: new Headers(scenario.retry ? { 'Retry-After': scenario.retry } : {}),
        json: async () => ({ error: 'secret server details', reason: scenario.reason }),
      };
    });
    await h.submit();
    assert.match(h.element('register-error').textContent, scenario.match);
    assert.doesNotMatch(h.element('register-error').textContent, /secret server details/);
    assert.equal(h.element('register-password').value, '');
    assert.equal(h.element('register-password-confirm').value, '');
    assert.equal(h.element('register-email').value, 'person@example.test');
    assert.equal(h.element('register-success').style.display, 'none');
    assert.equal(h.element('register-btn').disabled, false);
    assert.equal(calls, 1, 'no automatic retries');
  });
}

test('registration form distinguishes connection failure from received confirmation', async () => {
  const h = await harness(async () => { throw new TypeError('Failed to fetch'); });
  await h.submit();
  assert.match(h.element('register-error').textContent, /Verifique sua conexão/);
  assert.equal(h.element('register-btn').disabled, false);
  assert.equal(h.element('register-password').value, '');
});

test('registration form remains locked during the wait, then confirms only the exact accepted response', async () => {
  let deliver;
  let calls = 0;
  const h = await harness(() => {
    calls++;
    return new Promise(resolve => { deliver = resolve; });
  });
  const submission = h.submit();
  assert.equal(h.element('register-btn').disabled, true);
  assert.equal(h.element('register-btn').textContent, 'Enviando…');
  assert.equal(h.element('register-password').value, '');
  await h.submit();
  assert.equal(calls, 1);
  deliver({ status: 202, json: async () => ({ status: 'accepted', state: 'received' }) });
  await submission;
  assert.equal(h.element('register-success').style.display, 'block');
  assert.match(h.element('register-success').textContent, /aguarde a aprovação/);
  assert.equal(h.element('register-btn').disabled, true);
  assert.equal(h.element('register-password').value, '');
});

for (const body of [{ status: 'accepted' }, { status: 'accepted', state: 'received', other: true }, null]) {
  test(`registration form never confirms a malformed 202: ${JSON.stringify(body)}`, async () => {
    const h = await harness(async () => ({ status: 202, json: async () => body }));
    await h.submit();
    assert.equal(h.element('register-success').style.display, 'none');
    assert.match(h.element('register-error').textContent, /Não foi possível confirmar/);
    assert.equal(h.element('register-btn').disabled, false);
  });
}
