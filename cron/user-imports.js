async function triggerUserImports(env = process.env, fetchImpl = fetch) {
  if (!env.BULK_IMPORT_WORKER_SECRET || !env.BULK_IMPORT_API_URL) throw new Error('Bulk import worker configuration is missing');
  const response = await fetchImpl(`${env.BULK_IMPORT_API_URL}/api/internal/user-imports/process`, {
    method: 'POST', headers: { 'x-worker-secret': env.BULK_IMPORT_WORKER_SECRET },
  });
  if (!response.ok) throw new Error(`Bulk import worker returned HTTP ${response.status}`);
  return response.json();
}

module.exports = { triggerUserImports };
