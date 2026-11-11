import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertLocalMP4 } = require('../../api/pages/mp4-boxes');
const box = (type, ...data) => { const payload = Buffer.concat(data), header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type,4,'latin1'); return Buffer.concat([header,payload]); };
const fullEntries = (...entries) => { const prefix = Buffer.alloc(8); prefix.writeUInt32BE(entries.length,4); return Buffer.concat([prefix,...entries]); };
const visual = (...children) => { const prefix = Buffer.alloc(78); prefix.writeUInt16BE(1,6); return box('avc1',prefix,...children); };
const track = (...entries) => box('moov',box('trak',box('mdia',box('minf',box('stbl',box('stsd',fullEntries(...entries)))))));

test('BMFF scanner skips opaque mdat, metadata, codec configuration and unknown leaves instead of ASCII-searching', () => {
  const words = Buffer.from('sinf schm pssh url urn encv enca');
  const nestedImitation = box('sinf',box('schm',words));
  for (const type of ['mdat','free','udta','meta','avcC','zzzz']) assert.doesNotThrow(() => assertLocalMP4(box(type,words,nestedImitation)));
  assert.doesNotThrow(() => assertLocalMP4(track(visual(box('avcC',words,nestedImitation)))));
});
test('actual encryption boxes and encrypted sample entries fail at structural boundaries', () => {
  for (const type of ['pssh','senc','sinf','schm','schi','tenc']) {
    assert.throws(() => assertLocalMP4(box('moov',box(type,Buffer.alloc(8)))), { status: 415 });
    assert.throws(() => assertLocalMP4(track(visual(box(type,Buffer.alloc(8))))), { status: 415 });
  }
  for (const type of ['encv','enca','drmi','drms']) assert.throws(() => assertLocalMP4(track(box(type,Buffer.alloc(78)))), { status: 415 });
  assert.throws(() => assertLocalMP4(box('uuid',Buffer.from('a2394f525a9b4f14a2446c427c648df4','hex'))), { status: 415 });
});
test('actual dref entries require self-contained URL flags, no external/URN/unknown reference', () => {
  const local = box('url ',Buffer.from([0,0,0,1]));
  const dref = (...entries) => box('moov',box('trak',box('mdia',box('minf',box('dinf',box('dref',fullEntries(...entries)))))));
  assert.doesNotThrow(() => assertLocalMP4(dref(local)));
  for (const entry of [box('url ',Buffer.alloc(4),Buffer.from('file:///outside')), box('urn ',Buffer.from([0,0,0,1])), box('url ',Buffer.from([0,0,0,1]),Buffer.from('contradictory')), box('zzzz',Buffer.alloc(4))]) assert.throws(() => assertLocalMP4(dref(entry)), { status: 415 });
});
test('box lengths, extended sizes, full-box counts, depth and sample-entry prefixes are bounded', () => {
  const large = Buffer.alloc(16); large.writeUInt32BE(1); large.write('free',4); large.writeBigUInt64BE(16n,8); assert.doesNotThrow(() => assertLocalMP4(large));
  for (const value of [Buffer.alloc(7), box('free').subarray(0,7), box('stsd',Buffer.alloc(4)), track(box('avc1',Buffer.alloc(10)))]) assert.throws(() => assertLocalMP4(value), { status: 415 });
  const overflow = Buffer.from(large); overflow.writeBigUInt64BE(9007199254740992n,8); assert.throws(() => assertLocalMP4(overflow), { status: 415 });
  const truncated = box('free'); truncated.writeUInt32BE(100); assert.throws(() => assertLocalMP4(truncated), { status: 415 });
  let deep = box('free'); for (let i = 0; i < 18; i++) deep = box('moov',deep); assert.throws(() => assertLocalMP4(deep), { status: 415 });
});
