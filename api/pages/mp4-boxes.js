const { PagesError } = require('./validation');

const invalid = () => { throw new PagesError(415, 'invalid_media'); };
const containers = new Set(['moov','trak','mdia','minf','stbl','dinf','mvex','moof','traf','mfra','edts']);
const encrypted = new Set(['encv','enca','drms','drmi','sinf','schm','schi','tenc','pssh','senc']);
const encryptionUUIDs = new Set([
  'd08a4f1810f34a82b6c832d8aba183d3', // PIFF protection-system header
  'a2394f525a9b4f14a2446c427c648df4', // PIFF sample encryption
  '8974dbce7be74c5184f97148f9882554', // PIFF track encryption
]);

// Walk actual box boundaries only. Sample data, codec configuration, metadata,
// free space and unknown leaf payloads are opaque, never searched for words.
function assertLocalMP4(buffer) {
  if (!Buffer.isBuffer(buffer)) invalid();
  let boxes = 0;
  function header(start, end) {
    if (++boxes > 20000 || end - start < 8) invalid();
    let size = buffer.readUInt32BE(start), bytes = 8;
    const type = buffer.toString('latin1', start + 4, start + 8);
    if (size === 1) {
      if (end - start < 16) invalid();
      const large = buffer.readBigUInt64BE(start + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      size = Number(large); bytes = 16;
    } else if (size === 0) size = end - start;
    if (size < bytes || size > end - start) invalid();
    return { type, payload: start + bytes, end: start + size };
  }
  function fullBoxEntries(box, depth, reference = false) {
    if (box.end - box.payload < 8 || buffer.readUInt32BE(box.payload) !== 0) invalid();
    const count = buffer.readUInt32BE(box.payload + 4);
    if (!count || count > 256) invalid();
    let cursor = box.payload + 8;
    for (let i = 0; i < count; i++) {
      const entry = header(cursor, box.end);
      if (reference) {
        // Only a version-zero, self-contained URL entry is local. URNs,
        // external URLs, unknown reference types and contradictory payloads fail.
        if (entry.type !== 'url ' || entry.end - entry.payload !== 4 || buffer.readUInt32BE(entry.payload) !== 1) invalid();
      } else inspect(entry, depth + 1, true);
      cursor = entry.end;
    }
    if (cursor !== box.end) invalid();
  }
  function inspect(box, depth, sampleEntry = false) {
    if (depth > 16 || encrypted.has(box.type)) invalid();
    if (box.type === 'uuid') {
      if (box.end - box.payload < 16) invalid();
      if (encryptionUUIDs.has(buffer.subarray(box.payload, box.payload + 16).toString('hex'))) invalid();
    } else if (box.type === 'dref') fullBoxEntries(box, depth, true);
    else if (box.type === 'stsd') fullBoxEntries(box, depth);
    else if (sampleEntry && ['avc1','avc3','mp4a'].includes(box.type)) {
      const length = box.end - box.payload;
      if (length < 8 || buffer.readUInt16BE(box.payload + 6) === 0) invalid();
      let prefix = 78;
      if (box.type === 'mp4a') {
        if (length < 28) invalid();
        const version = buffer.readUInt16BE(box.payload + 8);
        prefix = { 0: 28, 1: 44, 2: 64 }[version];
        if (prefix === undefined) invalid();
      }
      if (length < prefix) invalid();
      walk(box.payload + prefix, box.end, depth + 1);
    } else if (containers.has(box.type)) walk(box.payload, box.end, depth + 1);
  }
  function walk(start, end, depth) {
    let cursor = start;
    while (cursor < end) {
      const box = header(cursor, end); inspect(box, depth); cursor = box.end;
    }
  }
  walk(0, buffer.length, 0);
}
module.exports = { assertLocalMP4 };
