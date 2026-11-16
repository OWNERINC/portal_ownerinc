// A static shell alias, not authorization to read its published content.
export function pagesSlug(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/conteudos/')) return null;
  const slug = pathname.slice('/conteudos/'.length);
  const match = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(slug);
  return slug.length <= 120 && match?.[0] === slug ? slug : null;
}

export function routePath(pathname) {
  return pagesSlug(pathname) === null ? pathname : '/pages.html';
}
