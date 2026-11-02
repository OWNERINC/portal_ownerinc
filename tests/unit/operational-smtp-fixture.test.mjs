import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readOperationalMessageId } from '../helpers/operational-smtp-message.mjs';

const cronRequire = createRequire(new URL('../../cron/package.json', import.meta.url));
const nodemailer = cronRequire('nodemailer');
const notificationId = '0123456789abcdef0123456789abcdef';
const messageId = `<own34-${notificationId}@monitor.ownerinc.invalid>`;
const otherId = `<own34-${'b'.repeat(32)}@monitor.ownerinc.invalid>`;
const message = (headers, body = 'synthetic body') => `${headers}\r\n\r\n${body}`;
const rejects = value => assert.throws(() => readOperationalMessageId(value), { message: 'invalid_operational_message_id' });

test('pinned Nodemailer stream transport reproduces the folded Message-ID without SMTP or sockets', async () => {
  assert.equal(cronRequire('nodemailer/package.json').version,
    cronRequire('./package-lock.json').packages['node_modules/nodemailer'].version);
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows',
    disableFileAccess: true, disableUrlAccess: true });
  try {
    const result = await transport.sendMail({ from: 'sender@example.test', to: 'monitor@example.test',
      subject: 'Portal Ownerinc: fixture regression', text: 'disk_monitor: failed / disk_critical', messageId });
    assert.ok(Buffer.isBuffer(result.message));
    const raw = result.message.toString('utf8');
    assert.match(raw.slice(0, raw.indexOf('\r\n\r\n')), /^Message-ID:\r\n[ \t]+<own34-/m,
      'exercise the actual folded header emitted by the installed pinned composer');
    assert.equal(readOperationalMessageId(raw), messageId);
    assert.equal(result.messageId, messageId);
    assert.match(raw, /^disk_monitor: failed \/ disk_critical\r?$/m);
  } finally { transport.close(); }
});

test('single Message-ID accepts ordinary headers and RFC SP/HTAB folding with canonical value', () => {
  for (const header of [`Message-ID: ${messageId}`, `message-id:${messageId}`, `mEsSaGe-Id:\t${messageId}\t`,
    `Message-ID:\r\n ${messageId}`, `Message-ID:\r\n\t${messageId}`, `Message-ID: \r\n \t${messageId}\r\n\t `]) {
    assert.equal(readOperationalMessageId(message(`Subject: synthetic\r\n\tfolded subject\r\n${header}\r\nMIME-Version: 1.0`)), messageId);
  }
});

test('exactly one Message-ID is required even for identical, differently cased or folded duplicate headers', () => {
  for (const duplicate of [`Message-ID: ${messageId}`, `message-id:\r\n\t${messageId}`, `MESSAGE-ID: ${otherId}`, 'Message-ID:']) {
    rejects(message(`Message-ID:\r\n ${messageId}\r\n${duplicate}`));
  }
  rejects(message(` ${messageId}\r\nMessage-ID: ${messageId}`));
  rejects(message(`Message-ID: ${messageId}\r\n Message-ID: ${otherId}`));
});

test('body or another field cannot counterfeit a missing or invalid Message-ID', () => {
  const counterfeit = `Message-ID: ${messageId}\r\nMessage-ID:\r\n\t${messageId}`;
  for (const headers of ['Subject: synthetic', `X-Message-ID: ${messageId}`, `Subject: Message-ID: ${messageId}`,
    `Subject: synthetic\r\n Message-ID: ${messageId}`, 'Message-ID: invalid']) {
    rejects(message(headers, counterfeit));
  }
  assert.equal(readOperationalMessageId(message(`Message-ID: ${messageId}`, `Message-ID: ${otherId}`)), messageId);
});

test('FIFO identity comparisons use exact canonical headers, ignoring misleading body IDs', () => {
  const messages = [message(`Message-ID:\r\n ${messageId}`, `Message-ID: ${otherId}`),
    message(`Message-ID:\r\n\t${otherId}`, `Message-ID: ${messageId}`)];
  assert.deepEqual(messages.map(readOperationalMessageId), [messageId, otherId]);
});

test('bare CR/LF, invalid folding and malformed header boundaries are rejected', () => {
  for (const headers of [`Message-ID:\n ${messageId}`, `Message-ID:\r ${messageId}`, `Message-ID:\r\r\n ${messageId}`,
    `Subject: broken\nMessage-ID: ${messageId}`, `Message-ID:\r\n\v${messageId}`, `Message-ID:\r\n\f${messageId}`,
    `Message-ID:\r\n\u00a0${messageId}`, `Message-ID : ${messageId}`, `Message-ID:\r\n${messageId}`]) rejects(message(headers));
  for (const value of [`Message-ID: ${messageId}`, `Message-ID: ${messageId}\n\nbody`,
    `Message-ID: ${messageId}\r\n\nbody`, `Message-ID: ${messageId}\n\r\nbody`, null, {}, [messageId]]) rejects(value);
});

test('Message-ID value must preserve exact own34 lowercase 32-hex syntax and domain', () => {
  for (const value of [messageId.replace(notificationId, 'a'.repeat(31)), messageId.replace(notificationId, 'a'.repeat(33)),
    messageId.replace(notificationId, 'g'.repeat(32)), messageId.replace(notificationId, 'A'.repeat(32)),
    messageId.replace('own34-', 'other-'), messageId.replace('monitor.ownerinc.invalid', 'attacker.test'),
    messageId.slice(1, -1), `${messageId} ${otherId}`, `${messageId} (comment)`, `\v${messageId}`, `${messageId}\f`,
    messageId.replace(notificationId, `${notificationId.slice(0, 16)}\r\n ${notificationId.slice(16)}`)]) {
    rejects(message(`Message-ID: ${value}`, `Message-ID: ${messageId}`));
  }
});
