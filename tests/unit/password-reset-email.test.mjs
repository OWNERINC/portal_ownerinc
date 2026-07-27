import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { passwordResetMessage, smtpOptions } = require('../../api/integrations/password-reset-email');

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

test('public reset flow uses the Portal API and avoids account enumeration copy', async () => {
  const login = await readFile('public/js/login.js', 'utf8');
  const route = await readFile('api/routes/auth.js', 'utf8');
  assert.match(login, /\/api\/auth\/password-reset/);
  assert.doesNotMatch(login, /sendPasswordResetEmail/);
  assert.match(route, /res\.status\(202\)\.json\(accepted\)/);
  assert.match(route, /max: 5/);
});
