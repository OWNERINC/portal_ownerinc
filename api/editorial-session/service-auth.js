const { createHash, timingSafeEqual } = require('node:crypto');
const { EditorialSessionError, unavailable } = require('./service');

function bridgeSecret(env) {
  const secret = env.PAYLOAD_TO_PORTAL_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret.trim()) < 32 ||
    secret !== secret.trim() || /[\r\n]/.test(secret) || secret === env.PORTAL_TO_PAYLOAD_SECRET) throw unavailable();
  return secret;
}
function assertEditorialService(req, env) {
  const expected = bridgeSecret(env);
  const supplied = req.get('authorization') || '';
  const digest = value => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(`Bearer ${expected}`))) {
    throw new EditorialSessionError(401, 'editorial_service_unauthorized');
  }
}
module.exports = { bridgeSecret, assertEditorialService };
