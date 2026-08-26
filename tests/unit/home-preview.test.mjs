import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('home preview preserves the required HTML accessibility and navigation contract', async () => {
  const html = await readFile('public/home-preview.html', 'utf8');

  assert.equal((html.match(/<h1(?:\s|>)/gi) || []).length, 1);
  assert.match(html, /<a class="skip-link" href="#main-content">/);
  assert.match(html, /<main\b[^>]*\bid="main-content"/i);
  assert.match(html, /aria-labelledby="featured-heading"/);
  assert.match(html, /aria-labelledby="areas-heading"/);

  const images = html.match(/<img\b[^>]*>/gi) || [];
  assert.ok(
    images.some((image) => /\balt\s*=\s*["'][^"']*\S[^"']*["']/i.test(image)),
    'expected at least one image with a non-empty alt attribute',
  );

  assert.doesNotMatch(html, /\son(?:click|change|submit|keydown)\s*=/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc\s*=)[^>]*>/i);

  for (const href of [
    './knowledge.html',
    './reminders.html',
    './academy.html',
    './benefits.html',
    './announcements.html',
    './profile.html',
  ]) {
    assert.match(html, new RegExp(`href="${href.replace('.', '\\.')}"`));
  }

  assert.match(html, /assets\/icons\.svg#/);
  assert.doesNotMatch(html, /href\s*=\s*["']#["']/i);
});

test('home preview preserves the required responsive and motion CSS contract', async () => {
  const css = await readFile('public/css/home-preview.css', 'utf8');

  assert.match(css, /overflow-x\s*:\s*hidden/);
  assert.match(css, /scroll-snap-type\s*:\s*x\s+mandatory/);
  assert.match(css, /prefers-reduced-motion\s*:\s*reduce/);
  assert.match(css, /min-width\s*:\s*44px/);
  assert.match(css, /aspect-ratio\s*:/);
});

test('home preview preserves the light and dark surface contrast tokens', async () => {
  const css = await readFile('public/css/home-preview.css', 'utf8');

  assert.match(css, /\.eyebrow\s*\{[^}]*\bcolor:\s*var\(--primary\)\s*;/s);
  assert.match(css, /\.section-kicker\s*\{[^}]*\bcolor:\s*var\(--espresso\)\s*;/s);
  assert.doesNotMatch(css, /\.eyebrow\s*,\s*\.section-kicker/);
  assert.match(css, /\.preview-sidebar-note\s*\{[^}]*\bcolor:\s*var\(--sidebar-text\)\s*;/s);
  assert.doesNotMatch(
    css,
    /\.preview-sidebar-note\s*\{[^}]*rgba\(255\s*,\s*255\s*,\s*255\s*,\s*0\.35\)/s,
  );
});
