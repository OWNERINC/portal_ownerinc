import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cms = await readFile('api/routes/cms.js', 'utf8');
const assets = await readFile('api/routes/cms-assets.js', 'utf8');
const index = await readFile('api/index.js', 'utf8');
const permissions = await readFile('api/cms/permissions.js', 'utf8');

test('CMS routes are authenticated and mounted at the required API boundaries', () => {
  assert.match(index, /app\.use\('\/api\/cms',\s+require\('\.\/routes\/cms'\)\)/);
  assert.match(index, /app\.use\('\/api\/cms\/assets',\s+require\('\.\/routes\/cms-assets'\)\)/);
  assert.ok((cms.match(/authMiddleware/g) || []).length >= 7);
  assert.match(assets, /router\.post\('\/', authMiddleware/);
  assert.match(assets, /router\.get\('\/:id', authMiddleware/);
});

test('document endpoints validate query and body contracts and use Task 1 permissions', () => {
  assert.match(cms, /parseListQuery\(req\.query/);
  assert.match(cms, /oneOf\(\.\.\.CONTENT_TYPES\)/);
  assert.match(cms, /source_id: \(sourceId\) => uuid\(sourceId\)/);
  assert.match(cms, /canManageCms\(req\.user, req\.body\.type\)/);
  assert.match(cms, /validateBlocks\(req\.body\.blocks\)/);
  assert.match(cms, /const types = manageableTypes\(user\)/);
  assert.match(permissions, /knowledge: 'manageKnowledge'/);
  assert.match(permissions, /announcement: 'manageKnowledge'/);
  assert.match(permissions, /academy: 'manageAcademy'/);
  assert.match(permissions, /benefit: 'manageBenefits'/);
  assert.match(permissions, /reminder: 'manageReminders'/);
});

test('document mutations are transactional, audited, and preserve revision immutability', () => {
  for (const action of ['cms.document.create', 'cms.revision.draft', 'cms.document.publish', 'cms.document.schedule', 'cms.document.unpublish', 'cms.revision.delete']) {
    assert.match(cms, new RegExp(`withAudit\\(pool, req, '${action}'`), action);
  }
  assert.match(cms, /SELECT COALESCE\(MAX\(version\), 0\) \+ 1/);
  assert.match(cms, /INSERT INTO cms_revisions/);
  assert.match(cms, /UPDATE cms_revisions SET status = 'archived'/);
  assert.match(cms, /UPDATE cms_revisions SET status = 'published'/);
  assert.match(cms, /UPDATE cms_revisions SET status = 'scheduled'/);
  assert.doesNotMatch(cms, /UPDATE cms_revisions SET blocks/);
  assert.match(cms, /FOR UPDATE/);
  assert.match(cms, /scheduled_at: futureIso/);
  assert.match(cms, /timestamp > Date\.now\(\)/);
  assert.match(cms, /revision\.status !== 'draft'/);
  assert.match(cms, /status = 'draft' RETURNING id, document_id/);
});

test('protected assets validate signatures, use UUID storage keys, audit uploads, and hide filesystem paths', () => {
  assert.match(assets, /multer\.memoryStorage\(\)/);
  assert.match(assets, /MAX_ASSET_SIZE = 50 \* 1024 \* 1024/);
  assert.match(assets, /detectedMime\(req\.file\.buffer\)/);
  assert.match(assets, /mimeType !== req\.file\.mimetype/);
  assert.match(assets, /crypto\.randomUUID\(\)/);
  assert.match(assets, /withAudit\(pool, req, 'cms\.asset\.upload'/);
  assert.match(assets, /canReadAsset\(req\.user, asset\)/);
  assert.match(assets, /fs\.createReadStream\(path\.join\(privateDirectory, asset\.storage_key\)\)/);
  assert.doesNotMatch(assets, /json\([^\n]*storage_key/);
  assert.doesNotMatch(assets, /res\.json\([^\n]*uploadDirectory/);
  assert.match(index, /uploads\/cms-private/);
});
