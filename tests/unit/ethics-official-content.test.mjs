import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { renderEthicsDocument } from '../../public/js/ethics-document.js';
import { createFeedbackHarness } from '../helpers/frontend-feedback-harness.mjs';

const require = createRequire(import.meta.url);
const { term } = require('../../api/ethics');
const content = require('../../api/ethics/term.json');
const provenance = require('../fixtures/ethics-official-provenance.json');

test('official 1.0 preserves every DOCX body text, in order, with only the approved DHO substitution', () => {
  assert.equal(term.mock, false);
  assert.equal(term.version, provenance.version);
  assert.equal(term.notice, '');
  const texts = [...term.preamble, ...term.sections.flatMap(section => [section.title,
    ...section.blocks.flatMap(block => {
      if (block.type === 'paragraph') return [block.text];
      if (block.type === 'list') return block.items;
      assert.equal(block.type, 'table', 'unsupported content must never be silently omitted');
      assert.ok(['row', 'column'].includes(block.header));
      assert.ok(block.rows.every(row => row.length === 2));
      return block.rows.flat();
    }),
  ])].map(text => text.trim().replace(/\s+/g, ' '));
  assert.equal(texts.length, provenance.normalizedTextCount);
  assert.equal(createHash('sha256').update(JSON.stringify(texts)).digest('hex'), provenance.normalizedTextSha256,
    'normalized DOCX text digest includes all headings, paragraphs, list items, cells and signature lines');
  assert.equal(term.sections.length, provenance.sectionCount);
  assert.deepEqual(term.sections.filter(section => /^\d+\./.test(section.title)).map(section => Number.parseInt(section.title, 10)),
    Array.from({ length: 23 }, (_, index) => index + 1));
  assert.equal(term.sections.filter(section => section.title.startsWith('ANEXO ')).length, 2);
  assert.deepEqual(term.sections.flatMap(section => section.blocks).filter(block => block.type === 'table').map(block => block.rows.length),
    provenance.tableRowCounts);
  assert.ok(texts.includes(provenance.approvedCorrection.after));
  assert.ok(!texts.includes(provenance.approvedCorrection.before));
  assert.doesNotMatch(JSON.stringify(content), /xxxxxxxxxxx|demonstração|demonstrativo|mock-2026/);
});

test('the complete content identity includes immutable nested table, list and preamble data', () => {
  assert.equal(term.contentHash, createHash('sha256').update(JSON.stringify(content)).digest('hex'));
  assert.ok(Object.isFrozen(term.preamble));
  const blocks = term.sections.flatMap(section => section.blocks);
  const table = blocks.find(block => block.type === 'table');
  const list = blocks.find(block => block.type === 'list');
  assert.ok(Object.isFrozen(table.rows[1]));
  assert.ok(Object.isFrozen(list.items));
  assert.throws(() => { table.rows[1][0] = 'Modified'; }, TypeError);
  assert.throws(() => { list.items.push('Modified'); }, TypeError);
});

test('renderer preserves source semantics, control row headers, static signature lines and literal text safety', async () => {
  const h = await createFeedbackHarness('ethics', { mount: false });
  h.doc.createDocumentFragment = () => h.doc.createElement('fragment');
  const host = h.node('ethics-document');
  renderEthicsDocument(host, term);
  assert.equal(host.querySelectorAll('h2').length, 27);
  assert.equal(host.querySelectorAll('table').length, 3);
  assert.equal(host.querySelectorAll('ul').length, 7);
  assert.equal(host.querySelectorAll('th[scope="col"]').length, 4);
  assert.equal(host.querySelectorAll('th[scope="row"]').length, 5);
  assert.match(host.textContent, /Assinatura: _+/);
  assert.equal(host.querySelectorAll('input').length, 0, 'annex remains document text, not an extra identity/signature form');
  renderEthicsDocument(host, {
    preamble: ['<script>unsafe()</script>'],
    sections: [{ title: 'Literal text', blocks: [{ type: 'paragraph', text: '<img src=x onerror=unsafe()>' }] }],
  });
  assert.equal(host.querySelectorAll('script').length, 0);
  assert.equal(host.querySelectorAll('img').length, 0);
  assert.match(host.textContent, /<script>unsafe\(\)<\/script>/);
  assert.throws(() => renderEthicsDocument(host, {
    preamble: [], sections: [{ title: 'Unsupported', blocks: [{ type: 'unsupported' }] }],
  }), /não suportado/);
});
