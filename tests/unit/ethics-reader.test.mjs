import assert from 'node:assert/strict';
import test from 'node:test';
import { createEthicsReader } from '../../public/js/ethics-reader.js';
import { safeDestination } from '../../public/js/portal-destination.js';

function target(properties = {}) {
  const listeners = new Map();
  return { ...properties, addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }, fire(name) { listeners.get(name)?.(); }, listeners };
}
function setup(overrides = {}) {
  const reader = target({ scrollHeight: 1000, clientHeight: 300, scrollTop: 0, ...overrides });
  const checkbox = target({ checked: false });
  const button = {};
  const status = {};
  const form = { setAttribute(name, value) { this[name] = value; } };
  const controller = createEthicsReader({ reader, checkbox, button, status, form });
  return { reader, checkbox, button, status, form, controller };
}

test('scroll completion only enables checkbox; explicit checked choice and non-busy state are mandatory', () => {
  const h = setup();
  assert.equal(h.checkbox.disabled, true);
  assert.equal(h.button.disabled, true);
  h.checkbox.checked = true;
  h.checkbox.fire('change');
  assert.equal(h.controller.canAccept(), false, 'scripted check cannot replace reaching the end');
  h.checkbox.checked = false;
  h.reader.scrollTop = 600;
  h.reader.fire('scroll');
  assert.equal(h.checkbox.disabled, true);
  h.reader.scrollTop = 699.5;
  h.reader.fire('scroll');
  assert.equal(h.checkbox.disabled, false);
  assert.equal(h.button.disabled, true);
  h.checkbox.checked = true;
  h.checkbox.fire('change');
  assert.equal(h.controller.canAccept(), true);
  assert.equal(h.button.disabled, false);
  h.controller.setBusy(true);
  assert.equal(h.controller.canAccept(), false);
  assert.equal(h.checkbox.disabled, true);
  assert.equal(h.button.disabled, true);
  assert.equal(h.form['aria-busy'], 'true');
  h.controller.setBusy(false);
  assert.equal(h.controller.canAccept(), true);
  h.checkbox.checked = false;
  h.checkbox.fire('change');
  assert.equal(h.button.disabled, true);
  h.controller.destroy();
  assert.equal(h.reader.listeners.size, 0);
  assert.equal(h.checkbox.listeners.size, 0);
});

test('a fully visible short term is eligible; hidden content never unlocks acceptance', () => {
  const short = setup({ scrollHeight: 100, clientHeight: 300 });
  assert.equal(short.checkbox.disabled, false);
  assert.equal(short.button.disabled, true);
  short.controller.destroy();
  const hidden = setup({ scrollHeight: 0, clientHeight: 0 });
  assert.equal(hidden.checkbox.disabled, true);
  hidden.controller.destroy();
});

test('scroll completion remains available on scroll back, and a fresh term resets reading and choice', () => {
  const h = setup();
  h.reader.scrollTop = 700;
  h.reader.fire('scroll');
  h.reader.scrollTop = 0;
  h.reader.fire('scroll');
  assert.equal(h.checkbox.disabled, false);
  h.controller.destroy();
  const fresh = setup();
  assert.equal(fresh.checkbox.disabled, true);
  assert.equal(fresh.controller.canAccept(), false);
  fresh.controller.destroy();
});

test('return destinations preserve internal document query/hash and reject external or loop destinations', () => {
  const origin = 'https://portal.example.test';
  assert.equal(safeDestination('/academy.html?course=123#lesson', origin), '/academy.html?course=123#lesson');
  for (const value of [null, '', 'javascript:alert(1)', 'https://external.test/profile.html', '//external.test/admin.html',
    '/login.html?next=/ethics.html', '/ethics.html', '/index.html', '/api/users/me', '/uploads/file.webp']) {
    assert.equal(safeDestination(value, origin), './dashboard.html');
  }
});
