import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRouterHarness, Node, TestEvent, deferred, drain } from './router-harness.mjs';

export { TestEvent, drain };
const booleans = new Set(['hidden', 'disabled', 'checked', 'selected', 'inert', 'required', 'readonly']);
const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function parse(root, html) {
  const stack = [root], voids = new Set(['input', 'meta', 'link', 'img', 'br', 'hr']);
  for (const token of html.match(/<!--[^]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (token.startsWith('<')) {
      const [, tag, attrs] = /^<([\w-]+)([^]*?)\/?\s*>$/.exec(token);
      const node = root.ownerDocument.createElement(tag);
      for (const attr of attrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      stack.at(-1).append(node);
      if (!voids.has(tag)) stack.push(node);
    } else if (token.trim()) stack.at(-1).append(root.ownerDocument.createTextNode(decode(token)));
  }
}

// Only DOM/form mechanics are doubles. Parse all admin.html, run the entire
// admin mount, its helper, bulk ticket, UI, lifecycle and real router/history.
class AdminNode extends Node {
  constructor(tag, doc) { super(tag, doc); this.hidden = false; this.disabled = false; this.checked = false; this.required = false; }
  get textContent() { return (this._text || '') + this.children.map(node => node.textContent || '').join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  replaceChildren(...nodes) { this._text = ''; super.replaceChildren(...nodes); }
  get options() { return this.querySelectorAll('option'); }
  get value() {
    if (this.tagName === 'SELECT') {
      const option = this._value === undefined ? this.options.find(item => item.selected) || this.options[0] : this.options.find(item => item.value === this._value);
      return option?.value || '';
    }
    return this._value ?? this.getAttribute('value') ?? '';
  }
  set value(value) { this._value = String(value); }
  setAttribute(key, value) { super.setAttribute(key, value); if (booleans.has(key)) this[key] = true; }
  removeAttribute(key) { super.removeAttribute(key); if (booleans.has(key)) this[key] = false; }
  dispatchEvent(event) {
    event.target ||= this; event.currentTarget = this;
    const result = super.dispatchEvent(event);
    if (event.bubbles && !event.stopped) this.parentNode?.dispatchEvent(event);
    return result;
  }
  click() { if (!this.disabled) this.dispatchEvent(new TestEvent('click', { bubbles: true })); }
  reset() { this.querySelectorAll('input, select, textarea').forEach(node => { node._value = undefined; node.checked = node.hasAttribute('checked'); }); }
  reportValidity() { return this.querySelectorAll('input, select, textarea').every(node => node.disabled || !node.required || Boolean(node.value)); }
  setCustomValidity(message) { this.validationMessage = message; }
}

export const manager = { uid: 'user-1', role: 'admin', permissions: { manageUsers: true } };
export const superadmin = { uid: 'user-1', role: 'admin', permissions: { superAdmin: true } };
export const titleId = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const titleFixtures = (count = 105) => Array.from({ length: count }, (_, i) => ({ id: titleId(i + 1), name: `Cargo ${i + 1}`, active: i !== 103, user_count: i }));

export async function createAdminUIHarness(t, { search = '?tab=users', user = manager } = {}) {
  const h = await createRouterHarness({ initialURL: `https://portal.test/admin.html${search}`, user, autoStart: false, realUI: true });
  const { doc, context, window } = h;
  doc.createElement = tag => new AdminNode(tag, doc);
  doc.createTextNode = text => { const node = doc.createElement('#text'); node.textContent = text; return node; };
  const root = doc.createElement('document');
  const html = await readFile('public/admin.html', 'utf8'); parse(root, html);
  doc.documentElement = root.querySelector('html'); doc.head = root.querySelector('head'); doc.body = root.querySelector('body'); doc.activeElement = doc.body;
  doc.documentElement.dataset.authSnapshot = 'true';
  const requests = [], confirms = [];
  const transport = kind => (path, options = {}) => { const request = { kind, path, options, ...deferred() }; requests.push(request); return request.promise; };
  Object.assign(context, { fetchAPI: transport('api'), fetchAPIPage: transport('list'), localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, confirm: message => { confirms.push(message); return true; } });
  context.FormData = class {
    constructor(form) { this.form = form; }
    entries() { return this.form.querySelectorAll('[name]').filter(node => !node.disabled && (node.type !== 'checkbox' || node.checked)).map(node => [node.name, node.value]); }
  };
  async function load(path, exports) {
    const source = (await readFile(path, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, { ${exports} }); })();`, context, { filename: path });
  }
  await load('public/js/bulk-preview-state.js', 'createBulkPreviewState');
  await load('public/js/admin-list-state.js', 'ADMIN_LIST_FIELDS, readAdminListURL, writeAdminListURL, validateAdminFilters, adminListQuery');
  await load('public/js/admin.js', 'adminMount: mount');
  context.onMount = (name, page) => { if (name === './admin.js') context.adminMount(page); };
  await h.router.startRouter(); await drain();
  t.after(() => { h.scope?.dispose(); context.disposePageUI(); });
  const node = id => doc.getElementById(id);
  return {
    ...h, html, requests, confirms, node, page: h.scope,
    latest: prefix => [...requests].reverse().find(request => request.path.startsWith(prefix)),
    async resolve(request, data = [], total = data.length) { request.resolve({ data, total }); await drain(); },
    async reject(request) { request.reject(new Error('Controlled failure')); await drain(); },
    async submit(id, fields = {}) { for (const [field, value] of Object.entries(fields)) node(field).value = value; node(id).dispatchEvent(new TestEvent('submit')); await drain(); },
    async click(id) { node(id).click(); await drain(); },
    async catalog(titles = titleFixtures()) {
      for (let offset = 0; offset < titles.length || offset === 0; offset += 100) {
        const request = [...requests].reverse().find(item => item.path === `/api/job-titles?all=true&limit=100&offset=${offset}`);
        if (!request) throw new Error(`Catalog page ${offset} was not requested`);
        request.resolve({ data: titles.slice(offset, offset + 100), total: titles.length }); await drain();
      }
    },
    async back() { h.history.go(-1); await drain(); },
    async forward() { h.history.go(1); await drain(); },
  };
}
