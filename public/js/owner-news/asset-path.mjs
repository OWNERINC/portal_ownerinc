const roots = Object.freeze({
  legacy: '/api/cms/assets/',
  'owner-news': '/api/announcements/assets/',
  'owner-news-preview': '/api/announcements/preview/assets/',
});

export function validateAssetScope(scope) {
  if (typeof scope !== 'string' || !Object.hasOwn(roots, scope)) throw new Error('invalid_asset_scope');
  return scope;
}

export function cmsAssetEndpoint(id, scope = 'legacy') {
  validateAssetScope(scope);
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('invalid_asset_id');
  }
  return roots[scope] + id.toLowerCase();
}
