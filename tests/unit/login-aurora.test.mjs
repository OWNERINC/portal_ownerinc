import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const css = await readFile('public/css/login.css', 'utf8');

test('aurora stays behind the login without intercepting controls or locking scroll', () => {
  const layers = css.match(/body::before,\s*body::after\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(layers, /content:\s*""/);
  assert.match(layers, /position:\s*fixed/);
  assert.match(layers, /inset:\s*0/);
  assert.match(layers, /pointer-events:\s*none/);
  assert.match(layers, /z-index:\s*-1/);
  assert.match(css, /body\s*\{[^}]*isolation:\s*isolate/);
  assert.doesNotMatch(css, /(?:body|html)\s*\{[^}]*(?:overflow(?:-y)?:\s*hidden|height:\s*100(?:s|d)?vh)/);
  assert.doesNotMatch(css, /filter:\s*blur|backdrop-filter|https?:\/\//);
});

test('aurora uses brand gradients and a brief single entrance, with a static reduced-motion fallback', () => {
  assert.match(css, /body::before\s*\{[^}]*radial-gradient/);
  assert.match(css, /body::after\s*\{[^}]*radial-gradient/);
  assert.match(css, /var\(--primary\)/);
  assert.match(css, /var\(--accent\)/);
  assert.match(css, /@keyframes login-aurora-enter/);
  const motion = css.match(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*body::before,\s*body::after\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(motion, /animation:\s*login-aurora-enter 900ms ease-out both/);
  assert.doesNotMatch(css, /infinite/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*body::before,\s*body::after\s*\{[^}]*animation:\s*none;[^}]*transform:\s*none/);
});

test('only login loads its effect stylesheet', async () => {
  for (const file of await readdir('public')) {
    if (!file.endsWith('.html')) continue;
    const html = await readFile(`public/${file}`, 'utf8');
    assert.equal(/href=["'][^"']*css\/login\.css["']/.test(html), file === 'login.html', file);
  }
});
