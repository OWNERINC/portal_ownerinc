const { canReadCourse } = require('./access');

// Caller owns the transaction and supplies freshly read, row-locked sources.
async function authorizeLessonInTransaction(db, user, lessonId) {
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
  return { course, module, lesson };
}

module.exports = { authorizeLessonInTransaction };
