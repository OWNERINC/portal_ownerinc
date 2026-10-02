const { createHash } = require('node:crypto');
const { ActivePortalUserError, loadActivePortalUser } = require('../middleware/active-user');
const { can } = require('../middleware/policy');
const { createSessionRecord, findSessionRecord, revokeSessionRecord } = require('./store');

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
async function activeActor(db, decoded) {
  try {
    return actorFromUser(await loadActivePortalUser(db, decoded));
  } catch (error) {
    if (error instanceof ActivePortalUserError) throw new EditorialSessionError(403, error.reason || 'account-inactive');
    if (error instanceof EditorialSessionError) throw error;
    throw unavailable();
  }
}
async function issueEditorialSession({ firebaseAuth, db, token, user, now = new Date() }) {
  actorFromUser(user);
  let cookie;
  try {
    cookie = await firebaseAuth.createSessionCookie(token, { expiresIn: SESSION_DURATION_MS });
  } catch (error) { throw firebaseError(error); }
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  try {
    await createSessionRecord(db, { hash: sessionHash(cookie), uid: user.uid, expiresAt });
  } catch { throw unavailable(); }
  return { cookie, expiresAt: expiresAt.toISOString() };
}
async function resolveEditorialSession({ firebaseAuth, db, cookie, now = new Date() }) {
  const hash = sessionHash(cookie);
  let record;
  try { record = await findSessionRecord(db, hash); } catch { throw unavailable(); }
  if (!record || !(record.expiresAt instanceof Date) || !(record.expiresAt > now)) throw invalidSession();
  let decoded;
  try { decoded = await firebaseAuth.verifySessionCookie(cookie, true); } catch (error) { throw firebaseError(error); }
  if (!decoded.uid || decoded.uid !== record.uid) throw invalidSession();
  return { actor: await activeActor(db, decoded), expiresAt: record.expiresAt.toISOString() };
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
  issueEditorialSession, resolveEditorialSession, revokeEditorialSession, checkEditorialActor,
};
