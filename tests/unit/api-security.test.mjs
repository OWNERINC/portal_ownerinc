import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  can, canUseAutoCard, canUsePosCards, isSuperAdmin, mayChangeAccountStatus, maySetPrivileges, normalizePermissions,
  removesLastActiveSuperAdmin,
} = require('../../api/middleware/policy');
const { containsLegacyJobTitleToken } = require('../../api/route-utils');
const { errorHandler, requestOrigin, safeResponses, validateEnvironment } = require('../../api/middleware/security');
const { imageExtension, isHttpUrl, normalizeContract, normalizeImage, sanitizeRichText, sanitizeRichValues, validateProfile, validateRegistration, validateUser } = require('../../api/middleware/validation');
const { canManageCms } = require('../../api/cms/permissions');

const manager = { uid: 'manager', role: 'admin', permissions: { manageUsers: true } };
const superAdmin = { uid: 'root', role: 'admin', permissions: { superAdmin: true } };

test('authorization requires an admin role and reserves privilege mutation for another super admin', () => {
  assert.equal(can(manager, 'manageUsers'), true);
  assert.equal(can(manager, 'viewOmbudsman'), false);
  assert.equal(can({ role: 'viewer', permissions: { manageUsers: true } }, 'manageUsers'), false);
  assert.equal(isSuperAdmin(superAdmin), true);
  assert.equal(maySetPrivileges(superAdmin, 'other'), true);
  assert.equal(maySetPrivileges(superAdmin, 'root'), false);
  assert.equal(maySetPrivileges(manager, 'other'), false);
  assert.equal(mayChangeAccountStatus(manager, { uid: 'manager', role: 'viewer', permissions: {} }), false);
  assert.equal(mayChangeAccountStatus(manager, { uid: 'root', role: 'admin', permissions: { superAdmin: true } }), false);
  assert.equal(mayChangeAccountStatus(superAdmin, { uid: 'other', role: 'viewer', permissions: {} }), true);
  assert.equal(removesLastActiveSuperAdmin(superAdmin, 'viewer', {}, 1), true);
  assert.equal(removesLastActiveSuperAdmin(superAdmin, 'admin', { superAdmin: true }, 1), false);
});

test('page access follows the job title and super-admin bypass', () => {
  const activeDho = { role: 'viewer', job_title: 'Analista de DHO Sênior', job_title_active: true, job_title_access: { autocard: true, posCards: true } };
  const activeCustom = { role: 'viewer', job_title: 'Analista Administrativo', job_title_active: true, job_title_access: { autocard: true, posCards: true } };
  assert.equal(canUseAutoCard(activeDho), true);
  assert.equal(canUsePosCards(activeDho), true);
  assert.equal(canUseAutoCard(activeCustom), true);
  assert.equal(canUsePosCards(activeCustom), true);
  assert.equal(canUseAutoCard({ ...activeDho, job_title_active: false }), false);
  assert.equal(canUsePosCards({ ...activeDho, job_title_active: false }), false);
  assert.equal(canUseAutoCard({ role: 'viewer', job_title: 'Analista de DHO Sênior', job_title_access: { autocard: true } }), false);
  assert.equal(canUsePosCards({ role: 'admin', job_title: 'Diretor' }), false);
  assert.equal(canUseAutoCard({ role: 'admin', permissions: { manageUsers: true }, job_title_active: true, job_title_access: {} }), false);
  assert.equal(canUseAutoCard(superAdmin), true);
  assert.equal(canUsePosCards(superAdmin), true);
});

test('job title validation rejects RH as a token without rejecting larger words', () => {
  assert.equal(containsLegacyJobTitleToken('Analista de RH'), true);
  assert.equal(containsLegacyJobTitleToken(' RH '), true);
  assert.equal(containsLegacyJobTitleToken('RHub'), false);
  assert.equal(containsLegacyJobTitleToken('RHOps'), false);
  assert.equal(containsLegacyJobTitleToken('ÁreaRH'), false);
});

test('Cards Pós remains isolated from AutoCard routes, storage, and the migration ledger', async () => {
  const [autocard, posCards, verification, schema, migrationFiles] = await Promise.all([
    readFile('api/routes/autocard.js', 'utf8'),
    readFile('api/routes/pos-cards.js', 'utf8'),
    readFile('api/db/verify-migrations.js', 'utf8'),
    readFile('api/db/schema.sql', 'utf8'),
    readdir('api/db/migrations'),
  ]);
  assert.doesNotMatch(autocard, /canUsePosCards|pos_card/);
  assert.match(autocard, /canUseAutoCard/);
  assert.match(posCards, /canUsePosCards/);
  const referencedTables = [...posCards.matchAll(/\b(?:FROM|INTO|UPDATE)\s+(pos_\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(referencedTables)].sort(), ['pos_card_media', 'pos_cards']);
  assert.match(verification, /'017_pos_cards'/);
  assert.match(verification, /'018_pos_card_storage_key'/);
  assert.match(schema, /'017_pos_cards'/);
  assert.match(schema, /'018_pos_card_storage_key'/);
  assert.ok(migrationFiles.includes('017_pos_cards.sql'));
  assert.ok(migrationFiles.includes('018_pos_card_storage_key.sql'));
});

test('public uploads expose only profile-photo keys and AutoCard icons stay allowlisted', async () => {
  const [index, autocard] = await Promise.all([
    readFile('api/index.js', 'utf8'),
    readFile('api/routes/autocard.js', 'utf8'),
  ]);
  assert.match(index, /autocard-\[0-9a-f-\]\+\\\.webp/);
  assert.match(index, /!\/\^\\\/\[0-9a-f\]\{8\}/);
  assert.match(autocard, /const icons = new Set\(/);
  assert.match(autocard, /const illustrations = new Set\(/);
  assert.match(autocard, /body\.icon != null && !icons\.has\(body\.icon\)/);
  assert.match(autocard, /body\.illustration != null && !illustrations\.has\(body\.illustration\)/);
  assert.match(autocard, /function safeCard\(card\)/);
  assert.doesNotMatch(autocard, /body\.icon != null && \(typeof body\.icon/);
  assert.doesNotMatch(autocard, /body\.illustration != null && \(typeof body\.illustration/);
});

test('CMS management permission mapping stays area-scoped', () => {
  const user = {
    role: 'admin',
    permissions: { manageKnowledge: true, manageAcademy: false, manageBenefits: true, manageReminders: false },
  };
  assert.equal(canManageCms(user, 'knowledge'), true);
  assert.equal(canManageCms(user, 'announcement'), true);
  assert.equal(canManageCms(user, 'academy'), false);
  assert.equal(canManageCms(user, 'benefit'), true);
  assert.equal(canManageCms(user, 'reminder'), false);
  assert.equal(canManageCms(user, 'unknown'), false);
});

test('permission normalization accepts only known true booleans', () => {
  assert.deepEqual(normalizePermissions({ superAdmin: true, manageUsers: 'yes', unknown: true }), {
    superAdmin: true,
    manageUsers: false,
    manageReminders: false,
    manageAcademy: false,
    manageBenefits: false,
    manageKnowledge: false,
    manageSolides: false,
  });
});

test('user and profile validation rejects unsafe privilege, URL, photo, and date shapes', () => {
  assert.equal(validateUser({ name: 'User', email: 'user@example.com', job_title_id: 'e7fa4cd2-70f5-4d75-a77f-b17b5caedfa9' }, { creating: true }), true);
  assert.equal(validateUser({ name: 'User', email: 'user@example.com', password: 'secret1', job_title_id: 'e7fa4cd2-70f5-4d75-a77f-b17b5caedfa9' }, { creating: true }), false);
  assert.equal(validateUser({ name: 'User', email: 'bad', job_title_id: 'e7fa4cd2-70f5-4d75-a77f-b17b5caedfa9' }, { creating: true }), false);
  assert.equal(validateUser({ role: 'owner' }), false);
  assert.equal(validateUser({ pj_due_day: 32 }), false);
  assert.equal(validateUser({ contract_type: 'pj', is_pj: true, pj_due_day: 15 }), true);
  assert.equal(validateUser({ contract_type: 'pj', is_pj: true, pj_due_day: null }), false);
  assert.equal(validateUser({ contract_type: 'clt', is_pj: false, pj_due_day: 15 }), false);
  assert.deepEqual(normalizeContract('clt', 'not-a-day'), { contract_type: 'clt', is_pj: false, pj_due_day: null });
  assert.deepEqual(normalizeContract('pj', '07'), { contract_type: 'pj', is_pj: true, pj_due_day: 7 });
  assert.equal(normalizeContract('pj', 32), null);
  assert.equal(validateUser({ permissions: { superAdmin: 'true' } }), false);
  assert.equal(validateUser({ permissions: { viewOmbudsman: true } }), false);
  assert.equal(validateUser({ permissions: { manageKnowledge: true } }), true);
  assert.equal(validateUser({ permissions: { manageSolides: true } }), true);
  assert.equal(validateUser({ job_title_id: 'e7fa4cd2-70f5-4d75-a77f-b17b5caedfa9' }), true);
  assert.equal(validateUser({ job_title_id: 'not-a-uuid' }), false);
  assert.equal(validateProfile({ job_title_id: 'e7fa4cd2-70f5-4d75-a77f-b17b5caedfa9' }), false);
  assert.equal(validateProfile({ photo_url: '/uploads/anything.svg' }), false);
  assert.equal(validateProfile({ linkedin_url: 'javascript:alert(1)' }), false);
  assert.equal(validateProfile({ name: '   ' }), false);
  assert.equal(validateProfile({ name: 'Ana\nSilva' }), false);
  assert.equal(validateProfile({ phone: '+55\n61 99999-9999' }), false);
  assert.equal(validateProfile({ linkedin_url: 'https://linkedin.com/in/ana\nsilva' }), false);
  assert.equal(validateProfile({ photo_crop: { x: 0.5, y: 0.5, zoom: 1 } }), true);
  assert.equal(validateProfile({ photo_crop: { x: 1.1, y: 0.5, zoom: 1 } }), false);
  assert.equal(validateProfile({ photo_crop: { x: 0.5, y: 0.5, zoom: 4 } }), false);
  assert.equal(isHttpUrl('https://www.linkedin.com/in/user'), true);
});

test('public registration validation accepts only the name and email contract', () => {
  assert.equal(validateRegistration({ name: 'Ana Silva', email: 'ana@example.com' }), true);
  assert.equal(validateRegistration({ name: ' Ana Silva ', email: ' ana@example.com ' }), true);
  assert.equal(validateRegistration({ name: 'A', email: 'ana@example.com' }), false);
  assert.equal(validateRegistration({ name: 'Ana\nSilva', email: 'ana@example.com' }), false);
  assert.equal(validateRegistration({ name: 'Ana Silva', email: 'bad' }), false);
  assert.equal(validateRegistration({ name: 'Ana Silva', email: 'ana@example.com', password: 'known-secret' }), false);
  assert.equal(validateRegistration({ name: 'Ana Silva', email: 'ana@example.com', role: 'admin' }), false);
});

test('image validation uses file signatures rather than supplied MIME or extension', () => {
  assert.equal(imageExtension(Buffer.from('ffd8ff00', 'hex')), '.jpg');
  assert.equal(imageExtension(Buffer.from('89504e470d0a1a0a', 'hex')), '.png');
  assert.equal(imageExtension(Buffer.from('524946460000000057454250', 'hex')), '.webp');
  assert.equal(imageExtension(Buffer.from('<svg><script>')), null);
});

test('rich text sanitizer is canonical, attribute-free, and recursive', () => {
  const value = '<strong onclick="alert(1)">A & B</strong><script>alert(2)</script><ul><li>Item</li></ul>\nFim';
  const sanitized = sanitizeRichText(value);
  assert.equal(sanitized, '<strong>A &amp; B</strong>alert(2)<ul><li>Item</li></ul><br>Fim');
  assert.equal(sanitizeRichText(sanitized), sanitized);
  assert.equal(sanitizeRichText('Uma linha<div>Outra linha</div>'), 'Uma linha<br>Outra linha');
  assert.equal(sanitizeRichText('<div>Uma linha</div><div>Outra linha</div>'), 'Uma linha<br>Outra linha');
  assert.equal(sanitizeRichText('<div>Uma linha</div>Outra linha'), 'Uma linha<br>Outra linha');
  assert.equal(sanitizeRichText('<p>Uma linha</p><strong>Outra linha</strong>'), 'Uma linha<br><strong>Outra linha</strong>');
  assert.equal(sanitizeRichText('<strong>Sem fechamento'), '<strong>Sem fechamento</strong>');
  assert.deepEqual(sanitizeRichValues({ body: value, nested: [value] }), { body: sanitized, nested: [sanitized] });
  assert.doesNotMatch(sanitized, /on\w+\s*=|<script|<\/script/i);
});

test('image normalization decodes valid input and rejects a malformed signature prefix', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const normalized = await normalizeImage(png);
  assert.equal(normalized.subarray(0, 4).toString(), 'RIFF');
  assert.equal(normalized.subarray(8, 12).toString(), 'WEBP');
  await assert.rejects(normalizeImage(Buffer.from('ffd8ff3c7363726970743e', 'hex')));
  await assert.rejects(normalizeImage(Buffer.concat([png, Buffer.from('<script>')])));
});

test('startup validation names missing settings without exposing values', () => {
  assert.throws(() => validateEnvironment({}), /DATABASE_URL.*FIREBASE_PROJECT_ID/);
  assert.doesNotThrow(() => validateEnvironment({
    DATABASE_URL: 'secret',
    FIREBASE_PROJECT_ID: 'project',
    FIREBASE_CLIENT_EMAIL: 'service@example.com',
    FIREBASE_PRIVATE_KEY: 'secret',
    BULK_IMPORT_WORKER_SECRET: 'x'.repeat(32),
    PORT: '3000',
    CORS_ORIGINS: 'https://portal.example.com',
  }));
  assert.doesNotThrow(() => validateEnvironment({
    NODE_ENV: 'development', DATABASE_URL: 'secret', FIREBASE_PROJECT_ID: 'project',
     FIREBASE_AUTH_EMULATOR_HOST: 'firebase-auth:9099', BULK_IMPORT_WORKER_SECRET: 'x'.repeat(32),
  }));
  assert.throws(() => validateEnvironment({
    NODE_ENV: 'production', DATABASE_URL: 'secret', FIREBASE_PROJECT_ID: 'project',
     FIREBASE_AUTH_EMULATOR_HOST: 'firebase-auth:9099', BULK_IMPORT_WORKER_SECRET: 'x'.repeat(32),
  }), /FIREBASE_AUTH_EMULATOR_HOST/);
  assert.throws(() => validateEnvironment({
     DATABASE_URL: 'secret', FIREBASE_PROJECT_ID: 'project',
     FIREBASE_CLIENT_EMAIL: 'service@example.com', FIREBASE_PRIVATE_KEY: 'secret', BULK_IMPORT_WORKER_SECRET: 'x'.repeat(32), PORT: '99999',
  }), /PORT/);
});

test('CORS derives same-origin from forwarded host and port and invalid JSON is a client error', () => {
  const headers = {
    'x-forwarded-proto': 'http',
    'x-forwarded-host': 'portal.example.test:8080',
    'x-forwarded-port': '8080',
  };
  const req = { protocol: 'http', get: name => headers[name] };
  assert.equal(requestOrigin(req), 'http://portal.example.test:8080');

  let statusCode;
  let body;
  const res = {
    headersSent: false,
    status(status) { statusCode = status; return this; },
    json(value) { body = value; return this; },
  };
  errorHandler({ type: 'entity.parse.failed', message: 'unexpected token' }, { id: 'request-1' }, res, () => {});
  assert.equal(statusCode, 400);
  assert.notEqual(statusCode, 500);
  assert.deepEqual(body, { error: 'Invalid JSON.', requestId: 'request-1' });
  assert.doesNotMatch(JSON.stringify(body), /unexpected token/);
});

test('5xx responses preserve only the allowlisted Firebase identity reason', (t) => {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });

  let body;
  const response = {
    statusCode: 503,
    json(value) { body = value; return this; },
  };
  safeResponses({ id: 'request-1' }, response, () => {});

  response.json({ error: 'private error', reason: 'firebase_identity_indeterminate', uid: 'secret-uid' });
  assert.deepEqual(body, {
    error: 'Internal server error.',
    reason: 'firebase_identity_indeterminate',
    requestId: 'request-1',
  });

  response.json({ error: 'private error', reason: 'arbitrary-internal-state', uid: 'secret-uid' });
  assert.deepEqual(body, { error: 'Internal server error.', requestId: 'request-1' });
});
