require('dotenv').config();

function validateEnvironment(env = process.env) {
  const missing = ['DATABASE_URL', 'SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'].filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

validateEnvironment();

const cron = require('node-cron');
const sgMail = require('@sendgrid/mail');
const pool = require('./db');
const { checkReminders } = require('./checkReminders');
const { enforceRetention, retentionDays } = require('./retention');
const { TIME_ZONE } = require('./scheduling');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
retentionDays();

async function run() {
  try {
    await checkReminders();
  } catch (error) {
    console.error(JSON.stringify({ service: 'cron', event: 'run_failed', error: error.message }));
  }
}

const task = cron.schedule('0 8 * * *', run, { timezone: TIME_ZONE });
const retentionTask = cron.schedule('30 3 * * *', async () => {
  try {
    await enforceRetention();
  } catch (error) {
    console.error(JSON.stringify({ service: 'cron', event: 'retention_failed', error: error.message }));
  }
}, { timezone: TIME_ZONE });
run();
enforceRetention().catch((error) => console.error(JSON.stringify({ service: 'cron', event: 'retention_failed', error: error.message })));
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
