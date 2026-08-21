import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  can, canUseAutoCard, canUsePosCards, isSuperAdmin, mayChangeAccountStatus, maySetPrivileges, normalizePermissions,
  removesLastActiveSuperAdmin,
} = require('../../api/middleware/policy');
const { validateEnvironment } = require('../../api/middleware/security');
const { imageExtension, isHttpUrl, normalizeImage, validateProfile, validateUser } = require('../../api/middleware/validation');
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

test('AutoCard allowlist remains exact and independent from Cards Pós access', () => {
  assert.equal(canUseAutoCard({ job_title: 'Analista de RH Sênior' }), true);
  assert.equal(canUseAutoCard({ job_title: 'Gerente de RH' }), true);
  assert.equal(canUseAutoCard({ job_title: 'Analista de DHO' }), false);
  assert.equal(canUseAutoCard({ job_title: 'Gerente de RH Jr.' }), false);
  assert.equal(canUsePosCards({ role: 'admin', job_title: 'Diretor' }), true);
  assert.equal(canUsePosCards({ role: 'viewer', job_title: 'Analista de RH Sênior' }), false);
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
  assert.equal(validateUser({ permissions: { superAdmin: 'true' } }), false);
  assert.equal(validateUser({ permissions: { viewOmbudsman: true } }), false);
  assert.equal(validateUser({ permissions: { manageKnowledge: true } }), true);
  assert.equal(validateUser({ permissions: { manageSolides: true } }), true);
  assert.equal(validateUser({ job_title_id: 'e7fa4cd2-70f5-4d75-a77f-b17b5caedfa9' }), true);
  assert.equal(validateUser({ job_title_id: 'not-a-uuid' }), false);
  assert.equal(validateProfile({ job_title_id: 'e7fa4cd2-70f5-4d75-a77f-b17b5caedfa9' }), false);
  assert.equal(validateProfile({ photo_url: '/uploads/anything.svg' }), false);
  assert.equal(validateProfile({ linkedin_url: 'javascript:alert(1)' }), false);
  assert.equal(isHttpUrl('https://www.linkedin.com/in/user'), true);
});

test('image validation uses file signatures rather than supplied MIME or extension', () => {
  assert.equal(imageExtension(Buffer.from('ffd8ff00', 'hex')), '.jpg');
  assert.equal(imageExtension(Buffer.from('89504e470d0a1a0a', 'hex')), '.png');
  assert.equal(imageExtension(Buffer.from('524946460000000057454250', 'hex')), '.webp');
  assert.equal(imageExtension(Buffer.from('<svg><script>')), null);
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
    PORT: '3000',
    CORS_ORIGINS: 'https://portal.example.com',
  }));
  assert.doesNotThrow(() => validateEnvironment({
    NODE_ENV: 'development', DATABASE_URL: 'secret', FIREBASE_PROJECT_ID: 'project',
    FIREBASE_AUTH_EMULATOR_HOST: 'firebase-auth:9099',
  }));
  assert.throws(() => validateEnvironment({
    NODE_ENV: 'production', DATABASE_URL: 'secret', FIREBASE_PROJECT_ID: 'project',
    FIREBASE_AUTH_EMULATOR_HOST: 'firebase-auth:9099',
  }), /FIREBASE_CLIENT_EMAIL.*FIREBASE_PRIVATE_KEY/);
  assert.throws(() => validateEnvironment({
    DATABASE_URL: 'secret', FIREBASE_PROJECT_ID: 'project',
    FIREBASE_CLIENT_EMAIL: 'service@example.com', FIREBASE_PRIVATE_KEY: 'secret', PORT: '99999',
  }), /PORT/);
});
