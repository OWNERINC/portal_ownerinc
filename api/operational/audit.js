const { withAudit } = require('../route-utils');
const { takeLegacyWriteObservation } = require('../owner-news/authority');

// Metadata goes into the existing transaction's audit entry. No extra ledger,
// no write by the observer, and no identities/content are added to diagnostics.
async function withOperationalAudit(pool, req, action, targetType, operation, options = {}) {
  let observation = null;
  return withAudit(pool, req, action, targetType, async db => {
    takeLegacyWriteObservation(db); // Discard metadata left by a rolled-back caller.
    try { return await operation(db); }
    finally { observation = takeLegacyWriteObservation(db); }
  }, { ...options, details: result => ({
    ...(typeof options.details === 'function' ? options.details(result) : options.details || {}),
    ...(observation ? { operationalNews: observation } : {}),
  }) });
}
module.exports = { withOperationalAudit };
