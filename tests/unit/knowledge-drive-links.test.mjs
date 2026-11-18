import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeEditorialHarness } from '../helpers/knowledge-editorial-harness.mjs';

const drive = 'https://drive.google.com/file/d/1MEy-Orrh-Q3lIMSHorkJD-b2EEKr138P/view?usp=sharing';
const article = { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Uniformes — Recepção', category: 'Uniformes' };

test('a standalone Drive file URL becomes a named external action without altering the saved content', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  const content = `Orientações da recepção.\n\n${drive}\n\nDocumento original.`;
  await h.showArticle({ ...article, content }, false);
  const root = h.node('article-content');
  const link = root.querySelector('a');
  assert.ok(link);
  assert.equal(link.href, drive);
  assert.equal(link.textContent, 'Abrir documento no Drive ↗');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.match(link.getAttribute('aria-label'), /nova aba/);
  assert.ok(root.textContent.includes('Orientações da recepção.'));
  assert.ok(root.textContent.includes('Documento original.'));
  await h.showArticle({ ...article, content });
  assert.equal(h.node('f-content').value, content);
  await h.submit();
  const request = h.latest(`/api/knowledge/${article.id}`);
  assert.equal(request.options.method, 'PUT');
  assert.equal(JSON.parse(request.options.body).content, content);
  request.resolve({ ...article, content });
});

test('HTML and lookalike or unsupported URLs remain literal text without executable elements', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  const content = [
    '<img src=x onerror=alert(1)>',
    'javascript:alert(1)',
    'http://drive.google.com/file/d/abc/view',
    'https://drive.google.com.evil.test/file/d/abc/view',
    'https://drive.google.com@evil.test/file/d/abc/view',
    'https://user:password@drive.google.com/file/d/abc/view',
    'https://drive.google.com:8443/file/d/abc/view',
    'https://drive.google.com/file/d/abc/preview',
    'https://drive.google.com/file/d/abc/view?redirect=https://evil.test',
    'https://drive.google.com/file/d/abc/view?usp=sharing&redirect=https://evil.test',
    'https://drive.google.com/file/d/abc/view#javascript:alert(1)',
    'https://drive.google.com/file/d/../view',
    'https://drive.google.com/file/d/abc%2fdef/view',
    'https://drive.google.com\\@evil.test/file/d/abc/view',
    'https://drive.google.com/drive/folders/abc',
    `Consulte ${drive} para saber mais.`,
  ].join('\n');
  await h.showArticle({ ...article, content }, false);
  const root = h.node('article-content');
  assert.equal(root.textContent, content);
  assert.equal(root.querySelectorAll('a').length, 0);
  assert.equal(root.querySelectorAll('img, script, iframe').length, 0);
});

test('CRLF and multiple standalone document links retain their text and have distinct accessible names', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  const second = 'https://drive.google.com/file/d/15wB1z-KCH7BOoaZqisKxiozPn10LGsvF/view';
  const content = `Primeiro\r\n${drive}\r\n\r\nSegundo\r\n${second}`;
  await h.showArticle({ ...article, content }, false);
  const links = h.node('article-content').querySelectorAll('a');
  assert.equal(links.length, 2);
  assert.equal(links[0].href, drive);
  assert.equal(links[1].href, second);
  assert.notEqual(links[0].getAttribute('aria-label'), links[1].getAttribute('aria-label'));
  assert.equal(h.node('article-content').textContent, content.replace(drive, links[0].textContent).replace(second, links[1].textContent));
});

test('read-only users can open Drive documents alongside literal HTML and later articles clear the links', async t => {
  const h = await createKnowledgeEditorialHarness(t, { user: { uid: 'user-1', role: 'viewer', permissions: {} } });
  const shared = drive.replace('usp=sharing', 'usp=drive_link');
  const literal = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>';
  await h.showArticle({ ...article, content: `${literal}\n${shared}` }, false);
  const root = h.node('article-content');
  assert.equal(root.querySelectorAll('a').length, 1);
  assert.equal(root.querySelector('a').href, shared);
  assert.equal(root.querySelectorAll('img, script, iframe').length, 0);
  assert.ok(root.textContent.startsWith(`${literal}\n`));
  assert.equal(h.node('article-admin-bar').hidden, true);
  await h.showArticle({ ...article, content: 'Artigo somente em texto.' }, false);
  assert.equal(root.querySelectorAll('a').length, 0);
  assert.equal(root.textContent, 'Artigo somente em texto.');
  await h.showArticle({ ...article, content: null }, false);
  assert.equal(root.textContent, '');
});
