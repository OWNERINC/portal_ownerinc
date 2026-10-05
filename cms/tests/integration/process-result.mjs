/** Keep test exit codes distinct from launcher timeout/spawn/signal failures. */
export function describeProcessResult(result) {
  if (result.error?.code === 'ETIMEDOUT') return 'timeout (ETIMEDOUT)'
  if (result.error) return `spawn-error (${result.error.code || 'unknown'})`
  if (result.signal) return `signal ${result.signal}`
  return `exit ${result.status}`
}
