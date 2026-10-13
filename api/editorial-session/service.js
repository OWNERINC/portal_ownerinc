const { createHash } = require('node:crypto');
const { ActivePortalUserError, loadActivePortalUser } = require('../middleware/active-user');
const { can } = require('../middleware/policy');
const { buildAdminActor } = require('./admin-actor');
const { createSessionRecord, findSessionRecord, revokeSessionRecord } = require('./store');
const { prepareSessionIssuance, sessionHashExists } = require('./issuance');

const SESSION_DURATION_MS = 7200000;
class EditorialSessionError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}
const unavailable = () => new EditorialSessionError(503, 'editorial_unavailable');
const invalidSession = () => new EditorialSessionError(401, 'editorial_session_invalid');
function firebaseError(error) {
  if (error?.code === 'auth/user-disabled') return new EditorialSessionError(403, 'account-disabled');
  if (['auth/session-cookie-revoked', 'auth/session-cookie-expired', 'auth/invalid-session-cookie',
    'auth/id-token-revoked', 'auth/id-token-expired', 'auth/invalid-id-token',
    'auth/argument-error', 'auth/user-not-found'].includes(error?.code)) return invalidSession();
  return unavailable();
}
function sessionHash(cookie) {
  if (typeof cookie !== 'string' || !cookie || cookie.length > 12000 || /[\s;,\x00-\x1f\x7f]/.test(cookie)) throw invalidSession();
  return createHash('sha256').update(cookie).digest('hex');
}
function actorFromUser(user) {
  if (!can(user, 'manageKnowledge')) throw new EditorialSessionError(403, 'editorial_permission_denied');
  return { uid: user.uid, email: user.email, name: user.name || null, canManageNews: true };
}
function adminActorFromUser(user) {
  const actor = buildAdminActor(user);
  if (!actor) throw new EditorialSessionError(403, 'editorial_permission_denied');
  return actor;
}
async function activeActor(db, decoded, actorMapper = actorFromUser) {
  try {
    return actorMapper(await loadActivePortalUser(db, decoded));
  } catch (error) {
    if (error instanceof ActivePortalUserError) throw new EditorialSessionError(403, error.reason || 'account-inactive');
    if (error instanceof EditorialSessionError) throw error;
    throw unavailable();
  }
}
async function issueSessionCore({ firebaseAuth, db, token, user, previous, now }) {
  const previousHash = previous ? sessionHash(previous) : null;
  let client;
  let releaseError;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    await prepareSessionIssuance(client, user.uid);
    // Compute the two-hour lifetime after waiting, never vary it for uniqueness.
    const issuedAt = now || new Date();
    let cookie;
    try {
      cookie = await firebaseAuth.createSessionCookie(token, { expiresIn: SESSION_DURATION_MS });
    } catch (error) { throw firebaseError(error); }
    const hash = sessionHash(cookie);
    if (hash === previousHash || await sessionHashExists(client, hash)) throw unavailable();
    const expiresAt = new Date(issuedAt.getTime() + SESSION_DURATION_MS);
    // Revocation and replacement are one commit, including account switches.
    if (previousHash) await revokeSessionRecord(client, previousHash);
    const record = await createSessionRecord(client, { hash, uid: user.uid, expiresAt });
    if (!record || record.uid !== user.uid || record.expiresAt?.getTime() !== expiresAt.getTime()) throw unavailable();
    await client.query('COMMIT');
    return { cookie, expiresAt: expiresAt.toISOString() };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { releaseError = rollbackError; }
    }
    throw error instanceof EditorialSessionError ? error : unavailable();
  } finally { if (client) client.release(releaseError); }
}
async function issueEditorialSession(args) {
  actorFromUser(args.user);
  return issueSessionCore(args);
}
async function issueEditorialAdminSession(args) {
  adminActorFromUser(args.user);
  return issueSessionCore(args);
}
async function resolveSessionCore({ firebaseAuth, db, cookie, now = new Date() }, actorMapper) {
  const hash = sessionHash(cookie);
  let record;
  try { record = await findSessionRecord(db, hash); } catch { throw unavailable(); }
  if (!record || !(record.expiresAt instanceof Date) || !(record.expiresAt > now)) throw invalidSession();
  let decoded;
  try { decoded = await firebaseAuth.verifySessionCookie(cookie, true); } catch (error) { throw firebaseError(error); }
  if (!decoded.uid || decoded.uid !== record.uid) throw invalidSession();
  return { actor: await activeActor(db, decoded, actorMapper), expiresAt: record.expiresAt.toISOString() };
}
function resolveEditorialSession(args) {
  return resolveSessionCore(args, actorFromUser);
}
function resolveEditorialAdminSession(args) {
  return resolveSessionCore(args, adminActorFromUser);
}
async function revokeEditorialSession({ db, cookie }) {
  if (!cookie) return false;
  const hash = sessionHash(cookie);
  try { return await revokeSessionRecord(db, hash); } catch { throw unavailable(); }
}
async function checkEditorialActor({ firebaseAuth, db, uid }) {
  if (typeof uid !== 'string' || !uid || uid.length > 128) throw new EditorialSessionError(400, 'invalid_editorial_request');
  let identity;
  try { identity = await firebaseAuth.getUser(uid); } catch (error) { throw firebaseError(error); }
  if (identity.uid !== uid) throw invalidSession();
  if (identity.disabled !== false) throw new EditorialSessionError(403, 'account-disabled');
  return activeActor(db, { uid, email_verified: identity.emailVerified === true });
}
module.exports = {
  EditorialSessionError, SESSION_DURATION_MS, firebaseError, unavailable,
  issueEditorialSession, resolveEditorialSession, issueEditorialAdminSession, resolveEditorialAdminSession,
  adminActorFromUser, revokeEditorialSession, checkEditorialActor,
};
