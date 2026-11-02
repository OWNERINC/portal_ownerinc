// Notification-only contract. Never import this in a control/qualification path.
const API_CHECKS = Object.freeze(['portal_database', 'legacy_feed', 'cms_readiness', 'cms_bridge', 'authority_barrier',
  'feed_requests', 'editorial_requests', 'legacy_refusals', 'legacy_writes']);
const HOST_CHECKS = Object.freeze(['host_state', 'host_admission', 'backup_age', 'backup_attempt', 'backup_timer',
  'disk_postgres', 'disk_portal_uploads', 'disk_cms_uploads', 'disk_backups', 'disk_monitor']);
const CHECKS = Object.freeze([...API_CHECKS, ...HOST_CHECKS, 'application', 'host_observer', 'public_editorial']);
const REASONS = Object.freeze({
  ready: 'ok', sampled: 'ok', verified_local: 'ok', quiet: 'ok',
  read_degraded: 'degraded', request_failures: 'failed', legacy_refused: 'degraded',
  legacy_write_forbidden: 'failed', audit_coverage_missing: 'unknown', audit_limit: 'unknown',
  sample_invalid: 'failed', sample_limit: 'unknown', database_unavailable: 'unknown', application_unavailable: 'unknown',
  contract_missing: 'unknown', unsupported_contract: 'unknown', observation_invalid: 'unknown',
  observation_stale: 'unknown', observation_busy: 'unknown', coverage_gap: 'unknown', no_samples: 'unknown',
  state_unverified: 'unknown', admission_mismatch: 'failed', authority_changed: 'unknown',
  authority_mismatch: 'failed', planned_hold: 'degraded', backup_missing: 'unknown',
  backup_stale: 'failed', backup_running: 'degraded', backup_failed: 'failed', backup_invalid: 'failed',
  backup_timer_unavailable: 'unknown', storage_unavailable: 'unknown', storage_read_only: 'failed',
  disk_warning: 'degraded', disk_critical: 'failed', editorial_unavailable: 'failed',
});
const URGENT = new Set(['authority_mismatch', 'admission_mismatch', 'legacy_write_forbidden', 'backup_invalid',
  'backup_failed', 'disk_critical', 'storage_read_only']);
const check = (id, reason, value) => ({ id, status: REASONS[reason], reason, ...(value === undefined ? {} : { value }) });
function validCheck(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['id', 'status', 'reason', 'value'].includes(key))
    && CHECKS.includes(value.id) && typeof value.reason === 'string'
    && Object.hasOwn(REASONS, value.reason) && value.status === REASONS[value.reason]
    && (value.value === undefined || (Number.isFinite(value.value) && value.value >= 0 && value.value <= Number.MAX_SAFE_INTEGER));
}
function validateObservation(value, source, now) {
  const expected = source === 'api' ? API_CHECKS : HOST_CHECKS;
  if (!value || Object.keys(value).sort().join(',') !== 'checks,expiresAt,generation,kind,observedAt,schemaVersion,source'
    || value.schemaVersion !== 1 || value.kind !== 'portal-operational-observation-v1' || value.source !== source
    || !/^[a-f0-9-]{32,64}$/u.test(value.generation || '') || !Number.isSafeInteger(value.observedAt)
    || !Number.isSafeInteger(value.expiresAt) || value.observedAt > now + 5000 || value.observedAt < now - 120000
    || value.expiresAt <= now || value.expiresAt <= value.observedAt || value.expiresAt - value.observedAt > 120000
    || !Array.isArray(value.checks) || value.checks.length !== expected.length
    || new Set(value.checks.map(item => item?.id)).size !== expected.length
    || value.checks.some(item => !validCheck(item) || !expected.includes(item.id))) throw new Error('observation_invalid');
  return value;
}
module.exports = { API_CHECKS, HOST_CHECKS, CHECKS, REASONS, URGENT, check, validCheck, validateObservation };
