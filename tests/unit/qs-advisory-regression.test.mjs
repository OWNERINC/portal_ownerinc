import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const qs = apiRequire('qs');

// GHSA-6pq8-jhm2-2vcw: both the join and encodeValuesOnly coercion paths.
// Expected serialization is grounded in the upstream fix and its regressions:
// https://github.com/ljharb/qs/commit/a952e7519338ef0cfb25694a2988848f93333727
for (const encodeValuesOnly of [false, true]) {
  test(`qs comma serialization handles hostile array elements (encodeValuesOnly=${encodeValuesOnly})`, () => {
    const options = { arrayFormat: 'comma', encodeValuesOnly };
    const inputs = [
      ['JSON own non-callable toString', JSON.parse('{"a":[{"toString":"x"}]}')],
      ['extended query parser', qs.parse('a[0][toString]=x', { allowPrototypes: true })],
      ['null-prototype parser result', qs.parse('a[][b]=c', { plainObjects: true })],
    ];
    for (const [source, input] of inputs) {
      assert.equal(qs.stringify(input, options), 'a=%5Bobject%20Object%5D', source);
    }
    assert.equal(
      qs.stringify(JSON.parse('{"a":["b",{"toString":"x"},"c"]}'), options),
      encodeValuesOnly ? 'a=b,%5Bobject%20Object%5D,c' : 'a=b%2C%5Bobject%20Object%5D%2Cc',
      'surrounding primitive entries retain the documented comma encoding',
    );
    assert.equal(
      qs.stringify({ a: [{ toString: () => 'safe' }] }, options),
      'a=safe',
      'a callable toString retains its existing behavior',
    );
  });
}

// The same patch line fixes []= detection at the key/value boundary.
// https://github.com/ljharb/qs/blob/v6.16.2/test/parse.js
test('qs comma parsing does not treat []= inside a value as an array key', () => {
  assert.deepEqual(qs.parse('a[b]=1,2,3[]=x', { comma: true }), { a: { b: ['1', '2', '3[]=x'] } });
  assert.deepEqual(qs.parse('a[b]=1,2[]=3', { comma: true }), { a: { b: ['1', '2[]=3'] } });
  assert.deepEqual(qs.parse('a[]=1,2,3', { comma: true }), { a: [['1', '2', '3']] });
});

test('qs value text containing []= respects the requested duplicate policy', () => {
  const query = 'a[b]=1&a[b]=2[]=3';
  assert.deepEqual(qs.parse(query, { duplicates: 'first' }), { a: { b: '1' } });
  assert.deepEqual(qs.parse(query, { duplicates: 'last' }), { a: { b: '2[]=3' } });
  assert.deepEqual(qs.parse(query, { duplicates: 'combine' }), { a: { b: ['1', '2[]=3'] } });
});
