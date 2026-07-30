const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const sharp = require('sharp');

function validateProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const allowed = new Set(['name', 'bio', 'phone', 'linkedin_url']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return false;
  if (hasOwn(body, 'name') && (typeof body.name !== 'string' || body.name.trim().length > 120)) return false;
  if (hasOwn(body, 'bio') && (typeof body.bio !== 'string' || body.bio.length > 2000)) return false;
  if (hasOwn(body, 'phone') && (typeof body.phone !== 'string' || body.phone.length > 40)) return false;
  if (hasOwn(body, 'linkedin_url')) {
    if (typeof body.linkedin_url !== 'string' || body.linkedin_url.length > 500) return false;
    if (body.linkedin_url && !isHttpUrl(body.linkedin_url)) return false;
  }
  return true;
}

function validateUser(body, { creating = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const allowed = new Set(['name', 'role', 'contract_type', 'is_pj', 'pj_due_day', 'job_title_id', 'phone', 'permissions']);
  if (creating) allowed.add('email').add('password');
  if (Object.keys(body).some((key) => !allowed.has(key))) return false;
  if (creating && (!isEmail(body.email) || typeof body.password !== 'string' || body.password.length < 6)) return false;
  if (creating && (typeof body.name !== 'string' || !body.name.trim())) return false;
  if (creating && !isUuid(body.job_title_id)) return false;
  if (hasOwn(body, 'name') && (typeof body.name !== 'string' || body.name.trim().length > 120)) return false;
  if (hasOwn(body, 'role') && !['viewer', 'admin'].includes(body.role)) return false;
  if (hasOwn(body, 'contract_type') && !['clt', 'pj'].includes(body.contract_type)) return false;
  if (hasOwn(body, 'is_pj') && typeof body.is_pj !== 'boolean') return false;
  if (hasOwn(body, 'contract_type') !== hasOwn(body, 'is_pj')) return false;
  if (hasOwn(body, 'contract_type') && (body.contract_type === 'pj') !== body.is_pj) return false;
  if (hasOwn(body, 'phone') && (typeof body.phone !== 'string' || body.phone.length > 40)) return false;
  if (hasOwn(body, 'pj_due_day') && body.pj_due_day !== null
      && (!Number.isInteger(body.pj_due_day) || body.pj_due_day < 1 || body.pj_due_day > 31)) return false;
  if (hasOwn(body, 'job_title_id') && body.job_title_id !== null && !isUuid(body.job_title_id)) return false;
  if (hasOwn(body, 'permissions') && !validPermissions(body.permissions)) return false;
  return true;
}

function validPermissions(value) {
  const allowed = new Set(['superAdmin', 'manageUsers', 'manageReminders', 'manageAcademy', 'manageBenefits', 'manageKnowledge', 'viewOmbudsman', 'manageSolides']);
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, enabled]) => allowed.has(key) && typeof enabled === 'boolean');
}

function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function imageExtension(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return '.webp';
  return null;
}

async function normalizeImage(buffer) {
  const image = sharp(buffer, { failOn: 'warning', limitInputPixels: 16 * 1024 * 1024 });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)
      || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192
      || (metadata.pages || 1) !== 1 || !hasExactImageBoundary(buffer, metadata.format)) throw new Error('Invalid image');
  return image.rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
}

function hasExactImageBoundary(buffer, format) {
  if (format === 'jpeg') return buffer.length >= 2 && buffer.subarray(-2).equals(Buffer.from([0xff, 0xd9]));
  if (format === 'png') return buffer.length >= 12
    && buffer.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
  return buffer.length >= 12 && buffer.readUInt32LE(4) + 8 === buffer.length;
}

module.exports = { hasOwn, imageExtension, isHttpUrl, normalizeImage, validateProfile, validateUser };
