import assert from 'node:assert/strict';
import test from 'node:test';
import { pagesSlug, routePath } from '../../public/js/pages-route.js';

test('only exact lowercase ASCII aliases of 1–120 characters resolve to the Pages shell', () => {
  for (const slug of ['a', '0', 'codigo-de-vestimenta', 'a'.repeat(120)]) {
    assert.equal(pagesSlug(`/conteudos/${slug}`), slug);
    assert.equal(routePath(`/conteudos/${slug}`), '/pages.html');
  }
  for (const path of ['/conteudos/', '/conteudos/a/b', '/conteudos/%2fadmin', '/conteudos/%61',
    '/conteudos/A', '/conteudos/a/', '/conteudos/a--b', '/conteudos/-a', '/conteudos/a-',
    '/conteudos/../admin.html', '/conteudos/a.b', '/conteudos/a?b', '/conteudos/a#b',
    `/conteudos/${'a'.repeat(121)}`, '/conteudos/á', '/conteudos/a\n', '/announcements.html',
    '/pages.html', '/api/pages/a', '/uploads/a', '/another/a']) {
    assert.equal(pagesSlug(path), null, path);
    assert.equal(routePath(path), path, path);
  }
});
