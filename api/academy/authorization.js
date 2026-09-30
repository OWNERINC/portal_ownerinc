const { canReadCourse } = require('./access');
const { lockCmsAssets } = require('../cms/locks');
const { validatePublishedBlocks, validatePublishedBlocksBatch, promoteDueScheduled } = require('../cms/reader');

// Local source reader until Task 5 registers academy_lesson in the shared CMS.
// Caller owns the transaction and CMS lock and supplies freshly read, row-locked
// sources with authorized ancestors (never pre-lock snapshots). Missing documents
// mean legacy content only for those extant sources. Never open a pool connection.
async function readPublishedSources(db, type, rows) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  await promoteDueScheduled(db, new Date(), type, ids);
  const { rows: documents } = await db.query(`SELECT d.source_id, d.id AS document_id,
    r.blocks FROM cms_documents d LEFT JOIN cms_revisions r
    ON r.id=d.published_revision_id AND r.status='published'
    WHERE d.content_type=$1 AND d.source_id=ANY($2::uuid[])`, [type, ids]);
  const validations = await validatePublishedBlocksBatch(db, documents.map(row => row.blocks));
  const byId = new Map(documents.map((row, i) => [row.source_id, validations[i].blocks]));
  return rows.map(row => {
    if (!byId.has(row.id)) return row;
    const blocks = byId.get(row.id);
    return { ...row, description: '', cms_managed: true, ...(blocks === null ? {} : { content_blocks: blocks }) };
  });
}

async function hasPublication(db, type, id) {
  const { rows } = await db.query(`SELECT d.id, r.blocks FROM cms_documents d
    LEFT JOIN cms_revisions r ON r.id=d.published_revision_id AND r.status='published'
    WHERE d.content_type=$1 AND d.source_id=$2`, [type, id]);
  return !rows.length || (await validatePublishedBlocks(db, rows[0].blocks)).blocks !== null;
}

async function authorizeLessonInTransaction(db, user, lessonId) {
  await lockCmsAssets(db);
  const { rows: ancestry } = await db.query(`SELECT m.course_id, l.module_id
    FROM academy_lessons l JOIN academy_modules m ON m.id=l.module_id WHERE l.id=$1`, [lessonId]);
  if (!ancestry[0]) return null;
  const { course_id: courseId, module_id: moduleId } = ancestry[0];
  const { rows: courses } = await db.query('SELECT * FROM academy WHERE id=$1 FOR UPDATE', [courseId]);
  const { rows: modules } = await db.query('SELECT * FROM academy_modules WHERE id=$1 AND course_id=$2 FOR UPDATE', [moduleId, courseId]);
  const { rows: lessons } = await db.query('SELECT * FROM academy_lessons WHERE id=$1 AND module_id=$2 FOR UPDATE', [lessonId, moduleId]);
  const [course, module, lesson] = [courses[0], modules[0], lessons[0]];
  if (!course || !module || !lesson || module.active !== true || lesson.active !== true) return null;
  const { rows: audience } = await db.query('SELECT job_title_id FROM academy_course_job_titles WHERE course_id=$1', [courseId]);
  if (!canReadCourse(user, course, audience.map(row => row.job_title_id))) return null;
  await promoteDueScheduled(db, new Date(), 'academy', [courseId]);
  await promoteDueScheduled(db, new Date(), 'academy_lesson', [lessonId]);
  if (!await hasPublication(db, 'academy', courseId) || !await hasPublication(db, 'academy_lesson', lessonId)) return null;
  return { course, module, lesson };
}

module.exports = { authorizeLessonInTransaction, readPublishedSources };
