import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { withAudit } = require('../../api/route-utils');
const cms = await readFile('api/routes/cms.js', 'utf8');
const assets = await readFile('api/routes/cms-assets.js', 'utf8');
const index = await readFile('api/index.js', 'utf8');
const nginx = await readFile('nginx/nginx.conf', 'utf8');
const permissions = await readFile('api/cms/permissions.js', 'utf8');
const blocks = await readFile('api/cms/blocks.js', 'utf8');
const knowledge = await readFile('api/routes/knowledge.js', 'utf8');

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
  assert.match(cms, /router\.get\('\/documents\/:id\/revisions', authMiddleware/);
  assert.match(cms, /ORDER BY version DESC/);
  assert.match(cms, /X-Total-Count/);
});

test('document mutations are transactional, audited, and preserve revision immutability', () => {
  for (const action of ['cms.document.create', 'cms.revision.draft', 'cms.document.publish', 'cms.document.schedule', 'cms.document.unpublish', 'cms.document.unschedule', 'cms.revision.delete']) {
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
  assert.match(cms, /router\.delete\('\/documents\/:id\/schedule', authMiddleware/);
  assert.match(cms, /cms\.document\.unschedule/);
  assert.match(cms, /const body = req\.body === undefined \? \{\} : req\.body/);
  assert.match(cms, /resolveDraftRevisionId\(document, body\.revision_id\)/);
  assert.match(cms, /UPDATE cms_revisions SET status = 'draft'/);
  assert.match(cms, /validateAssetReferences\(db, blocks\)/);
  assert.match(cms, /FROM cms_assets[\s\S]*storage_key IS NOT NULL[\s\S]*byte_size BETWEEN/);
  assert.match(cms, /ASSET_MIMES\[type\]\.has\(asset\.mime_type\)/);
});

test('CMS draft saves share the asset-retention advisory lock', () => {
  assert.match(cms, /CMS_ASSET_RETENTION_LOCK = 7193029/);
  assert.match(cms, /pg_advisory_xact_lock\(\$1\)/);
});

test('CMS revision history returns metadata without replaying block payloads', () => {
  const historyQuery = cms.match(/SELECT id, document_id, version, status, created_by, created_at[\s\S]*?ORDER BY version DESC/);
  assert.ok(historyQuery);
  assert.doesNotMatch(historyQuery[0], /blocks/);
});

test('CMS revision history binds limit before offset', () => {
  assert.match(cms, /const limitIndex = values\.length \+ 1;\s+const offsetIndex = values\.length \+ 2;/);
  assert.match(cms, /LIMIT \$\$\{limitIndex\} OFFSET \$\$\{offsetIndex\}[\s\S]*\[\.\.\.values, page\.limit, page\.offset\]/);
});

test('protected assets validate signatures, use UUID storage keys, audit uploads, and hide filesystem paths', () => {
  assert.match(assets, /multer\.memoryStorage\(\)/);
  assert.match(assets, /MAX_ASSET_SIZE = 50 \* 1024 \* 1024/);
  assert.match(assets, /detectedMime\(req\.file\.buffer\)/);
  assert.match(assets, /mimeType !== req\.file\.mimetype/);
  assert.match(assets, /crypto\.randomUUID\(\)/);
  assert.match(assets, /withAudit\(pool, req, 'cms\.asset\.upload'/);
  assert.match(assets, /canReadAsset\(db, req\.user, asset\)/);
  assert.match(assets, /lockCmsAssets\(db\)/);
  assert.match(assets, /fsp\.open\(path\.join\(privateDirectory, asset\.storage_key\), 'r'\)/);
  assert.match(assets, /file\.createReadStream\(\)/);
  assert.match(assets, /LIMIT_FILE_SIZE/);
  assert.match(assets, /status\(413\)/);
  assert.match(assets, /LIMIT_UNEXPECTED_FILE/);
  assert.match(assets, /LIMIT_FILE_COUNT/);
  assert.match(assets, /Unexpected end of form/);
  assert.match(assets, /isMalformedMultipart/);
  assert.match(assets, /instanceof multer\.MulterError/);
  assert.doesNotMatch(assets, /json\([^\n]*storage_key/);
  assert.doesNotMatch(assets, /res\.json\([^\n]*uploadDirectory/);
  assert.match(assets, /CROSS JOIN LATERAL jsonb_array_elements\(r\.blocks\)/);
  assert.match(assets, /r\.status IN \('draft', 'published', 'scheduled'\)/);
  assert.match(assets, /published_revision_id === row\.revision_id/);
  assert.match(assets, /academy_active === true/);
  assert.match(assets, /benefit_active === true/);
  assert.match(assets, /reminderIsVisible\(row, user\)/);
  assert.doesNotMatch(assets, /asset\.uploaded_by === user\.uid/);
  const uploadStart = assets.indexOf('function uploadMiddleware');
  const authCheck = assets.indexOf('if (!manageable(req.user)) return forbidden(req, res);', uploadStart);
  const parserCall = assets.indexOf("upload.single('asset')", uploadStart);
  assert.ok(uploadStart >= 0 && authCheck >= 0 && authCheck < parserCall);
  assert.match(assets, /fieldNameSize: 100/);
  assert.match(assets, /fieldSize: 1024/);
  assert.match(assets, /fields: 0/);
  assert.match(assets, /parts: 2/);
  assert.doesNotMatch(assets, /headerPairs/);
  assert.match(index, /uploads\/cms-private/);
});

test('CMS list totals count all matching documents and Nginx scopes the large upload body limit', () => {
  assert.match(cms, /SELECT COUNT\(\*\)::integer AS count/);
  assert.match(cms, /res\.set\('X-Total-Count', String\(count\)\)/);
  assert.doesNotMatch(cms, /String\(rows\.length\)/);

  const cmsLocation = nginx.indexOf('location = /api/cms/assets');
  const cmsUploadLocation = nginx.indexOf('location = /api/cms/assets/');
  const cmsReadLocation = nginx.indexOf('location ^~ /api/cms/assets/');
  const genericApi = nginx.indexOf('location /api/');
  assert.ok(cmsLocation >= 0 && cmsUploadLocation > cmsLocation
    && cmsReadLocation > cmsUploadLocation && cmsReadLocation < genericApi);
  assert.match(nginx, /location = \/api\/cms\/assets[\s\S]*client_max_body_size 51m;[\s\S]*proxy_request_buffering off;[\s\S]*limit_req zone=uploads[\s\S]*proxy_pass \$api_upstream/);
  assert.match(nginx, /location = \/api\/cms\/assets\/[\s\S]*client_max_body_size 51m;[\s\S]*proxy_request_buffering off;[\s\S]*limit_req zone=uploads[\s\S]*proxy_pass \$api_upstream/);
  assert.match(nginx, /location \^~ \/api\/cms\/assets\/[\s\S]*client_max_body_size 100k;[\s\S]*limit_req zone=media_reads[\s\S]*proxy_pass \$api_upstream/);
  assert.match(nginx, /frame-src https:\/\/\*\.firebaseapp\.com blob:/);
  assert.doesNotMatch(nginx, /location[^\n]*\/uploads\/cms-private/);
});

test('CMS JSON transport is bounded separately from the normal API', () => {
  assert.match(index, /app\.use\('\/api\/cms', express\.json\(\{ limit: '6mb' \}\)\)/);
  assert.match(index, /express\.json\(\{ limit: '100kb' \}\)/);
  assert.match(blocks, /MAX_CMS_PAYLOAD_BYTES = 5 \* 1024 \* 1024/);
  assert.match(blocks, /normalized\.every\(Boolean\)/);
  assert.match(blocks, /Buffer\.byteLength\(JSON\.stringify\(normalized\), 'utf8'\)/);
  assert.match(nginx, /location \^~ \/api\/cms\/[\s\S]*client_max_body_size 6m;/);
  assert.match(nginx, /location = \/api\/cms\/assets[\s\S]*client_max_body_size 51m;/);
});

test('missing Knowledge updates return 404 without a success audit payload', () => {
  assert.match(knowledge, /if \(!existing\.rows\[0\]\) return null;/);
  assert.match(knowledge, /if \(!result \|\| !result\.row\) return res\.status\(404\)/);
});

test('withAudit treats a missing update as a committed no-op', async () => {
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const result = await withAudit(
    pool,
    { user: { uid: 'admin-1' }, id: 'request-1' },
    'knowledge.update',
    'knowledge',
    async () => null,
  );
  assert.equal(result, null);
  assert.equal(calls.some(sql => /INSERT INTO audit_log/.test(sql)), false);
  assert.equal(calls.at(-1), 'COMMIT');
});
