const { can } = require('../middleware/policy');
const { canReadCourse } = require('./access');
const { AcademyError } = require('./errors');
const { summarizeProgress, readProgress } = require('./progress');
const { readPublishedSources } = require('./authorization');
const { addPublishedBlocks, isPublicCmsRow } = require('../cms/reader');
const { lockCmsAssets } = require('../cms/locks');

function checkPreview(user, preview) {
  if (preview && !can(user, 'manageAcademy')) throw new AcademyError(403, 'forbidden');
}

async function candidates(pool, user, query = {}) {
  const preview = query.preview === true;
  checkPreview(user, preview);
  const values = [];
  const conditions = [];
  const parameter = value => { values.push(value); return `$${values.length}`; };
  if (!preview) {
    const active = parameter(user.job_title_active === true);
    const job = parameter(user.job_title_id || null);
    conditions.push(`a.active = TRUE AND (a.audience = 'all' OR (${active}::boolean = TRUE AND EXISTS (
      SELECT 1 FROM academy_course_job_titles audience WHERE audience.course_id=a.id AND audience.job_title_id=${job}::uuid)))`);
  }
  if (query.active === 'true') conditions.push('a.active = TRUE');
  if (query.category) conditions.push(`btrim(a.category) = ${parameter(query.category)}`);
  if (query.group) conditions.push(`a.learning_group = ${parameter(query.group)}`);
  if (query.id) conditions.push(`a.id = ${parameter(query.id)}::uuid`);
  const { rows } = await pool.query(`SELECT a.*, ARRAY(SELECT job_title_id FROM academy_course_job_titles
    WHERE course_id=a.id ORDER BY job_title_id) AS allowed_job_title_ids
    FROM academy a ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY a."order", a.id`, values);
  const eligible = rows.filter(row => canReadCourse(user, row, row.allowed_job_title_ids, { preview }));
  const enriched = await addPublishedBlocks(pool, eligible, 'academy');
  return preview ? enriched.filter(Boolean) : enriched.filter(isPublicCmsRow);
}

async function curriculum(pool, user, courses, preview = false) {
  if (!courses.length) return { modules: [], lessons: [], progress: [] };
  const ids = courses.filter(course => course.delivery_mode === 'internal').map(course => course.id);
  if (!ids.length) return { modules: [], lessons: [], progress: [] };
  const { rows: modules } = await pool.query(`SELECT * FROM academy_modules
    WHERE course_id=ANY($1::uuid[]) ${preview ? '' : 'AND active = TRUE'} ORDER BY "order", id`, [ids]);
  const moduleIds = modules.map(module => module.id);
  if (!moduleIds.length) return { modules, lessons: [], progress: [] };
  const { rows } = await pool.query(`SELECT * FROM academy_lessons WHERE module_id=ANY($1::uuid[])
    ${preview ? '' : 'AND active = TRUE'} ORDER BY "order", id`, [moduleIds]);
  const db = await pool.connect();
  let lessons;
  try {
    await db.query('BEGIN');
    await lockCmsAssets(db);
    lessons = await readPublishedSources(db, 'academy_lesson', rows);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); }
  if (!preview) lessons = lessons.filter(isPublicCmsRow);
  const { rows: progress } = lessons.length ? await pool.query(`SELECT * FROM academy_lesson_progress
    WHERE user_uid=$1 AND lesson_id=ANY($2::uuid[])`, [user.uid, lessons.map(lesson => lesson.id)]) : { rows: [] };
  return { modules, lessons, progress };
}

function courseLessons(course, data, publicOnly = false) {
  return data.modules.filter(module => module.course_id === course.id && (!publicOnly || module.active === true))
    .flatMap(module => data.lessons.filter(lesson => lesson.module_id === module.id && (!publicOnly || isPublicCmsRow(lesson))));
}

function summary(course, data, preview) {
  const { allowed_job_title_ids, ...fields } = course;
  return { ...fields, ...(preview ? { allowed_job_title_ids } : {}),
    cover_asset_id: course.content_blocks?.find(block => block.type === 'image' && block.asset_id)?.asset_id || null,
    ...summarizeProgress(course.active === true && isPublicCmsRow(course) ? courseLessons(course, data, true) : [], data.progress) };
}

function lessonSummary(lesson, progress) {
  const { id, module_id, title, order, active, media_version } = lesson;
  return { id, module_id, title, order, active, media_version,
    completed: progress.some(row => row.lesson_id === id && row.media_version === media_version && row.completed === true) };
}

async function listCourses(pool, user, query = {}) {
  const rows = await candidates(pool, user, query);
  const selected = rows.slice(query.offset || 0, (query.offset || 0) + (query.limit || 50));
  const data = await curriculum(pool, user, selected, query.preview);
  return { items: selected.map(course => summary(course, data, query.preview)), total: rows.length };
}

async function listCategories(pool, user, { preview = false } = {}) {
  const rows = await candidates(pool, user, { preview });
  return [...new Set(rows.map(row => row.category?.trim()).filter(Boolean))].sort();
}

async function getCourseView(pool, user, courseId, { preview = false } = {}) {
  const [course] = await candidates(pool, user, { id: courseId, preview });
  if (!course) return null;
  const data = await curriculum(pool, user, [course], preview);
  return { course: summary(course, data, preview), content_blocks: course.content_blocks || null,
    ...(preview ? { allowed_job_title_ids: course.allowed_job_title_ids } : {}),
    modules: data.modules.map(module => ({ ...module, lessons: data.lessons
      .filter(lesson => lesson.module_id === module.id).map(lesson => lessonSummary(lesson, data.progress)) })) };
}

async function getLessonView(pool, user, lessonId, { preview = false } = {}) {
  checkPreview(user, preview);
  const { rows } = await pool.query(`SELECT m.course_id FROM academy_lessons l
    JOIN academy_modules m ON m.id=l.module_id WHERE l.id=$1`, [lessonId]);
  if (!rows[0]) return null;
  const [course] = await candidates(pool, user, { id: rows[0].course_id, preview });
  if (!course) return null;
  const data = await curriculum(pool, user, [course], preview);
  const ordered = courseLessons(course, data);
  const index = ordered.findIndex(lesson => lesson.id === lessonId.toLowerCase());
  if (index < 0) return null;
  const lesson = ordered[index];
  return { course_id: course.id, module_id: lesson.module_id, lesson: lessonSummary(lesson, data.progress),
    description: lesson.description, content_blocks: lesson.content_blocks || null,
    media: lesson.media_type === 'youtube' ? { type: 'youtube', video_id: lesson.youtube_video_id } : { type: 'file', url: lesson.media_url },
    previous_lesson_id: ordered[index - 1]?.id || null, next_lesson_id: ordered[index + 1]?.id || null,
    progress: await readProgress(pool, user.uid, lesson.id, lesson.media_version) };
}

// Permission is checked by the manager-only HTTP endpoint; no public source enumeration.
async function listLessonSources(pool, query = {}) {
  const [{ rows: [{ count }] }, { rows }] = await Promise.all([
    pool.query('SELECT COUNT(*)::integer AS count FROM academy_lessons'),
    pool.query(`SELECT l.*, m.course_id, m.title AS module_title, a.title AS course_title
      FROM academy_lessons l JOIN academy_modules m ON m.id=l.module_id JOIN academy a ON a.id=m.course_id
      ORDER BY a."order", a.id, m."order", m.id, l."order", l.id LIMIT $1 OFFSET $2`, [query.limit || 50, query.offset || 0]),
  ]);
  return { items: rows, total: Number(count) };
}

module.exports = { listCourses, listCategories, getCourseView, getLessonView, listLessonSources };
