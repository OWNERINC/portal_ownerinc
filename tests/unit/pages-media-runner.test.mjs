import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createPagesMediaFixtures } from '../helpers/pages-media-fixtures.mjs';
const require = createRequire(import.meta.url);
const sharp = createRequire(new URL('../../api/package.json', import.meta.url))('sharp');
const { admit, run, binary, inputArgs } = require('../../api/pages/media-runner');
const { normalizePageMedia } = require('../../api/pages/media');
const execute = promisify(execFile);

function mediaBinaryPath(name) {
  const key = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  if (process.env[key]) return process.env[key];
  if (process.platform !== 'win32') return name;
  return Buffer.from(execFileSync('powershell.exe', ['-NoProfile','-Command', `[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes((Get-Command ${name}).Source))`], { encoding: 'ascii' }).trim(), 'base64').toString('utf16le');
}

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
test('real media fixtures create a missing temporary parent and clean their unique directory', async () => {
  const temporaryParent = join(tmpdir(), 'opencode');
  await mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = await mkdtemp(join(temporaryParent, 'pages-media-temp-'));
  const helperUrl = new URL('../helpers/pages-media-fixtures.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { stat, readdir } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { basename, dirname, join } from 'node:path';
    import { createPagesMediaFixtures } from ${JSON.stringify(helperUrl)};
    const parent = join(tmpdir(), 'opencode');
    await assert.rejects(stat(parent), { code: 'ENOENT' });
    const fixtures = await createPagesMediaFixtures();
    try {
      assert.equal(dirname(fixtures.directory), parent);
      assert.ok(basename(fixtures.directory).startsWith('pages-media-fixtures-'));
      assert.ok((await stat(parent)).isDirectory());
      for (const name of ['synthetic.gif', 'synthetic.mp3', 'synthetic.mp4']) {
        assert.ok(fixtures.files[name], name);
      }
      for (const { path, buffer } of Object.values(fixtures.files)) {
        assert.equal(dirname(path), fixtures.directory);
        assert.ok(buffer.length > 0);
        assert.equal((await stat(path)).size, buffer.length);
      }
    } finally {
      await fixtures.close();
    }
    await assert.rejects(stat(fixtures.directory), { code: 'ENOENT' });
    assert.deepEqual(await readdir(parent), []);
    process.stdout.write('real fixtures generated and cleaned');
  `;
  try {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot, FFMPEG_PATH: mediaBinaryPath('ffmpeg') },
      timeout: 120000, maxBuffer: 262144, windowsHide: true
    });
    assert.equal(stdout, 'real fixtures generated and cleaned');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
test('real generated animations/audio/video fully decode; abusive/truncated/confused inputs fail closed', async () => {
  const old = { FFMPEG_PATH: process.env.FFMPEG_PATH, FFPROBE_PATH: process.env.FFPROBE_PATH };
  if (process.platform === 'win32') {
    for (const name of ['ffmpeg','ffprobe']) {
      const key = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
      if (!process.env[key]) process.env[key] = mediaBinaryPath(name);
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
