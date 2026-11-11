import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const sharp = require('sharp');
const { normalizePageImage, animatedContainer, writeImage, compensate, mediaPath } = require('./pages/media');

test('Pages image pipeline strips metadata, caps long side at 2400, never upscales and uses private namespace', async () => {
  const source = await sharp({ create: { width: 3000, height: 120, channels: 3, background: '#ff0000' } }).withMetadata({ exif: { IFD0: { Artist: 'Private fixture' } } }).jpeg().toBuffer();
  const output = await normalizePageImage(source);
  assert.equal(output.width, 2400); assert.equal(output.height, 96);
  const metadata = await sharp(output.data).metadata(); assert.equal(metadata.format, 'webp'); assert.equal(metadata.exif, undefined);
  const small = await normalizePageImage(await sharp({ create: { width: 10, height: 20, channels: 3, background: '#fff' } }).png().toBuffer());
  assert.equal(small.width, 10); assert.equal(small.height, 20);
  const root = await mkdtemp(path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir(), 'pages-unit-'));
  try { const file = await writeImage(root, small); assert.equal(path.dirname(file.filename), path.join(root, 'pages-private'));
    assert.match(file.storage_key, /^pages-[0-9a-f-]{36}\.webp$/); assert.deepEqual(await readFile(file.filename), small.data);
    assert.equal(mediaPath(root, file.storage_key), file.filename); assert.throws(() => mediaPath(root, '../public.webp'));
    await compensate(file); await assert.rejects(readFile(file.filename), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsupported, animated, oversize and malformed image bytes are rejected independently from profile rules', async () => {
  await assert.rejects(normalizePageImage(Buffer.from('<svg><script/></svg>')), { status: 415 });
  await assert.rejects(normalizePageImage(Buffer.alloc(5 * 1024 * 1024 + 1)), { status: 413 });
  const large = await sharp({ create: { width: 5000, height: 4001, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(normalizePageImage(large), { status: 415 });
  const gif = await sharp({ create: { width: 10, height: 20, channels: 3, background: '#fff' } }).gif().toBuffer();
  await assert.rejects(normalizePageImage(gif), { status: 415 });
  const animationChunk = Buffer.alloc(20); animationChunk.writeUInt32BE(8,0); animationChunk.write('acTL',4);
  const apng = Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), animationChunk]);
  assert.equal(animatedContainer(apng), true); await assert.rejects(normalizePageImage(apng), { status: 415 });
});
