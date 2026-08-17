require('dotenv').config();

function validateEnvironment(env = process.env) {
  const missing = [
    'DATABASE_URL', 'SMTP_ADDRESS', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'MAILER_SENDER_EMAIL',
  ].filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

validateEnvironment();

const cron = require('node-cron');
const pool = require('./db');
const { checkReminders } = require('./checkReminders');
const { enforceRetention, retentionDays } = require('./retention');
const { autocardMediaRetentionDays, enforceAutocardMediaRetention } = require('./autocard-media-retention');
const { TIME_ZONE } = require('./scheduling');

retentionDays();
autocardMediaRetentionDays();

async function run() {
  try {
    await checkReminders();
  } catch (error) {
    console.error(JSON.stringify({ service: 'cron', event: 'run_failed', error: error.message }));
  }
}

const task = cron.schedule('0 8 * * *', run, { timezone: TIME_ZONE });
async function runRetention() {
  try {
    await enforceRetention();
  } catch (error) {
    console.error(JSON.stringify({ service: 'cron', event: 'retention_failed', error: error.message }));
  }
  try {
    await enforceAutocardMediaRetention();
  } catch (error) {
    console.error(JSON.stringify({ service: 'cron', event: 'autocard_media_retention_failed', error: error.message }));
  }
}

const retentionTask = cron.schedule('30 3 * * *', runRetention, { timezone: TIME_ZONE });
run();
runRetention();
console.log(JSON.stringify({ service: 'cron', event: 'started', schedule: '0 8 * * *', timezone: TIME_ZONE }));

async function shutdown(signal) {
  console.log(JSON.stringify({ service: 'cron', event: 'stopping', signal }));
  task.stop();
  retentionTask.stop();
  await pool.end();
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = { validateEnvironment };
