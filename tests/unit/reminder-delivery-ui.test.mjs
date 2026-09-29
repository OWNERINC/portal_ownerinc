import assert from 'node:assert/strict';
import test from 'node:test';
import { createMountedHarness, drain } from '../helpers/cms-harness.mjs';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const cron = overrides => ({
  heartbeat_at: new Date().toISOString(), execution_status: 'completed',
  delivery_status: 'sent', failed_count: 0, last_success_at: new Date().toISOString(), ...overrides,
});
const delivery = title => ({
  reminder_id: UUID, reminder_title: title, recipient_name: 'Pessoa de teste',
  recipient_email: 'test@example.test', scheduled_date: '2026-09-29',
  status: 'sent', channel: 'email', attempt_count: 1,
});
const rows = (title = 'Entrega atual', total = 1) => ({ data: [delivery(title)], total });
const historyText = h => h.node('deliveries-tbody').textContent;
const health = h => h.node('cron-health');
const historyRequests = h => h.matching('/deliveries?');
const healthRequests = h => h.matching('/cron-status');
const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);

async function setup(t, options) {
  const h = await createMountedHarness('reminders', options);
  t.after(() => h.page.dispose());
  h.requests.find(request => request.path.startsWith('/api/reminders?')).resolve({ data: [], total: 0 });
  await drain();
  return h;
}

test('cron health renders while the independent delivery history is stalled', async t => {
  const h = await setup(t);
  healthRequests(h)[0].resolve(cron());
  await drain();
  assert.match(health(h).textContent, /^Cron ativo/);
  assert.equal(health(h).className, 'badge badge-green');
  assert.match(health(h).title, /Execução: completed/);
  assert.equal(historyText(h), 'Carregando histórico…');
  historyRequests(h)[0].resolve(rows());
  await drain();
  assert.match(historyText(h), /Entrega atual/);
});

test('history failure does not mislabel a successful cron consultation', async t => {
  const h = await setup(t);
  healthRequests(h)[0].resolve(cron());
  historyRequests(h)[0].reject(Object.assign(new Error('query rejected'), { status: 400 }));
  await drain();
  assert.match(historyText(h), /Não foi possível carregar o histórico/);
  assert.match(health(h).textContent, /^Cron ativo/);
  assert.equal(health(h).className, 'badge badge-green');
  assert.equal(h.node('deliveries-pagination').children.length, 0);
  const healthBefore = { text: health(h).textContent, title: health(h).title };
  button(h.node('deliveries-tbody'), 'Tentar novamente').click();
  assert.equal(healthRequests(h).length, 1, 'history retry never restarts health');
  historyRequests(h)[1].resolve(rows('Histórico recuperado'));
  await drain();
  assert.match(historyText(h), /Histórico recuperado/);
  assert.deepEqual({ text: health(h).textContent, title: health(h).title }, healthBefore);
});

test('cron consultation failure leaves successful history intact and retries only health', async t => {
  const h = await setup(t);
  historyRequests(h)[0].resolve(rows());
  await drain();
  assert.match(historyText(h), /Entrega atual/, 'history does not wait for health');
  healthRequests(h)[0].reject(new Error('offline'));
  await drain();
  assert.match(health(h).textContent, /Não foi possível consultar a saúde do cron/);
  assert.equal(health(h).className, 'badge badge-gray');
  assert.match(health(h).title, /execução não foi confirmado/);
  const retry = button(h.node('cron-health-actions'), 'Consultar cron novamente');
  retry.click(); retry.click();
  assert.equal(healthRequests(h).length, 2, 'detached retry cannot start another request');
  assert.equal(historyRequests(h).length, 1);
  assert.equal(health(h).title, '');
  healthRequests(h)[1].resolve(cron());
  await drain();
  assert.match(health(h).textContent, /^Cron ativo/);
  assert.match(historyText(h), /Entrega atual/);
});

test('independent retries can overlap after both consultations fail without resetting each other', async t => {
  const h = await setup(t);
  h.latest('/deliveries?').reject(new Error('history offline'));
  h.latest('/cron-status').reject(new Error('health offline'));
  await drain();
  button(h.node('deliveries-tbody'), 'Tentar novamente').click();
  assert.match(health(h).textContent, /Não foi possível consultar/);
  button(h.node('cron-health-actions'), 'Consultar cron novamente').click();
  assert.equal(historyRequests(h).length, 2);
  assert.equal(healthRequests(h).length, 2);
  h.latest('/cron-status').resolve(cron());
  await drain();
  assert.match(health(h).textContent, /^Cron ativo/);
  assert.equal(historyText(h), 'Carregando histórico…');
  h.latest('/deliveries?').resolve(rows('Histórico recuperado'));
  await drain();
  assert.match(historyText(h), /Histórico recuperado/);
  assert.match(health(h).textContent, /^Cron ativo/);
});

test('local filter validation rejects technical IDs, bad civil dates and inverted ranges', async t => {
  const cases = [
    ['delivery-reminder', 'inexistente'],
    ['delivery-reminder', '550e8400-e29b-71d4-a716-446655440000'],
    ['delivery-reminder', '550e8400-e29b-41d4-1716-446655440000'],
    ['delivery-user', 'user@example.test'],
    ['delivery-user', 'a'.repeat(129)],
    ['delivery-user', 'nome sobrenome'],
    ['delivery-from', '2026-02-29'],
    ['delivery-to', '2026-04-31'],
    ['delivery-from', '2026-13-01'],
    ['delivery-to', '29/09/2026'],
    ['delivery-from', '2026-09-30', { 'delivery-to': '2026-09-29' }],
  ];
  for (const [field, value, other = {}] of cases) await t.test(`${field}: ${value}`, async t => {
    const h = await setup(t);
    h.node(field).value = value;
    for (const [id, input] of Object.entries(other)) h.node(id).value = input;
    h.submit('delivery-filters');
    assert.equal(historyRequests(h).length, 1, 'invalid filters never reach the history endpoint');
    assert.equal(h.node(field).getAttribute('aria-invalid'), 'true');
    assert.ok(h.node(field).getAttribute('aria-describedby').split(' ').includes(`${field}-error`));
    assert.equal(h.node(`${field}-error`).hidden, false);
    assert.ok(h.node(`${field}-error`).textContent.length > 0);
    assert.equal(h.doc.activeElement, h.node(field));
    assert.match(historyText(h), /Revise os filtros/);
    assert.equal(h.node('deliveries-pagination').children.length, 0);
    healthRequests(h).at(-1).resolve(cron());
    await drain();
    assert.match(health(h).textContent, /^Cron ativo/, 'health remains independently available');
  });
});

test('incomplete native date input is not silently treated as an empty date', async t => {
  const h = await setup(t);
  h.node('delivery-from').validity.badInput = true;
  h.submit('delivery-filters');
  assert.equal(historyRequests(h).length, 1);
  assert.equal(h.node('delivery-from').getAttribute('aria-invalid'), 'true');
  assert.match(h.node('delivery-from-error').textContent, /data inicial válida/);
});

test('valid UUID versions, UID punctuation and leap dates retain existing query and WhatsApp contracts', async t => {
  const h = await setup(t);
  for (const version of [1, 2, 3, 4, 5]) {
    const id = `550E8400-E29B-${version}1D4-A716-446655440000`;
    h.node('delivery-reminder').value = ` ${id} `;
    h.node('delivery-user').value = ' uid._:-123 ';
    h.node('delivery-from').value = '2024-02-29';
    h.node('delivery-to').value = '2024-02-29';
    h.node('delivery-channel').value = 'whatsapp';
    h.submit('delivery-filters');
    const params = new URL(h.latest('/deliveries?').path, 'https://portal.test').searchParams;
    assert.equal(params.get('reminder_id'), id);
    assert.equal(params.get('user_uid'), 'uid._:-123');
    assert.equal(params.get('scheduled_from'), '2024-02-29');
    assert.equal(params.get('scheduled_to'), '2024-02-29');
    assert.equal(params.get('channel'), 'whatsapp');
    assert.equal(params.get('offset'), '0');
    assert.equal(h.node('delivery-reminder').getAttribute('aria-invalid'), 'false');
  }
  assert.match(h.node('delivery-reminder-help').textContent, /UUID.*não o título/);
  assert.match(h.node('delivery-user-help').textContent, /não nome ou e-mail/);
});

for (const staleOutcome of ['success', 'failure']) {
  test(`new history query ignores stale ${staleOutcome}, including a locally rejected latest query`, async t => {
    const h = await setup(t);
    const first = historyRequests(h)[0];
    h.submit('delivery-filters');
    const second = historyRequests(h)[1];
    second.resolve(rows('Consulta nova', 41));
    await drain();
    if (staleOutcome === 'success') first.resolve(rows('Resultado antigo', 100));
    else first.reject(new Error('old failure'));
    await drain();
    assert.match(historyText(h), /Consulta nova/);
    assert.doesNotMatch(historyText(h), /Resultado antigo|Não foi possível/);

    const staleNext = button(h.node('deliveries-pagination'), 'Próxima');
    staleNext.click();
    const older = h.latest('/deliveries?');
    h.node('delivery-reminder').value = 'invalid';
    h.submit('delivery-filters');
    const requestCount = h.requests.length;
    staleNext.click();
    assert.equal(h.requests.length, requestCount);
    if (staleOutcome === 'success') older.resolve(rows('Também antigo', 41));
    else older.reject(new Error('another old failure'));
    await drain();
    assert.match(historyText(h), /Revise os filtros/);
    assert.doesNotMatch(historyText(h), /Também antigo|Não foi possível/);
    assert.equal(h.node('deliveries-pagination').children.length, 0);

    h.node('delivery-clear').click();
    assert.equal(h.node('delivery-reminder').value, '');
    assert.equal(h.node('delivery-reminder').getAttribute('aria-invalid'), 'false');
    assert.equal(h.node('delivery-reminder-error').hidden, true);
    const cleared = new URL(h.latest('/deliveries?').path, 'https://portal.test');
    assert.equal(cleared.search, '?limit=20&offset=0');
    h.latest('/deliveries?').resolve(rows('Consulta restaurada'));
    await drain();
    assert.match(historyText(h), /Consulta restaurada/);
  });

  test(`cron request ownership ignores stale ${staleOutcome}`, async t => {
    const h = await setup(t);
    const first = healthRequests(h)[0];
    h.submit('delivery-filters');
    healthRequests(h)[1].resolve(cron({ failed_count: 2, delivery_status: 'failed' }));
    await drain();
    const current = { text: health(h).textContent, title: health(h).title };
    if (staleOutcome === 'success') first.resolve(null);
    else first.reject(new Error('old health failure'));
    await drain();
    assert.deepEqual({ text: health(h).textContent, title: health(h).title }, current);
    assert.equal(health(h).className, 'badge badge-red');
    assert.match(current.text, /Cron ativo.*2 falha\(s\) de entrega/);
    assert.equal(h.node('cron-health-actions').children.length, 0);
  });
}

test('cron badge resets text, class and title across success, null, query error and recovery', async t => {
  const h = await setup(t);
  h.latest('/cron-status').resolve(cron({ execution_status: 'failed', execution_error: 'Erro de execução de teste' }));
  await drain();
  assert.equal(health(h).textContent, 'Cron com falha');
  assert.equal(health(h).className, 'badge badge-gray');
  assert.equal(health(h).title, 'Erro de execução de teste');
  h.submit('delivery-filters');
  assert.equal(health(h).title, '');
  h.latest('/cron-status').resolve(null);
  await drain();
  assert.equal(health(h).textContent, 'Cron sem heartbeat');
  assert.equal(health(h).className, 'badge badge-gray');
  assert.equal(health(h).title, '');
  h.submit('delivery-filters');
  h.latest('/cron-status').resolve(cron());
  await drain();
  assert.equal(health(h).className, 'badge badge-green');
  h.submit('delivery-filters');
  assert.equal(health(h).className, 'badge badge-gray');
  h.latest('/cron-status').reject(new Error('unreachable'));
  await drain();
  assert.match(health(h).textContent, /consultar/);
  assert.doesNotMatch(health(h).title, /Execução: completed/);
  const staleRetry = button(h.node('cron-health-actions'), 'Consultar cron novamente');
  h.submit('delivery-filters');
  const count = h.requests.length;
  staleRetry.click();
  assert.equal(h.requests.length, count);
  h.latest('/cron-status').resolve(cron({ heartbeat_at: new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString() }));
  await drain();
  assert.equal(health(h).textContent, 'Cron atrasado');
  assert.equal(health(h).className, 'badge badge-gray');
});

test('history pagers and retries own their query snapshot, clear stale controls and recover out-of-range pages', async t => {
  const h = await setup(t);
  h.latest('/deliveries?').resolve(rows('Primeira página', 41));
  await drain();
  const next = button(h.node('deliveries-pagination'), 'Próxima');
  h.node('delivery-user').value = 'unsubmitted-user';
  next.click(); next.click();
  assert.equal(historyRequests(h).length, 2);
  assert.equal(h.node('deliveries-pagination').children.length, 0);
  assert.equal(historyText(h), 'Carregando histórico…');
  assert.match(h.latest('/deliveries?').path, /offset=20$/);
  h.latest('/deliveries?').reject(new Error('transient'));
  await drain();
  const retry = button(h.node('deliveries-tbody'), 'Tentar novamente');
  retry.click(); retry.click();
  assert.equal(historyRequests(h).length, 3);
  assert.match(h.latest('/deliveries?').path, /offset=20$/);
  assert.equal(healthRequests(h).length, 1);
  h.latest('/deliveries?').resolve({ data: [], total: 1 });
  await drain();
  assert.match(h.latest('/deliveries?').path, /offset=0$/);
  h.latest('/deliveries?').resolve(rows('Última página válida'));
  await drain();
  assert.match(historyText(h), /Última página válida/);
  assert.equal(h.node('deliveries-pagination').children.length, 0);
  h.submit('delivery-filters');
  assert.match(h.latest('/deliveries?').path, /offset=0&user_uid=unsubmitted-user$/);
  const count = h.requests.length;
  retry.click(); next.click();
  assert.equal(h.requests.length, count, 'callbacks from old query cannot take ownership back');
});

test('readers make no privileged delivery or cron requests, even on synthetic filter events', async t => {
  const h = await setup(t, { user: { permissions: {} } });
  h.submit('delivery-filters');
  h.node('delivery-clear').click();
  await drain();
  assert.equal(h.node('delivery-manager').hidden, true);
  assert.equal(historyRequests(h).length, 0);
  assert.equal(healthRequests(h).length, 0);
  assert.equal(h.requests.length, 1);
});

test('real lifecycle disposal aborts both requests and ignores late success/failure and old controls', async t => {
  for (const outcome of ['success', 'failure']) await t.test(outcome, async t => {
    const h = await setup(t);
    const pendingHistory = h.latest('/deliveries?'), pendingHealth = h.latest('/cron-status');
    const before = { history: historyText(h), health: health(h).textContent };
    h.page.dispose();
    assert.equal(pendingHistory.options.signal.aborted, true);
    assert.equal(pendingHealth.options.signal.aborted, true);
    if (outcome === 'success') { pendingHistory.resolve(rows('Late')); pendingHealth.resolve(cron()); }
    else { pendingHistory.reject(new Error('late')); pendingHealth.reject(new Error('late')); }
    h.submit('delivery-filters');
    h.node('delivery-clear').click();
    await drain();
    assert.deepEqual({ history: historyText(h), health: health(h).textContent }, before);
    assert.equal(historyRequests(h).length, 1);
    assert.equal(healthRequests(h).length, 1);
  });
});
