const PERMISSIONS = new Set([
  'manageUsers',
  'manageReminders',
  'manageAcademy',
  'manageBenefits',
  'manageKnowledge',
  'viewOmbudsman',
  'manageSolides',
]);

const AUTOCARD_JOB_TITLES = new Set([
  'analista de dho',
  'assistente de dho',
  'coordenador de dho',
  'gerente de dho',
]);

function isSuperAdmin(user) {
  return user?.role === 'admin' && user?.permissions?.superAdmin === true;
}

function can(user, permission) {
  return user?.role === 'admin'
    && (isSuperAdmin(user) || (PERMISSIONS.has(permission) && user?.permissions?.[permission] === true));
}

function canUseAutoCard(user) {
  const title = String(user?.job_title || '').trim().toLocaleLowerCase('pt-BR');
  return AUTOCARD_JOB_TITLES.has(title);
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
  AUTOCARD_JOB_TITLES, PERMISSIONS, can, canUseAutoCard, isSuperAdmin, mayChangeAccountStatus, maySetPrivileges,
  normalizePermissions, removesLastActiveSuperAdmin,
};
