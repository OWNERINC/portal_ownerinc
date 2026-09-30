import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Node, TestEvent, deferred, drain } from './router-harness.mjs';

export { TestEvent, drain };

const booleanAttributes = new Set(['hidden', 'disabled', 'required', 'checked', 'selected', 'inert', 'novalidate', 'open']);

// Extend the shared DOM double with text/form behavior used by both CMS and
// reminder filters. No application state or loader logic is reproduced here.
class FormNode extends Node {
  constructor(tag, owner, attrs = {}) {
    super(tag, owner, attrs);
    for (const key of booleanAttributes) this[key] = this.hasAttribute(key);
    this.validity = { badInput: false };
    this.files = [];
  }
  get textContent() { return (this._text || '') + this.children.map(node => node.textContent || '').join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const options = this.querySelectorAll('option');
      return (options.find(option => option.selected) || options[0])?.value || '';
    }
    return this.getAttribute('value') || '';
  }
  set value(value) { this._value = String(value); }
  setAttribute(name, value) {
    super.setAttribute(name, value);
    if (booleanAttributes.has(name)) this[name] = true;
  }
  removeAttribute(name) {
    super.removeAttribute(name);
    if (booleanAttributes.has(name)) this[name] = false;
  }
  replaceChildren(...nodes) { this._text = ''; super.replaceChildren(...nodes); }
  replaceWith(node) { this.parentNode?.insertBefore(node, this); this.remove(); }
  reset() {
    this.querySelectorAll('input, select, textarea').forEach(field => {
      field._value = undefined;
      field.checked = field.hasAttribute('checked');
      field.validity.badInput = false;
    });
  }
  reportValidity() { return true; }
}

export function parseFixture(html) {
  const doc = new FormNode('document');
  doc.ownerDocument = doc;
  doc.createElement = tag => new FormNode(tag, doc);
  doc.createTextNode = text => { const node = doc.createElement('#text'); node.textContent = text; return node; };
  doc.getElementById = id => doc.querySelector(`#${id}`);
  const decode = text => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);
  const stack = [doc];
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (token.startsWith('<')) {
      const [, tag, attributeText] = /^<([\w-]+)([\s\S]*?)\/?\s*>$/.exec(token);
      const node = doc.createElement(tag);
      for (const match of attributeText.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        node.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? ''));
      }
      stack.at(-1).append(node);
      if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(node);
    } else if (token.trim()) stack.at(-1).append(doc.createTextNode(decode(token)));
  }
  doc.documentElement = doc.querySelector('html');
  doc.body = doc.querySelector('body');
  doc.activeElement = doc.body;
  return doc;
}

// Mount the complete production module, UI helpers, renderer and lifecycle.
// Only browser DOM and external transports/timers are doubled. Transports
// deliberately ignore abort so tests exercise the lifecycle's late-result guard.
export async function createMountedHarness(name = 'cms', { user = { permissions: { superAdmin: true } } } = {}) {
  const html = await readFile(`public/${name}.html`, 'utf8');
  const doc = parseFixture(html);
  const requests = [], revoked = [], observers = [], editorCallbacks = [], timers = new Map();
  let timerId = 0;
  const window = new FormNode('window', doc);
  const location = new URL(`https://portal.test/${name}.html`);
  window.history = {};
  const request = kind => (path, options = {}) => {
    const pending = { kind, path, options, ...deferred() };
    requests.push(pending);
    return pending.promise;
  };
  const context = vm.createContext({
    document: doc, window, location, console, AbortController, DOMException,
    URL: class extends URL { static revokeObjectURL(url) { revoked.push(url); } },
    URLSearchParams, TextEncoder, structuredClone,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { return context.setTimeout(fn); },
    cancelAnimationFrame(id) { context.clearTimeout(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.target = null; }
    },
    FormData: class { constructor() { this.parts = []; } append(...part) { this.parts.push(part); } },
    can: (profile, permission) => !!(profile.permissions?.superAdmin || profile.permissions?.[permission]),
    fetchAPI: request('api'), fetchAPIPage: request('list'), fetchAPIAsset: request('asset'),
    showToast() {},
  });
  let confirms = 0;
  window.confirm = () => { confirms++; return context.confirmResult === true; };
  async function loadModule(path, exports) {
    const source = (await readFile(path, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => {\n${source}\nObject.assign(globalThis, { ${exports.join(', ')} });\n})();`, context, { filename: path });
  }
  await loadModule('public/js/ui.js', ['clear', 'element', 'showState', 'safeHttpUrl', 'openDialog', 'closeDialog', 'setDialogCloseGuard']);
  await loadModule('public/js/page-lifecycle.js', ['createPageLifecycle']);
  await loadModule('public/js/cms-block-renderer.js', ['renderBlocks', 'cleanupRenderedBlocks', 'validateBlocks', 'BLOCK_TYPES']);
  if (name === 'cms') {
    await loadModule('public/js/pagination.js', ['renderPagination']);
    await loadModule('public/js/cms-editor-values.js', ['normalizeEditorBlocks']);
    await loadModule('public/js/cms-block-editor.js', ['createBlockEditor', 'createBlockSettings', 'serializeBlocks', 'STANDARD_BLOCK_TYPES']);
    await loadModule('public/js/owner-news/model.js', ['normalizeEditorial', 'getNewsPresentation', 'estimateNewsReadTime']);
    await loadModule('public/js/owner-news/reader-view.js', ['renderNewsArticle']);
    await loadModule('public/js/owner-news/cms-editorial.js', ['createEditorialFields', 'editorialPublicationError']);
    await loadModule('public/js/owner-news/cms-home.js', ['mountNewsHomeEditor']);
    const createEditor = context.createBlockEditor;
    context.createBlockEditor = options => { editorCallbacks.push(options); return createEditor(options); };
  }
  await loadModule(`public/js/${name}.js`, ['mount']);
  const page = context.createPageLifecycle({ user });
  page.location = location;
  context.mount(page);
  return {
    doc, html, window, context, page, requests, revoked, observers, editorCallbacks, timers,
    get confirms() { return confirms; },
    node: id => doc.getElementById(id),
    matching: fragment => requests.filter(request => request.path.includes(fragment)),
    latest: fragment => [...requests].reverse().find(request => request.path.includes(fragment)),
    submit(id) { doc.getElementById(id).dispatchEvent(new TestEvent('submit')); },
    input(node, value) { node.value = value; node.dispatchEvent(new TestEvent('input')); },
    async runTimers() {
      const pending = [...timers]; timers.clear();
      pending.forEach(([, callback]) => callback());
      await drain();
    },
  };
}
