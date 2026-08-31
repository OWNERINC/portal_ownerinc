import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(path, 'utf8');

test('Pos-Cards API is mounted at its isolated namespace', async () => {
  const source = await read('api/index.js');
  assert.match(source, /const posCardsRoutes = require\('\.\/routes\/pos-cards'\);/);
  assert.match(source, /app\.use\('\/api\/pos-cards',\s*posCardsRoutes\);/);
});

test('public uploads block the Pos namespace before generic static delivery', async () => {
  const source = await read('api/index.js');
  const posBoundary = source.indexOf("/^\\/pos-card-[0-9a-f-]+\\.webp$/i.test(req.path)");
  const genericUploads = source.indexOf("app.use('/uploads', express.static('/app/uploads'))");
  assert.ok(posBoundary >= 0 && posBoundary < genericUploads);
  assert.match(source, /app\.use\('\/uploads', \(req, res, next\) => \{[\s\S]*\^\\\/pos-card-\[0-9a-f-\]\+\\\.webp\$[\s\S]*res\.sendStatus\(404\)[\s\S]*next\(\)/);
});

test('all Pos-Cards routes share authentication and the policy boundary', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /function requirePosCards\(req, res, next\)/);
  assert.match(source, /return canUsePosCards\(req\.user\) \? next\(\) : forbidden\(req, res\);/);
  assert.match(source, /router\.use\(authMiddleware, requirePosCards\);/);
  assert.match(source, /router\.get\('\/access'/);
  assert.match(source, /router\.get\('\/cards'/);
  assert.match(source, /router\.post\('\/cards'/);
  assert.match(source, /router\.get\('\/cards\/:id'/);
  assert.match(source, /router\.put\('\/cards\/:id'/);
  assert.match(source, /router\.post\('\/cards\/:id\/duplicate'/);
  assert.match(source, /router\.delete\('\/cards\/:id'/);
  assert.match(source, /router\.post\('\/media'/);
  assert.match(source, /router\.get\('\/media\/:id'/);
  assert.doesNotMatch(source, /autocard_(?:cards|media)/);
});

test('card validation accepts the Guest and Owner contracts', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /const templates = new Set\(\['convite_owntime', 'convite_owner'\]\)/);
  assert.match(source, /templates\.has\(body\.template\)/);
  assert.match(source, /template: body\.template/);
  assert.match(source, /name\.length < 1 \|\| name\.length > 120/);
  assert.match(source, /body\.values \|\| typeof body\.values !== 'object' \|\| Array\.isArray\(body\.values\)/);
  assert.match(source, /serializedValues\.length > 50000/);
  assert.match(source, /parseListQuery\(req\.query, \{ search: value => value\.length <= 120 \}\)/);
  assert.match(source, /name ILIKE/);
  assert.match(source, /ORDER BY updated_at DESC/);
  assert.match(source, /SELECT LEFT\(name \|\| ' v2', 120\), template, "values", media_id/);
});

test('Pos-Cards name search treats wildcard characters literally', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /const escapedSearch = search\.replace\(/);
  assert.match(source, /\\\\%_/);
  assert.match(source, /ILIKE \$\$\{values\.length\} ESCAPE/);
});

test('Pos-Cards oversized media bodies return a bounded error without destroying the request', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /let settled = false/);
  assert.match(source, /error\.code = 'LIMIT_FILE_SIZE'/);
  assert.match(source, /req\.resume\(\)/);
  assert.doesNotMatch(source, /req\.destroy\(\)/);
});

test('Pos-Cards storage uses normalized WebP files and the dedicated tables', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /const maxMediaBytes = 3 \* 1024 \* 1024;/);
  assert.match(source, /readBody\(req, maxMediaBytes\)/);
  assert.match(source, /normalizeImage\(content\)/);
  assert.match(source, /storageKey = `pos-card-\$\{id\}\.webp`;/);
  assert.match(source, /INSERT INTO pos_card_media/);
  assert.match(source, /INSERT INTO pos_cards/);
  assert.doesNotMatch(source, /FROM autocard_(?:cards|media)|INTO autocard_(?:cards|media)/);
});

test('private media responses preserve database content type and cache policy', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /SELECT storage_key, content_type FROM pos_card_media/);
  assert.match(source, /res\.setHeader\('Content-Type', rows\[0\]\.content_type\)/);
  assert.match(source, /res\.setHeader\('Cache-Control', 'private, max-age=3600'\)/);
  assert.match(source, /sendFile\(path\.join\(uploadDirectory, rows\[0\]\.storage_key\)\)/);
});

test('writes are audited and replacement/deletion clean up unreferenced Pos media', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.equal((source.match(/withAudit\(/g) || []).length, 5);
  assert.match(source, /pos-cards\.card\.create/);
  assert.match(source, /pos-cards\.card\.update/);
  assert.match(source, /pos-cards\.card\.duplicate/);
  assert.match(source, /pos-cards\.card\.delete/);
  assert.match(source, /pos-cards\.media\.create/);
  assert.match(source, /function removeMediaIfUnused\(mediaId\)/);
  assert.match(source, /FROM pos_card_media m[\s\S]*FROM pos_cards c/);
  assert.match(source, /await removeMediaIfUnused\(result\.oldMediaId\)/);
  assert.match(source, /await removeMediaIfUnused\(result\.mediaId\)/);
});

test('Pos-Cards writes share the AutoCard media-retention lock', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /const posCardsLock = 7193003/);
});

test('duplicate names remain within the 120-character contract', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /LEFT\(name \|\| ' v2', 120\)/);
});

test('malformed image normalization returns invalid while storage cleanup remains active', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /let normalized;[\s\S]*?try \{\s*normalized = await normalizeImage\(content\);\s*\} catch \{\s*return invalid\(req, res\);\s*\}/);
  assert.match(source, /if \(storageKey\) await fs\.unlink\(path\.join\(uploadDirectory, storageKey\)\)\.catch\(\(\) => \{\}\)/);
});

test('invalid and missing resources carry repository request identifiers', async () => {
  const source = await read('api/routes/pos-cards.js');
  assert.match(source, /invalid\(req, res\)/);
  assert.match(source, /status\(404\)\.json\([\s\S]*requestId: req\.id/);
  assert.match(source, /status\(415\)\.json\([\s\S]*requestId: req\.id/);
});

test('the forbidden boundary is explicit and precedes route handlers', async () => {
  const source = await read('api/routes/pos-cards.js');
  const gate = source.indexOf('router.use(authMiddleware, requirePosCards);');
  const access = source.indexOf("router.get('/access'");
  assert.ok(gate >= 0 && gate < access);
  assert.match(source, /forbidden\(req, res\)/);
});
