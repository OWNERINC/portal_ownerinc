import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'development';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIREBASE_PROJECT_ID = 'portal-ownerinc-test';
const {
  hasEmployeeAccess, parsePilotUids, readSolidesConfig, validateSolidesEnvironment,
} = require('../../api/integrations/solides-config');
const { SolidesError, buildUrl, readLimitedText, solidesCheck, solidesJson } = require('../../api/integrations/solides');
const { _test } = require('../../api/routes/solides');

const config = {
  stage: 'pilot', stageRank: 2, token: 'secret', employerBaseUrl: 'https://employer.example/api/',
  punchBaseUrl: 'https://punch.example/punch/', reportBaseUrl: '', timeoutMs: 1000, pilotUids: new Set(['pilot']),
};

test('Sólides release stages are disabled by default and pilot access is explicit', () => {
  assert.equal(readSolidesConfig({}).stage, 'off');
  assert.deepEqual([...parsePilotUids(' one, two ,,one ')], ['one', 'two']);
  assert.equal(hasEmployeeAccess({ uid: 'pilot', role: 'viewer', contract_type: 'clt', permissions: {} }, config), true);
  assert.equal(hasEmployeeAccess({ uid: 'other', role: 'viewer', contract_type: 'clt', permissions: {} }, config), false);
  assert.equal(hasEmployeeAccess({ uid: 'other', role: 'admin', contract_type: 'clt', permissions: { manageSolides: true } }, config), false);
  assert.equal(hasEmployeeAccess({ uid: 'pilot', role: 'viewer', contract_type: 'pj', permissions: {} }, config), false);
  assert.equal(hasEmployeeAccess({ uid: 'root', role: 'admin', contract_type: 'clt', permissions: { superAdmin: true } }, { ...config, stage: 'internal', stageRank: 1 }), false);
  assert.doesNotThrow(() => validateSolidesEnvironment({ SOLIDES_RELEASE_STAGE: 'off' }));
  assert.throws(() => validateSolidesEnvironment({ SOLIDES_RELEASE_STAGE: 'unknown' }), /SOLIDES_RELEASE_STAGE/);
  assert.throws(() => validateSolidesEnvironment({ SOLIDES_RELEASE_STAGE: 'internal' }), /SOLIDES_TOKEN/);

  const clt = { uid: 'employee', role: 'viewer', contract_type: 'clt', permissions: {} };
  for (const stage of ['off', 'internal']) {
    assert.equal(hasEmployeeAccess(clt, { ...config, stage, stageRank: { off: 0, internal: 1 }[stage] }), false, stage);
  }
  assert.equal(hasEmployeeAccess(clt, { ...config, pilotUids: new Set(['employee']) }), true, 'pilot listed');
  assert.equal(hasEmployeeAccess(clt, { ...config, pilotUids: new Set() }), false, 'pilot unlisted');
  for (const [stage, stageRank] of [['general', 3], ['manager', 4], ['write', 5]]) {
    assert.equal(hasEmployeeAccess(clt, { ...config, stage, stageRank }), true, stage);
    assert.equal(hasEmployeeAccess({ ...clt, contract_type: 'pj' }, { ...config, stage, stageRank }), false, `${stage} pj`);
  }
});

test('Sólides client pins the configured origin and never exposes upstream bodies', async () => {
  assert.equal(buildUrl('https://example.com/api/', 'employee/find', { tangerinoId: '42' }).href,
    'https://example.com/api/employee/find?tangerinoId=42');
  assert.throws(() => buildUrl('https://example.com/api/', '../private', {}), /Invalid Sólides endpoint/);

  let authorization;
  const response = await solidesJson('employer', 'employee/find', {
    config, attempts: 1,
    fetchImpl: async (url, options) => {
      authorization = options.headers.Authorization;
      assert.equal(url.origin, 'https://employer.example');
      return new Response(JSON.stringify({ id: 42, cpf: 'discard-me' }), { status: 200 });
    },
  });
  assert.equal(authorization, 'Basic secret');
  assert.equal(response.id, 42);

  await assert.rejects(solidesJson('punch', 'summary', {
    config, attempts: 1, fetchImpl: async () => new Response('private upstream error', { status: 401 }),
  }), (error) => error instanceof SolidesError && !error.message.includes('private upstream error'));
  await assert.rejects(readLimitedText(new Response('{}', { headers: { 'content-length': '6000000' } })), /too large/);
  const check = await solidesCheck('punch', 'summary', {
    config, fetchImpl: async () => new Response(JSON.stringify({ content: [{ id: 1 }], totalElements: 1 }), { status: 200 }),
  });
  assert.deepEqual(check.shape, { kind: 'page', count: 1, hasTotal: true });
  assert.equal(check.ok, true);
});

test('Sólides adapters retain only the employee and punch fields used by the Portal', () => {
  const employee = _test.normalizeEmployee({
    id: 42, externalId: 'owner-42', name: 'User', cpf: 'discard', recordsPunch: true,
    currentWorkplaceDTO: { name: 'HQ' }, jobRoleDTO: { description: 'Analista' },
    currentWorkSchedule: { id: 7, name: 'Comercial', workScheduleTimetableList: [{ day: 2, startShift1: 32400000, endShift1: 64800000 }] },
  });
  assert.equal(employee.employeeId, '42');
  assert.equal(employee.cpf, undefined);
  assert.deepEqual(employee.schedule.days[0].shifts[0], { start: '09:00', end: '18:00' });

  const punch = _test.normalizePunch({
    id: 9, employeeId: 42, dateIn: '2026-07-20T09:00:00-03:00', status: 'APPROVED',
    locationIn: { latitude: 1 }, photoIn: 'private', edited: true,
  });
  assert.equal(punch.id, '9');
  assert.equal(punch.status, 'APPROVED');
  assert.equal(punch.locationIn, undefined);
  assert.equal(punch.photoIn, undefined);
  assert.equal(_test.finiteNumber(null), null);
  assert.equal(_test.finiteNumber(''), null);
  assert.equal(_test.finiteNumber('0'), 0);
  assert.equal(_test.positiveBigInt('9223372036854775807'), true);
  assert.equal(_test.positiveBigInt('9223372036854775808'), false);
  assert.equal(_test.verificationTransitionAllowed(null, '42', 'verified'), false);
  assert.equal(_test.verificationTransitionAllowed({ employee_id: '42' }, '42', 'verified'), true);
  assert.equal(_test.verificationTransitionAllowed({ employee_id: '41' }, '42', 'verified'), false);
  assert.equal(_test.verificationTransitionAllowed(null, '42', 'pending'), true);
  assert.equal(_test.employeeMatchesLink({ id: 42, externalId: 'owner-42' }, '42', 'owner-42'), true);
  assert.equal(_test.employeeMatchesLink({ id: 42, externalId: 'owner-99' }, '42', 'owner-42'), false);
  assert.equal(_test.employeeMatchesLink({ id: 99 }, '42', null), false);
  assert.equal(_test.employeeMatchesLink({ id: 42, fired: true }, '42', null), false);
  assert.equal(_test.dateRange({ from: '2026-07-01', to: '2026-08-01' }), null);
  const adjustmentRow = {
    id: 5, employeeId: 42, reason: 'Férias', justification: 'private', notes: 'private', cpf: 'discard',
    status: 'APROVADO', startDate: '2026-08-01T00:00:00-03:00',
  };
  const adjustment = _test.normalizeAdjustment(adjustmentRow);
  assert.equal(_test.adjustmentEmployeeId(adjustmentRow), '42');
  assert.equal(_test.adjustmentEmployeeId({ employee: { id: 42 } }), '42');
  assert.equal(_test.adjustmentEmployeeId({ id: 42 }), null);
  assert.equal(adjustment.id, '5');
  for (const field of ['reason', 'justification', 'notes', 'cpf']) assert.equal(adjustment[field], undefined);
  assert.deepEqual([
    adjustmentRow,
    { ...adjustmentRow, id: 6, employeeId: 99 },
    { ...adjustmentRow, id: 7, employeeId: undefined },
  ].filter((row) => _test.adjustmentEmployeeId(row) === '42').map(_test.normalizeAdjustment), [adjustment]);
});
