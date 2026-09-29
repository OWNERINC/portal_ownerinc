import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutoCardContractHarness } from '../helpers/autocard-contract-harness.mjs';
import { createFeedbackHarness, drain } from '../helpers/frontend-feedback-harness.mjs';

const expose = 'globalThis.cardProbe = { selectTemplate, saveCard, openSavedCard, activeTemplateKeys, current: () => current };';
const plain = value => JSON.parse(JSON.stringify(value));
async function mounted(t) {
  const h = await createFeedbackHarness('autocard', { expose });
  t.after(() => h.page.dispose());
  return h;
}
async function completeCaller(h, api, operation, expectedStatus) {
  operation.catch(() => {});
  const request = h.requests.at(-1);
  assert.ok(request, 'the mounted caller must issue the request');
  const response = await api.send(request);
  assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
  request.resolve(response.body); await operation; await drain();
  return { request, response };
}

for (const template of ['comunicado', 'vaga', 'aniversariante', 'novo_funcionario']) {
  test(`${template} mounted default POST/reopen/PUT payload passes the real AutoCard route validator`, { timeout: 10000 }, async t => {
    const api = await createAutoCardContractHarness(t), h = await mounted(t);
    assert.deepEqual(plain(h.context.cardProbe.activeTemplateKeys), ['comunicado', 'vaga', 'aniversariante', 'novo_funcionario']);
    h.context.cardProbe.selectTemplate(template);
    const defaultIcon = h.context.cardProbe.current().icon;
    for (const method of ['POST', 'PUT']) {
      h.input('field-titulo', method === 'POST' ? 'Título inicial' : 'Título atualizado');
      const { request, response } = await completeCaller(h, api, h.context.cardProbe.saveCard(), method === 'POST' ? 201 : 200);
      const payload = JSON.parse(request.options.body);
      assert.equal(request.options.method, method);
      assert.equal(payload.icon, defaultIcon, 'the default is not replaced in the test');
      assert.equal(payload.illustration, null);
      assert.deepEqual(Object.keys(payload).sort(), ['icon', 'illustration', 'mediaCrop', 'mediaId', 'mediaSize', 'mode', 'name', 'template', 'values', 'variant']);
      const { id, ...saved } = response.body;
      assert.deepEqual(saved, payload, 'real parseCard normalization keeps the submitted contract');
      assert.equal(h.context.cardProbe.current().editingId, id);
      const reopened = await completeCaller(h, api, h.context.cardProbe.openSavedCard(id), 200);
      assert.deepEqual(reopened.response.body, response.body);
      assert.equal(h.context.cardProbe.current().icon, defaultIcon);
      assert.deepEqual(plain(h.context.cardProbe.current().values), payload.values);
      assert.equal(h.node('saveButton').disabled, false);
    }
    const auditActions = api.state.sql.filter(call => /INSERT INTO audit_log/.test(call.sql)).map(call => call.params[1]);
    assert.deepEqual(auditActions, ['autocard.card.create', 'autocard.card.update']);
    assert.equal(api.state.connections, api.state.releases);
  });
}

test('employee manual icon/illustration and existing photo/crop survive reopening and PUT without resetting to the default', { timeout: 10000 }, async t => {
  const api = await createAutoCardContractHarness(t), h = await mounted(t);
  const id = '12345678-1234-4234-8234-123456789abc', mediaId = '22345678-1234-4234-8234-123456789abc';
  const mediaCrop = { x: 0.2, y: 0.8, zoom: 1.7 };
  api.state.media.add(mediaId);
  api.state.cards.set(id, { id, name: 'Pessoa de teste', template: 'novo_funcionario', values: { titulo: 'Pessoa de teste' }, icon: 'heart', illustration: null, mode: 'beige', variant: 'beige', mediaSize: 'medium', mediaId, mediaCrop });
  h.context.Image = class {
    naturalWidth = 800; naturalHeight = 800;
    set src(value) { if (value) queueMicrotask(() => this.onload?.()); }
  };
  await completeCaller(h, api, h.context.cardProbe.openSavedCard(id), 200);
  h.latest(`/api/autocard/media/${mediaId}`).resolve('blob:employee-contract-photo'); await drain();
  assert.equal(h.context.cardProbe.current().icon, 'heart');
  assert.equal(h.context.cardProbe.current().mediaStatus, 'ready');
  for (const [button, asset] of [['iconButton', 'users'], ['illustrationButton', 'user-plus']]) {
    h.node(button).click(); h.doc.querySelector(`[data-asset="${asset}"]`).click();
  }
  const saved = await completeCaller(h, api, h.context.cardProbe.saveCard(), 200);
  assert.equal(saved.response.body.icon, 'users');
  assert.equal(saved.response.body.illustration, 'user-plus', 'user-plus remains a valid illustration only');
  assert.equal(saved.response.body.mediaId, mediaId);
  assert.deepEqual(saved.response.body.mediaCrop, mediaCrop);
  assert.equal(saved.response.body.variant, 'beige');
  await completeCaller(h, api, h.context.cardProbe.openSavedCard(id), 200);
  h.latest(`/api/autocard/media/${mediaId}`).resolve('blob:employee-contract-reopened'); await drain();
  assert.equal(h.context.cardProbe.current().icon, 'users');
  assert.equal(h.context.cardProbe.current().illustration, 'user-plus');
  assert.deepEqual(plain(h.context.cardProbe.current().mediaCrop), mediaCrop);
});

test('real POST and PUT validators still reject the old employee icon before database access', { timeout: 10000 }, async t => {
  const api = await createAutoCardContractHarness(t), h = await mounted(t);
  h.context.cardProbe.selectTemplate('novo_funcionario');
  const saving = h.context.cardProbe.saveCard(); saving.catch(() => {});
  const payload = { ...JSON.parse(h.requests.at(-1).options.body), icon: 'user-plus' };
  for (const method of ['POST', 'PUT']) {
    const path = `/api/autocard/cards${method === 'POST' ? '' : '/12345678-1234-4234-8234-123456789abc'}`;
    const response = await api.send({ path, options: { method, body: JSON.stringify(payload) } });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Invalid request.');
    assert.equal(typeof response.body.requestId, 'string');
  }
  assert.equal(api.state.sql.length, 0);
  assert.equal(api.state.connections, 0);
});

test('default payload validation cannot bypass the real AutoCard permission gate for POST or PUT', { timeout: 10000 }, async t => {
  const api = await createAutoCardContractHarness(t), h = await mounted(t);
  h.context.cardProbe.selectTemplate('comunicado');
  const saving = h.context.cardProbe.saveCard(); saving.catch(() => {});
  const body = h.requests.at(-1).options.body;
  for (const method of ['POST', 'PUT']) for (const [actor, status] of [['denied', 403], [null, 401]]) {
    const path = `/api/autocard/cards${method === 'POST' ? '' : '/12345678-1234-4234-8234-123456789abc'}`;
    assert.equal((await api.send({ path, options: { method, body } }, actor)).status, status);
  }
  assert.equal(api.state.sql.length, 0);
});
