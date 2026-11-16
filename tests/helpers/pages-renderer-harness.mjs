import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { FixtureNode, deferred } from './frontend-feedback-harness.mjs';

export async function rendererHarness() {
  const doc = new FixtureNode('document'); doc.ownerDocument = doc;
  doc.createElement = tag => {
    const node = new FixtureNode(tag, doc); node.pauses = 0; node.loads = 0; node.plays = 0;
    node.pause = () => node.pauses++; node.load = () => node.loads++; node.play = () => { node.plays++; }; return node;
  };
  doc.createTextNode = text => { const n = doc.createElement('#text'); n.textContent = text; return n; };
  doc.createElementNS = (_, tag) => doc.createElement(tag);
  doc.body = doc.createElement('body'); doc.append(doc.body); doc.downloads = [];
  const revoked = [], created = [];
  const context = vm.createContext({ document: doc, console, AbortController, Blob, TextEncoder, crypto: { randomUUID },
    URL: class extends URL { static createObjectURL(blob) { const url = `blob:test-${created.length}`; created.push({ blob, url }); return url; } static revokeObjectURL(url) { revoked.push(url); } },
    window: { location: { hash: '', href: 'https://portal.test/conteudos/teste' }, history: { pushState() {} } } });
  // Explicit real module dependencies, never production globals or renderer stubs.
  for (const [file,names] of [['model','safeLink,clone,newId,allBlocks'], ['composition','compose,findBlock,defaultStyle'], ['document-v3','upgradeDocument'], ['history','createDraftHistory'], ['state','createEditorState'], ['dom','el,button'], ['button','createPageButton'], ['appearance','resolveAppearance,normalizeHex,typographyMetrics'], ['render-blocks-v3','renderV3Block,v3Icon'], ['renderer','richNode,imageFigure,applyBlockStyle,mediaFigure,renderDocument,captionsVTT']]) {
    const source = (await readFile(`public/pages/${file}.js`, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export \{[^\n]+\};?$/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis,{${names}}); })()`, context, { filename: `public/pages/${file}.js` });
  }
  const requests = [];
  const options = { api: { asset(...args) { const item = { args, ...deferred() }; requests.push(item); return item.promise; } }, pageId: 'page', staged: true };
  return { context, doc, revoked, created, requests, options };
}
