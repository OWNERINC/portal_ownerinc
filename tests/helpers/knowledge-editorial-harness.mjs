import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseFixture } from './cms-harness.mjs';
import { createRouterHarness, TestEvent, deferred, drain } from './router-harness.mjs';

export { TestEvent, drain };
export const editor = { uid: 'user-1', role: 'admin', permissions: { manageKnowledge: true } };

// Parse the actual HTML and run the whole Knowledge module, renderer, UI and
// router/lifecycle with DOM/form/auth/transport doubles. The destination CMS
// mount is a marker, not its real editor; CMS has a separate mounted harness.
export async function createKnowledgeEditorialHarness(t, { user = editor } = {}) {
  const h = await createRouterHarness({ initialURL: 'https://portal.test/knowledge.html', user, autoStart: false, realUI: true });
  const { doc, context } = h;
  const html = await readFile('public/knowledge.html', 'utf8');
  const fixture = parseFixture(html), FormNode = fixture.body.constructor;
  doc.documentElement = fixture.documentElement; doc.head = fixture.querySelector('head'); doc.body = fixture.body; doc.activeElement = doc.body;
  const adopt = node => {
    node.ownerDocument = doc;
    node.hasChildNodes = () => Boolean(node.childNodes.length || node.textContent);
    if (node.tagName === 'A') Object.defineProperty(node, 'href', {
      configurable: true,
      get() { const value = this.getAttribute('href'); return value ? new URL(value, h.location.href).href : ''; },
      set(value) { this.attrs.href = String(value); },
    });
    node.children.forEach(adopt);
  };
  adopt(doc.documentElement);
  doc.createElement = tag => { const node = new FormNode(tag, doc); adopt(node); return node; };
  doc.createTextNode = text => { const node = doc.createElement('#text'); node.textContent = text; return node; };
  doc.documentElement.dataset.authSnapshot = 'true';
  const requests = [], revoked = [], confirms = [], errors = [];
  const transport = kind => (path, options = {}) => { const call = { kind, path, options, ...deferred() }; requests.push(call); return call.promise; };
  Object.assign(context, {
    console: { ...console, error: (...args) => errors.push(args) },
    fetchAPI: transport('api'), fetchAPIPage: transport('list'), fetchAPIAsset: transport('asset'), TextEncoder, structuredClone,
    URL: class extends URL { static revokeObjectURL(url) { revoked.push(url); } },
    FormData: class {
      constructor(form) { this.form = form; this.parts = []; }
      append(...parts) { this.parts.push(parts); }
      entries() { return this.form ? this.form.querySelectorAll('[name]').filter(node => !node.disabled && (node.type !== 'checkbox' || node.checked)).map(node => [node.name, node.value || '']) : this.parts; }
    },
  });
  h.window.confirm = message => { confirms.push(message); return context.confirmResult !== false; };
  context.confirm = h.window.confirm;
  async function load(path, exports) {
    const source = (await readFile(path, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, { ${exports} }); })();`, context, { filename: path });
  }
  await load('public/js/pagination.js', 'renderPagination, readOffset, setPaginationBusy');
  await load('public/js/cms-block-renderer.js', 'blocksToText, renderBlocks');
  await load('public/js/knowledge.js', 'knowledgeMount: mount');
  context.onMount = (name, page) => { if (name === './knowledge.js') context.knowledgeMount(page); };
  await h.router.startRouter(); await drain();
  const page = h.scope;
  t.after(() => { h.scope?.dispose(); page?.dispose(); context.disposePageUI(); });
  const latest = fragment => [...requests].reverse().find(call => call.path.includes(fragment));
  const node = id => doc.getElementById(id);
  latest('/api/knowledge?').resolve({ data: [], total: 0 });
  latest('/api/knowledge/categories').resolve([]); await drain();
  return {
    ...h, html, page, node, requests, revoked, confirms, errors, latest,
    async showArticle(article, edit = true) {
      page.history.pushState({}, '', `/knowledge.html?article=${encodeURIComponent(article.id)}`);
      h.window.dispatchEvent(new TestEvent('popstate', { state: h.history.state })); await drain();
      latest('/api/knowledge?').resolve({ data: [article], total: 1 }); latest('/api/knowledge/categories').resolve([article.category]); await drain();
      latest(`/api/knowledge/${article.id}`).resolve(article); await drain();
      if (edit) { node('article-admin-bar').querySelectorAll('button').find(button => button.textContent === 'Editar')?.click(); await drain(); }
    },
    input(id, value) { node(id).value = value; node(id).dispatchEvent(new TestEvent('input')); },
    async submit() { node('article-form').dispatchEvent(new TestEvent('submit')); await drain(); },
    async followCmsLink() {
      const anchor = node('article-cms-link');
      if (!anchor) throw new Error('No authorized CMS link');
      doc.dispatchEvent(new TestEvent('click', { target: anchor })); await drain();
    },
    async uploadPdf() { node('f-pdf').files = [{ name: 'synthetic.pdf', type: 'application/pdf', size: 100 }]; node('f-pdf').dispatchEvent(new TestEvent('change')); await drain(); return latest('/api/cms/assets'); },
  };
}
