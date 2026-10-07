const { can } = require('../middleware/policy');

// This allowlist is the complete Portal-admin shell boundary for session v2.
const ADMIN_CAPABILITIES = Object.freeze([
  'manageKnowledge',
  'manageAcademy',
  'manageBenefits',
  'manageReminders',
]);

function adminCapabilities(user) {
  return Object.fromEntries(ADMIN_CAPABILITIES.map(permission => [permission, can(user, permission)]));
}

function canEnterAdmin(user) {
  return Object.values(adminCapabilities(user)).some(Boolean);
}

function buildAdminActor(user) {
  const capabilities = adminCapabilities(user);
  if (!Object.values(capabilities).some(Boolean)) return null;
  return {
    version: 2,
    uid: user.uid,
    email: user.email,
    name: user.name || null,
    capabilities,
  };
}

module.exports = { ADMIN_CAPABILITIES, adminCapabilities, canEnterAdmin, buildAdminActor };
