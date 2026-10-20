import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const helperPath = new URL('../../public/js/content-length.js', import.meta.url);
const helperSource = await readFile(helperPath, 'utf8').catch(() => '');
const context = vm.createContext({});
if (helperSource) {
  vm.runInContext(`${helperSource.replace(/^export\s+/gmu, '')}\nglobalThis.parseContentLength = parseContentLength;`, context,
    { filename: 'public/js/content-length.js' });
}

test('shared Content-Length parser distinguishes absent, canonical, invalid and over-cap values', () => {
  const parse = context.parseContentLength;
  assert.equal(typeof parse, 'function', 'the shared parser is present');
  assert.deepEqual(JSON.parse(JSON.stringify(parse(null, 16))), { kind: 'absent' });
  assert.deepEqual(JSON.parse(JSON.stringify(parse(undefined, 16))), { kind: 'absent' });
  for (const [value, length] of [['0', 0], ['1', 1], ['16', 16]]) {
    assert.deepEqual(JSON.parse(JSON.stringify(parse(value, 16))), { kind: 'valid', length });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(parse('17', 16))), { kind: 'too-large', length: 17 });
  for (const value of ['', '01', '-1', '+1', '1.0', '1e2', ' 1', '1 ', '1, 1', '9007199254740992']) {
    assert.deepEqual(JSON.parse(JSON.stringify(parse(value, 16))), { kind: 'invalid' }, `reject ${JSON.stringify(value)}`);
  }
});

test('shared Content-Length parser rejects invalid caps rather than weakening validation', () => {
  const parse = context.parseContentLength;
  assert.equal(typeof parse, 'function', 'the shared parser is present');
  for (const maxBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => parse('1', maxBytes), error => error.name === 'TypeError');
  }
});
