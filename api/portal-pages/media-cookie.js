'use strict';

const MEDIA_SESSION_MS = 5 * 60 * 1000;

class MediaSessionError extends Error {
  constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}

const unavailable = () => new MediaSessionError(503, 'portal_pages_unavailable');
const invalidSession = () => new MediaSessionError(401, 'media_session_invalid');

function mediaCookieConfig(env = process.env) {
  let url;
  try { url = new URL(env.PORTAL_PUBLIC_URL); } catch { throw unavailable(); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    ![url.origin, `${url.origin}/`].includes(env.PORTAL_PUBLIC_URL)) throw unavailable();
  const development = env.NODE_ENV === 'development' && url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !development) throw unavailable();
  return {
    origin: url.origin,
    development,
    name: development ? 'ownerinc-content-media-dev' : '__Secure-ownerinc-content-media',
    options: { httpOnly: true, secure: !development, sameSite: 'strict', path: '/api/contents/assets' },
  };
}

function assertMediaOrigin(req, config) {
  if (req.get('origin') !== config.origin || req.get('sec-fetch-site') === 'cross-site') {
    throw new MediaSessionError(403, 'origin_denied');
  }
}

function readMediaCookie(header, name) {
  const entries = String(header || '').split(';').map(value => value.trim()).filter(value => value === name || value.startsWith(`${name}=`));
  if (entries.length > 1) throw invalidSession();
  if (!entries.length) return undefined;
  if (entries[0] === name) throw invalidSession();
  const cookie = entries[0].slice(name.length + 1);
  if (!cookie || cookie.length > 12_000 || !/^[A-Za-z0-9._-]+$/u.test(cookie)) throw invalidSession();
  return cookie;
}

function mediaFirebaseError(error) {
  if (error?.code === 'auth/user-disabled') return new MediaSessionError(403, 'account-disabled');
  if (['auth/session-cookie-revoked', 'auth/session-cookie-expired', 'auth/invalid-session-cookie',
    'auth/id-token-revoked', 'auth/id-token-expired', 'auth/invalid-id-token', 'auth/argument-error', 'auth/user-not-found'].includes(error?.code)) {
    return invalidSession();
  }
  return unavailable();
}

module.exports = { MEDIA_SESSION_MS, MediaSessionError, assertMediaOrigin, mediaCookieConfig, mediaFirebaseError, readMediaCookie };
