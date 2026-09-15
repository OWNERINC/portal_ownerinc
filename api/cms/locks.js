const CMS_ASSET_RETENTION_LOCK = 7193029;

async function lockCmsAssets(db) {
  await db.query('SELECT pg_advisory_xact_lock($1)', [CMS_ASSET_RETENTION_LOCK]);
}

module.exports = { CMS_ASSET_RETENTION_LOCK, lockCmsAssets };
