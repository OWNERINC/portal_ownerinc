const roots = Object.freeze({
  legacy: '/api/cms/assets/',
  'owner-news': '/api/announcements/assets/',
  'owner-news-preview': '/api/announcements/preview/assets/',
});

export function validateAssetScope(scope) {
  if (typeof scope !== 'string' || !Object.hasOwn(roots, scope)) throw new Error('invalid_asset_scope');
  return scope;
}

function validateSource(source) {
  if (!['legacy', 'payload'].includes(source)) throw new Error('invalid_news_source');
  return source;
}

export function validateNewsSourceScope(source, scope, { preview = false } = {}) {
  validateSource(source);
  validateAssetScope(scope);
  const valid = preview
    ? scope === 'owner-news-preview'
    : (source === 'legacy' && scope === 'legacy') || (source === 'payload' && scope === 'owner-news');
  if (!valid) throw new Error('invalid_asset_source_scope');
  return { source, scope };
}

export function cmsAssetEndpoint(id, scope = 'legacy', source) {
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    if (!Object.hasOwn(scope, 'source') && !Object.hasOwn(scope, 'asset_scope')) throw new Error('invalid_asset_scope');
    source = scope.source;
    scope = scope.asset_scope;
  }
  validateAssetScope(scope);
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('invalid_asset_id');
  }
  if (source !== undefined) {
    validateNewsSourceScope(source, scope, { preview: scope === 'owner-news-preview' });
  }
  const endpoint = roots[scope] + id.toLowerCase();
  return scope === 'owner-news-preview' && source === 'legacy' ? `${endpoint}?source=legacy` : endpoint;
}
