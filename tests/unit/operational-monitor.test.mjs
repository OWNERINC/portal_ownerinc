import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { openState, MAX_PENDING } = require('../../cron/operational-monitor-state');
const { runMonitor, collectObservations, boundedFetch } = require('../../cron/operational-monitor');
const { CHECKS, API_CHECKS, HOST_CHECKS, check, validateObservation } = require('../../cron/operational-contract');
const { sendOperationalAlertResult } = require('../../cron/sendOperationalAlert');
const epoch = 1800000000000;
const generation = 'a'.repeat(32);
const healthy = () => CHECKS.map(id => check(id, 'ready'));
const sample = (checks, now) => ({ checks, sources: { api: { observedAt: now, generation }, host: { observedAt: now, generation } } });
const env = { OPERATIONAL_ALERT_EMAIL: 'monitor@example.test', MAILER_SENDER_EMAIL: 'sender@example.test' };
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(process.platform === 'win32' ? path.join(tmpdir(), 'opencode') : tmpdir(), 'own34-runner-'))); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await openState(directory) };
}
test('real file outbox deduplicates DB outage and recovery across restarts', async t => {
  const { directory, store } = await fixture(t); const messages = [];
  const send = async message => { messages.push(message); return { status: 'accepted' }; };
  const checks = healthy().map(row => ['application', 'portal_database'].includes(row.id) ? check(row.id, 'application_unavailable') : row);
  for (let index = 0; index < 3; index++) await runMonitor({ store: index ? await openState(directory) : store, send,
    now: epoch + index * 60000, collect: async () => sample(checks, epoch + index * 60000) });
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /portal_database: unknown \/ application_unavailable/);
  for (let index = 3; index < 5; index++) await runMonitor({ store: await openState(directory), send,
    now: epoch + index * 60000, collect: async () => sample(healthy(), epoch + index * 60000) });
  assert.equal(messages.length, 2); assert.match(messages[1].subject, /recuperacao/);
  assert.equal((await store.load()).outbox, null);
});
test('temporary/permanent/unconfirmed delivery persists and respects backoff', async t => {
  const { store } = await fixture(t); let sends = 0; let status = 'retryable';
  const checks = healthy().map(row => row.id === 'backup_attempt' ? check(row.id, 'backup_failed') : row);
  const cycle = time => runMonitor({ store, now: time, collect: async () => sample(checks, time),
    send: async () => { sends++; return { status }; } });
  await cycle(epoch); assert.equal(sends, 1);
  await cycle(epoch + 1000); assert.equal(sends, 1);
  status = 'permanent'; await cycle(epoch + 60000); assert.equal(sends, 2);
  assert.equal((await store.load()).outbox.nextAt, epoch + 3660000);
  status = 'accepted'; await cycle(epoch + 3660000); assert.equal(sends, 3);
  await cycle(epoch + 3720000); assert.equal(sends, 3);
});
test('pending A preserves B critical and recovery in order across file-store restarts', async t => {
  const { directory } = await fixture(t);
  const attempts = [], accepted = [];
  let status = 'permanent';
  const cycle = async (offset, critical = false) => {
    const now = epoch + offset;
    const checks = healthy().map(row => row.id === 'backup_attempt' ? check(row.id, 'backup_failed')
      : row.id === 'disk_monitor' ? check(row.id, critical ? 'disk_critical' : 'ready', critical ? 91 : 10) : row);
    return runMonitor({ store: await openState(directory), now, collect: async () => sample(checks, now), send: async message => {
      attempts.push(message.notificationId); if (status === 'accepted') accepted.push(message); return { status };
    } });
  };
  await cycle(0);
  const a = (await (await openState(directory)).load()).outbox.id;
  await cycle(60000, true);
  await cycle(120000);
  await cycle(180000);
  const pending = await (await openState(directory)).load();
  assert.equal(attempts.length, 1, 'A is backing off while B fails and recovers');
  assert.equal(pending.checks.disk_monitor.current, null);
  assert.equal(pending.checks.disk_monitor.delivered, null);
  assert.deepEqual(pending.pending.map(item => item.changes), [
    [{ id: 'disk_monitor', reason: 'disk_critical' }], [{ id: 'disk_monitor', reason: null }],
  ]);
  const ids = [a, ...pending.pending.map(item => item.id)];
  status = 'accepted';
  assert.equal((await cycle(3600000)).pending, true);
  assert.equal((await cycle(3660000)).pending, true);
  assert.equal((await cycle(3720000)).pending, false);
  await cycle(3780000);
  assert.deepEqual(accepted.map(message => message.notificationId), ids);
  assert.deepEqual(attempts, [a, ...ids]);
  assert.match(accepted[1].text, /^disk_monitor: failed \/ disk_critical$/m);
  assert.match(accepted[2].text, /^disk_monitor: recovered$/m);
  const final = await (await openState(directory)).load();
  assert.equal(final.outbox, null); assert.deepEqual(final.pending, []);
});
test('full transition queue persists an explicit fail-closed latch without advancing or dropping history', async t => {
  const { directory, store } = await fixture(t);
  const checks = healthy().map(row => row.id === 'backup_attempt' ? check(row.id, 'backup_failed') : row);
  await runMonitor({ store, now: epoch, collect: async () => sample(checks, epoch), send: async () => ({ status: 'permanent' }) });
  const full = await store.load();
  full.pending = Array.from({ length: MAX_PENDING }, (_, index) => ({
    id: (index + 1).toString(16).padStart(32, '0'), createdAt: epoch + index + 1, nextAt: epoch + index + 1,
    attempts: 0, inflight: false, changes: [{ id: 'disk_monitor', reason: index % 2 ? null : 'disk_critical' }],
  }));
  full.updatedAt = epoch + MAX_PENDING;
  await store.save(full);
  const incoming = checks.map(row => row.id === 'disk_monitor' ? check(row.id, 'disk_critical', 91) : row);
  await assert.rejects(runMonitor({ store, now: epoch + 60000, collect: async () => sample(incoming, epoch + 60000),
    send: () => assert.fail('overflow must not send') }), { message: 'monitor_queue_overflow' });
  assert.deepEqual(await store.load(), { ...full, queueOverflow: true });
  await assert.rejects(runMonitor({ store: await openState(directory), now: epoch + 120000,
    collect: () => assert.fail('latched overflow must not consume new observations'),
    send: () => assert.fail('latched overflow must not send') }), { message: 'monitor_queue_overflow' });
});
test('continuous alternating bad reasons qualify on the second sample; only two fresh clean samples recover', async t => {
  for (const reasons of [['sample_invalid', 'database_unavailable'], ['database_unavailable', 'sample_invalid']]) {
    const { directory } = await fixture(t); const messages = []; let offset = 0;
    const cycle = async reason => {
      const now = epoch + offset++ * 60000;
      const checks = healthy().map(row => row.id === 'legacy_feed' ? check(row.id, reason) : row);
      await runMonitor({ store: await openState(directory), now, collect: async () => sample(checks, now),
        send: async message => { messages.push(message); return { status: 'accepted' }; } });
    };
    await cycle(reasons[0]); assert.equal(messages.length, 0);
    await cycle(reasons[1]); assert.equal(messages.length, 1);
    for (let index = 0; index < 6; index++) await cycle(reasons[index % 2]);
    assert.equal(messages.length, 1, 'reason alternation does not suppress the incident or duplicate its delivery');
    await cycle('ready'); await cycle('database_unavailable');
    assert.notEqual((await (await openState(directory)).load()).checks.legacy_feed.current, null);
    assert.equal(messages.length, 1, 'unknown interrupts clean qualification and cannot recover the check');
    await cycle('ready'); assert.equal(messages.length, 1);
    await cycle('ready'); assert.equal(messages.length, 2);
    assert.match(messages[1].text, /^legacy_feed: recovered$/m);
  }
});
test('accepted-before-persist crash keeps stable notification ID and delays ambiguous retry', async t => {
  const { store } = await fixture(t);
  let saves = 0, sent;
  const failingStore = { load: store.load, save: async value => { if (++saves === 3) throw new Error('fsync_failure'); await store.save(value); } };
  const checks = healthy().map(row => row.id === 'backup_attempt' ? check(row.id, 'backup_failed') : row);
  await assert.rejects(runMonitor({ store: failingStore, now: epoch, collect: async () => sample(checks, epoch),
    send: async message => { sent = message.notificationId; return { status: 'accepted' }; } }), /fsync/);
  assert.equal((await store.load()).outbox.inflight, true);
  await runMonitor({ store, now: epoch + 60000, collect: async () => sample(checks, epoch + 60000), send: () => assert.fail('ambiguous immediate resend') });
  assert.equal((await store.load()).outbox.id, sent);
  assert.equal((await store.load()).outbox.nextAt, epoch + 960000);
});
test('unknown/replayed observations do not recover a failed check; critical legacy write stays latched', async t => {
  const { store } = await fixture(t); const messages = [];
  const send = async message => { messages.push(message); return { status: 'accepted' }; };
  const initial = healthy().map(row => row.id === 'legacy_writes' ? check(row.id, 'legacy_write_forbidden') : row);
  await runMonitor({ store, send, now: epoch, collect: async () => sample(initial, epoch) });
  for (let index = 1; index <= 2; index++) await runMonitor({ store, send, now: epoch + index * 60000,
    collect: async () => sample(healthy(), epoch) });
  assert.equal((await store.load()).checks.legacy_writes.current, 'legacy_write_forbidden');
  assert.equal((await store.load()).checks.application.current, 'observation_stale');
  assert.ok(messages.every(message => !message.text.includes('legacy_writes: recovered')));
});
test('disk hysteresis requires two readings below75 and failed state persistence sends nothing', async t => {
  const { store } = await fixture(t); const send = async () => ({ status: 'accepted' });
  for (const [index, percentage] of [91, 77, 74, 74].entries()) {
    const checks = healthy().map(row => row.id === 'disk_monitor' ? check(row.id, percentage >= 90 ? 'disk_critical' : 'ready', percentage) : row);
    await runMonitor({ store, send, now: epoch + index * 60000, collect: async () => sample(checks, epoch + index * 60000) });
    if (index < 3) assert.notEqual((await store.load()).checks.disk_monitor.current, null);
  }
  assert.equal((await store.load()).checks.disk_monitor.current, null);
  await assert.rejects(runMonitor({ store: { load: store.load, save: async () => { throw new Error('full'); } }, now: epoch + 300000,
    collect: async () => sample(healthy(), epoch + 300000), send: () => assert.fail('untracked email') }), /full/);
});
test('collector failure still yields mailer observations and API failure is not DB diagnosis', async () => {
  const result = await collectObservations({ origin: 'https://portal.example.test', token: 'canary' }, {
    now: epoch, readHost: async () => { throw new Error('private host path'); },
    fetchImpl: async () => { throw new Error('private db password'); },
  });
  assert.equal(result.checks.length, CHECKS.length);
  assert.equal(result.checks.find(row => row.id === 'host_observer').status, 'unknown');
  assert.equal(result.checks.find(row => row.id === 'portal_database').reason, 'application_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /password|canary|private host/);
});
test('observation schemas reject missing, extra, stale, future and unknown checks', () => {
  const value = { schemaVersion: 1, kind: 'portal-operational-observation-v1', source: 'api', generation,
    observedAt: epoch, expiresAt: epoch + 120000, checks: API_CHECKS.map(id => check(id, 'ready')) };
  assert.equal(validateObservation(value, 'api', epoch), value);
  for (const bad of [{ ...value, schemaVersion: 3 }, { ...value, authenticated: true }, { ...value, observedAt: epoch + 6000 },
    { ...value, expiresAt: epoch }, { ...value, checks: value.checks.slice(1) },
    { ...value, checks: [...value.checks.slice(1), check('private_arbitrary', 'ready')] }]) assert.throws(() => validateObservation(bad, 'api', epoch));
});
test('observation reasons must be primitive codes, never coercible arrays or boxed strings', () => {
  for (const source of ['api', 'host']) {
    const ids = source === 'api' ? API_CHECKS : HOST_CHECKS;
    const value = { schemaVersion: 1, kind: 'portal-operational-observation-v1', source, generation,
      observedAt: epoch, expiresAt: epoch + 120000, checks: ids.map(id => check(id, 'ready')) };
    for (const reason of [['ready'], new String('ready'), {}, 1, true, null]) {
      const malformed = { ...value, checks: [{ ...value.checks[0], reason }, ...value.checks.slice(1)] };
      assert.throws(() => validateObservation(malformed, source, epoch), /observation_invalid/);
    }
  }
});
test('only authenticated supported hold probes the fixed public route, and redirects never count as held', async () => {
  for (const [reason, status, expected, publicCalls] of [
    ['planned_hold', 404, 'planned_hold', 1], ['planned_hold', 302, 'editorial_unavailable', 1],
    ['unsupported_contract', 200, 'unsupported_contract', 0],
  ]) {
    const envelope = (source, ids) => ({ schemaVersion: 1, kind: 'portal-operational-observation-v1', source, generation,
      observedAt: epoch, expiresAt: epoch + 120000, checks: ids.map(id => check(id, id === 'host_state' ? reason : 'ready')) });
    const calls = [];
    const result = await collectObservations({ origin: 'https://portal.example.test', token: 'fixture' }, { now: epoch,
      readHost: async () => envelope('host', HOST_CHECKS), fetchImpl: async (url, options) => {
        calls.push(url); assert.equal(options.redirect, 'manual');
        if (url.endsWith('/api/operational/observe')) return new Response(JSON.stringify(envelope('api', API_CHECKS)),
          { status: 200, headers: { 'content-type': 'application/json' } });
        assert.equal(url, 'https://portal.example.test/editorial');
        assert.equal(options.headers, undefined);
        return new Response('', { status, headers: { location: 'https://untrusted.example.test' } });
      } });
    assert.equal(result.checks.find(row => row.id === 'public_editorial').reason, expected);
    assert.equal(calls.length, 1 + publicCalls);
  }
});
test('HTTP response budget, redirect refusal and cancellation are bounded without sockets', async () => {
  let cancelled = false;
  const huge = { status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; },
  }) };
  await assert.rejects(boundedFetch('https://fixture.test', {}, async () => huge), /observation_invalid/);
  assert.equal(cancelled, true);
  await assert.rejects(boundedFetch('https://fixture.test', {}, async () => new Promise(() => {}), { timeoutMs: 5 }), /application_unavailable/);
  await assert.rejects(boundedFetch('https://fixture.test', {}, async () => ({ status: 302, headers: new Headers(), body: null })), /application_unavailable/);
});
test('SMTP requires exact recipient and final2xx, rejects contradictions and sanitizes exceptions', async () => {
  const message = { subject: 'failure', text: 'bounded', notificationId: 'b'.repeat(32) };
  for (const [result, expected] of [
    [{ accepted: [env.OPERATIONAL_ALERT_EMAIL], rejected: [], response: '250 queued' }, 'accepted'],
    [{ accepted: [env.OPERATIONAL_ALERT_EMAIL], rejected: [] }, 'unknown'],
    [{ accepted: [env.OPERATIONAL_ALERT_EMAIL], rejected: [], responseCode: 250 }, 'unknown'],
    [{ accepted: [env.OPERATIONAL_ALERT_EMAIL], rejected: [], responseCode: 250, response: '550 denied' }, 'unknown'],
    [{ accepted: ['wrong@example.test'], rejected: [], response: '250 queued' }, 'unknown'],
    [{ accepted: [env.OPERATIONAL_ALERT_EMAIL], rejected: [], response: '451 retry' }, 'unknown'],
    [{ accepted: [env.OPERATIONAL_ALERT_EMAIL], rejected: [env.OPERATIONAL_ALERT_EMAIL], response: '250 queued' }, 'unknown'],
    [{ accepted: [], rejected: [env.OPERATIONAL_ALERT_EMAIL], response: '550 denied' }, 'permanent'],
  ]) {
    let closed = 0;
    const outcome = await sendOperationalAlertResult(message, env, { getTransport: () => ({ sendMail: async () => result, close: () => { closed++; } }) });
    assert.equal(outcome.status, expected); assert.equal(closed, 1);
  }
  const result = await sendOperationalAlertResult(message, env, { getTransport: () => ({
    sendMail: async () => { throw Object.assign(new Error('password-canary'), { code: 'ETIMEDOUT' }); }, close() {},
  }) });
  assert.equal(result.status, 'retryable'); assert.doesNotMatch(JSON.stringify(result), /canary/);
});
test('overall SMTP timeout destroys transport and never marks delivery accepted', async () => {
  let closed = 0;
  const result = await sendOperationalAlertResult({ subject: 'failure', text: 'bounded' }, env, {
    timeoutMs: 5, getTransport: () => ({ sendMail: () => new Promise(() => {}), close() { closed++; } }),
  });
  assert.deepEqual(result, { status: 'unknown', reason: 'smtp_timeout' }); assert.ok(closed >= 1);
});
