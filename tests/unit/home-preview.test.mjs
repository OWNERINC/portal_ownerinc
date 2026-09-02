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
  assert.match(html, /<a class="preview-brand"[^>]*aria-label="Ownerinc, ir para a visão geral"/);
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
  assert.match(css, /\.preview-shell\s*\{[^}]*grid-template-columns\s*:\s*clamp\(190px,\s*16vw,\s*var\(--sidebar-width\)\)\s+minmax\(0,\s*1fr\);/s);
  assert.match(css, /\.preview-sidebar\s*\{[^}]*position\s*:\s*fixed;[^}]*inset\s*:\s*0\s+auto\s+0\s+0;/s);
  assert.match(css, /\.preview-sidebar\s*\{[^}]*width\s*:\s*clamp\(190px,\s*16vw,\s*var\(--sidebar-width\)\);/s);
  assert.match(css, /\.preview-sidebar\s*\{[^}]*height\s*:\s*100dvh;[^}]*max-height\s*:\s*100dvh;[^}]*overflow-y\s*:\s*auto;[^}]*overscroll-behavior\s*:\s*contain;/s);
  assert.match(css, /\.preview-content\s*\{[^}]*grid-column\s*:\s*2;/s);
  assert.match(css, /scroll-snap-type\s*:\s*x\s+mandatory/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.story-rail\s*\{[^}]*scroll-snap-type\s*:\s*none;/,
  );
  assert.match(css, /min-width\s*:\s*44px/);
  assert.match(css, /aspect-ratio\s*:/);
  assert.match(css, /main\s*\{[^}]*width\s*:\s*min\(100%,\s*1360px\)[^}]*padding\s*:[^}]*56px[^}]*96px/s);
  assert.match(css, /\.preview-section\s*\{[^}]*margin-top\s*:\s*clamp\(48px,\s*6vw,\s*88px\)/s);
  assert.match(css, /\.section-heading h2\s*\{[^}]*font-size\s*:\s*clamp\(26px,\s*2\.5vw,\s*32px\);/s);
  assert.match(css, /\.story-rail\s*\{[^}]*gap\s*:\s*20px;/s);
  assert.match(css, /\.story-rail\s*\{[^}]*grid-template-columns\s*:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*260px\),\s*1fr\)\);/s);
  assert.match(css, /\.story-card\s*\{[^}]*display\s*:\s*flex;[^}]*flex-direction\s*:\s*column;/s);
  assert.match(css, /\.story-card-body\s*\{[^}]*display\s*:\s*flex;[^}]*flex-direction\s*:\s*column;/s);
  assert.match(css, /\.story-card strong\s*\{[^}]*font-size\s*:\s*clamp\(17px,\s*1\.5vw,\s*21px\);/s);
  assert.match(css, /\.story-card small\s*\{[^}]*font-size\s*:\s*10px;/s);
  assert.match(css, /\.areas-grid\s*\{[^}]*gap\s*:\s*16px;/s);
  assert.match(css, /\.areas-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*160px\),\s*1fr\)\);/s);
  assert.match(css, /\.preview-sidebar nav\s*\{[^}]*display\s*:\s*flex;[^}]*flex-direction\s*:\s*column;/s);
  assert.match(css, /\.area-card-copy\s*\{[^}]*display\s*:\s*flex;[^}]*flex-direction\s*:\s*column;/s);
  assert.match(css, /\.area-card strong\s*\{[^}]*font-size\s*:\s*13px;/s);
  assert.match(css, /\.area-card-copy > span\s*\{[^}]*font-size\s*:\s*12px;/s);
  assert.match(css, /\.preview-hero-copy\s*\{[^}]*width\s*:\s*min\(72%,\s*760px\);[^}]*padding\s*:\s*clamp\(24px,\s*3vw,\s*40px\)\s+clamp\(40px,\s*6vw,\s*80px\);/s);
  assert.match(css, /\.preview-hero h1\s*\{[^}]*font-size\s*:\s*clamp\(34px,\s*4vw,\s*60px\);/s);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.preview-hero-copy\s*\{[^}]*padding\s*:\s*28px\s+clamp\(28px,\s*8vw,\s*40px\)\s+32px;/s);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.preview-sidebar\s*\{[^}]*display\s*:\s*none;/s);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.preview-content\s*\{[^}]*grid-column\s*:\s*auto;/s);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.preview-mobile-profile\s*\{[^}]*display\s*:\s*inline-flex;/s);
});

test('home preview preserves the light and dark surface contrast tokens', async () => {
  const css = await readFile('public/css/home-preview.css', 'utf8');
  const tokens = await readFile('public/css/tokens.css', 'utf8');

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
  assert.match(tokens, /font-family:\s*'Oswald';[\s\S]*assets\/fonts\/Oswald-Variable\.ttf/);
  assert.match(tokens, /font-family:\s*'Hamilton';[\s\S]*fonts\.cdnfonts\.com/);
  assert.match(tokens, /--font-sans:\s*'Hamilton'/);
  assert.match(tokens, /--font-display:\s*'Oswald'/);
  assert.doesNotMatch(tokens, /Novelin|Signaturia/);
  assert.match(css, /\.preview-hero h1\s*\{[^}]*font-family:\s*var\(--font-display\);/s);
  assert.match(css, /\.section-heading h2\s*\{[^}]*font-family:\s*var\(--font-display\);/s);
  assert.match(css, /\.story-card strong\s*\{[^}]*font-family:\s*var\(--font-display\);/s);
});
