import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepare, identity, sourceUrl, download, richText, publicationDate, localDatabase, existingState, validateMedia, persist } from '../../scripts/import-owner-news.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { validateBlocks } = require('./cms/blocks.js');
const article = (extra = {}) => ({ id: 'fixture-1', status: 'published', title: 'Fixture', category: 'Cultura', author: 'Autor', publishedAt: '2026-08-28', excerpt: 'Resumo', cover: '/assets/cover.jpg', blocks: [], ...extra });
const convert = (articles) => prepare({ store: { articles } });

test('published-only conversion preserves ordered paragraphs, inline images, quote and profile attribution', () => {
  const result = convert([article({ blocks: [
    { type: 'text', text: '<p>Primeiro <b>texto</b> &amp; ação.</p><p>Segundo<br>Terceiro</p><img src="/assets/inline.jpg"><p>Depois</p>' },
    { type: 'quote', text: 'Uma ideia', author: 'Autora da citação' },
    { type: 'profile', name: 'Pessoa', role: 'Cargo', image: '/assets/profile.jpg', text: 'Trajetória' },
    { type: 'video', url: '/assets/clip.mp4', title: 'Entrevista' },
  ] }), article({ id: 'draft', status: 'draft', cover: 'http://unsafe.test', blocks: [{ type: 'unknown' }] })]);
  assert.equal(result.documents.length, 1);
  assert.equal(result.ignored, 1);
  assert.equal(result.media.length, 4);
  const blocks = result.documents[0].blocks;
  assert.ok(validateBlocks(blocks));
  assert.deepEqual(blocks.slice(4, 9).map((b) => b.text || b.type), ['Primeiro texto & ação.', 'Segundo', 'Terceiro', 'image', 'Depois']);
  assert.deepEqual(blocks.slice(9).map((b) => b.text || b.type), ['“Uma ideia”', 'Autora da citação', 'image', 'Pessoa — Cargo', 'Trajetória', 'video']);
  assert.equal(blocks[2].text, 'Autoria: Autor');
  assert.equal(blocks[3].text, 'Publicado em: 2026-08-28');
});

test('stable identities deduplicate media and reject duplicate source IDs or unknown blocks', () => {
  const result = convert([article(), article({ id: 'fixture-2' })]);
  assert.equal(result.media.length, 1);
  assert.deepEqual(result, convert([article(), article({ id: 'fixture-2' })]));
  assert.notEqual(identity('document', '1'), identity('asset', '1'));
  assert.throws(() => convert([article(), article()]), /duplicate/);
  assert.throws(() => convert([article({ blocks: [{ type: 'unknown' }] })]), /Unsupported/);
});

test('source rich HTML variants and image/video captions preserve the rendered text', () => {
  const result = convert([article({ titleHtml: '<b>Título real</b>', excerptHtml: '<p>Resumo real</p>', blocks: [
    { type: 'text', text: 'fallback', html: '<div>Texto real</div>' },
    { type: 'image', image: '/assets/cover.jpg', text: 'Descrição', captionHtml: '<b>Legenda</b>' },
    { type: 'video', url: '/assets/a.mp4', caption: 'Legenda de vídeo' },
  ] })]);
  assert.equal(result.documents[0].title, 'Título real');
  assert.equal(result.documents[0].blocks[1].text, 'Resumo real');
  assert.deepEqual(result.documents[0].blocks.slice(4).map((b) => b.text || b.type), ['Texto real', 'image', 'Descrição', 'Legenda', 'video', 'Legenda de vídeo']);
});

test('HTML never survives conversion and oversized text respects the CMS limits', () => {
  assert.equal(richText('<script>alert(1)</script><p>Seguro &nbsp; &#231; &#xE3;</p>'), 'Seguro ç ã');
  assert.throws(() => convert([article({ blocks: [{ type: 'text', text: '&lt;img src=x onerror=evil&gt;' }] })]), /schema/);
  const result = convert([article({ blocks: [{ type: 'text', text: 'palavra '.repeat(1000) }] })]);
  assert.ok(validateBlocks(result.documents[0].blocks));
  assert.equal(result.documents[0].blocks.slice(4).map((b) => b.text).join(' '), 'palavra '.repeat(1000).trim());
});

test('dates use explicit publication or labeled Portuguese update fallback without inventing today', () => {
  assert.equal(publicationDate(article({ publishedAt: undefined, updatedAt: '27 de ago. de 2026' })), '2026-08-27T12:00:00.000Z');
  assert.throws(() => publicationDate(article({ publishedAt: '2026-02-30' })), /date/);
  assert.throws(() => publicationDate(article({ publishedAt: undefined })), /date/);
});

test('only approved HTTPS source URLs and validated redirect targets are fetched', async () => {
  for (const value of ['http://owner-news.ownerinc-developers.chatgpt.site/assets/a', '//evil.test/a', 'https://user:pass@owner-news.ownerinc-developers.chatgpt.site/assets/a', '/api/admin', 'https://127.0.0.1/assets/a', '/assets/a#x']) {
    assert.throws(() => sourceUrl(value));
  }
  let calls = 0;
  await assert.rejects(download('/assets/a', 10, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
  }), /approved/);
  assert.equal(calls, 1);
  await assert.rejects(download('/assets/a', 2, async () => new Response('123')), /size/);
  await assert.rejects(download('/assets/a', 2, async () => new Response('1', { headers: { 'content-length': '3' } })), /size/);
});

test('MIME signatures reject disguised payloads and validate actual image decoding', async () => {
  await assert.rejects(validateMedia({ buffer: Buffer.from('<html>bad</html>'), mime: 'image/jpeg' }, 'image'), /signature/);
  await assert.rejects(validateMedia({ buffer: Buffer.from([255, 216, 255, 0]), mime: 'image/jpeg' }, 'image'));
  const sharp = require('sharp');
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const validated = await validateMedia({ buffer, mime: 'image/png' }, 'image');
  assert.match(validated.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(validateMedia({ buffer, mime: 'image/jpeg' }, 'image'), /signature/);
  await assert.rejects(validateMedia({ buffer, mime: 'image/png' }, 'video'), /signature/);
});

test('writes require an explicitly configured loopback development database', () => {
  const env = { NODE_ENV: 'development', OWNER_NEWS_DATABASE_URL: 'postgres://localhost/portal_dev' };
  assert.ok(localDatabase(env));
  for (const patch of [{ NODE_ENV: 'production' }, { OWNER_NEWS_DATABASE_URL: 'postgres://remote/portal_dev' }, { OWNER_NEWS_DATABASE_URL: 'postgres://localhost/portal' }, { OWNER_NEWS_DATABASE_URL: 'postgres://localhost/portal_dev?host=remote' }]) {
    assert.throws(() => localDatabase({ ...env, ...patch }));
  }
});

test('reruns accept identical JSONB with reordered keys and reject unrelated or edited publications', () => {
  const document = convert([article()]).documents[0];
  assert.equal(existingState(document), 'new');
  const row = { id: document.id, source_id: document.sourceId, content_type: 'announcement', title: document.title, category: document.category, published_revision_id: document.revisionId, published_at: document.publishedAt, status: 'published', blocks: document.blocks.map((b) => Object.fromEntries(Object.entries(b).reverse())) };
  assert.equal(existingState(document, row), 'existing');
  assert.throws(() => existingState(document, { ...row, source_id: null }), /unrelated/);
  assert.throws(() => existingState(document, { ...row, title: 'Edited by editor' }), /never overwritten/);
  assert.throws(() => existingState(document, { ...row, blocks: [] }), /never overwritten/);
});

test('missing asset rows require repair only when referenced by an existing publication, including shared assets', async (t) => {
  const output = t.mock.method(console, 'log', () => {});
  for (const existingHasMedia of [false, true]) {
    const plan = convert([
      article({ cover: existingHasMedia ? '/assets/cover.jpg' : undefined }),
      article({ id: 'new-document', title: 'New document' }),
    ]);
    const document = plan.documents[0];
    for (const apply of existingHasMedia ? [false, true] : [false]) {
      const queries = [];
      const db = {
        async connect() {}, async end() {},
        async query(sql, values) {
          queries.push(sql);
          if (sql.includes('SELECT d.*') && values[0] === document.id) return { rows: [{
            id: document.id, source_id: document.sourceId, content_type: 'announcement',
            title: document.title, category: document.category, published_revision_id: document.revisionId,
            published_at: document.publishedAt, status: 'published', blocks: document.blocks,
          }] };
          return { rows: [] };
        },
      };
      const logsBefore = output.mock.callCount();
      if (existingHasMedia) {
        await assert.rejects(persist(plan, {}, { db, apply }), /Existing imported publication references missing cms_assets row .*explicit repair required/);
        assert.equal(output.mock.callCount(), logsBefore, 'broken publications must not produce a success report');
      } else {
        const report = await persist(plan, {}, { db, apply });
        assert.equal(report.existing, 1, 'new-only assets remain valid preparation even alongside an existing publication');
        assert.equal(report.databaseChecked, true);
        assert.equal(output.mock.callCount(), logsBefore + 1);
      }
      assert.ok(queries.includes('ROLLBACK'));
      assert.ok(!queries.some((sql) => /^(INSERT|UPDATE|COMMIT)/.test(sql)));
    }
  }
});

test('failed transaction removes only files created by that run; exclusive writes preserve leftovers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-news-import-test-'));
  const plan = convert([article()]);
  const buffer = Buffer.from('fixture media');
  Object.assign(plan.media[0], { buffer, mime: 'image/jpeg', sha256: 'fixture' });
  const queries = [];
  const db = {
    async connect() {}, async end() {},
    async query(sql) {
      queries.push(sql);
      if (sql.includes('INSERT INTO cms_revisions')) throw new Error('simulated revision failure');
      return { rows: [] };
    },
  };
  const file = path.join(directory, plan.media[0].id);
  try {
    await assert.rejects(persist(plan, {}, { db, directory, apply: true }), /simulated revision failure/);
    assert.ok(queries.includes('ROLLBACK'));
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    await fs.writeFile(file, 'preexisting');
    await assert.rejects(persist(plan, {}, { db, directory, apply: true }), { code: 'EEXIST' });
    assert.equal(await fs.readFile(file, 'utf8'), 'preexisting');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('ambiguous COMMIT retains private files rather than deleting possibly published assets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-news-commit-test-'));
  const plan = convert([article()]);
  Object.assign(plan.media[0], { buffer: Buffer.from('fixture'), mime: 'image/jpeg', sha256: 'fixture' });
  const document = plan.documents[0];
  let published = false;
  const db = {
    async connect() {}, async end() {},
    async query(sql) {
      if (sql === 'COMMIT') throw new Error('connection lost');
      if (sql.startsWith('UPDATE cms_documents')) published = true;
      if (sql.includes('SELECT d.*') && published) return { rows: [{ id: document.id, source_id: document.sourceId, content_type: 'announcement', title: document.title, category: document.category, published_revision_id: document.revisionId, published_at: document.publishedAt, status: 'published', blocks: document.blocks }] };
      return { rows: [] };
    },
  };
  try {
    await assert.rejects(persist(plan, {}, { db, directory, apply: true }), /Commit outcome uncertain/);
    assert.equal(await fs.readFile(path.join(directory, plan.media[0].id), 'utf8'), 'fixture');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
