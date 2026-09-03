const PERMISSIONS = new Set([
  'manageUsers',
  'manageReminders',
  'manageAcademy',
  'manageBenefits',
  'manageKnowledge',
  'manageSolides',
]);

const JOB_TITLE_PAGES = ['autocard', 'posCards'];

function isSuperAdmin(user) {
  return user?.role === 'admin' && user?.permissions?.superAdmin === true;
}

function can(user, permission) {
  return user?.role === 'admin'
    && (isSuperAdmin(user) || (PERMISSIONS.has(permission) && user?.permissions?.[permission] === true));
}

function canUseAutoCard(user) {
  return isSuperAdmin(user) || user?.job_title_access?.autocard === true;
}

function canUsePosCards(user) {
  return isSuperAdmin(user) || user?.job_title_access?.posCards === true;
}

function normalizeJobTitlePages(value = {}) {
  return Object.fromEntries(JOB_TITLE_PAGES.map((page) => [page, value[page] === true]));
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
  JOB_TITLE_PAGES, PERMISSIONS, can, canUseAutoCard,
  canUsePosCards, isSuperAdmin, mayChangeAccountStatus, maySetPrivileges,
  normalizeJobTitlePages, normalizePermissions, removesLastActiveSuperAdmin,
};
