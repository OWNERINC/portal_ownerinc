import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { deadline } from '../helpers/readiness-harness.mjs';

const require = createRequire(import.meta.url);
const { createRegistrationGate } = require('../../api/services/registration-gate');
const tick = () => new Promise(resolve => setImmediate(resolve));

function hold(gate) {
  let release;
  const done = gate(() => new Promise(resolve => { release = resolve; }));
  return { done, release: () => release() };
}

test('registration gate preserves two active operations, FIFO waiting and immediate legacy rejection', async () => {
  const gate = createRegistrationGate();
  const first = hold(gate), second = hold(gate);
  await tick();
  await assert.rejects(gate(async () => {}), { code: 'REGISTRATION_BUSY' });
  const calls = [];
  const third = gate(async () => { calls.push(3); }, { wait: true });
  const fourth = gate(async () => { calls.push(4); }, { wait: true });
  await tick();
  assert.deepEqual(calls, []);
  first.release();
  await deadline(Promise.all([third, fourth]), 'waiting registrations must drain');
  assert.deepEqual(calls, [3, 4]);
  second.release();
  await Promise.all([first.done, second.done]);
});

test('registration queue has a bounded size and timeout, with no late side effects', async () => {
  const gate = createRegistrationGate({ maxQueued: 1, waitMs: 20 });
  const first = hold(gate), second = hold(gate);
  await tick();
  let calls = 0;
  const timedOut = assert.rejects(gate(async () => { calls++; }, { wait: true }), { code: 'REGISTRATION_BUSY' });
  await assert.rejects(gate(async () => { calls++; }, { wait: true }), { code: 'REGISTRATION_BUSY' });
  await timedOut;
  first.release(); second.release();
  await Promise.all([first.done, second.done]);
  await gate(async () => { calls++; }, { wait: true });
  assert.equal(calls, 1);
});

test('disconnected waiters are removed without running and their queue place is reusable', async () => {
  const gate = createRegistrationGate({ maxQueued: 1 });
  const first = hold(gate), second = hold(gate);
  await tick();
  const controller = new AbortController();
  let calls = 0;
  const cancelled = assert.rejects(gate(async () => { calls++; }, { wait: true, signal: controller.signal }), { code: 'REGISTRATION_ABORTED' });
  controller.abort();
  await cancelled;
  const next = gate(async () => { calls++; }, { wait: true });
  first.release(); second.release();
  await deadline(Promise.all([first.done, second.done, next]), 'cancelled waiter must not retain a slot');
  await assert.rejects(gate(async () => { calls++; }, { wait: true, signal: controller.signal }), { code: 'REGISTRATION_ABORTED' });
  assert.equal(calls, 1);
});

test('failed operations release their slot for a waiting request', async () => {
  const gate = createRegistrationGate();
  let fail;
  const first = gate(() => new Promise((resolve, reject) => { fail = reject; }));
  const failed = assert.rejects(first, /synthetic failure/);
  const second = hold(gate);
  await tick();
  const waiting = gate(async () => 'received', { wait: true });
  fail(new Error('synthetic failure'));
  assert.equal(await deadline(waiting, 'failed operation must release its slot'), 'received');
  second.release();
  await Promise.all([failed, second.done]);
});

test('disconnect immediately after a queued slot is granted still prevents execution', async () => {
  const gate = createRegistrationGate();
  const first = hold(gate), second = hold(gate);
  await tick();
  const controller = new AbortController();
  let calls = 0;
  const cancelled = assert.rejects(gate(async () => { calls++; }, { wait: true, signal: controller.signal }), { code: 'REGISTRATION_ABORTED' });
  first.release();
  queueMicrotask(() => controller.abort());
  await cancelled;
  second.release();
  await Promise.all([first.done, second.done]);
  await gate(async () => { calls++; });
  assert.equal(calls, 1);
});
