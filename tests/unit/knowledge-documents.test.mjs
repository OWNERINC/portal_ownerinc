import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateDescriptor, loadDocument, documentImage, documentSummary } = require('../../api/knowledge/documents.js');
const key = 'a'.repeat(64);
const descriptor = { kind: 'pdf', key };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('document descriptors are closed shapes, never paths or arbitrary URLs', () => {
  for (const value of [null, { kind: 'ethics' }, descriptor]) assert.equal(validateDescriptor(value), true);
  for (const value of [undefined, [], {}, 'pdf', { kind: 'ethics', key },
    { kind: 'pdf' }, { kind: 'pdf', key: '../secret' }, { kind: 'pdf', key: key.toUpperCase() },
    { ...descriptor, url: 'https://evil.test' }]) assert.equal(validateDescriptor(value), false);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-doc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'knowledge-private', key);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('RIFFxxxxWEBPtest');
  const image = { width: 720, height: 480, bytes: bytes.length, sha256: hash(bytes) };
  const manifest = { version: 1, source: { id: 'abc', filename: 'Manual.pdf', bytes: 100, sha256: key,
    url: 'https://drive.google.com/file/d/abc/view' },
  cover: image, pages: [{ ...image, number: 1, text: 'Texto original.' }] };
  const save = () => writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await save();
  await writeFile(path.join(directory, 'cover.webp'), bytes);
  await writeFile(path.join(directory, '0001.webp'), bytes);
  return { root, directory, manifest, bytes, save };
}

test('private document reads validate complete manifests and exact image integrity', async t => {
  const f = await fixture(t);
  assert.equal((await loadDocument(f.root, descriptor)).pages[0].text, 'Texto original.');
  assert.deepEqual(await documentImage(f.root, descriptor, '1'), f.bytes);
  assert.deepEqual(await documentImage(f.root, descriptor, 'cover'), f.bytes);
  const article = { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Manual', document: descriptor };
  const dto = await documentSummary(article, f.root);
  assert.equal(dto.document.pageCount, 1);
  assert.equal(JSON.stringify(dto).includes(key), false);
  for (const number of ['0', '01', '-1', '1.0', '2', '../manifest.json', '1%2f']) {
    await assert.rejects(documentImage(f.root, descriptor, number), { status: 404 });
  }
  await writeFile(path.join(f.directory, '0001.webp'), Buffer.from('RIFFxxxxWEBPevil'));
  await assert.rejects(documentImage(f.root, descriptor, '1'), { status: 404 });
});

test('manifest rejects unordered pages, hostile metadata, oversized dimensions and excess keys', async t => {
  const f = await fixture(t);
  const original = structuredClone(f.manifest);
  for (const change of [
    m => { m.pages[0].number = 2; },
    m => { m.pages[0].width = 2401; },
    m => { m.pages[0].filename = '../../secret'; },
    m => { m.source.url = 'https://drive.google.com.evil.test/file/d/abc/view'; },
    m => { m.source.sha256 = 'b'.repeat(64); },
    m => { m.cover.bytes = 20 * 1024 * 1024; },
  ]) {
    Object.assign(f.manifest, structuredClone(original)); change(f.manifest); await f.save();
    await assert.rejects(loadDocument(f.root, descriptor), { status: 404 });
  }
});

test('unavailable documents keep their article visible with an explicit unavailable descriptor', async t => {
  const f = await fixture(t);
  await rm(path.join(f.directory, 'manifest.json'));
  const dto = await documentSummary({ id: 'x', document: descriptor }, f.root);
  assert.equal(dto.document.available, false);
  assert.equal(dto.document.key, undefined);
  assert.deepEqual(await documentSummary({ id: 'y', document: { kind: 'ethics' } }, f.root),
    { id: 'y', document: { kind: 'ethics' } });
});
