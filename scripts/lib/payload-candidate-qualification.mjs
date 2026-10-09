import { createHash } from 'node:crypto';

// Report schema 1 with the two independent restore comparisons and the injected
// lease race. Changing this contract requires a new identifier, never a fallback.
export const QUALIFICATION_CONTRACT = 'payload-preauthority-recovery-v1';
export const RECOVERY_CHECKS = Object.freeze([
  'disposableSourceAndTargets', 'fixtureCronBootstrapOnly', 'quiescentSnapshotStable',
  'actualAdapterAndCoordinator', 'fourStoreBackupAndRestore',
  'exactPortalDatabaseAndSequences', 'exactCmsDatabaseAndMigrations', 'exactPortalUploadsTree',
  'exactCmsMediaAndStagingTree', 'authorityLegacyEpochOne', 'nativeProtocolAbsent',
  'workerStopped', 'allNegativeCasesRejectedBeforeRestore', 'repeatedCaptureRestoreAfterLiveEdit',
]);
export const RECOVERY_NEGATIVES = Object.freeze([
  'tampered_dump', 'tampered_proof', 'tampered_manifest', 'unsafe_archive',
  'wrong_image_digest', 'migration_mismatch', 'unexpected_schema', 'weak_native_constraint',
  'materialized_view', 'migration_ledger_mismatch', 'target_changed_after_restore_preflight',
]);
const ddlNegatives = new Set(['unexpected_schema', 'weak_native_constraint', 'materialized_view', 'migration_ledger_mismatch']);
const hashPattern = /^[0-9a-f]{64}$/u;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function reject(code) { throw new Error(code); }

export function exactKeys(value, keys, code = 'invalid_candidate_shape') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) reject(code);
}

// JSON.parse alone silently accepts duplicate fields. Parse syntax with JSON.parse,
// then walk the original tokens to reject duplicates (including escaped names).
export function parseEvidenceJson(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024) reject('invalid_evidence_bytes');
  let text;
  let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) reject('invalid_evidence_number');
      return item;
    });
  } catch { reject('invalid_evidence_json'); }
  let index = 0;
  const whitespace = () => { while (/\s/u.test(text[index] || '') && index < text.length) index++; };
  const string = () => {
    const start = index++;
    while (text[index] !== '"') { if (text[index++] === '\\') index++; }
    return JSON.parse(text.slice(start, ++index));
  };
  const walk = (depth = 0) => {
    if (depth > 32) reject('evidence_nesting_exceeded');
    whitespace();
    if (text[index] === '{') {
      index++; whitespace();
      const seen = new Set();
      if (text[index] !== '}') {
        while (true) {
          whitespace(); const key = string();
          if (seen.has(key)) reject('duplicate_evidence_field');
          seen.add(key); whitespace(); index++; walk(depth + 1); whitespace();
          if (text[index] !== ',') break;
          index++;
        }
      }
      index++;
    } else if (text[index] === '[') {
      index++; whitespace();
      if (text[index] !== ']') {
        while (true) { walk(depth + 1); whitespace(); if (text[index] !== ',') break; index++; }
      }
      index++;
    } else if (text[index] === '"') string();
    else { while (index < text.length && !/[\s,\]}]/u.test(text[index])) index++; }
  };
  walk();
  return value;
}

export function validateRunIdentity(identity) {
  exactKeys(identity, ['commit', 'runId', 'runAttempt'], 'invalid_run_identity');
  if (typeof identity.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(identity.commit) ||
      !['runId', 'runAttempt'].every(key => typeof identity[key] === 'string' && /^[1-9][0-9]{0,19}$/u.test(identity[key]))) {
    reject('invalid_run_identity');
  }
}

export function validateCandidateImages(images) {
  exactKeys(images, ['api', 'cron', 'cms'], 'invalid_candidate_images');
  for (const service of ['api', 'cron', 'cms']) {
    if (typeof images[service] !== 'string' ||
        !new RegExp(`^ghcr\\.io/ownerinc/ownerinc-portal-${service}@sha256:[0-9a-f]{64}$`, 'u').test(images[service])) {
      reject('invalid_candidate_images');
    }
  }
}

function sameIdentity(value, expected) {
  validateRunIdentity(value);
  if (['commit', 'runId', 'runAttempt'].some(key => value[key] !== expected[key])) reject('candidate_run_binding_mismatch');
}
function sameImages(value, expected) {
  validateCandidateImages(value);
  if (['api', 'cron', 'cms'].some(key => value[key] !== expected[key])) reject('candidate_image_binding_mismatch');
}

export function qualifyCandidate({ candidateBytes, reportBytes, expectedRun, expectedImages }) {
  validateRunIdentity(expectedRun); validateCandidateImages(expectedImages);
  const candidate = parseEvidenceJson(candidateBytes);
  exactKeys(candidate, ['schemaVersion', 'commit', 'runId', 'runAttempt', 'images']);
  if (candidate.schemaVersion !== 1) reject('unsupported_candidate_schema');
  sameIdentity({ commit: candidate.commit, runId: candidate.runId, runAttempt: candidate.runAttempt }, expectedRun);
  sameImages(candidate.images, expectedImages);
  const report = parseEvidenceJson(reportBytes);
  exactKeys(report, ['schemaVersion', 'status', 'run', 'images', 'sourceInventoryIdentity', 'targetInventoryIdentity',
    'negativeCases', 'checks', 'recoveryProgress', 'restoreAcceptanceProgress', 'evidence'], 'invalid_recovery_report_shape');
  if (report.schemaVersion !== 1) reject('unsupported_recovery_report_schema');
  if (report.status !== 'passed') reject('recovery_report_not_passed');
  sameIdentity(report.run, expectedRun); sameImages(report.images, expectedImages);
  if (![report.sourceInventoryIdentity, report.targetInventoryIdentity].every(value => typeof value === 'string' && hashPattern.test(value)) ||
      report.sourceInventoryIdentity === report.targetInventoryIdentity) reject('invalid_recovery_inventory_identity');
  exactKeys(report.checks, RECOVERY_CHECKS, 'invalid_recovery_checks');
  if (Object.values(report.checks).some(value => value !== true)) reject('recovery_checks_not_passed');
  if (!Array.isArray(report.negativeCases) || report.negativeCases.length !== RECOVERY_NEGATIVES.length ||
      report.negativeCases.map(item => item?.name).sort().join('\0') !== [...RECOVERY_NEGATIVES].sort().join('\0')) {
    reject('invalid_recovery_negative_cases');
  }
  for (const item of report.negativeCases) {
    const extra = ddlNegatives.has(item.name) ? ['fixtureDdlCleaned']
      : item.name === 'target_changed_after_restore_preflight' ? ['raceInjectedAfterLeaseReservation'] : [];
    exactKeys(item, ['name', 'rejected', 'targetContentUnchanged', ...extra], 'invalid_recovery_negative_shape');
    if (item.rejected !== true || item.targetContentUnchanged !== true || extra.some(key => item[key] !== true)) {
      reject('recovery_negative_not_proven');
    }
  }
  exactKeys(report.restoreAcceptanceProgress, ['first', 'second'], 'invalid_restore_progress');
  for (const restore of Object.values(report.restoreAcceptanceProgress)) {
    exactKeys(restore, ['coordinatorReturnedSuccessfully', 'fullSnapshotComparisonPassed'], 'invalid_restore_progress');
    if (Object.values(restore).some(value => value !== true)) reject('restore_comparison_not_proven');
  }
  exactKeys(report.recoveryProgress, ['source', 'target', 'leaseTarget'], 'invalid_recovery_progress');
  for (const progress of Object.values(report.recoveryProgress)) {
    exactKeys(progress, ['initialCmsHealthPassed', 'writersRestartedHealthy', 'quiescentSnapshotComparison'], 'invalid_recovery_progress');
    if (progress.initialCmsHealthPassed !== true || progress.writersRestartedHealthy !== true ||
        progress.quiescentSnapshotComparison !== 'passed') reject('recovery_progress_not_passed');
  }
  exactKeys(report.evidence, ['kind', 'privateFixtureRetainedForRunnerLifetime'], 'invalid_recovery_evidence');
  if (report.evidence.kind !== 'redacted-metadata-only' || report.evidence.privateFixtureRetainedForRunnerLifetime !== false) {
    reject('invalid_recovery_evidence');
  }
  return {
    schemaVersion: 1, qualificationContract: QUALIFICATION_CONTRACT,
    ...expectedRun, images: { ...expectedImages }, recoveryReportSha256: sha256(reportBytes),
  };
}

export function validateQualifiedCandidate({ qualifiedBytes, ...input }) {
  const expected = qualifyCandidate(input);
  const qualified = parseEvidenceJson(qualifiedBytes);
  exactKeys(qualified, Object.keys(expected), 'invalid_qualified_candidate_shape');
  sameImages(qualified.images, expected.images);
  for (const key of Object.keys(expected).filter(key => key !== 'images')) {
    if (qualified[key] !== expected[key]) reject('qualified_candidate_binding_mismatch');
  }
  return qualified;
}
