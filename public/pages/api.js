import { fetchAPI, fetchAPIPage, fetchAPIAsset } from '../js/auth.js';

export function createPagesAPI(page) {
  const request = page.bindAPI({ fetchAPI, fetchAPIPage, fetchAPIAsset });
  const get = path => request.fetchAPI(`/api/pages${path}`, { signal: page.signal });
  const send = (path, body, method = 'POST') => request.fetchAPI(`/api/pages${path}`, { method, body: JSON.stringify(body), signal: page.signal });
  return {
    list(query, manage = false) { return request.fetchAPIPage(`/api/pages${manage ? '/manage' : ''}?${new URLSearchParams(query)}`, { signal: page.signal }); },
    templates() { return get('/templates'); },
    async cargos() {
      const items = []; let offset = 0, result;
      do { result = await request.fetchAPIPage(`/api/pages/job-titles?limit=100&offset=${offset}`, { signal: page.signal }); items.push(...result.data); offset += result.data.length; }
      while (result.data.length && offset < result.total);
      return items;
    },
    workspace(id) { return get(`/${encodeURIComponent(id)}/workspace`); },
    read(id) { return get(`/${encodeURIComponent(id)}`); },
    preview(id, revisionId) { return get(`/${encodeURIComponent(id)}/preview${revisionId ? `?revision_id=${encodeURIComponent(revisionId)}` : ''}`); },
    create(body) { return send('', body); },
    save(id, body) { return send(`/${encodeURIComponent(id)}/draft`, body, 'PUT'); },
    publish(id, body) { return send(`/${encodeURIComponent(id)}/publish`, body); },
    archive(id, body) { return send(`/${encodeURIComponent(id)}/archive`, body); },
    restore(id, body) { return send(`/${encodeURIComponent(id)}/restore`, body); },
    upload(id, file, key, kind = 'image') { const body = new FormData(); body.append('client_mutation_id', key); if (kind !== 'image') body.append('kind', kind); body.append(kind === 'image' ? 'image' : 'file', file);
      return request.fetchAPI(`/api/pages/${encodeURIComponent(id)}/media`, { method: 'POST', body, signal: page.signal }); },
    asset(id, mediaId, { revisionId, staged = false, signal } = {}) {
      const query = staged ? '?preview=1' : revisionId ? `?revision_id=${encodeURIComponent(revisionId)}` : '';
      return request.fetchAPIAsset(`/api/pages/${encodeURIComponent(id)}/media/${encodeURIComponent(mediaId)}${query}`, { signal: signal || page.signal });
    },
  };
}
