const sharp = require('sharp');
const { createHash, randomUUID } = require('node:crypto');
const { mkdir, writeFile, unlink } = require('node:fs/promises');
const path = require('node:path');
const { PagesError } = require('./validation');
const { inspectMedia } = require('./media-runner');
const { assertLocalMP4 } = require('./mp4-boxes');

const MAX_BYTES = 5 * 1024 * 1024;
const LIMITS = { image: MAX_BYTES, gif: 8 * 1024 * 1024, audio: 10 * 1024 * 1024, video: 25 * 1024 * 1024 };
function animatedContainer(buffer) {
  // Some decoders expose only the first APNG frame. Reject animation chunks
  // independently, rather than silently flattening an animated source.
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) {
    for (let cursor = 8; cursor + 12 <= buffer.length;) {
      const size = buffer.readUInt32BE(cursor), type = buffer.toString('ascii',cursor + 4,cursor + 8);
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return true;
      if (size > buffer.length - cursor - 12) break;
      cursor += size + 12;
    }
  }
  if (buffer.length >= 12 && buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP') {
    for (let cursor = 12; cursor + 8 <= buffer.length;) {
      const type = buffer.toString('ascii',cursor,cursor + 4), size = buffer.readUInt32LE(cursor + 4);
      if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && size >= 1 && (buffer[cursor + 8] & 2))) return true;
      if (size > buffer.length - cursor - 8) break;
      cursor += 8 + size + (size % 2);
    }
  }
  return false;
}
async function normalizePageImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_BYTES) throw new PagesError(413, 'image_too_large');
  try {
    if (animatedContainer(buffer)) throw new Error('Animated image');
    const image = sharp(buffer, { failOn: 'warning', limitInputPixels: 20000000, animated: true });
    const meta = await image.metadata();
    if (!['jpeg','png','webp'].includes(meta.format) || !meta.width || !meta.height || (meta.pages || 1) !== 1
      || meta.width * meta.height > 20000000) throw new Error('Unsupported image');
    const { data, info } = await image.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    if (data.length > MAX_BYTES) throw new PagesError(413, 'image_too_large');
    return { data, width: info.width, height: info.height, byte_size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  } catch (err) {
    if (err instanceof PagesError) throw err;
    throw new PagesError(415, 'unsupported_image', 'Use uma imagem estática JPEG, PNG ou WebP de até 5 MiB e 20 MP.');
  }
}
function privateDirectory(uploadDirectory) { return path.join(uploadDirectory, 'pages-private'); }
async function normalizePageMedia(buffer, kind, options) {
  if (!Object.hasOwn(LIMITS, kind)) throw new PagesError(400, 'invalid_upload');
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > LIMITS[kind]) throw new PagesError(413, 'media_too_large');
  if (kind === 'image') return { ...await normalizePageImage(buffer), kind, mime_type: 'image/webp' };
  if (kind === 'video') assertLocalMP4(buffer);
  const metadata = await inspectMedia(buffer, kind, options);
  let data = buffer;
  if (kind === 'gif') {
    try {
      const image = sharp(buffer, { animated: true, failOn: 'warning', limitInputPixels: 20000000 });
      const meta = await image.metadata();
      if (meta.format !== 'gif' || (meta.pages || 1) !== metadata.frame_count || (meta.delay || []).reduce((sum, delay) => sum + delay, 0) > 30000) throw new Error('Invalid GIF');
      data = await image.gif({ effort: 7 }).toBuffer();
    } catch { throw new PagesError(415, 'invalid_media'); }
  }
  if (data.length > LIMITS[kind]) throw new PagesError(413, 'media_too_large');
  return { ...metadata, kind, mime_type: { gif: 'image/gif', audio: 'audio/mpeg', video: 'video/mp4' }[kind], data,
    byte_size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
async function writeImage(uploadDirectory, normalized) {
  const id = randomUUID(), storage_key = `pages-${id}.${{ image: 'webp', gif: 'gif', audio: 'mp3', video: 'mp4' }[normalized.kind || 'image']}`;
  const directory = privateDirectory(uploadDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, storage_key);
  await writeFile(filename, normalized.data, { flag: 'wx', mode: 0o600 });
  return { ...normalized, id, storage_key, filename };
}
function mediaPath(uploadDirectory, key) {
  if (!/^pages-[0-9a-f-]{36}\.(webp|gif|mp3|mp4)$/.test(key)) throw new PagesError(404, 'not_visible');
  return path.join(privateDirectory(uploadDirectory), key);
}
const compensate = image => unlink(image.filename).catch(() => {});
module.exports = { MAX_BYTES, LIMITS, animatedContainer, normalizePageImage, normalizePageMedia, privateDirectory, writeImage, mediaPath, compensate };
