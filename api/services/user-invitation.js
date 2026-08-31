const crypto = require('node:crypto');
const { firebaseAuth } = require('../middleware/auth');
const { sendInvitation } = require('../integrations/password-reset-email');

async function createInvitedUser({ client, data, audit }) {
  const firebaseUser = await firebaseAuth.createUser({
    email: data.email, password: crypto.randomBytes(32).toString('base64url'),
    displayName: data.name || undefined, emailVerified: true, disabled: true,
  });
  try {
    const { rows } = await client.query(
      `INSERT INTO users (uid, email, name, role, contract_type, is_pj, pj_due_day, job_title_id, phone, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING *`,
      [firebaseUser.uid, data.email, data.name, data.role || 'viewer', data.contract_type, data.contract_type === 'pj', data.pj_due_day || null, data.job_title_id, data.phone || '', JSON.stringify(data.permissions || {})]
    );
    const link = await firebaseAuth.generatePasswordResetLink(data.email, { url: 'https://portal.ownerinc.com.br/login.html' });
    await sendInvitation({ to: data.email, name: data.name, link });
    await firebaseAuth.updateUser(firebaseUser.uid, { disabled: false });
    if (audit) await audit('user.create', firebaseUser.uid, { role: data.role || 'viewer' });
    return rows[0];
  } catch (error) {
    await firebaseAuth.deleteUser(firebaseUser.uid).catch(() => {});
    throw error;
  }
}

module.exports = { createInvitedUser };
