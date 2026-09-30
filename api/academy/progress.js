// The catalog supplies visible lessons in curriculum order. No catalog dependency here.
function summarizeProgress(lessons, progressRows) {
  const current = new Map(lessons.map(lesson => [lesson.id, lesson]));
  const progress = new Map(progressRows.filter(row =>
    current.has(row.lesson_id) && current.get(row.lesson_id).media_version === row.media_version
  ).map(row => [row.lesson_id, row]));
  const incomplete = lessons.filter(lesson => progress.get(lesson.id)?.completed !== true);
  const recentIncomplete = incomplete.filter(lesson => progress.has(lesson.id))
    .sort((a, b) => new Date(progress.get(b.id).updated_at) - new Date(progress.get(a.id).updated_at));
  const completed = lessons.length - incomplete.length;
  return {
    total_lessons: lessons.length,
    completed_lessons: completed,
    progress_percent: lessons.length ? Math.floor(completed * 100 / lessons.length) : 0,
    resume_lesson_id: progress.size ? (recentIncomplete[0]?.id || incomplete[0]?.id || null) : null,
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

module.exports = { summarizeProgress, readProgress };
