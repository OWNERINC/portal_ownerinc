import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('invitation audit persists only a sanitized SMTP acceptance correlation', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendInvitation = mailer.sendInvitation;

  const firebaseAuth = {
    createUser: async () => ({ uid: 'user-123' }),
    generatePasswordResetLink: async () => 'https://example.test/reset',
    updateUser: async () => {},
    deleteUser: async () => {},
  };
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      return { rows: [{ uid: 'user-123' }] };
    },
  };
  const audits = [];

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, exports: { firebaseAuth },
  };
  mailer.sendInvitation = async () => ({
    messageId: '<portal-message@example.test>',
    response: '250 2.0.0 accepted by SMTP',
    accepted: ['recipient@example.test'],
    rejected: [],
  });
  delete require.cache[servicePath];
  const { createInvitedUser } = require(servicePath);

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendInvitation = originalSendInvitation;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  const created = await createInvitedUser({
    client,
    data: { email: 'recipient@example.test', name: 'Recipient', contract_type: 'clt' },
    audit: async (action, targetId, details) => audits.push({ action, targetId, details }),
  });

  assert.deepEqual(created, { uid: 'user-123', invitation: { state: 'accepted_by_smtp' } });
  assert.equal(queries.length, 1);
  assert.deepEqual(audits, [{
    action: 'user.create',
    targetId: 'user-123',
    details: {
      role: 'viewer',
      invitation: {
        state: 'accepted_by_smtp',
        message_id: '<portal-message@example.test>',
        response_code: 250,
        accepted_count: 1,
        rejected_count: 0,
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(audits), /recipient@example\.test|accepted by SMTP/);
});

test('admin UI does not represent SMTP acceptance as inbox delivery', async () => {
  const source = await readFile('public/js/admin.js', 'utf8');
  assert.match(source, /Convite encaminhado ao serviço de e-mail/);
  assert.match(source, /Confirme o recebimento na caixa de entrada/);
  assert.doesNotMatch(source, /Convite enviado para/);
});
