import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const exclusiveEditorAssets = [
  'public/cms.html',
  'public/js/cms.js',
  'public/js/cms-block-editor.js',
];

test('Portal não expõe a interface exclusiva do Editor CMS', async () => {
  for (const file of exclusiveEditorAssets) {
    assert.equal(existsSync(file), false, file);
  }

  const [router, shell, auth, authShell, layout, knowledge, curriculum] = await Promise.all([
    readFile('public/js/router.js', 'utf8'),
    readFile('scripts/generate-public-shell.mjs', 'utf8'),
    readFile('public/js/auth.js', 'utf8'),
    readFile('public/js/auth-shell.js', 'utf8'),
    readFile('public/css/layout.css', 'utf8'),
    readFile('public/js/knowledge.js', 'utf8'),
    readFile('public/academy/curriculum-editor.js', 'utf8'),
  ]);

  assert.doesNotMatch(router, /cms\.html|cms\.js/);
  assert.doesNotMatch(shell, /Editor CMS|cms\.html|cmsAccess|file-edit/);
  assert.doesNotMatch(auth, /cmsAccess|data\.cmsAccess/);
  assert.doesNotMatch(authShell, /cmsAccess|data\.cmsAccess/);
  assert.doesNotMatch(layout, /cms-link|cms-entry-link|data-cms-access/);
  assert.doesNotMatch(knowledge, /Editor CMS|cms\.html|article-cms-link/);
  assert.doesNotMatch(curriculum, /cms\.html|ensureLessonDocument/);

  for (const filename of (await readdir('public')).filter(file => file.endsWith('.html'))) {
    const source = await readFile(`public/${filename}`, 'utf8');
    assert.doesNotMatch(source, /Editor CMS|cms\.html/, filename);
  }

  assert.equal(existsSync('public/js/cms-block-renderer.js'), true);
  assert.equal(existsSync('public/css/cms.css'), true);
});
