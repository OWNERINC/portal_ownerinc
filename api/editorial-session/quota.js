const { rateLimit } = require('../middleware/security');

// Per API process, one fixed aggregate bucket per operation. Resolution is normal
// per-request traffic from every editor, not one browser's IP budget. Separate
// lanes reserve capacity for confirmed logout, job checks and authority reads.
const EDITORIAL_QUOTA = Object.freeze({ resolve: 3000, revoke: 300, actor: 600, authority: 120, rejected: 60 });
function createEditorialQuotas(overrides = {}) {
  const limits = { ...EDITORIAL_QUOTA, ...overrides };
  return Object.fromEntries(Object.keys(EDITORIAL_QUOTA).map(operation => {
    if (!Number.isSafeInteger(limits[operation]) || limits[operation] < 1) throw new Error('Invalid editorial quota');
    return [operation, rateLimit({ windowMs: 60 * 1000, max: limits[operation], key: () => 'editorial-service' })];
  }));
}

module.exports = { EDITORIAL_QUOTA, createEditorialQuotas };
