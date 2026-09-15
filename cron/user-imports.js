async function postWorkerRequest(path, env, fetchImpl, label) {
  if (!env.BULK_IMPORT_WORKER_SECRET || !env.BULK_IMPORT_API_URL) throw new Error('Bulk import worker configuration is missing');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(`${env.BULK_IMPORT_API_URL}${path}`, {
      method: 'POST', headers: { 'x-worker-secret': env.BULK_IMPORT_WORKER_SECRET }, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function triggerUserImports(env = process.env, fetchImpl = fetch) {
  return postWorkerRequest('/api/internal/user-imports/process', env, fetchImpl, 'Bulk import worker');
}

async function cleanupPendingRegistrations(env = process.env, fetchImpl = fetch) {
  return postWorkerRequest('/api/internal/user-imports/registrations/retention', env, fetchImpl, 'Pending registration retention');
}

async function reconcileFirebaseEnables(env = process.env, fetchImpl = fetch) {
  return postWorkerRequest('/api/internal/user-imports/firebase-enables', env, fetchImpl, 'Firebase enable reconciliation');
}

async function cleanupFirebaseUsers(env = process.env, fetchImpl = fetch) {
  return postWorkerRequest('/api/internal/user-imports/firebase-cleanup', env, fetchImpl, 'Firebase cleanup worker');
}

module.exports = { cleanupFirebaseUsers, cleanupPendingRegistrations, reconcileFirebaseEnables, triggerUserImports };
