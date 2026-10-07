/** Shared finite budgets: child work is followed by capture, cleanup, and settle time. */
export const TASK9_TIME_BUDGETS = Object.freeze({
  parentStartupMs: 30000,
  captureMs: 10000,
  cleanupWorkMs: 14000,
  cleanupMs: 16000,
  settleMs: 2000,
  parentKillGraceMs: 5000,
  defaultChildWorkMs: 155000,
  httpChildWorkMs: 200000,
  acceptanceChildWorkMs: 180000,
})

export function task9ChildWorkBudget(mode) {
  if (mode === '--http') return TASK9_TIME_BUDGETS.httpChildWorkMs
  if (['--metadata', '--entry-probe', '--nav-probe', '--destinations'].includes(mode)) {
    return TASK9_TIME_BUDGETS.acceptanceChildWorkMs
  }
  return TASK9_TIME_BUDGETS.defaultChildWorkMs
}

/** Independent parent kill switch leaves the child enough time to capture and clean up. */
export function task9ParentSpawnBudget(mode) {
  return TASK9_TIME_BUDGETS.parentStartupMs
    + task9ChildWorkBudget(mode)
    + TASK9_TIME_BUDGETS.captureMs
    + TASK9_TIME_BUDGETS.cleanupMs
    + TASK9_TIME_BUDGETS.settleMs
    + TASK9_TIME_BUDGETS.parentKillGraceMs
}
