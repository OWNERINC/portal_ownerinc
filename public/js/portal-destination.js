import { pagesSlug } from './pages-route.js';

// Only portal documents/Pages aliases are valid return destinations. Never return to login,
// the consent screen, an API URL or an external origin after acceptance.
export function safeDestination(value, origin = window.location.origin) {
  const fallback = '/dashboard.html';
  if (!value) return fallback;
  try {
    // Reject ambiguous spellings BEFORE URL normalizes dot segments/whitespace.
    const rawPath = value.split(/[?#]/)[0];
    if (/[\\\u0000-\u001f\u007f]/.test(value) || / /.test(rawPath) || /%(?:2f|5c|2e)/i.test(rawPath)
      || /(?:^|\/)\.\.(?:\/|$)/.test(rawPath)) return fallback;
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password
      || (!/^\/[a-z0-9-]+\.html$/.test(url.pathname) && pagesSlug(url.pathname) === null)
      || ['/login.html', '/ethics.html', '/index.html', '/announcements.html'].includes(url.pathname)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
