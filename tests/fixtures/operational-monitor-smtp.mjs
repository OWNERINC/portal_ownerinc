// Deliberately outside the offline unit runner. This file binds sockets ONLY in
// the dedicated disposable hosted CI job, with a completely explicit SMTP env.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

assert.equal(process.platform, 'linux');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.OWN34_SMTP_FIXTURE, '1');
assert.notEqual(process.getuid(), 0);
const require = createRequire(import.meta.url);
const { runMonitor } = require('../../cron/operational-monitor');
const { openState } = require('../../cron/operational-monitor-state');
const { CHECKS, check } = require('../../cron/operational-contract');
const { sendOperationalAlertResult } = require('../../cron/sendOperationalAlert');
const certificateRoot = process.env.OWN34_FIXTURE_CERT_DIR;
assert.ok(certificateRoot && path.isAbsolute(certificateRoot));
const secureContext = createSecureContext({ key: await readFile(path.join(certificateRoot, 'key.pem')),
  cert: await readFile(path.join(certificateRoot, 'cert.pem')) });
const directory = await mkdtemp(path.join(tmpdir(), 'own34-ci-smtp-'));
await chmod(directory, 0o700);
const sockets = new Set(), messages = [];
let rejection = null, hang = false, useTls = false;
let tlsStarts = 0;
function track(socket) {
  sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
  socket.setTimeout(5000, () => socket.destroy());
}
async function disconnected() {
  let timer;
  try {
    await Promise.race([
      Promise.all([...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture_socket_not_closed')), 1500); }),
    ]);
    assert.equal(sockets.size, 0);
  } finally { clearTimeout(timer); }
}
const server = createServer(socket => {
  track(socket); socket.setEncoding('utf8');
  let buffer = '', data = null, authenticated = false, envelope = { to: [] };
  const reply = value => socket.write(`${value}\r\n`);
  reply('220 fixture.example.test ESMTP');
  const read = chunk => {
    buffer += chunk;
    assert.ok(buffer.length < 32768);
    let at;
    while ((at = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 2);
      if (data !== null) {
        if (line === '.') {
          if (!hang) { messages.push({ envelope, body: data.join('\r\n') }); reply('250 2.0.0 fixture accepted'); }
          data = null;
        } else data.push(line.replace(/^\.\./, '.'));
      } else if (/^(EHLO|HELO) /.test(line)) reply(useTls ? '250-fixture.example.test\r\n250-STARTTLS\r\n250 AUTH PLAIN' : '250-fixture.example.test\r\n250 AUTH PLAIN');
      else if (line === 'STARTTLS') {
        tlsStarts++;
        reply('220 Ready to start TLS'); socket.removeListener('data', read);
        const wrapped = new TLSSocket(socket, { isServer: true, secureContext }); track(wrapped);
        // A self-signed certificate MUST be refused before any AUTH or message.
        wrapped.on('data', () => assert.fail('TLS verification bypassed'));
        return;
      } else if (line.startsWith('AUTH PLAIN ')) {
        authenticated = Buffer.from(line.slice(11), 'base64').toString() === '\0fixture\0fixture-password';
        reply(authenticated ? '235 2.7.0 authenticated' : '535 denied');
      } else if (line.startsWith('MAIL FROM:')) {
        envelope = { from: line.match(/<([^>]+)>/)[1], to: [] };
        reply(authenticated ? '250 sender accepted' : '530 authentication required');
      } else if (line.startsWith('RCPT TO:')) {
        if (rejection) reply(rejection);
        else { envelope.to.push(line.match(/<([^>]+)>/)[1]); reply('250 recipient accepted'); }
      } else if (line === 'DATA') { data = []; reply('354 Send message'); }
      else if (line === 'QUIT') socket.end('221 closing\r\n');
      else reply('500 unsupported');
    }
  };
  socket.on('data', read);
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const env = { SMTP_ADDRESS: '127.0.0.1', SMTP_PORT: String(server.address().port), SMTP_USERNAME: 'fixture',
    SMTP_PASSWORD: 'fixture-password', MAILER_SENDER_EMAIL: 'sender@example.test', OPERATIONAL_ALERT_EMAIL: 'monitor@example.test' };
  let now = Date.now(), bad = true, backupBad = false, diskBad = false;
  const generation = 'a'.repeat(32);
  const collect = async () => ({ checks: CHECKS.map(id => id === 'disk_monitor' ? check(id, diskBad ? 'disk_critical' : 'ready', diskBad ? 91 : 10)
    : check(id, backupBad && id === 'backup_attempt' ? 'backup_failed' : bad && id === 'application' ? 'application_unavailable' : 'ready')),
    sources: { api: { observedAt: now, generation }, host: { observedAt: now, generation } } });
  const cycle = async () => { now += 60000; return runMonitor({ store: await openState(directory), env, now, collect }); };
  await cycle(); await cycle(); await cycle();
  assert.equal(messages.length, 1, 'initial failure only once across fresh store instances');
  bad = false; await cycle(); await cycle();
  assert.equal(messages.length, 2, 'one recovery');
  for (const message of messages) {
    assert.deepEqual(message.envelope, { from: 'sender@example.test', to: ['monitor@example.test'] });
    assert.match(message.body, /Message-ID: <own34-[a-f0-9]{32}@monitor\.ownerinc\.invalid>/i);
    assert.doesNotMatch(message.body, /fixture-password/);
  }
  rejection = '451 temporary'; bad = true; await cycle(); await cycle();
  const pending = await (await openState(directory)).load();
  assert.ok(pending.outbox); assert.equal(messages.length, 2);
  const pendingId = pending.outbox.id;
  rejection = null; await cycle();
  assert.equal(messages.length, 3); assert.ok(messages[2].body.includes(pendingId));
  // Keep A permanently rejected/backing off while B becomes critical and then
  // recovers. Every cycle reopens the actual file store, as after a restart.
  rejection = '550 denied'; backupBad = true; await cycle();
  diskBad = true; await cycle();
  diskBad = false; await cycle(); await cycle();
  const backlog = await (await openState(directory)).load();
  assert.equal(messages.length, 3);
  assert.deepEqual(backlog.pending.map(item => item.changes), [
    [{ id: 'disk_monitor', reason: 'disk_critical' }], [{ id: 'disk_monitor', reason: null }],
  ]);
  const retainedIds = [backlog.outbox.id, ...backlog.pending.map(item => item.id)];
  rejection = null; now = backlog.outbox.nextAt - 60000;
  await cycle(); await cycle(); await cycle(); await cycle();
  assert.equal(messages.length, 6, 'A, then B incident and recovery, with no ordinary duplicate');
  assert.deepEqual(messages.slice(3).map(message => /Message-ID: <own34-([a-f0-9]{32})@monitor\.ownerinc\.invalid>/i.exec(message.body)?.[1]), retainedIds);
  assert.match(messages[4].body, /^disk_monitor: failed \/ disk_critical\r?$/m);
  assert.match(messages[5].body, /^disk_monitor: recovered\r?$/m);
  const drained = await (await openState(directory)).load();
  assert.equal(drained.outbox, null); assert.deepEqual(drained.pending, []);
  rejection = '550 denied';
  assert.equal((await sendOperationalAlertResult({ subject: 'fixture rejection', text: 'synthetic' }, env)).status, 'permanent');
  assert.equal(messages.length, 6);
  rejection = null; hang = true;
  const timeout = await sendOperationalAlertResult({ subject: 'fixture timeout', text: 'synthetic' }, env, { timeoutMs: 150 });
  assert.equal(timeout.status, 'unknown'); assert.equal(timeout.reason, 'smtp_timeout');
  await disconnected();
  hang = false; useTls = true;
  assert.notEqual((await sendOperationalAlertResult({ subject: 'fixture TLS', text: 'synthetic' }, env)).status, 'accepted');
  assert.equal(tlsStarts, 1);
  await disconnected();
  assert.equal(messages.length, 6);
  console.log('OWN34 native SMTP fixture: failure/recovery/FIFO/dedup/rejection/timeout/TLS passed (synthetic only).');
} finally {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
