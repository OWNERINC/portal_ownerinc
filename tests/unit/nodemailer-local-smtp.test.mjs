import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { sendInvitation } = require('../../api/integrations/password-reset-email');
const { sendEmail } = require('../../cron/sendEmail');
const { classifySmtpError, classifySmtpResult } = require('../../cron/mailTransport');

async function localSmtp(t) {
  const messages = [];
  const sockets = new Set();
  let rejection = null;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let data = null;
    let authenticated = false;
    let envelope;
    const reply = line => socket.write(`${line}\r\n`);
    reply('220 fixture.example.test ESMTP');
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data !== null) {
          if (line === '.') {
            messages.push({ envelope, message: data.join('\r\n') });
            data = null;
            reply('250 2.0.0 fixture accepted');
          } else {
            data.push(line.replace(/^\.\./, '.'));
          }
        } else if (/^(EHLO|HELO) /.test(line)) {
          reply('250-fixture.example.test\r\n250 AUTH PLAIN');
        } else if (line.startsWith('AUTH PLAIN ')) {
          authenticated = Buffer.from(line.slice(11), 'base64').toString() === '\0fixture\0fixture-password';
          reply(authenticated ? '235 2.7.0 fixture authenticated' : '535 5.7.8 fixture auth rejected');
        } else if (line.startsWith('MAIL FROM:')) {
          envelope = { from: line.match(/<([^>]+)>/)[1], to: [] };
          reply(authenticated ? '250 2.1.0 sender accepted' : '530 5.7.0 authentication required');
        } else if (line.startsWith('RCPT TO:')) {
          if (rejection) {
            reply(rejection);
          } else {
            envelope.to.push(line.match(/<([^>]+)>/)[1]);
            reply('250 2.1.5 recipient accepted');
          }
        } else if (line === 'DATA') {
          data = [];
          reply('354 End with a single dot');
        } else if (line === 'QUIT') {
          socket.end('221 2.0.0 closing\r\n');
        } else {
          reply('500 5.5.1 unsupported fixture command');
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { messages, port: server.address().port, rejectWith: value => { rejection = value; } };
}

function decodeQuotedPrintable(value) {
  return Buffer.from(value.replace(/=\r\n/g, '').replace(/=([\da-f]{2})/gi,
    (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1').toString('utf8');
}

test('real API and cron SMTP preserve envelope/content and propagate recipient rejection', { timeout: 15000 }, async t => {
  const smtp = await localSmtp(t);
  // Explicit local-only configuration: never load .env or inherit live SMTP credentials.
  const env = {
    SMTP_ADDRESS: '127.0.0.1', SMTP_PORT: String(smtp.port),
    SMTP_USERNAME: 'fixture', SMTP_PASSWORD: 'fixture-password',
    SMTP_ENABLE_STARTTLS_AUTO: 'false',
    MAILER_SENDER_EMAIL: 'Fixture <mailer@example.test>',
    PORTAL_PUBLIC_URL: 'https://portal.example.test',
  };
  const link = 'https://portal.example.test/setup?a=1&b=2';
  const invitation = { to: 'invite@example.test', name: '<Fixture>', link, env };
  const reminder = { to: 'reminder@example.test', subject: 'Fixture reminder', text: 'Synthetic reminder content.' };

  const apiResult = await sendInvitation(invitation);
  const cronResult = await sendEmail(reminder, env);
  assert.equal(smtp.messages.length, 2);
  for (const [index, result, to] of [[0, apiResult, invitation.to], [1, cronResult, reminder.to]]) {
    const expected = { from: 'mailer@example.test', to: [to] };
    assert.deepEqual(result.envelope, expected);
    assert.deepEqual(smtp.messages[index].envelope, expected);
    assert.deepEqual(result.accepted, [to]);
    assert.deepEqual(result.rejected, []);
    assert.match(result.response, /^250 /);
    assert.match(smtp.messages[index].message, new RegExp(`^To: ${to.replaceAll('.', '\\.')}\r?$`, 'm'));
    assert.ok(smtp.messages[index].message.includes(`Message-ID: ${result.messageId}\r\n`));
    assert.doesNotMatch(smtp.messages[index].message, /fixture-password/);
  }
  assert.equal(classifySmtpResult(cronResult, reminder.to), 'accepted');
  const apiMessage = decodeQuotedPrintable(smtp.messages[0].message);
  assert.match(apiMessage, /^From: Portal Interno Ownerinc <mailer@example\.test>\r?$/m);
  assert.match(apiMessage, /^Subject: Seu convite para o Portal Interno Ownerinc\r?$/m);
  assert.match(apiMessage, /Content-Type: multipart\/alternative/);
  assert.match(apiMessage, /Content-Type: text\/plain/);
  assert.match(apiMessage, /Content-Type: text\/html/);
  assert.ok(apiMessage.includes(link));
  assert.ok(apiMessage.includes('href="https://portal.example.test/setup?a=1&amp;b=2"'));
  assert.ok(apiMessage.includes('Olá, &lt;Fixture&gt;!'));
  const cronMessage = smtp.messages[1].message;
  assert.match(cronMessage, /^From: Fixture <mailer@example\.test>\r?$/m);
  assert.match(cronMessage, /^Subject: Fixture reminder\r?$/m);
  assert.ok(cronMessage.includes(reminder.text));

  for (const [response, classification] of [['451 4.3.0 fixture temporary rejection', 'retryable'], ['550 5.1.1 fixture permanent rejection', 'permanent']]) {
    smtp.rejectWith(response);
    await assert.rejects(sendInvitation(invitation), { code: 'EENVELOPE', responseCode: Number(response.slice(0, 3)), command: 'RCPT TO' });
    await assert.rejects(sendEmail(reminder, env), error => {
      assert.equal(error.code, 'EENVELOPE');
      assert.equal(error.responseCode, Number(response.slice(0, 3)));
      assert.equal(error.command, 'RCPT TO');
      assert.equal(classifySmtpError(error, reminder.to), classification);
      return true;
    });
  }
  assert.equal(smtp.messages.length, 2, 'rejected recipients must not receive DATA');
});
