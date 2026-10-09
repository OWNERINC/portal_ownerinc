import {
  CMS_READINESS_ROUTE,
  createReadinessDiagnostic,
  sanitizeCommandDiagnostic,
} from './payload-preauthority-diagnostics.mjs';
import { sanitizeSnapshotMismatch } from './payload-preauthority-snapshot.mjs';

const safeLabel = /^[a-z][a-z0-9_]{0,95}$/u;

function failureSummary(error, fallbackSubstep) {
  const commandDiagnostic = error?.diagnostic && typeof error.diagnostic === 'object'
    ? sanitizeCommandDiagnostic(error.diagnostic) : null;
  const knownFallbackSubstep = typeof fallbackSubstep === 'string' && safeLabel.test(fallbackSubstep)
    ? fallbackSubstep : null;
  const normalizedCommandDiagnostic = commandDiagnostic?.substep === 'unclassified_command' && knownFallbackSubstep
    ? { ...commandDiagnostic, substep: knownFallbackSubstep }
    : commandDiagnostic;
  const rawReadiness = error?.readinessDiagnostic;
  const readinessDiagnostic = rawReadiness && typeof rawReadiness === 'object'
    ? createReadinessDiagnostic({
      reason: rawReadiness.reason,
      containerState: rawReadiness.containerState,
      healthStatus: rawReadiness.healthStatus,
      containerExitCode: rawReadiness.containerExitCode,
      readinessHttpStatus: rawReadiness.readinessHttpStatus,
      service: rawReadiness.expectedRoute === CMS_READINESS_ROUTE ? 'cms' : 'other',
    }) : null;
  const rawCode = typeof error?.code === 'string' && safeLabel.test(error.code)
    ? error.code : 'acceptance_assertion_failed';
  const candidateSubstep = commandDiagnostic?.substep === 'unclassified_command'
    ? knownFallbackSubstep : commandDiagnostic?.substep || knownFallbackSubstep;
  const snapshotMismatch = sanitizeSnapshotMismatch(error?.snapshotMismatch);

  return {
    failureCode: rawCode,
    ...(snapshotMismatch ? { snapshotMismatch } : {}),
    ...(typeof candidateSubstep === 'string' && safeLabel.test(candidateSubstep)
      ? { failedSubstep: candidateSubstep } : {}),
    ...(normalizedCommandDiagnostic ? { commandDiagnostic: normalizedCommandDiagnostic } : {}),
    ...(readinessDiagnostic ? { readinessDiagnostic } : {}),
  };
}

/** Always run writer restart, but retain snapshot failure as the primary outcome. */
export async function runSnapshotAndRestart(snapshotOperation, restartOperation, getSubstep = () => null) {
  const readSubstep = () => {
    try {
      const value = getSubstep();
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };
  let value;
  let snapshotError = null;
  let snapshotSubstep = null;
  try {
    value = await snapshotOperation();
  } catch (error) {
    snapshotError = error;
    snapshotSubstep = readSubstep();
  }

  let restartError = null;
  let restartSubstep = null;
  try {
    await restartOperation();
  } catch (error) {
    restartError = error;
    restartSubstep = readSubstep();
  }

  const primaryError = snapshotError || restartError;
  const primarySubstep = snapshotError ? snapshotSubstep : restartSubstep;
  const primaryPhase = snapshotError ? 'snapshot' : restartError ? 'writer_restart' : null;
  const secondaryError = snapshotError ? restartError : null;
  const secondarySubstep = snapshotError ? restartSubstep : null;

  return {
    value,
    primaryError,
    primarySubstep,
    primaryPhase,
    secondaryError,
    secondarySubstep,
  };
}

/** Build only bounded metadata for the primary failure and optional restart secondary. */
export function createRecoveryFailureReportFields(outcome) {
  if (!outcome?.primaryError) return {};
  const primary = failureSummary(outcome.primaryError, outcome.primarySubstep);
  const secondary = outcome.secondaryError
    ? failureSummary(outcome.secondaryError, outcome.secondarySubstep) : null;
  const ownerRestoration = outcome.primaryError?.secondaryFailure;
  const safeOwnerRestoration = ownerRestoration && typeof ownerRestoration === 'object'
    ? {
      failureCode: typeof ownerRestoration.code === 'string' && safeLabel.test(ownerRestoration.code)
        ? ownerRestoration.code : 'fixture_owner_restore_failed',
      failedSubstep: typeof ownerRestoration.substep === 'string' && safeLabel.test(ownerRestoration.substep)
        ? ownerRestoration.substep : 'fixture_restore_root_owner',
      ...(ownerRestoration.diagnostic && typeof ownerRestoration.diagnostic === 'object'
        ? { commandDiagnostic: sanitizeCommandDiagnostic(ownerRestoration.diagnostic) } : {}),
      lockIdentityPreserved: ownerRestoration.lockIdentityPreserved === true,
      rootOwnerRestored: ownerRestoration.rootOwnerRestored === true,
    } : null;
  const failureContext = {
    ...(secondary ? { writerRestart: secondary } : {}),
    ...(safeOwnerRestoration ? { fixtureOwnerRestoration: safeOwnerRestoration } : {}),
  };

  return {
    ...primary,
    ...(Object.keys(failureContext).length ? { failureContext } : {}),
  };
}
