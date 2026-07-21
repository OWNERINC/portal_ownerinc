const PERMISSIONS = new Set([
  'manageUsers',
  'manageReminders',
  'manageAcademy',
  'manageBenefits',
  'manageKnowledge',
  'viewOmbudsman',
  'manageSolides',
]);

function isSuperAdmin(user) {
  return user?.role === 'admin' && user?.permissions?.superAdmin === true;
}

function can(user, permission) {
  return user?.role === 'admin'
    && (isSuperAdmin(user) || (PERMISSIONS.has(permission) && user?.permissions?.[permission] === true));
}

function maySetPrivileges(actor, targetUid) {
  return isSuperAdmin(actor) && actor.uid !== targetUid;
}

function mayChangeAccountStatus(actor, target) {
  return can(actor, 'manageUsers') && actor.uid !== target.uid
    && (!isSuperAdmin(target) || isSuperAdmin(actor));
}

function removesLastActiveSuperAdmin(target, nextRole, nextPermissions, activeSuperAdminCount) {
  const targetIsActive = target?.permissions?.accountDisabled !== true;
  const remainsSuperAdmin = nextRole === 'admin' && nextPermissions?.superAdmin === true;
  return targetIsActive && isSuperAdmin(target) && !remainsSuperAdmin && activeSuperAdminCount <= 1;
}

function normalizePermissions(value = {}) {
  const permissions = {};
  for (const permission of ['superAdmin', ...PERMISSIONS]) {
    permissions[permission] = value[permission] === true;
  }
  return permissions;
}

module.exports = {
  PERMISSIONS, can, isSuperAdmin, mayChangeAccountStatus, maySetPrivileges,
  normalizePermissions, removesLastActiveSuperAdmin,
};
