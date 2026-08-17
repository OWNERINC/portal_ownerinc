const { can } = require('../middleware/policy');

const CMS_PERMISSIONS = {
  knowledge: 'manageKnowledge',
  announcement: 'manageKnowledge',
  academy: 'manageAcademy',
  benefit: 'manageBenefits',
  reminder: 'manageReminders',
};

function canManageCms(user, contentType) {
  const permission = CMS_PERMISSIONS[contentType];
  return permission ? can(user, permission) : false;
}

module.exports = { canManageCms };
