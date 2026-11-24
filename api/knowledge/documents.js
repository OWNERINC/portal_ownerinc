const { open, lstat } = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const unavailable = () => Object.assign(new Error('Documento indisponível.'), { status: 404 });
function validateDescriptor(value) {
  return value === null || (shape(value, ['kind']) && value.kind === 'ethics')
    || (shape(value, ['kind', 'key']) && value.kind === 'pdf'
      && typeof value.key === 'string' && HASH.test(value.key));
}
function validImage(value, page) {
  return shape(value, page ? ['width','height','bytes','sha256','number','text'] : ['width','height','bytes','sha256'])
    && ['width','height'].every(key => Number.isInteger(value[key]) && value[key] > 0 && value[key] <= 2400)
    && Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= 8 * 1024 * 1024
    && typeof value.sha256 === 'string' && HASH.test(value.sha256)
    && (!page || (typeof value.text === 'string' && value.text.length <= 50000));
}
function validateManifest(value, key) {
  return shape(value, ['version','source','cover','pages']) && value.version === 1
    && shape(value.source, ['id','filename','bytes','sha256','url'])
    && typeof value.source.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value.source.id)
    && typeof value.source.filename === 'string' && value.source.filename.length <= 300
    && Number.isSafeInteger(value.source.bytes) && value.source.bytes > 0
    && value.source.sha256 === key
    && value.source.url === `https://drive.google.com/file/d/${value.source.id}/view`
    && validImage(value.cover, false) && value.cover.width <= 720 && value.cover.height <= 720
    && Array.isArray(value.pages) && value.pages.length > 0 && value.pages.length <= 500
    && value.pages.every((page, index) => validImage(page, true) && page.number === index + 1);
}
async function privateRead(uploadDir, key, name, maxBytes) {
  // All path components are generated or allowlisted, never taken from a filename in JSON.
  if (!HASH.test(key) || !/^(manifest\.json|cover\.webp|[0-9]{4}\.webp)$/.test(name)) throw unavailable();
  const root = path.resolve(uploadDir, 'knowledge-private');
  const directory = path.join(root, key);
  try {
    for (const part of [root, directory]) {
      const stat = await lstat(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    }
    const filename = path.join(directory, name);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw unavailable();
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const current = await file.stat();
      if (!current.isFile() || current.size > maxBytes) throw unavailable();
      const bytes = await file.readFile();
      if (bytes.length > maxBytes) throw unavailable();
      return bytes;
    } finally { await file.close(); }
  } catch { throw unavailable(); }
}
async function loadDocument(uploadDir, descriptor) {
  if (!validateDescriptor(descriptor) || descriptor?.kind !== 'pdf') throw unavailable();
  try {
    const bytes = await privateRead(uploadDir, descriptor.key, 'manifest.json', 4 * 1024 * 1024);
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (!validateManifest(manifest, descriptor.key)) throw unavailable();
    return manifest;
  } catch { throw unavailable(); }
}
async function documentImage(uploadDir, descriptor, numberOrCover) {
  if (numberOrCover !== 'cover' && !/^[1-9][0-9]{0,2}$/.test(numberOrCover)) throw unavailable();
  const manifest = await loadDocument(uploadDir, descriptor);
  const image = numberOrCover === 'cover' ? manifest.cover : manifest.pages[Number(numberOrCover) - 1];
  if (!image) throw unavailable();
  const name = numberOrCover === 'cover' ? 'cover.webp' : `${String(numberOrCover).padStart(4, '0')}.webp`;
  const bytes = await privateRead(uploadDir, descriptor.key, name, 8 * 1024 * 1024);
  if (bytes.length !== image.bytes || createHash('sha256').update(bytes).digest('hex') !== image.sha256
    || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw unavailable();
  return bytes;
}
async function documentSummary(article, uploadDir) {
  if (!article.document) return article;
  if (article.document.kind === 'ethics' && validateDescriptor(article.document)) return article;
  const base = `/api/knowledge/${article.id}/document`;
  const document = { kind: 'pdf', manifestUrl: base, available: false };
  try {
    const manifest = await loadDocument(uploadDir, article.document);
    Object.assign(document, { available: true, pageCount: manifest.pages.length,
      cover: { url: `${base}/cover`, width: manifest.cover.width, height: manifest.cover.height } });
  } catch { /* Keep the article visible; the reader offers a scoped retry. */ }
  return { ...article, document };
}
module.exports = { validateDescriptor, validateManifest, loadDocument, documentImage, documentSummary };
