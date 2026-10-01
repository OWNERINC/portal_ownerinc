const { boolean, httpUrl, integer, oneOf, text, uuid, validBody } = require('../route-utils');

// validBody alone accepts inherited schema names (e.g. constructor).
// Editorial payloads must contain only their own, explicitly allowed fields.
function hasOnlyFields(body, schema) {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && [Object.prototype, null].includes(Object.getPrototypeOf(body))
    && Object.keys(body).every(key => Object.hasOwn(schema, key) && body[key] !== undefined);
}

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function parseYouTubeId(value) {
  const url = httpsUrl(value);
  if (!url || url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  let id;
  if (host === 'youtu.be' && parts.length === 1) id = parts[0];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (parts.length === 2 && ['embed', 'shorts'].includes(parts[0])) id = parts[1];
  }
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

function normalizeMedia(body) {
  if (!hasOnlyFields(body, { type: true, url: true })) return null;
  if (body.type === 'youtube') {
    const videoId = parseYouTubeId(body.url);
    return videoId ? { type: 'youtube', video_id: videoId } : null;
  }
  if (body.type === 'file') {
    const url = httpsUrl(body.url);
    return url && url.href.length <= 2048 && /\.(mp4|webm)$/i.test(url.pathname)
      ? { type: 'file', url: url.href } : null;
  }
  return null;
}

function jobTitleIds(value) {
  return Array.isArray(value) && value.length <= 100 && value.every(uuid)
    && new Set(value.map(id => id.toLowerCase())).size === value.length;
}

const courseSchema = {
  title: text(200, true), category: text(100), description: text(5000),
  url: value => value === null || httpUrl(value), order: integer(-100000, 100000), active: boolean,
  delivery_mode: oneOf('external', 'internal'), audience: oneOf('all', 'job_titles'),
  learning_group: oneOf('initial', 'role'),
  icon_key: oneOf('icon-01', 'icon-02', 'icon-03', 'icon-04', 'icon-05', 'icon-06'),
  instructor_name: text(120), job_title_ids: jobTitleIds,
};

function validateCourseInput(body, current) {
  if (!hasOnlyFields(body, { ...courseSchema, allowed_job_title_ids: jobTitleIds })) return null;
  if (body && Object.hasOwn(body, 'allowed_job_title_ids')) {
    if (Object.hasOwn(body, 'job_title_ids')) return null;
    body = { ...body, job_title_ids: body.allowed_job_title_ids };
    delete body.allowed_job_title_ids;
  }
  if (!hasOnlyFields(body, courseSchema)) return null;
  const course = {
    title: '', category: '', description: '', url: null, order: 0, active: false,
    delivery_mode: 'external', audience: 'all', learning_group: 'initial',
    icon_key: 'icon-01', instructor_name: '', job_title_ids: [],
  };
  // Preserve omitted legacy update fields, but never return row identifiers/metadata.
  for (const key of Object.keys(courseSchema)) {
    if (current && Object.hasOwn(current, key) && current[key] !== undefined) course[key] = current[key];
    if (Object.hasOwn(body, key)) course[key] = body[key];
  }
  if (course.delivery_mode === 'internal' && !Object.hasOwn(body, 'url')) course.url = null;
  if (!validBody(course, courseSchema)) return null;
  if (course.delivery_mode === 'internal' ? course.url !== null : course.url === null) return null;
  if (course.audience === 'job_titles' && course.job_title_ids.length === 0) return null;
  return { ...course, title: course.title.trim(), job_title_ids: course.job_title_ids.map(id => id.toLowerCase()) };
}

const lessonSchema = {
  title: text(200, true), description: text(5000), order: integer(-100000, 100000),
  active: boolean, media: value => normalizeMedia(value) !== null,
};

function validateLessonInput(body) {
  if (!hasOnlyFields(body, lessonSchema) || !validBody(body, lessonSchema, ['title', 'media'])) return null;
  return {
    title: body.title.trim(), description: body.description ?? '', order: body.order ?? 0,
    active: body.active ?? false, media: normalizeMedia(body.media),
  };
}

module.exports = { hasOnlyFields, parseYouTubeId, normalizeMedia, validateCourseInput, validateLessonInput };
