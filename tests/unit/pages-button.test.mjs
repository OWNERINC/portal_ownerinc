import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { FixtureNode, deferred, drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';
import { featureDocument } from '../helpers/pages-reference-document.mjs';
const require = createRequire(import.meta.url);
const { validateDocument } = require('../../api/pages/validation');

test('the extended v3 local icon vocabulary reaches the existing button without changing its action/state contract', async () => {
  const h=await harness();
  for(const icon of ['coffee','users','headphones','shirt','info','alert']) {
    const component=h.context.createPageButton({label:'Local',preset:'secondary',icon,action:{type:'url',value:'/profile.html'}});
    assert.equal(component.node.querySelectorAll('svg').length,1);assert.equal(component.node.querySelectorAll('img').length,0);
    assert.equal(component.node.getAttribute('href'),'/profile.html');component.setDisabled(true);assert.equal(component.node.hasAttribute('href'),false);component.dispose();
  }
});

async function harness() {
  const document = new FixtureNode('document'); document.ownerDocument = document;
  document.createElement = tag => new FixtureNode(tag, document);
  document.createElementNS = (_, tag) => document.createElement(tag);
  document.body = document.createElement('body'); document.append(document.body); document.downloads = [];
  const revoked = [], requests = [], controller = new AbortController();
  const context = vm.createContext({ document, AbortController, URLSearchParams, console,
    URL: class extends URL { static revokeObjectURL(value) { revoked.push(value); } },
    window: { location: { href: 'https://portal.test/conteudos/guia?preview=1' }, history: { state: {}, pushState(_s,_t,href) { this.href = href; } } } });
  for (const [file, names] of [['dom','el'], ['model','safeLink'], ['api','createPagesAPI'], ['render-blocks-v3','v3Icon,renderV3Block'], ['button','createPageButton']]) {
    const source = (await readFile(`public/pages/${file}.js`, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis,{${names}}); })()`, context);
  }
  const options = { api: { download(...args) { const item = { args, ...deferred() }; requests.push(item); return item.promise; } },
    pageId: 'page', revisionId: 'revision', host: document.body, signal: controller.signal };
  const create = (action = { type: 'download', media_id: 'media', kind: 'image', file_name: 'guia.webp' }, extra = {}) => {
    const component = context.createPageButton({ label: 'Baixar material', preset: 'secondary', action, context: { ...options, ...extra } });
    document.body.append(component.node); return component;
  };
  return { context, document, revoked, requests, controller, options, create };
}
test('private download is scoped, busy prevents double click, retry is honest and filename uses only an ephemeral blob', async () => {
  const h = await harness(), component = h.create();
  component.node.click(); component.node.click(); assert.equal(h.requests.length, 1);
  assert.equal(component.node.getAttribute('aria-busy'), 'true');
  assert.equal(h.requests[0].args[0], 'page'); assert.equal(h.requests[0].args[2].revisionId, 'revision');
  h.requests[0].reject(new Error('offline')); await drain();
  assert.equal(component.node.disabled, false); assert.match(component.node.textContent, /Não foi possível/);
  assert.equal(h.document.downloads.length, 0);
  component.node.click(); h.requests[1].resolve('blob:private'); await drain();
  assert.deepEqual(h.document.downloads, [{ name: 'guia.webp', href: 'blob:private' }]);
  assert.ok(h.revoked.includes('blob:private')); assert.equal(h.document.body.querySelectorAll('a').length, 0);
  assert.doesNotMatch(component.node.textContent, /Salvo/); component.dispose();
});
test('disabled, dispose and account signal block late downloads, abort requests and revoke even an abort-ignoring response', async () => {
  for (const exit of ['dispose','account']) {
    const h = await harness(), component = h.create(); component.setDisabled(true);
    component.node.dispatchEvent(new TestEvent('click')); assert.equal(h.requests.length, 0);
    component.setDisabled(false); component.node.click();
    if (exit === 'dispose') component.dispose(); else h.controller.abort();
    assert.equal(h.requests[0].args[2].signal.aborted, true);
    h.requests[0].resolve('blob:late'); await drain(); assert.ok(h.revoked.includes('blob:late')); assert.equal(h.document.downloads.length, 0);
    component.node.dispatchEvent(new TestEvent('click')); assert.equal(h.requests.length, 1);
  }
});
test('UI commands require author authorization and fulfilled ACK; false/void/rejected promises never claim Saved', async () => {
  const h = await harness(); let calls = 0;
  const denied = h.create(null, { command: 'upload', onCommand() { calls++; } }); denied.node.click(); assert.equal(calls, 0);
  for (const outcome of [undefined, false, { nope: true }]) {
    const component = h.create(null, { command: 'save', canAuthor: true, onCommand: async () => outcome });
    component.node.click(); await drain(); assert.doesNotMatch(component.node.textContent, /Salvo/); component.dispose();
  }
  const pending = deferred();
  const component = h.create(null, { command: 'save', canAuthor: true, onCommand: () => pending.promise });
  component.node.click(); assert.doesNotMatch(component.node.textContent, /Salvo/);
  pending.resolve({ acknowledged: true }); await drain(); assert.match(component.node.textContent, /Salvo/);
  assert.equal(component.node.dataset.preset, 'confirmed');
  const sync = h.create(null, { command: 'save', canAuthor: true, onCommand: () => ({ acknowledged: true }) });
  sync.node.click(); await drain(); assert.doesNotMatch(sync.node.textContent, /Salvo/);
  let attempt = 0;
  const retry = h.create(null, { command: 'save', canAuthor: true, onCommand: async () => { if (++attempt === 1) return { acknowledged: true }; throw new Error('uncertain ACK'); } });
  retry.node.click(); await drain(); assert.match(retry.node.textContent, /Salvo/);
  retry.node.click(); await drain(); assert.doesNotMatch(retry.node.textContent, /Salvo/); assert.match(retry.node.textContent, /Não foi possível/);
  const late = deferred(), disposed = h.create(null, { command: 'save', canAuthor: true, onCommand: () => late.promise });
  disposed.node.click(); disposed.dispose(); late.resolve({ acknowledged: true }); await drain(); assert.doesNotMatch(disposed.node.textContent, /Salvo/);
});
test('save ACK for an older revision is not Saved; a later dirty edit resets confirmation without erasing component DOM',async()=>{
  const h=await harness();
  const older=h.create(null,{command:'save',canAuthor:true,onCommand:async()=>({acknowledged:true,current:false})});
  older.node.click();await drain();assert.notEqual(older.node.dataset.preset,'confirmed');assert.match(older.node.textContent,/alterações não salvas/);
  const current=h.create(null,{command:'save',canAuthor:true,onCommand:async()=>({acknowledged:true,current:true})});
  const text=current.node.querySelector('.pages-button-label'),status=current.node.querySelector('.pages-button-status');
  current.node.click();await drain();assert.equal(current.node.dataset.preset,'confirmed');current.resetConfirmation();
  assert.equal(current.node.querySelector('.pages-button-label'),text);assert.equal(current.node.querySelector('.pages-button-status'),status);
  assert.equal(current.node.getAttribute('aria-label'),'Baixar material');assert.equal(current.node.querySelectorAll('svg').length,1);
});

test('all four validated download kinds retain canonical filenames, rejecting hostile names and non-blob responses', async () => {
  for (const [kind,extension] of [['image','webp'],['gif','gif'],['audio','mp3'],['video','mp4']]) {
    const h = await harness(), component = h.create({type:'download',media_id:'media',kind,file_name:`material.${extension}`});
    component.node.click(); h.requests[0].resolve(`blob:${kind}`); await drain();
    assert.equal(h.document.downloads[0].name,`material.${extension}`); assert.ok(h.revoked.includes(`blob:${kind}`));
  }
  for (const name of ['../guia.webp','x\r\n.webp','x\u0085.webp','fake.mp4','.webp']) {
    const h = await harness(), component = h.create({type:'download',media_id:'media',kind:'image',file_name:name});
    component.node.click(); await drain(); assert.equal(h.requests.length,0);assert.equal(h.document.downloads.length,0);
  }
  const h = await harness(), component = h.create();component.node.click();h.requests[0].resolve('https://portal.test/private');await drain();
  assert.equal(h.document.downloads.length,0);assert.equal(component.node.disabled,false);
});
test('URL and section navigation stay safe on friendly/preview URL; video delegates focus/load without playback or iframe', async () => {
  const h = await harness();
  const section = h.document.createElement('section'); section.setAttribute('id', 'section-10000000-0000-4000-8000-000000000001'); h.document.body.append(section);
  const component = h.create({ type: 'section', value: section.id.slice(8) }); component.node.click();
  assert.equal(h.context.window.history.href, undefined, 'revision previews only focus; they do not write browser history');
  assert.equal(h.document.activeElement, section);
  const unsafe = h.create({ type: 'url', value: 'javascript:alert(1)' }); assert.equal(unsafe.node.getAttribute('href'), null);
  let activated = 0;
  const video = h.create({ type: 'video', value: 'video-id' }, { resolveBlock: () => ({ type: 'video_embed' }), activateVideo: () => { activated++; } });
  video.node.click(); await drain(); assert.equal(activated, 1); assert.equal(h.document.querySelectorAll('iframe').length, 0);
});

test('published sections leave native fragment handling to the shell; staged and revision previews prevent navigation and only focus', async () => {
  for (const mode of [{ staged: false, revisionId: null }, { staged: true, revisionId: null }, { staged: false, revisionId: 'revision' }]) {
    const h = await harness(), id = '10000000-0000-4000-8000-000000000001';
    const target = h.document.createElement('section'); target.setAttribute('id',`section-${id}`);h.document.body.append(target);
    const component = h.create({ type: 'section', value: id }, mode);
    const event = new TestEvent('click', { bubbles: true, button: 0 }); component.node.dispatchEvent(event);
    assert.equal(event.defaultPrevented, Boolean(mode.staged || mode.revisionId));
    assert.equal(h.context.window.history.href, undefined, 'the component must never use raw window history');
    if (mode.staged || mode.revisionId) assert.equal(h.document.activeElement, target);
    assert.match(component.node.getAttribute('href'), /^https:\/\/portal.test\/conteudos\/guia\?preview=1#section-/);
  }
});

test('authoritative published filename passes unchanged from validator into download/retry, including safe leading spaces', async () => {
  for (const [kind, extension] of [['image','webp'],['gif','gif'],['audio','mp3'],['video','mp4']]) {
    const doc = featureDocument(), section = doc.sections[0], row = section.rows[0], column = row.columns[0];
    doc.sections = [section]; section.rows = [row]; row.layout = 'single'; row.columns = [column];
    column.blocks = [column.blocks.find(block => block.type === 'rich_text'), {
      id: 'abcdefab-1234-4000-8000-000000000090', type: 'button', preset: 'secondary', label: 'Baixar material',
      action: { type: 'download', kind, media_id: 'abcdefab-1234-4000-8000-000000000091', file_name: ` guia.${extension}` },
    }];
    const validated = validateDocument(doc, { publishing: true }).document;
    const action = validated.sections[0].rows[0].columns[0].blocks[1].action;
    assert.equal(action.file_name, ` guia.${extension}`, 'do not trim or rewrite persisted snapshots');
    const h = await harness(), component = h.create(action);
    component.node.click(); assert.equal(h.requests.length, 1, 'every server-valid action reaches the private API');
    h.requests[0].reject(new Error('retryable')); await drain(); assert.equal(component.node.disabled, false);
    component.node.click(); assert.equal(h.requests.length, 2);
    h.requests[1].resolve(`blob:${kind}-leading`); await drain();
    assert.equal(h.document.downloads[0].name, action.file_name); assert.ok(h.revoked.includes(`blob:${kind}-leading`));
  }
});
test('download client uses scoped fetchAPIAsset and exact query/abort options', async () => {
  const h = await harness(), calls = [];
  Object.assign(h.context, { fetchAPI() {}, fetchAPIPage() {}, fetchAPIAsset() {} });
  const api = h.context.createPagesAPI({ signal: h.controller.signal, bindAPI: () => ({ fetchAPIAsset: (...args) => { calls.push(args); return Promise.resolve('blob:asset'); } }) });
  assert.equal(await api.download('p/a', 'm/a', { revisionId: 'r/a', signal: h.controller.signal }), 'blob:asset');
  assert.equal(calls[0][0], '/api/pages/p%2Fa/media/m%2Fa/download?revision_id=r%2Fa');
  assert.equal(calls[0][1].signal, h.controller.signal);
  await api.download('p', 'm', { staged: true }); assert.equal(calls[1][0], '/api/pages/p/media/m/download?preview=1');
});
