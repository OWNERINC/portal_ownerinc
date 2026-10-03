const { EditorialSessionError, unavailable } = require('./service');

function editorialCookieConfig(env) {
  let url;
  try { url = new URL(env.PORTAL_PUBLIC_URL); } catch { throw unavailable(); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    ![url.origin, `${url.origin}/`].includes(env.PORTAL_PUBLIC_URL)) throw unavailable();
  const development = env.NODE_ENV === 'development' && url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !development) throw unavailable();
  return {
    origin: url.origin,
    name: development ? 'ownerinc-editorial-dev' : '__Host-ownerinc-editorial',
    options: { httpOnly: true, secure: !development, sameSite: 'lax', path: '/' },
  };
}
function assertEditorialOrigin(req, config) {
  if (req.get('origin') !== config.origin || req.get('sec-fetch-site') === 'cross-site') {
    throw new EditorialSessionError(403, 'editorial_origin_denied');
  }
}
function readEditorialCookie(header, name) {
  const values = String(header || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  // Duplicate names are ambiguous (e.g. a shadow cookie from a different path).
  if (values.length > 1) throw new EditorialSessionError(401, 'editorial_session_invalid');
  return values.length ? values[0].slice(name.length + 1) : undefined;
}
module.exports = { editorialCookieConfig, assertEditorialOrigin, readEditorialCookie };
