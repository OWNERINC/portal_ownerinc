import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  invitationMessage, passwordResetMessage, smtpOptions,
} = require('../../api/integrations/password-reset-email');

const env = {
  SMTP_ADDRESS: 'smtp.resend.com', SMTP_PORT: '465', SMTP_USERNAME: 'resend', SMTP_PASSWORD: 're_test_secret',
  MAILER_SENDER_EMAIL: 'Portal <portal@example.com>',
};

test('Resend SMTP password reset transport uses implicit TLS and keeps credentials out of the message', () => {
  const options = smtpOptions(env);
  assert.equal(options.host, 'smtp.resend.com');
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.auth.user, 'resend');
  assert.equal(options.requireTLS, false);
  assert.equal(options.tls.rejectUnauthorized, true);
  const message = passwordResetMessage({ to: 'user@example.com', link: 'https://example.com/?a=1&b=2', env });
  assert.match(message.html, /a=1&amp;b=2/);
  assert.doesNotMatch(JSON.stringify(message), /smtp\.resend\.com|\bresend\b|re_test_secret/);
});

test('password reset uses the configured sender as Portal Interno Ownerinc', () => {
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

test('password reset ignores unsupported provider-specific sender settings', () => {
  const message = passwordResetMessage({
    to: 'user@example.com',
    link: 'https://example.com/reset',
    env: { ...env, LEGACY_FROM_EMAIL: 'portal@ownerinc.com.br' },
  });
  assert.deepEqual(message.from, {
    name: 'Portal Interno Ownerinc',
    address: 'portal@example.com',
  });
});

test('invitation message explains password setup without exposing credentials', () => {
  const message = invitationMessage({
    to: 'user@example.com', name: 'Ana', link: 'https://example.com/invite?a=1&b=2', env,
  });
  assert.equal(message.subject, 'Seu convite para o Portal Interno Ownerinc');
  assert.deepEqual(message.from, { name: 'Portal Interno Ownerinc', address: 'portal@example.com' });
  assert.match(message.text, /Ana/);
  assert.match(message.html, /a=1&amp;b=2/);
  assert.doesNotMatch(JSON.stringify(message), /password|senha inicial|smtp\.resend\.com|\bresend\b|re_test_secret/i);
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
