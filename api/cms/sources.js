const { lockCmsAssets } = require('./locks');

const SOURCE_TABLES = {
  knowledge: 'knowledge_base',
  academy: 'academy',
  academy_lesson: 'academy_lessons',
  benefit: 'benefits',
  reminder: 'reminders',
};

async function deleteCmsSource(db, contentType, sourceId) {
  if (contentType === 'academy' || contentType === 'academy_lesson') {
    const { deleteCourseTree, deleteLesson } = require('../academy/mutations');
    return contentType === 'academy' ? deleteCourseTree(db, sourceId) : deleteLesson(db, sourceId);
  }
  const sourceTable = SOURCE_TABLES[contentType];
  if (!sourceTable) throw new Error(`Unsupported CMS source: ${contentType}`);

  await lockCmsAssets(db);
  const { rows } = await db.query(
    `DELETE FROM ${sourceTable} WHERE id = $1 RETURNING id`,
    [sourceId],
  );
  if (!rows[0]) return null;

  await db.query(
    'DELETE FROM cms_documents WHERE content_type = $1 AND source_id = $2',
    [contentType, sourceId],
  );
  return rows[0];
}

module.exports = { deleteCmsSource };
