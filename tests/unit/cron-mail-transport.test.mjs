import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { getMailTransport } = require('../../cron/mailTransport');
const { sendEmail } = require('../../cron/sendEmail');
const { sendOperationalAlert } = require('../../cron/sendOperationalAlert');

const env = {
  DATABASE_URL: 'postgres://localhost/portal',
  SMTP_ADDRESS: 'smtp.resend.com',
  SMTP_PORT: '465',
  SMTP_USERNAME: 'resend',
  SMTP_PASSWORD: 'unit-test-password',
  MAILER_SENDER_EMAIL: 'Portal <portal@example.com>',
  OPERATIONAL_ALERT_EMAIL: 'ops@example.com',
};

test('shared transport uses Resend SMTP with implicit TLS and certificate verification', () => {
  const transport = getMailTransport(env);

  assert.equal(transport.options.host, 'smtp.resend.com');
  assert.equal(transport.options.port, 465);
  assert.equal(transport.options.secure, true);
  assert.equal(transport.options.auth.user, 'resend');
  assert.equal(transport.options.auth.pass, env.SMTP_PASSWORD);
  assert.equal(transport.options.tls.rejectUnauthorized, true);
  assert.strictEqual(getMailTransport({ ...env, SMTP_ADDRESS: 'different.example.com' }), transport);
});

test('reminders and operational alerts send through the shared transport', async () => {
  const transport = getMailTransport(env);
  const messages = [];
  transport.sendMail = async (message) => {
    messages.push(message);
  };

  await sendEmail({ to: 'user@example.com', subject: 'Reminder', text: 'Reminder text' }, env);
  assert.equal(await sendOperationalAlert({ subject: 'Worker failed', text: 'Failure text' }, env), true);
  assert.equal(await sendOperationalAlert({ subject: 'Ignored', text: 'Ignored text' }, { ...env, OPERATIONAL_ALERT_EMAIL: '' }), false);
  assert.deepEqual(messages, [
    { to: 'user@example.com', from: env.MAILER_SENDER_EMAIL, subject: 'Reminder', text: 'Reminder text' },
    { from: env.MAILER_SENDER_EMAIL, to: env.OPERATIONAL_ALERT_EMAIL, subject: 'Portal Ownerinc: Worker failed', text: 'Failure text' },
  ]);
  assert.doesNotMatch(JSON.stringify(messages), /unit-test-password/);
});

test('cron source and dependency manifest contain no SendGrid setup', async () => {
  const index = await readFile('cron/index.js', 'utf8');
  const sendEmailSource = await readFile('cron/sendEmail.js', 'utf8');
  const alertSource = await readFile('cron/sendOperationalAlert.js', 'utf8');
  const packageJson = JSON.parse(await readFile('cron/package.json', 'utf8'));
  const packageLock = await readFile('cron/package-lock.json', 'utf8');

  assert.doesNotMatch(index, /@sendgrid\/mail|SENDGRID_|setApiKey/);
  assert.match(sendEmailSource, /require\('\.\/mailTransport'\)/);
  assert.match(alertSource, /require\('\.\/mailTransport'\)/);
  assert.equal(packageJson.dependencies['@sendgrid/mail'], undefined);
  assert.doesNotMatch(packageLock, /@sendgrid\/mail|@sendgrid\/client|@sendgrid\/helpers/);
});

test('cron validates only the required database and SMTP delivery variables', async () => {
  const source = await readFile('cron/index.js', 'utf8');
  assert.match(source, /DATABASE_URL.*SMTP_ADDRESS.*SMTP_PORT.*SMTP_USERNAME.*SMTP_PASSWORD.*MAILER_SENDER_EMAIL/s);
  assert.doesNotMatch(source, /OPERATIONAL_ALERT_EMAIL.*filter/);
});
