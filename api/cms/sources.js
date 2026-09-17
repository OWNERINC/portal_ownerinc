const { lockCmsAssets } = require('./locks');

const SOURCE_TABLES = {
  knowledge: 'knowledge_base',
  academy: 'academy',
  benefit: 'benefits',
  reminder: 'reminders',
};

async function deleteCmsSource(db, contentType, sourceId) {
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
