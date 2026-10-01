import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Academy usa vetores próprios com componentes animáveis seguros', async () => {
  const manifest = JSON.parse(await readFile('public/assets/academy/manifest.json', 'utf8'));
  assert.match(manifest.source_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.assets.map(({ key }) => key), [
    'symbol', 'icon-01', 'icon-02', 'icon-03', 'icon-04', 'icon-05', 'icon-06',
    'logo-dark', 'logo-light'
  ]);
  for (const asset of manifest.assets) {
    assert.equal(asset.file, `${asset.key}.svg`);
    assert.equal(asset.page, asset.key.startsWith('logo-') ? 1 : 3);
    assert.equal(asset.viewBox.length, 4);
    assert.ok(asset.viewBox.every(Number.isFinite));
    assert.ok(asset.viewBox[2] > 0 && asset.viewBox[3] > 0);
    const svg = await readFile(`public/assets/academy/${asset.file}`, 'utf8');
    const viewBox = svg.match(/viewBox="([^"]+)"/);
    assert.ok(viewBox);
    const coordinates = viewBox[1].split(' ').map(Number);
    assert.equal(coordinates.length, 4);
    coordinates.forEach((value, index) => {
      assert.ok(Math.abs(value - asset.viewBox[index]) <= 0.000051);
    });
    assert.match(svg, /<path\b/);
    assert.doesNotMatch(svg, /<script\b|<foreignObject\b|<image\b|\son\w+=|(?:href|src)=/i);
    assert.equal((svg.match(/data-part=/g) || []).length, asset.parts);
    assert.equal((svg.match(/<path\b/g) || []).length, asset.parts);
    assert.equal(asset.parts, asset.key.startsWith('icon-') ? 2 : asset.key === 'symbol' ? 1 : 16);
    for (let part = 1; part <= asset.parts; part += 1) {
      assert.ok(svg.includes(`<g data-part="${part}">`));
    }
    const fill = asset.key === 'logo-dark' ? '#141414' : asset.key === 'logo-light' ? '#F6FAF5' : 'currentColor';
    assert.equal((svg.match(new RegExp(`fill="${fill}"`, 'g')) || []).length, asset.parts + 1);
  }
});
