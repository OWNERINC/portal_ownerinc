function noteWorkerResultFailures(currentError, label, result) {
  const failed = Number(result?.failed || 0) + Number(result?.fileFailures || 0);
  return currentError || (failed > 0 ? new Error(`${label} reported ${failed} failed item(s).`) : null);
}

module.exports = { noteWorkerResultFailures };
