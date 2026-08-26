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

  const brandLogo = html.match(/<img\b(?=[^>]*class="preview-brand-logo")[^>]*>/i)?.[0];
  assert.ok(brandLogo, 'expected the sidebar to use the Ownerinc wordmark asset');
  assert.match(brandLogo, /class="preview-brand-logo"/);
  assert.match(brandLogo, /src="\.\/assets\/ownerinc-wordmark-white\.webp"/);
  assert.match(brandLogo, /alt="Ownerinc"/);
  assert.match(brandLogo, /width="292"/);
  assert.match(brandLogo, /height="38"/);
  const logoAsset = await readFile('public/assets/ownerinc-wordmark-white.webp');
  assert.ok(logoAsset.byteLength > 0, 'expected the Ownerinc wordmark asset to exist');

  const sidebarProfile = html.match(
    /<a\b(?=[^>]*class="preview-sidebar-profile")[^>]*>[\s\S]*?<\/a>/i,
  )?.[0];
  assert.ok(sidebarProfile, 'expected a sidebar profile link');
  assert.match(sidebarProfile, /class="preview-sidebar-profile"/);
  assert.match(sidebarProfile, /href="\.\/profile\.html"/);
  assert.match(sidebarProfile, /\bMO\b/);
  assert.match(sidebarProfile, /Marina Oliveira/);
  assert.match(sidebarProfile, /Meu perfil/);

  const mobileProfile = html.match(
    /<a\b(?=[^>]*class="preview-avatar preview-mobile-profile")[^>]*>/i,
  )?.[0];
  assert.ok(mobileProfile, 'expected the topbar mobile profile entry');
  assert.match(mobileProfile, /class="preview-avatar preview-mobile-profile"/);
  assert.match(mobileProfile, /href="\.\/profile\.html"/);

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
  assert.match(css, /\.preview-sidebar\s*\{[^}]*height\s*:\s*100dvh;[^}]*max-height\s*:\s*100dvh;[^}]*overflow-y\s*:\s*auto;[^}]*overscroll-behavior\s*:\s*contain;/s);
  assert.match(css, /scroll-snap-type\s*:\s*x\s+mandatory/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.story-rail\s*\{[^}]*scroll-snap-type\s*:\s*none;/,
  );
  assert.match(css, /min-width\s*:\s*44px/);
  assert.match(css, /aspect-ratio\s*:/);
  assert.match(css, /main\s*\{[^}]*width\s*:\s*min\(100%,\s*1320px\)[^}]*padding\s*:[^}]*72px[^}]*88px/s);
  assert.match(css, /\.preview-section\s*\{[^}]*margin-top\s*:\s*clamp\(48px,\s*7vw,\s*112px\)/s);
  assert.match(css, /\.section-heading h2\s*\{[^}]*font-size\s*:\s*28px;/s);
  assert.match(css, /\.story-rail\s*\{[^}]*gap\s*:\s*24px;/s);
  assert.match(css, /\.areas-grid\s*\{[^}]*gap\s*:\s*16px;/s);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.preview-sidebar\s*\{[^}]*display\s*:\s*none;[\s\S]*\.preview-mobile-profile\s*\{[^}]*display\s*:\s*inline-flex;/s);
});

test('home preview preserves the light and dark surface contrast tokens', async () => {
  const css = await readFile('public/css/home-preview.css', 'utf8');

  assert.match(css, /\.eyebrow\s*\{[^}]*\bcolor:\s*var\(--primary\)\s*;/s);
  assert.match(css, /\.section-kicker\s*\{[^}]*\bcolor:\s*var\(--espresso\)\s*;/s);
  assert.doesNotMatch(css, /\.eyebrow\s*,\s*\.section-kicker/);
  assert.match(css, /\.preview-sidebar-note\s*\{[^}]*\bcolor:\s*var\(--sidebar-text\)\s*;/s);
  assert.match(css, /\.preview-meta\s*\{[^}]*\bcolor:\s*var\(--surface\)\s*;/s);
  assert.doesNotMatch(
    css,
    /\.preview-sidebar-note\s*\{[^}]*rgba\(255\s*,\s*255\s*,\s*255\s*,\s*0\.35\)/s,
  );
  assert.doesNotMatch(
    css,
    /\.preview-meta\s*\{[^}]*rgba\(255\s*,\s*255\s*,\s*255\s*,\s*0\.62\)/s,
  );
});
