import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Node, TestEvent, deferred, drain } from './router-harness.mjs';

export { TestEvent, deferred, drain };
const booleans = new Set(['hidden', 'disabled', 'checked', 'selected', 'inert', 'open']);
const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function parseInto(root, html) {
  const stack = [root];
  const voids = new Set(['area', 'base', 'br', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);
  for (const token of html.match(/<!--[^]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<')) {
      const match = /^<([\w-]+)([^]*?)\/?\s*>$/.exec(token);
      if (!match) continue;
      const [, tag, attributes] = match;
      const node = root.ownerDocument.createElement(tag);
      for (const attr of attributes.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      stack.at(-1).append(node);
      if (!voids.has(tag) && !token.endsWith('/>')) stack.push(node);
    } else if (token.trim()) {
      const node = root.ownerDocument.createElement('#text');
      node.textContent = decode(token); stack.at(-1).append(node);
    }
  }
}
class FixtureNode extends Node {
  constructor(tag, owner) {
    super(tag, owner);
    this.hidden = false; this.disabled = false; this.open = false;
    this.clientWidth = 420; this.clientHeight = 420; this.scrollWidth = 0; this.scrollHeight = 0;
    this.naturalWidth = 800; this.naturalHeight = 800; this.complete = true;
    this.style = { setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] || ''; }, removeProperty(name) { delete this[name]; } };
  }
  get nodeType() { return this.tagName === '#TEXT' ? 3 : 1; }
  get textContent() { return (this._text || '') + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get innerHTML() { return this._markup ?? this.textContent; }
  set innerHTML(value) { this.replaceChildren(); this._markup = String(value); parseInto(this, this._markup); }
  get value() { return this._value ?? this.getAttribute('value') ?? (this.tagName === 'TEXTAREA' ? this.textContent : ''); }
  set value(value) { this._value = String(value); }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children.find(node => node.nodeType === 1) || null; }
  get parentElement() { return this.parentNode; }
  setAttribute(name, value) {
    if (name === 'style') { this.attrs[name] = String(value); return; }
    super.setAttribute(name, value);
    if (booleans.has(name)) this[name] = true;
  }
  removeAttribute(name) { super.removeAttribute(name); if (booleans.has(name)) this[name] = false; }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] ?? null;
    return super.getAttribute(name);
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector.includes(' > ')) { const [parent, child] = selector.split(' > '); return this.matches(child) && this.parentNode?.matches(parent); }
    if (/^\.[\w-]+\.[\w-]+$/.test(selector)) return selector.slice(1).split('.').every(name => this.classList.contains(name));
    return super.matches(selector);
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  replaceChildren(...nodes) { this._text = ''; this._markup = undefined; super.replaceChildren(...nodes); }
  replaceWith(node) { this.parentNode?.insertBefore(node, this); this.remove(); }
  getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight, top: 0, left: 0 }; }
  decode() { return Promise.resolve(); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new TestEvent('close')); }
  dispatchEvent(event) {
    event.target ||= this; event.currentTarget = this;
    this[`on${event.type}`]?.(event);
    const result = super.dispatchEvent(event);
    if (event.bubbles && !event.stopped) this.parentNode?.dispatchEvent(event);
    return result;
  }
  click() {
    if (this.disabled) return;
    if (this.tagName === 'A' && this.download) this.ownerDocument.downloads.push({ name: this.download, href: this.href });
    this.dispatchEvent(new TestEvent('click', { bubbles: true }));
  }
}

// Entire production mounts and their local modules run with the real lifecycle.
// Only DOM, browser rendering/export libraries and external transports are doubles.
export async function createFeedbackHarness(name, { expose = '', fonts = Promise.resolve() } = {}) {
  const html = await readFile(`public/${name}.html`, 'utf8');
  const doc = new FixtureNode('document'); doc.ownerDocument = doc;
  doc.createElement = tag => new FixtureNode(tag, doc);
  doc.createElementNS = (_, tag) => doc.createElement(tag);
  doc.createTextNode = text => { const node = doc.createElement('#text'); node.textContent = text; return node; };
  doc.getElementById = id => doc.querySelector(`#${id}`);
  doc.downloads = []; doc.fonts = { ready: fonts };
  parseInto(doc, html);
  doc.documentElement = doc.querySelector('html'); doc.body = doc.querySelector('body'); doc.activeElement = doc.body;
  const window = new FixtureNode('window', doc);
  Object.assign(window, { history: {}, matchMedia: () => ({ matches: false }), innerHeight: 900, scrollY: 0, confirm: () => true });
  const requests = [], revoked = [], frames = new Map(), timers = new Map(), observers = [], captures = [];
  let resourceId = 0;
  const transport = kind => (path, options = {}) => { const item = { kind, path, options, ...deferred() }; requests.push(item); return item.promise; };
  const context = vm.createContext({
    document: doc, window, console, AbortController, DOMException, URLSearchParams, TextEncoder, structuredClone,
    Event: TestEvent, URL: class extends URL { static revokeObjectURL(url) { revoked.push(url); } },
    setTimeout(fn) { const id = ++resourceId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = ++resourceId; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    fetchAPI: transport('api'), fetchAPIPage: transport('list'), fetchAPIAsset: transport('asset'),
    prompt: () => 'Card de teste', confirm: () => true,
    html2canvas: (canvas, options) => { const item = { canvas, options, ...deferred() }; captures.push(item); return item.promise; },
  });
  async function load(path, exports) {
    const source = (await readFile(path, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, { ${exports} }); })();`, context, { filename: path });
  }
  await load('public/js/page-lifecycle.js', 'createPageLifecycle');
  await load('public/js/ui.js', 'clear, element, safeHttpUrl, setBusy, showState');
  if (name === 'dashboard') await load('public/js/cms-block-renderer.js', 'blocksToText, renderBlocks');
  if (name === 'autocard') {
    await load('public/autocard/crop.js', 'DEFAULT_MEDIA_CROP, cropRenderStyle, cropStyle, dragMediaCrop, normalizeMediaCrop');
    await load('public/autocard/asset-catalog.js', 'searchAssets');
    await load('public/js/pagination.js', 'renderPagination, setPaginationBusy');
  }
  if (name === 'cards-pos') {
    await load('public/cards-pos/card-geometry.js', 'MODULE_CARD_GEOMETRY: CARD_GEOMETRY, fitPreview');
    await load('public/cards-pos/preview-layout.js', 'observePreviewLayout');
    await load('public/cards-pos/draft-state.js', 'createDraftState');
    await load('public/cards-pos/rich-text.js', 'attachRichInput, normalizeRichHtml, moduleRichTextLength: richTextLength, moduleRichTextToPlainText: richTextToPlainText');
    await load('public/cards-pos/field-registry.js', 'collectEditableFields');
    await load('public/cards-pos/inline-editor.js', 'createInlineEditor');
  }
  const path = name === 'dashboard' ? 'public/js/dashboard.js' : `public/${name}/app.js`;
  let source = (await readFile(path, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  const end = source.lastIndexOf('}');
  source = `${source.slice(0, end)}\n${expose}\n${source.slice(end)}`;
  vm.runInContext(`${source}\nglobalThis.page = createPageLifecycle(); mount(page);`, context, { filename: path });
  return {
    doc, window, context, html, requests, revoked, frames, timers, observers, captures, page: context.page,
    node: id => doc.getElementById(id),
    latest: fragment => [...requests].reverse().find(item => item.path.includes(fragment)),
    input(id, value) { const node = doc.getElementById(id); node.value = value; node.dispatchEvent(new TestEvent('input', { bubbles: true })); },
    async flushFrames() { const pending = [...frames]; frames.clear(); pending.forEach(([, fn]) => fn()); await drain(); },
  };
}
