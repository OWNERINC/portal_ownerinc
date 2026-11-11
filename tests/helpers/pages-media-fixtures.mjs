// Generated from lavfi only; no copyrighted uploads or checked-in binary fixtures.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
export async function createPagesMediaFixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'opencode', 'pages-media-fixtures-'));
  const executable = process.env.FFMPEG_PATH || 'ffmpeg';
  const files = {};
  async function generate(name, args) {
    const path = join(directory, name);
    await run(executable, ['-hide_banner', '-v', 'error', '-nostdin', ...args, '-threads', '1', '-y', path], { timeout: 60000, maxBuffer: 262144, windowsHide: true });
    files[name] = { path, buffer: await readFile(path) };
  }
  try {
    await generate('synthetic.gif', ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=4:duration=2', '-t', '2']);
    await generate('synthetic.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', '-c:a', 'libmp3lame', '-b:a', '64k']);
    await generate('synthetic.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=2', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-profile:a', 'aac_low', '-movflags', '+faststart', '-shortest']);
    await generate('different.gif', ['-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=4:duration=1', '-t', '1']);
    await generate('different.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=1', '-c:a', 'libmp3lame', '-b:a', '64k']);
    await generate('different.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
    await generate('unsupported-codec.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=0.5', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
    await generate('extra-audio-track.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.5', '-map', '0:v', '-map', '1:a', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']);
    await generate('too-many-frames.gif', ['-f', 'lavfi', '-i', 'testsrc=size=8x8:rate=60:duration=2', '-t', '2']);
    await generate('too-long.mp3', ['-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '601', '-c:a', 'libmp3lame', '-b:a', '32k']);
    await generate('too-fast.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=60:duration=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
    await generate('innocent-metadata.mp4', ['-i', files['synthetic.mp4'].path, '-c', 'copy', '-metadata', 'comment=Non-encrypted synthetic metadata: sinf schm pssh url ', '-movflags', '+faststart']);
    await generate('encrypted.mp4', ['-i', files['synthetic.mp4'].path, '-c', 'copy', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', Buffer.alloc(16, 17).toString('hex'), '-encryption_kid', Buffer.alloc(16, 34).toString('hex'), '-movflags', '+faststart']);
    await generate('initial.h264', ['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=10:scenecut=0:bframes=0', '-f', 'h264']);
    await generate('oversized-tail.h264', ['-f', 'lavfi', '-i', 'color=c=blue:s=2048x1152:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=10:scenecut=0:bframes=0', '-f', 'h264']);
    await generate('unsupported-pixels-tail.h264', ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-x264-params', 'keyint=10:scenecut=0:bframes=0', '-f', 'h264']);
    for (const [name, tail] of [['midstream-resolution.mp4', 'oversized-tail.h264'], ['midstream-pixels.mp4', 'unsupported-pixels-tail.h264']]) {
      const input = join(directory, `${name}.h264`);
      await writeFile(input, Buffer.concat([files['initial.h264'].buffer, files[tail].buffer]), { flag: 'wx' });
      await generate(name, ['-fflags', '+genpts', '-r', '10', '-f', 'h264', '-i', input, '-c:v', 'copy', '-movflags', '+faststart']);
    }
    return { directory: resolve(directory), files, async close() { await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
