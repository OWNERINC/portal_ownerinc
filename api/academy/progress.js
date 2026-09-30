const { authorizeLessonInTransaction } = require('./authorization');
const { AcademyError } = require('./errors');
const { hasOnlyFields } = require('./validation');

// The catalog supplies visible lessons in curriculum order. No catalog dependency here.
function summarizeProgress(lessons, progressRows) {
  const current = new Map(lessons.map(lesson => [lesson.id, lesson]));
  lessons = [...current.values()];
  const progress = new Map(progressRows.filter(row =>
    current.has(row.lesson_id) && current.get(row.lesson_id).media_version === row.media_version
  ).map(row => [row.lesson_id, row]));
  const incomplete = lessons.filter(lesson => progress.get(lesson.id)?.completed !== true);
  const recent = lessons.filter(lesson => progress.has(lesson.id))
    .sort((a, b) => new Date(progress.get(b.id).updated_at) - new Date(progress.get(a.id).updated_at));
  const last = recent[0];
  const resume = last && (progress.get(last.id).completed !== true ? last
    : incomplete.find(lesson => lessons.indexOf(lesson) > lessons.indexOf(last)) || incomplete[0]);
  const completed = lessons.length - incomplete.length;
  return {
    total_lessons: lessons.length,
    completed_lessons: completed,
    progress_percent: lessons.length ? Math.floor(completed * 100 / lessons.length) : 0,
    resume_lesson_id: resume?.id || null,
  };
}

async function readProgress(pool, userUid, lessonId, mediaVersion) {
  const { rows } = await pool.query(`SELECT lesson_id,media_version,position_seconds,
    completed,completed_at,version,updated_at FROM academy_lesson_progress
    WHERE user_uid=$1 AND lesson_id=$2 AND media_version=$3`,
  [userUid, lessonId, mediaVersion]);
  return rows[0] || {
    lesson_id: lessonId, media_version: mediaVersion, position_seconds: 0,
    completed: false, completed_at: null, version: 0, updated_at: null,
  };
}

async function saveProgress(pool, user, lessonId, input) {
  if (!hasOnlyFields(input, { media_version: true, expected_version: true, position_seconds: true, completed: true })
    || !Number.isSafeInteger(input.media_version) || input.media_version <= 0
    || !Number.isSafeInteger(input.expected_version) || input.expected_version < 0
    || !Number.isInteger(input.position_seconds) || input.position_seconds < 0 || input.position_seconds > 86400
    || (Object.hasOwn(input, 'completed') && typeof input.completed !== 'boolean')) {
    throw new AcademyError(400, 'invalid_progress');
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const authorized = await authorizeLessonInTransaction(db, user, lessonId);
    if (!authorized) throw new AcademyError(404, 'not_found');
    if (authorized.lesson.media_version !== input.media_version) throw new AcademyError(409, 'media_changed');
    const values = [user.uid, authorized.lesson.id, input.media_version, input.position_seconds, input.completed ?? null];
    const returning = 'RETURNING lesson_id,media_version,position_seconds,completed,completed_at,version,updated_at';
    const { rows } = input.expected_version === 0
      ? await db.query(`INSERT INTO academy_lesson_progress
        (user_uid,lesson_id,media_version,position_seconds,completed,completed_at)
        VALUES ($1,$2,$3,$4,COALESCE($5::boolean,FALSE),CASE WHEN $5::boolean=TRUE THEN NOW() ELSE NULL END)
        ON CONFLICT (user_uid,lesson_id,media_version) DO NOTHING ${returning}`, values)
      : await db.query(`UPDATE academy_lesson_progress SET position_seconds=$4,
        completed=CASE WHEN $5::boolean IS NULL THEN completed ELSE $5 END,
        completed_at=CASE WHEN $5::boolean IS NULL THEN completed_at
          WHEN $5=TRUE THEN COALESCE(completed_at,NOW()) ELSE NULL END,
        version=version+1, updated_at=NOW()
        WHERE user_uid=$1 AND lesson_id=$2 AND media_version=$3 AND version=$6 ${returning}`,
      [...values, input.expected_version]);
    if (!rows.length) throw new AcademyError(409, 'progress_conflict');
    await db.query('COMMIT');
    return rows[0];
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); }
}

module.exports = { summarizeProgress, readProgress, saveProgress };
