import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  invitationMessage, passwordResetMessage, sendGridMessage, smtpOptions, usesSendGrid,
} = require('../../api/integrations/password-reset-email');

const env = {
  SMTP_ADDRESS: 'smtp.example.com', SMTP_PORT: '587', SMTP_USERNAME: 'user', SMTP_PASSWORD: 'secret',
  SMTP_ENABLE_STARTTLS_AUTO: 'true', SMTP_OPENSSL_VERIFY_MODE: 'peer',
  MAILER_SENDER_EMAIL: 'Portal <portal@example.com>',
};

test('SMTP password reset transport requires TLS and keeps credentials out of the message', () => {
  const options = smtpOptions(env);
  assert.equal(options.host, 'smtp.example.com');
  assert.equal(options.requireTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  const message = passwordResetMessage({ to: 'user@example.com', link: 'https://example.com/?a=1&b=2', env });
  assert.match(message.html, /a=1&amp;b=2/);
  assert.doesNotMatch(JSON.stringify(message), /secret/);
});

test('transactional mail uses the verified SendGrid sender when configured', () => {
  assert.equal(usesSendGrid({ SENDGRID_API_KEY: 'SG.test-key', SENDGRID_FROM_EMAIL: 'portal@ownerinc.com.br' }), true);
  assert.equal(usesSendGrid({ SENDGRID_API_KEY: 'local-not-used', SENDGRID_FROM_EMAIL: 'local@ownerinc.test' }), false);
  assert.equal(usesSendGrid({ SENDGRID_API_KEY: 'SG.test-key', SENDGRID_FROM_EMAIL: '' }), false);
});

test('password reset always identifies the sender as Portal Interno Ownerinc', () => {
  const message = passwordResetMessage({
    to: 'user@example.com',
    link: 'https://example.com/reset',
    env: { ...env, MAILER_SENDER_EMAIL: 'Ownerinc Chatwoot <convites@example.com>' },
  });

  assert.deepEqual(message.from, {
    name: 'Portal Interno Ownerinc',
    address: 'convites@example.com',
  });
});

test('SendGrid messages use the configured verified sender', () => {
  const message = passwordResetMessage({
    to: 'user@example.com',
    link: 'https://example.com/reset',
    env: { ...env, SENDGRID_API_KEY: 'SG.test-key', SENDGRID_FROM_EMAIL: 'portal@ownerinc.com.br' },
  });
  assert.deepEqual(message.from, {
    name: 'Portal Interno Ownerinc',
    address: 'portal@ownerinc.com.br',
  });
});

test('SendGrid receives its expected sender shape without mutating the SMTP message', () => {
  const message = passwordResetMessage({
    to: 'user@example.com',
    link: 'https://example.com/reset',
    env: { ...env, SENDGRID_API_KEY: 'SG.test-key', SENDGRID_FROM_EMAIL: 'portal@ownerinc.com.br' },
  });
  const sendGrid = sendGridMessage(message);
  assert.deepEqual(sendGrid.from, { email: 'portal@ownerinc.com.br', name: 'Portal Interno Ownerinc' });
  assert.deepEqual(message.from, { address: 'portal@ownerinc.com.br', name: 'Portal Interno Ownerinc' });
});

test('invitation message explains password setup without exposing credentials', () => {
  const message = invitationMessage({
    to: 'user@example.com', name: 'Ana', link: 'https://example.com/invite?a=1&b=2', env,
  });
  assert.equal(message.subject, 'Seu convite para o Portal Interno Ownerinc');
  assert.deepEqual(message.from, { name: 'Portal Interno Ownerinc', address: 'portal@example.com' });
  assert.match(message.text, /Ana/);
  assert.match(message.html, /a=1&amp;b=2/);
  assert.doesNotMatch(JSON.stringify(message), /password|senha inicial/i);
});

test('invitation HTML escapes the recipient name', () => {
  const message = invitationMessage({ to: 'user@example.com', name: '<Ana>', link: 'https://example.com/invite', env });
  assert.match(message.html, /&lt;Ana&gt;/);
  assert.doesNotMatch(message.html, /<Ana>/);
});

test('public reset flow uses the Portal API and avoids account enumeration copy', async () => {
  const login = await readFile('public/js/login.js', 'utf8');
  const route = await readFile('api/routes/auth.js', 'utf8');
  assert.match(login, /\/api\/auth\/password-reset/);
  assert.doesNotMatch(login, /sendPasswordResetEmail/);
  assert.match(route, /res\.status\(202\)\.json\(accepted\)/);
  assert.match(route, /max: 5/);
});
