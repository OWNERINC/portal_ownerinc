const { spawn } = require('node:child_process');
const { access, mkdtemp, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PagesError } = require('./validation');

let admitted = false;
function admit() {
  if (admitted) throw new PagesError(429, 'media_busy');
  admitted = true; let released = false;
  return () => { if (!released) { released = true; admitted = false; } };
}
async function binary(name) {
  const filename = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'] || (process.platform === 'win32' ? '' : `/usr/bin/${name}`);
  if (!filename || !path.isAbsolute(filename)) throw new PagesError(503, 'media_tool_unavailable');
  try { await access(filename); } catch { throw new PagesError(503, 'media_tool_unavailable'); }
  return filename;
}
// Bounded streaming output, no shell, and cancellation settles only after close.
function run(filename, args, { signal, timeout = 10000, stdoutLimit = 262144, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new PagesError(499, 'upload_cancelled')); return; }
    const child = spawn(filename, args, { shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', pending = '', stderr = '', bytes = 0, failure;
    const stop = error => { failure ||= error; child.kill('SIGKILL'); };
    const abort = () => stop(new PagesError(499, 'upload_cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new PagesError(415, 'media_timeout')), timeout);
    child.on('error', () => { failure ||= new PagesError(503, 'media_tool_unavailable'); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > stdoutLimit) return stop(new PagesError(415, 'media_output_limit'));
      if (!onLine) output += chunk.toString();
      else {
        pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop();
        if (pending.length > 8192) return stop(new PagesError(415, 'media_output_limit'));
        try { lines.forEach(onLine); } catch (error) { stop(error); }
      }
    });
    child.stderr.on('data', chunk => { if (stderr.length + chunk.length > 65536) stop(new PagesError(415, 'media_output_limit')); else stderr += chunk.toString(); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || stderr.trim()) reject(new PagesError(415, 'invalid_media'));
      else resolve(output);
    });
  });
}
const rational = value => { const [a,b] = String(value).split('/').map(Number); return b ? a / b : NaN; };
function inputArgs(kind, file) {
  return ['-protocol_whitelist','file', '-f', { audio: 'mp3', video: 'mov', gif: 'gif' }[kind],
    ...(kind === 'video' ? ['-enable_drefs','0','-use_absolute_path','0'] : []), '-i', file];
}
function validateProbe(probe, kind) {
  const streams = probe.streams;
  if (!Array.isArray(streams) || !streams.length || streams.some(s => s.disposition?.attached_pic || s.tags?.encryption)) throw new PagesError(415, 'invalid_media');
  const video = streams.filter(s => s.codec_type === 'video'), audio = streams.filter(s => s.codec_type === 'audio');
  if (streams.length !== video.length + audio.length) throw new PagesError(415, 'invalid_media');
  const audioOkay = s => s.channels >= 1 && s.channels <= 2 && Number(s.sample_rate) > 0 && Number(s.sample_rate) <= 48000;
  if (kind === 'audio') {
    if (streams.length !== 1 || audio.length !== 1 || audio[0].codec_name !== 'mp3' || !audioOkay(audio[0])) throw new PagesError(415, 'invalid_media');
  } else {
    const s = video[0];
    if (video.length !== 1 || audio.length > (kind === 'video' ? 1 : 0) || !s.width || !s.height) throw new PagesError(415, 'invalid_media');
    if (kind === 'video' && (s.codec_name !== 'h264' || s.pix_fmt !== 'yuv420p' || s.width > 1920 || s.height > 1080
      || !(rational(s.avg_frame_rate) > 0 && rational(s.avg_frame_rate) <= 30.001)
      || Math.abs(rational(s.avg_frame_rate) - rational(s.r_frame_rate)) > 0.001
      || audio.some(a => a.codec_name !== 'aac' || a.profile !== 'LC' || !audioOkay(a)))) throw new PagesError(415, 'invalid_media');
    if (kind === 'gif' && (s.codec_name !== 'gif' || s.width * s.height > 20000000)) throw new PagesError(415, 'invalid_media');
  }
  const duration = Number(probe.format?.duration), limit = { gif: 30, audio: 600, video: 120 }[kind];
  if (!(duration > 0 && duration <= limit)) throw new PagesError(415, 'invalid_media');
  return { streams, video: video[0], duration, limit };
}
async function inspectMedia(buffer, kind, { signal } = {}) {
  const ffprobe = await binary('ffprobe'), ffmpeg = await binary('ffmpeg');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pages-media-'));
  try {
    const file = path.join(dir, `input.${{ audio: 'mp3', video: 'mp4', gif: 'gif' }[kind]}`);
    await writeFile(file, buffer, { flag: 'wx', mode: 0o600 });
    const common = ['-v','error','-max_alloc','104857600'];
    const probe = JSON.parse(await run(ffprobe, [...common, ...inputArgs(kind, file), '-show_streams','-show_format','-of','json'], { signal }));
    const checked = validateProbe(probe, kind), timelines = new Map(), timebases = new Map();
    if (kind === 'video') {
      let previous, interval, count = 0;
      await run(ffprobe, [...common, '-threads','1','-err_detect','explode', ...inputArgs(kind, file), '-select_streams','v:0', '-show_entries','frame=best_effort_timestamp_time,duration_time,width,height,pix_fmt', '-of','csv=p=0'], {
        signal,
        onLine(line) {
          if (!line.trim()) return;
          const values = line.trim().split(','), [pts, duration, width, height] = values.slice(0,4).map(Number), pixelFormat = values[4];
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1920 || height > 1080
            || pixelFormat !== 'yuv420p' || width !== checked.video.width || height !== checked.video.height) throw new PagesError(415, 'invalid_media_frame');
          if (!Number.isFinite(pts) || !(duration > 0) || (previous !== undefined && (!(pts > previous) || Math.abs((pts - previous) - interval) > 0.0001))
            || (interval !== undefined && Math.abs(duration - interval) > 0.0001)) throw new PagesError(415, 'invalid_media_timeline');
          interval ??= duration; previous = pts; count++;
          if (count > 3600) throw new PagesError(415, 'invalid_media_timeline');
        },
      });
      if (!count) throw new PagesError(415, 'invalid_media_frame');
    }
    const maps = kind === 'audio' ? ['-map','0:a:0'] : ['-map','0:v:0', ...(checked.streams.some(s => s.codec_type === 'audio') ? ['-map','0:a:0'] : [])];
    await run(ffmpeg, [...common, '-xerror','-err_detect','explode','-threads','1', ...inputArgs(kind, file), ...maps, '-threads','1','-filter_threads','1','-fps_mode','passthrough','-f','framemd5','-'], {
      signal, timeout: 45000, stdoutLimit: 8 * 1024 * 1024,
      onLine(line) {
        const tb = /^#tb (\d+): (\d+)\/(\d+)/.exec(line);
        if (tb) { timebases.set(Number(tb[1]), Number(tb[2]) / Number(tb[3])); return; }
        if (!line.trim() || line.startsWith('#')) return;
        const parts = line.split(',').map(v => v.trim()), index = Number(parts[0]), pts = Number(parts[2]), duration = Number(parts[3]);
        const base = timebases.get(index);
        if (!base || !Number.isFinite(pts) || !(duration > 0)) throw new PagesError(415, 'invalid_media_timeline');
        const t = timelines.get(index) || { first: pts * base, end: pts * base, count: 0, durations: new Set() };
        if (pts * base < t.end - base * 1.1) throw new PagesError(415, 'invalid_media_timeline');
        t.end = (pts + duration) * base; t.count++; t.durations.add(duration); timelines.set(index, t);
        if (t.end - t.first > checked.limit + 0.05 || (kind === 'gif' && (t.count > 100 || checked.video.width * checked.video.height * t.count > 20000000))) throw new PagesError(415, 'invalid_media_timeline');
      },
    });
    if (timelines.size !== checked.streams.length) throw new PagesError(415, 'invalid_media_timeline');
    const values = [...timelines.values()], duration = Math.max(...values.map(t => t.end - t.first));
    if (!(duration > 0 && duration <= checked.limit) || Math.abs(duration - checked.duration) > 0.15
      || (kind === 'video' && timelines.get(0).durations.size !== 1)) throw new PagesError(415, 'invalid_media_timeline');
    const mapped = kind === 'audio' ? checked.streams : [checked.video, ...checked.streams.filter(s => s.codec_type === 'audio')];
    for (let i = 0; i < mapped.length; i++) {
      const stream = mapped[i], measured = values[i].end - values[i].first;
      if (stream.duration !== undefined && Math.abs(Number(stream.duration) - measured) > 0.15) throw new PagesError(415, 'invalid_media_timeline');
    }
    return { duration_seconds: duration, width: checked.video?.width ?? null, height: checked.video?.height ?? null,
      frame_count: checked.video ? timelines.get(0).count : null };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
module.exports = { admit, binary, run, validateProbe, inspectMedia, inputArgs };
