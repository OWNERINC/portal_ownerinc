import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness() {
  const source = (await readFile('public/pages/editor-menus.js', 'utf8')).replace(/^export /gm, '');
  class TrackedTarget extends EventTarget {
    listeners = new Map();
    addEventListener(type, callback, options) { super.addEventListener(type, callback, options); if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback, options) { super.removeEventListener(type, callback, options); this.listeners.get(type)?.delete(callback); }
    count(type) { return this.listeners.get(type)?.size || 0; }
  }
  class Node extends TrackedTarget {
    open = false;
    isConnected = true;
    summary = { isConnected: true, focus: () => { focused = this; }, contains: node => node === this.summary };
    querySelector() { return this.summary; }
    contains(node) { return node === this || node === this.summary; }
  }
  let focused, cleanup;
  const window = new TrackedTarget(), document = { querySelector: () => null };
  const context = vm.createContext({ window, document });
  vm.runInContext(source, context);
  const menus = context.createEditorMenus({ page: { cleanup: fn => { cleanup = fn; } } });
  const event = (type, props = {}) => {
    const e = new Event(type, { cancelable: true });
    Object.entries(props).forEach(([key, value]) => Object.defineProperty(e, key, { value }));
    window.dispatchEvent(e); return e;
  };
  const a = new Node(), b = new Node();
  return { menus, a, b, window, document, event, focused: () => focused, cleanup: () => cleanup() };
}

test('only registered transient menus close; unregister and dispose release ownership', async () => {
  const { menus, a, b, event, cleanup } = await harness();
  menus.register(a); const unregister = menus.register(b);
  a.open = true; a.dispatchEvent(new Event('toggle'));
  b.open = true; b.dispatchEvent(new Event('toggle'));
  assert.equal(a.open, false); assert.equal(b.open, true);
  unregister(); event('pointerdown', { target: {} }); assert.equal(b.open, false);
  a.open = true; cleanup(); assert.equal(a.open, false);
  a.open = true; event('pointerdown', { target: {} }); assert.equal(a.open, true);
  menus.dispose();
});

test('Escape consumes one layer, restores summary, and respects IME and higher dialogs', async () => {
  const { menus, a, document, event, focused } = await harness(); menus.register(a);
  a.open = true;
  assert.equal(event('keydown', { key: 'Escape', isComposing: true }).defaultPrevented, false);
  assert.equal(a.open, true);
  assert.equal(event('keydown', { key: 'Escape', keyCode: 229 }).defaultPrevented, false);
  document.querySelector = () => ({});
  assert.equal(event('keydown', { key: 'Escape' }).defaultPrevented, false); assert.equal(a.open, true);
  document.querySelector = () => null;
  const escape = event('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true); assert.equal(a.open, false); assert.equal(focused(), a);
  a.open = true; menus.closeAll(); assert.equal(focused(), a);
});

test('unregister and visit disposal remove keydown, pointerdown, click and toggle subscriptions', async () => {
  const { menus, a, b, window, event, cleanup, focused } = await harness();
  menus.register(a); const unregister = menus.register(b);
  for (const node of [a,b]) for (const type of ['click','toggle']) assert.equal(node.count(type),1);
  for (const type of ['keydown','pointerdown']) assert.equal(window.count(type),1);
  unregister(); unregister();
  for (const type of ['click','toggle']) assert.equal(b.count(type),0);
  cleanup(); menus.dispose();
  for (const type of ['keydown','pointerdown']) assert.equal(window.count(type),0);
  for (const node of [a,b]) for (const type of ['click','toggle']) assert.equal(node.count(type),0);
  a.open=true; b.open=true;
  assert.equal(event('keydown',{key:'Escape'}).defaultPrevented,false);
  event('pointerdown',{target:{}}); a.dispatchEvent(new Event('toggle'));
  b.dispatchEvent(new Event('click'));
  assert.equal(a.open,true); assert.equal(b.open,true); assert.equal(focused(),undefined);
  menus.register(a); assert.equal(a.count('toggle'),0,'disposed controller cannot reacquire listeners');
});

test('outside pointerdown neither cancels the next action nor steals focus; inside is retained', async () => {
  const { menus, a, event, focused } = await harness(); menus.register(a); a.open = true;
  event('pointerdown', { target: a.summary }); assert.equal(a.open, true);
  assert.equal(event('pointerdown', { target: {} }).defaultPrevented, false);
  assert.equal(a.open, false); assert.equal(focused(), undefined);
  a.open = true; menus.closeAll({ restoreFocus: true }); assert.equal(focused(), a);
});
