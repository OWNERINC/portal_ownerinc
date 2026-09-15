require('dotenv').config();

function validateEnvironment(env = process.env) {
  const missing = [
    'DATABASE_URL', 'SMTP_ADDRESS', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'MAILER_SENDER_EMAIL',
    'BULK_IMPORT_API_URL', 'BULK_IMPORT_WORKER_SECRET',
  ].filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (String(env.BULK_IMPORT_WORKER_SECRET).length < 32) throw new Error('BULK_IMPORT_WORKER_SECRET must contain at least 32 characters');
}

validateEnvironment();

const cron = require('node-cron');
const pool = require('./db');
const { checkReminders } = require('./checkReminders');
const { enforceRetention, retentionDays } = require('./retention');
const { autocardMediaRetentionDays, enforceAutocardMediaRetention } = require('./autocard-media-retention');
const { cmsAssetRetentionDays, enforceCmsAssetRetention } = require('./cms-asset-retention');
const { TIME_ZONE } = require('./scheduling');
const { cleanupFirebaseUsers, cleanupPendingRegistrations, reconcileFirebaseEnables, triggerUserImports } = require('./user-imports');
const { noteWorkerResultFailures } = require('./worker-status');

retentionDays();
autocardMediaRetentionDays();
cmsAssetRetentionDays();

async function updateWorkerStatus(name, phase, error = null) {
  const message = error ? String(error.message || error).slice(0, 1000) : null;
  if (phase === 'start') {
    await pool.query(
       `INSERT INTO cron_status (name, heartbeat_at, last_started_at, last_error)
       VALUES ($1, NOW(), NOW(), NULL)
       ON CONFLICT (name) DO UPDATE SET heartbeat_at = NOW(), last_started_at = NOW(),
         last_error = CASE WHEN cron_status.last_error = 'Worker status missing' THEN NULL ELSE cron_status.last_error END`,
      [name],
    );
    return;
  }
  await pool.query(
    `UPDATE cron_status
     SET heartbeat_at = NOW(), last_finished_at = NOW(),
         last_success_at = CASE WHEN $2::text IS NULL THEN NOW() ELSE last_success_at END,
         last_error = $2
     WHERE name = $1`,
    [name, message],
  );
}

function start() {
async function run() {
  try {
    await checkReminders();
  } catch (error) {
    console.error(JSON.stringify({ service: 'cron', event: 'run_failed', error: error.message }));
  }
}

const task = cron.schedule('0 8 * * *', run, { timezone: TIME_ZONE, noOverlap: true });
async function runUserImports() {
  let lastError = null;
  await updateWorkerStatus('user-imports', 'start').catch((error) => { lastError = error; });
  try { lastError = noteWorkerResultFailures(lastError, 'Bulk import worker', await triggerUserImports()); }
  catch (error) { lastError = error; console.error(JSON.stringify({ service: 'cron', event: 'user_imports_failed', error: error.message })); }
  try { lastError = noteWorkerResultFailures(lastError, 'Firebase enable reconciliation', await reconcileFirebaseEnables()); }
  catch (error) { lastError = error; console.error(JSON.stringify({ service: 'cron', event: 'firebase_enable_reconciliation_failed', error: error.message })); }
  try { lastError = noteWorkerResultFailures(lastError, 'Firebase cleanup worker', await cleanupFirebaseUsers()); }
  catch (error) { lastError = error; console.error(JSON.stringify({ service: 'cron', event: 'firebase_cleanup_failed', error: error.message })); }
  await updateWorkerStatus('user-imports', 'finish', lastError).catch(() => {});
}
const userImportsTask = cron.schedule('* * * * *', runUserImports, { timezone: TIME_ZONE, noOverlap: true });
async function runRetention() {
  let lastError = null;
  await updateWorkerStatus('retention', 'start').catch((error) => { lastError = error; });
  try {
    lastError = noteWorkerResultFailures(lastError, 'Retention', await enforceRetention());
  } catch (error) {
    lastError = error;
    console.error(JSON.stringify({ service: 'cron', event: 'retention_failed', error: error.message }));
  }
  try {
    lastError = noteWorkerResultFailures(lastError, 'AutoCard retention', await enforceAutocardMediaRetention());
  } catch (error) {
    lastError = error;
    console.error(JSON.stringify({ service: 'cron', event: 'autocard_media_retention_failed', error: error.message }));
  }
  try {
    lastError = noteWorkerResultFailures(lastError, 'CMS asset retention', await enforceCmsAssetRetention());
  } catch (error) {
    lastError = error;
    console.error(JSON.stringify({ service: 'cron', event: 'cms_asset_retention_failed', error: error.message }));
  }
  try {
    lastError = noteWorkerResultFailures(lastError, 'Pending registration retention', await cleanupPendingRegistrations());
  } catch (error) {
    lastError = error;
    console.error(JSON.stringify({ service: 'cron', event: 'pending_registration_retention_failed', error: error.message }));
  }
  await updateWorkerStatus('retention', 'finish', lastError).catch(() => {});
}

const retentionTask = cron.schedule('30 3 * * *', runRetention, { timezone: TIME_ZONE, noOverlap: true });
run();
runUserImports();
runRetention();
console.log(JSON.stringify({ service: 'cron', event: 'started', schedule: '0 8 * * *; user-imports=* * * * *', timezone: TIME_ZONE }));

async function shutdown(signal) {
  console.log(JSON.stringify({ service: 'cron', event: 'stopping', signal }));
  task.stop();
  userImportsTask.stop();
  retentionTask.stop();
  await pool.end();
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
}

if (process.env.CRON_BOOTSTRAP_ONLY === 'true') {
  console.log(JSON.stringify({ service: 'cron', event: 'bootstrap_ready' }));
  setInterval(() => {}, 60_000);
} else {
  start();
}

module.exports = { validateEnvironment };
