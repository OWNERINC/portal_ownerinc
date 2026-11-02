import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { openState, withStateLock, validateState } = require('../../cron/operational-monitor-state');
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(process.platform === 'win32' ? path.join(tmpdir(), 'opencode') : tmpdir(), 'own34-state-')));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await openState(directory) };
}
test('state is durable and strict across new store instances', async t => {
  const { directory, store } = await fixture(t);
  const value = await store.load();
  value.updatedAt = 100;
  value.checks.application = { candidate: 'application_unavailable', count: 2, badCount: 2,
    current: 'application_unavailable', delivered: 'application_unavailable' };
  await store.save(value);
  assert.deepEqual(await (await openState(directory)).load(), value);
  const raw = await readFile(path.join(directory, 'state.json'), 'utf8');
  assert.equal(raw, `${JSON.stringify(value)}\n`);
  for (const bad of [{ ...value, token: 'canary' }, { ...value, version: 3 },
    { ...value, checks: { unknown: value.checks.application } }, { ...value, outbox: { id: 'attacker' } }]) {
    assert.throws(() => validateState(bad), /monitor_state_unavailable/);
  }
});
test('corrupt existing state is not reset and prevents persistence', async t => {
  const { directory, store } = await fixture(t);
  const fresh = await store.load();
  await writeFile(path.join(directory, 'state.json'), 'private-canary invalid', { mode: 0o600 });
  await assert.rejects(store.load(), { message: 'monitor_state_unavailable' });
  await assert.rejects(store.save(fresh), /monitor_state_unavailable/);
  assert.equal(await readFile(path.join(directory, 'state.json'), 'utf8'), 'private-canary invalid');
});
test('reason codes are primitive strings throughout checks, active outbox and pending transitions', async t => {
  const { store } = await fixture(t);
  const value = await store.load(); value.updatedAt = 100;
  value.checks.application = { candidate: null, count: 2, badCount: 0, current: null, delivered: null };
  value.outbox = { id: 'a'.repeat(32), createdAt: 10, nextAt: 10, attempts: 1, inflight: false,
    changes: [{ id: 'application', reason: 'application_unavailable' }] };
  value.pending = [{ id: 'b'.repeat(32), createdAt: 20, nextAt: 20, attempts: 0, inflight: false,
    changes: [{ id: 'application', reason: null }] }];
  validateState(value);
  for (const reason of [['application_unavailable'], new String('application_unavailable'), {}, 1, true]) {
    for (const field of ['candidate', 'current', 'delivered', 'outbox', 'pending']) {
      const malformed = structuredClone(value);
      if (field === 'outbox') malformed.outbox.changes[0].reason = reason;
      else if (field === 'pending') malformed.pending[0].changes[0].reason = reason;
      else malformed.checks.application[field] = reason;
      assert.throws(() => validateState(malformed), { message: 'monitor_state_unavailable' });
    }
  }
  const lost = structuredClone(value); lost.pending = [];
  assert.throws(() => validateState(lost), /monitor_state_unavailable/, 'queue must account for the current state');
});
test('v1 upgrade preserves in-flight identity and reconstructs remaining undelivered transitions', async t => {
  const { directory, store } = await fixture(t);
  const old = { version: 1, updatedAt: 100, sources: {}, checks: {
    application: { candidate: 'application_unavailable', count: 2, current: 'application_unavailable', delivered: null },
    backup_attempt: { candidate: 'backup_failed', count: 1, current: 'backup_failed', delivered: null },
  }, outbox: { id: 'a'.repeat(32), createdAt: 10, nextAt: 1000, attempts: 1, inflight: true,
    changes: [{ id: 'application', reason: 'application_unavailable' }] } };
  await writeFile(path.join(directory, 'state.json'), `${JSON.stringify(old)}\n`, { mode: 0o600 });
  const upgraded = await store.load();
  assert.equal(upgraded.version, 2); assert.deepEqual(upgraded.outbox, old.outbox);
  assert.deepEqual(upgraded.pending[0].changes, [{ id: 'backup_attempt', reason: 'backup_failed' }]);
  assert.equal(upgraded.checks.backup_attempt.badCount, 1);
  await store.save(upgraded);
  assert.deepEqual(await (await openState(directory)).load(), upgraded);
  for (const target of ['candidate', 'current', 'delivered', 'outbox']) {
    const malformed = structuredClone(old);
    if (target === 'outbox') malformed.outbox.changes[0].reason = ['application_unavailable'];
    else malformed.checks.application[target] = ['application_unavailable'];
    await writeFile(path.join(directory, 'state.json'), `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
    await assert.rejects(store.load(), { message: 'monitor_state_unavailable' });
  }
});
test('duplicate private JSON keys are rejected rather than interpreted as new incident state', async t => {
  const { directory, store } = await fixture(t);
  await writeFile(path.join(directory, 'state.json'), '{"version":2,"version":1,"updatedAt":0,"checks":{},"sources":{},"outbox":null}\n', { mode: 0o600 });
  await assert.rejects(store.load(), { message: 'monitor_state_unavailable' });
});
test('exclusive local runner lock rejects overlap and releases after failure', async t => {
  const { directory } = await fixture(t);
  await withStateLock(directory, async () => {
    await assert.rejects(withStateLock(directory, async () => assert.fail('overlap')));
  });
  await assert.rejects(withStateLock(directory, async () => { throw new Error('fixture'); }), /fixture/);
  await withStateLock(directory, async () => {});
});
test('native POSIX state permissions and symlink rejection', { skip: process.platform === 'win32' }, async t => {
  const { directory, store } = await fixture(t);
  const other = path.join(directory, 'other');
  await writeFile(other, '{}', { mode: 0o600 });
  await symlink(other, path.join(directory, 'state.json'));
  await assert.rejects(store.load(), /monitor_state_unavailable/);
  await rm(path.join(directory, 'state.json'));
  await chmod(directory, 0o777);
  await assert.rejects(openState(directory), /monitor_state_unavailable/);
  await chmod(directory, 0o700);
});
