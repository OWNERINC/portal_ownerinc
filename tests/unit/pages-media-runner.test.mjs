import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createPagesMediaFixtures } from '../helpers/pages-media-fixtures.mjs';
const require = createRequire(import.meta.url);
const sharp = createRequire(new URL('../../api/package.json', import.meta.url))('sharp');
const { admit, run, binary, inputArgs } = require('../../api/pages/media-runner');
const { normalizePageMedia } = require('../../api/pages/media');

test('one admission, no queue, idempotent release, before any buffering/decoding', () => {
  const release = admit(); assert.throws(() => admit(), { status: 429, reason: 'media_busy' });
  release(); release(); const second = admit(); second();
});
test('runner requires absolute local binaries and fails closed when unavailable', async () => {
  const saved = process.env.FFPROBE_PATH;
  try {
    process.env.FFPROBE_PATH = 'ffprobe'; await assert.rejects(binary('ffprobe'), { status: 503 });
    process.env.FFPROBE_PATH = `${process.cwd()}/no-such-pages-binary`; await assert.rejects(binary('ffprobe'), { status: 503 });
  } finally { if (saved === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = saved; }
});
test('runner kills and settles on timeout, cancellation, stdout/stderr flood and decode error', async () => {
  await assert.rejects(run(process.execPath, ['-e','setInterval(()=>{},1000)'], { timeout: 20 }), { reason: 'media_timeout' });
  await assert.rejects(run(process.execPath, ['-e','process.stdout.write("x".repeat(20000))'], { stdoutLimit: 10 }), { reason: 'media_output_limit' });
  await assert.rejects(run(process.execPath, ['-e','process.stderr.write("x".repeat(100000))']), { reason: 'media_output_limit' });
  await assert.rejects(run(process.execPath, ['-e','process.stderr.write("decode error")']), { reason: 'invalid_media' });
  const abort = new AbortController(), pending = run(process.execPath, ['-e','setInterval(()=>{},1000)'], { signal: abort.signal }); abort.abort();
  await assert.rejects(pending, { reason: 'upload_cancelled' });
  assert.equal(await run(process.execPath, ['-e','process.stdout.write("okay")']), 'okay');
});
test('demuxers, file-only protocols and MOV external references are fixed, not guessed from user filenames', () => {
  assert.deepEqual(inputArgs('video','/generated/input.mp4'), ['-protocol_whitelist','file','-f','mov','-enable_drefs','0','-use_absolute_path','0','-i','/generated/input.mp4']);
  assert.ok(inputArgs('audio','/generated/input.mp3').includes('mp3'));
});
test('real generated animations/audio/video fully decode; abusive/truncated/confused inputs fail closed', async () => {
  const old = { FFMPEG_PATH: process.env.FFMPEG_PATH, FFPROBE_PATH: process.env.FFPROBE_PATH };
  if (process.platform === 'win32') {
    for (const name of ['ffmpeg','ffprobe']) {
      const key = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
      if (!process.env[key]) process.env[key] = Buffer.from(execFileSync('powershell.exe', ['-NoProfile','-Command', `[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes((Get-Command ${name}).Source))`], { encoding: 'ascii' }).trim(), 'base64').toString('utf16le');
    }
  }
  let fixtures;
  try {
    fixtures = await createPagesMediaFixtures();
    const gif = await normalizePageMedia(fixtures.files['synthetic.gif'].buffer, 'gif');
    assert.equal(gif.frame_count, 8); assert.equal(gif.duration_seconds, 2);
    const metadata = await sharp(gif.data, { animated: true }).metadata(); assert.equal(metadata.pages, 8);
    const audio = await normalizePageMedia(fixtures.files['synthetic.mp3'].buffer, 'audio'); assert.equal(audio.mime_type, 'audio/mpeg'); assert.ok(audio.duration_seconds >= 1.9);
    const video = await normalizePageMedia(fixtures.files['synthetic.mp4'].buffer, 'video'); assert.equal(video.frame_count, 20); assert.equal(video.width, 160); assert.ok(video.duration_seconds <= 2.1);
    const innocent = await normalizePageMedia(fixtures.files['innocent-metadata.mp4'].buffer, 'video'); assert.equal(innocent.frame_count, 20);
    await assert.rejects(normalizePageMedia(fixtures.files['encrypted.mp4'].buffer, 'video'), { status: 415 });
    for (const name of ['midstream-resolution.mp4','midstream-pixels.mp4']) {
      await assert.rejects(normalizePageMedia(fixtures.files[name].buffer, 'video'), { status: 415, reason: 'invalid_media_frame' }, `${name}: every decoded frame, not just initial stream metadata, must stay in contract`);
    }
    for (const [name, kind] of [['unsupported-codec.mp4','video'],['extra-audio-track.mp4','video'],['too-fast.mp4','video'],['too-many-frames.gif','gif'],['too-long.mp3','audio'],['synthetic.mp3','video']]) await assert.rejects(normalizePageMedia(fixtures.files[name].buffer, kind), { status: 415 });
    const external = Buffer.from(fixtures.files['synthetic.mp4'].buffer); const position = external.indexOf(Buffer.from('url ')); external[position + 7] = 0;
    await assert.rejects(normalizePageMedia(external, 'video'), { status: 415 });
    await assert.rejects(normalizePageMedia(fixtures.files['synthetic.mp4'].buffer.subarray(0,64), 'video'), { status: 415 });
    for (const [kind,mib] of [['image',5],['gif',8],['audio',10],['video',25]]) await assert.rejects(normalizePageMedia(Buffer.alloc(mib * 1024 * 1024 + 1), kind), { status: 413 });
  } finally {
    await fixtures?.close();
    for (const [key,value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
