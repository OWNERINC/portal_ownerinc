import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// SHA-256 of the three original SVGs supplied by the user. No recoloring,
// path approximation, embedded remote resources or format conversion.
const originals = [
  ['logo-horizontal.svg', '6070305bb1b0ab1087f08cd363a6748c5d7a9d3f5f8e4d13d81cbbc5a210b7eb'],
  ['logo.svg', 'eb8f987b6af1786078ed4216ec04e8dc83d5213bce64a5d3a33946a114a8287f'],
  ['symbol.svg', '8c296e5e9ca0017618fa9d823bee7568dd0a307fb08a00d68f06d678934309ee'],
];

for (const [name, digest] of originals) {
  test(`PodFalar ${name} preserves the supplied original bytes and contains only passive SVG content`, async () => {
    const bytes = await readFile(`public/assets/podfalar/${name}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
    const svg = bytes.toString('utf8');
    assert.match(svg, /<svg\b[^>]*viewBox="0 0 [\d.]+ [\d.]+"/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image)\b|\bon\w+\s*=|(?:href|src)\s*=|@import|url\(/i);
  });
}
