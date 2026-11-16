const { PagesError } = require('./validation');

function slugBase(title) {
  if (!title.trim()) return null;
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '') || 'pagina';
}

// Caller owns the request lock and this page's row lock (or its new INSERT).
// Never lock a candidate's page: another base may produce our suffix as a title.
// The unique index is the last defense for that cross-base race; mutate rolls
// back and returns an explicit conflict, never retries in an aborted transaction.
async function ensureSlug(db, page, title) {
  if (page.slug != null) return page.slug;
  const base = slugBase(title);
  if (!base) return null;
  const suffix = `${base}-${page.id.replace(/-/g, '')}`;
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pages-alias:${base}`]);
  const { rows } = await db.query('SELECT slug FROM pages WHERE slug = ANY($1::text[])', [[base, suffix]]);
  const occupied = new Set(rows.map(row => row.slug));
  const slug = occupied.has(base) ? suffix : base;
  if (occupied.has(slug)) throw new PagesError(409, 'slug_conflict');
  await db.query('UPDATE pages SET slug = $2 WHERE id = $1', [page.id, slug]);
  return slug;
}

module.exports = { slugBase, ensureSlug };
