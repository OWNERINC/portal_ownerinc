import { fetchAPI, fetchAPIPage } from '../js/auth.js';

export function createAcademyAPI(page) {
  const requests = page.bindAPI({ fetchAPI, fetchAPIPage });
  const options = { signal: page.signal };
  return {
    list(query) { return requests.fetchAPIPage(`/api/academy?${new URLSearchParams({ active: 'true', limit: '20', offset: '0', ...query })}`, options); },
    categories() { return requests.fetchAPI('/api/academy/categories', options); },
    continueCourses() { return requests.fetchAPI('/api/academy/continue?limit=3', options); },
    course(id, preview = false) { return requests.fetchAPI(`/api/academy/${encodeURIComponent(id)}${preview ? '?all=true' : ''}`, options); },
    lesson(id, preview = false) { return requests.fetchAPI(`/api/academy/lessons/${encodeURIComponent(id)}${preview ? '?all=true' : ''}`, options); },
  };
}
