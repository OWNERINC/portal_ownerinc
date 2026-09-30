const { lockCmsAssets } = require('../cms/locks');
const { can } = require('../middleware/policy');
const { boolean, integer, text, uuid, validBody } = require('../route-utils');
const { AcademyError } = require('./errors');
const { hasOnlyFields, normalizeMedia, validateCourseInput, validateLessonInput } = require('./validation');
const { hasPublication } = require('./authorization');
const { promoteDueScheduled } = require('../cms/reader');

const fail = (reason = 'invalid_input') => { throw new AcademyError(400, reason); };
const moduleSchema = { title: text(200, true), order: integer(-100000, 100000), active: boolean };
const courseFields = ['title', 'category', 'description', 'url', 'order', 'active', 'delivery_mode',
  'audience', 'learning_group', 'icon_key', 'instructor_name'];

// Caller owns the transaction. Every writer, including deletion, enters the same
// CMS -> course -> module -> lesson protocol used by readers and asset serving.
async function lockTree(db, kind, id) {
  if (!uuid(id)) fail();
  await lockCmsAssets(db);
  let courseId = id;
  let moduleId;
  if (kind !== 'course') {
    const { rows } = await db.query(kind === 'module'
      ? 'SELECT course_id, id AS module_id FROM academy_modules WHERE id=$1'
      : `SELECT m.course_id, l.module_id FROM academy_lessons l
         JOIN academy_modules m ON m.id=l.module_id WHERE l.id=$1`, [id]);
    if (!rows[0]) return null;
    courseId = rows[0].course_id;
    moduleId = rows[0].module_id;
  }
  const { rows: courses } = await db.query('SELECT * FROM academy WHERE id=$1 FOR UPDATE', [courseId]);
  if (!courses[0]) return null;
  const tree = { course: courses[0] };
  if (moduleId) {
    const { rows } = await db.query('SELECT * FROM academy_modules WHERE id=$1 AND course_id=$2 FOR UPDATE', [moduleId, courseId]);
    if (!rows[0]) return null;
    tree.module = rows[0];
  }
  if (kind === 'lesson') {
    const { rows } = await db.query('SELECT * FROM academy_lessons WHERE id=$1 AND module_id=$2 FOR UPDATE', [id, moduleId]);
    if (!rows[0]) return null;
    tree.lesson = rows[0];
  }
  return tree;
}

function storedMedia(lesson) {
  return { type: lesson.media_type, url: lesson.media_type === 'youtube'
    ? `https://www.youtube.com/watch?v=${lesson.youtube_video_id}` : lesson.media_url };
}

async function canActivate(db, courseId) {
  const { rows: modules } = await db.query('SELECT * FROM academy_modules WHERE course_id=$1 ORDER BY id FOR UPDATE', [courseId]);
  const { rows: lessons } = await db.query('SELECT * FROM academy_lessons WHERE module_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [modules.map(row => row.id)]);
  // Match public readers: reconcile due schedules on this already locked client,
  // retaining CMS validation/invalid-schedule retirement and atomic audit rollback.
  const now = new Date();
  await promoteDueScheduled(db, now, 'academy', [courseId]);
  await promoteDueScheduled(db, now, 'academy_lesson', lessons.map(row => row.id));
  if (!await hasPublication(db, 'academy', courseId)) return false;
  const activeModules = new Set(modules.filter(row => row.active).map(row => row.id));
  for (const lesson of lessons) {
    if (lesson.active && activeModules.has(lesson.module_id) && normalizeMedia(storedMedia(lesson))
      && await hasPublication(db, 'academy_lesson', lesson.id)) return true;
  }
  return false;
}

async function saveCourse(db, user, courseId, input) {
  if (!can(user, 'manageAcademy')) throw new AcademyError(403, 'forbidden');
  if (courseId != null && !uuid(courseId)) fail();
  const tree = courseId ? await lockTree(db, 'course', courseId) : (await lockCmsAssets(db), {});
  if (!tree) return null;
  const { rows: audience } = courseId ? await db.query(
    'SELECT job_title_id FROM academy_course_job_titles WHERE course_id=$1', [courseId]) : { rows: [] };
  const previousIds = audience.map(row => row.job_title_id);
  // Explicit conversion preserves source identity/CMS, but discards the old link.
  const converting = tree.course?.delivery_mode === 'external' && input?.delivery_mode === 'internal';
  const course = validateCourseInput(converting ? { ...input, url: null } : input,
    tree.course ? { ...tree.course, job_title_ids: previousIds } : undefined);
  if (!course) fail();
  const newIds = course.job_title_ids.filter(id => !previousIds.includes(id));
  if (newIds.length) {
    const { rows } = await db.query('SELECT id FROM job_titles WHERE active=TRUE AND id=ANY($1::uuid[]) FOR SHARE', [newIds]);
    if (rows.length !== newIds.length) fail('invalid_audience');
  }
  if (course.delivery_mode === 'internal' && course.active && (!courseId || !await canActivate(db, courseId))) {
    fail('course_not_playable');
  }
  const values = courseFields.map(key => course[key]);
  const { rows } = courseId
    ? await db.query(`UPDATE academy SET ${courseFields.map((key, i) => `"${key}"=$${i + 2}`).join(', ')}, updated_at=NOW() WHERE id=$1 RETURNING *`, [courseId, ...values])
    : await db.query(`INSERT INTO academy (${courseFields.map(key => `"${key}"`).join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, values);
  const row = rows[0];
  await db.query('DELETE FROM academy_course_job_titles WHERE course_id=$1', [row.id]);
  if (course.job_title_ids.length) await db.query(`INSERT INTO academy_course_job_titles(course_id,job_title_id)
    SELECT $1, id FROM unnest($2::uuid[]) AS selected(id)`, [row.id, course.job_title_ids]);
  return { ...row, allowed_job_title_ids: course.job_title_ids };
}

function moduleInput(input, current) {
  if (!hasOnlyFields(input, moduleSchema)) fail();
  const result = { title: current?.title ?? '', order: current?.order ?? 0, active: current?.active ?? false, ...input };
  if (!validBody(result, moduleSchema)) fail();
  return { ...result, title: result.title.trim() };
}

async function createModule(db, courseId, input) {
  const value = moduleInput(input);
  const tree = await lockTree(db, 'course', courseId);
  if (!tree) return null;
  if (tree.course.delivery_mode !== 'internal') fail('internal_course_required');
  const { rows } = await db.query('SELECT COUNT(*)::integer AS count FROM academy_modules WHERE course_id=$1', [courseId]);
  if (rows[0].count >= 100) fail('module_limit');
  return (await db.query(`INSERT INTO academy_modules(course_id,title,"order",active)
    VALUES ($1,$2,$3,$4) RETURNING *`, [courseId, value.title, value.order, value.active])).rows[0];
}

async function saveModule(db, moduleId, input) {
  const tree = await lockTree(db, 'module', moduleId);
  if (!tree) return null;
  const value = moduleInput(input, tree.module);
  return (await db.query('UPDATE academy_modules SET title=$2, "order"=$3, active=$4, updated_at=NOW() WHERE id=$1 RETURNING *',
    [moduleId, value.title, value.order, value.active])).rows[0];
}

async function createLesson(db, moduleId, input) {
  const value = validateLessonInput(input);
  if (!value) fail();
  const tree = await lockTree(db, 'module', moduleId);
  if (!tree) return null;
  if (tree.course.delivery_mode !== 'internal') fail('internal_course_required');
  const { rows } = await db.query(`SELECT COUNT(*)::integer AS count FROM academy_lessons l
    JOIN academy_modules m ON m.id=l.module_id WHERE m.course_id=$1`, [tree.course.id]);
  if (rows[0].count >= 500) fail('lesson_limit');
  return (await db.query(`INSERT INTO academy_lessons(module_id,title,description,"order",active,media_type,youtube_video_id,media_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [moduleId, value.title, value.description, value.order,
    value.active, value.media.type, value.media.video_id ?? null, value.media.url ?? null])).rows[0];
}

async function saveLesson(db, lessonId, input) {
  const tree = await lockTree(db, 'lesson', lessonId);
  if (!tree) return null;
  const old = tree.lesson;
  // Preserve omitted fields while rejecting identifiers, media_version and dates.
  const value = validateLessonInput({ title: old.title, description: old.description, order: old.order,
    active: old.active, media: storedMedia(old), ...input });
  if (!hasOnlyFields(input, { title: true, description: true, order: true, active: true, media: true }) || !value) fail();
  const changed = JSON.stringify(normalizeMedia(storedMedia(old))) !== JSON.stringify(value.media);
  return (await db.query(`UPDATE academy_lessons SET title=$2, description=$3, "order"=$4, active=$5,
    media_type=$6, youtube_video_id=$7, media_url=$8, media_version=media_version+$9, updated_at=NOW()
    WHERE id=$1 RETURNING *`, [lessonId, value.title, value.description, value.order, value.active,
    value.media.type, value.media.video_id ?? null, value.media.url ?? null, changed ? 1 : 0])).rows[0];
}

async function reorder(db, kind, parentId, ids) {
  const maximum = kind === 'module' ? 100 : 500;
  if (!Array.isArray(ids) || ids.length > maximum || !ids.every(uuid)) fail('invalid_order');
  ids = ids.map(id => id.toLowerCase());
  if (new Set(ids).size !== ids.length) fail('invalid_order');
  const tree = await lockTree(db, kind === 'module' ? 'course' : 'module', parentId);
  if (!tree) return null;
  const table = kind === 'module' ? 'academy_modules' : 'academy_lessons';
  const parent = kind === 'module' ? 'course_id' : 'module_id';
  const { rows } = await db.query(`SELECT id FROM ${table} WHERE ${parent}=$1 ORDER BY id FOR UPDATE`, [parentId]);
  const existing = new Set(rows.map(row => row.id));
  if (rows.length !== ids.length || ids.some(id => !existing.has(id))) fail('invalid_order');
  return (await db.query(`UPDATE ${table} child SET "order"=ordered.position::integer, updated_at=NOW()
    FROM unnest($1::uuid[]) WITH ORDINALITY AS ordered(id,position)
    WHERE child.id=ordered.id AND child.${parent}=$2 RETURNING child.*`, [ids, parentId])).rows;
}

async function deleteTree(db, kind, id) {
  const tree = await lockTree(db, kind, id);
  if (!tree) return null;
  let lessonIds = [id];
  if (kind !== 'lesson') {
    const modules = kind === 'course' ? (await db.query(
      'SELECT id FROM academy_modules WHERE course_id=$1 ORDER BY id FOR UPDATE', [id])).rows : [tree.module];
    lessonIds = (await db.query('SELECT id FROM academy_lessons WHERE module_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [modules.map(row => row.id)])).rows.map(row => row.id);
  }
  await db.query("DELETE FROM cms_documents WHERE content_type='academy_lesson' AND source_id=ANY($1::uuid[])", [lessonIds]);
  if (kind === 'course') await db.query("DELETE FROM cms_documents WHERE content_type='academy' AND source_id=$1", [id]);
  // Cascades remove curriculum/progress/revisions. Asset retention owns files.
  const table = { course: 'academy', module: 'academy_modules', lesson: 'academy_lessons' }[kind];
  return (await db.query(`DELETE FROM ${table} WHERE id=$1 RETURNING id`, [id])).rows[0];
}

module.exports = { saveCourse, createModule, saveModule, createLesson, saveLesson,
  reorderModules: (db, id, ids) => reorder(db, 'module', id, ids),
  reorderLessons: (db, id, ids) => reorder(db, 'lesson', id, ids),
  deleteCourseTree: (db, id) => deleteTree(db, 'course', id),
  deleteModuleTree: (db, id) => deleteTree(db, 'module', id),
  deleteLesson: (db, id) => deleteTree(db, 'lesson', id) };
