// Only portal documents are valid return destinations. Never return to login,
// the consent screen, an API URL or an external origin after acceptance.
export function safeDestination(value, origin = window.location.origin) {
  const fallback = './dashboard.html';
  if (!value) return fallback;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !/^\/[a-z0-9-]+\.html$/.test(url.pathname)
      || ['/login.html', '/ethics.html', '/index.html'].includes(url.pathname)) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
