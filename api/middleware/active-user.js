const { canUseAutoCard, canUsePosCards } = require('./policy');

class ActivePortalUserError extends Error {
  constructor(message, reason) {
    super(message);
    this.status = 403;
    this.reason = reason;
  }
}

async function loadActivePortalUser(db, decoded) {
  if (decoded.email_verified !== true) {
    throw new ActivePortalUserError('A verified email is required.', 'email-not-verified');
  }
  const { rows } = await db.query(
    `SELECT u.*, jt.name AS job_title, jt.active AS job_title_active, jt.page_access AS job_title_access
     FROM users u LEFT JOIN job_titles jt ON jt.id = u.job_title_id
     WHERE u.uid = $1`, [decoded.uid],
  );
  const user = rows[0];
  if (!user) {
    const pending = await db.query(
      `SELECT status FROM pending_registrations
       WHERE firebase_uid = $1 ORDER BY created_at DESC LIMIT 1`, [decoded.uid],
    );
    if (pending.rows[0]?.status === 'pending') {
      throw new ActivePortalUserError('Cadastro pendente de aprovação.', 'pending-approval');
    }
    throw new ActivePortalUserError('Account is not active.');
  }
  if (user.permissions?.accountDisabled === true || user.permissions?.accountDisabled === 'true') {
    throw new ActivePortalUserError('Account is disabled.', 'account-disabled');
  }
  if (user.firebase_enable_pending === true) {
    throw new ActivePortalUserError('Account enablement is pending.', 'enable-pending');
  }
  user.autocard_access = canUseAutoCard(user);
  user.pos_cards_access = canUsePosCards(user);
  return user;
}

module.exports = { ActivePortalUserError, loadActivePortalUser };
