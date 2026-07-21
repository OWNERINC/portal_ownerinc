import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateSolidesEnvironment } = require('../api/integrations/solides-config');
const { solidesCheck } = require('../api/integrations/solides');

const employeeId = process.env.SOLIDES_TEST_EMPLOYEE_ID;
const config = validateSolidesEnvironment({ ...process.env, SOLIDES_RELEASE_STAGE: 'internal' });
if (employeeId && !/^[1-9]\d{0,18}$/.test(employeeId)) throw new Error('Invalid SOLIDES_TEST_EMPLOYEE_ID');

async function probe(name, service, path, query) {
  return { name, ...await solidesCheck(service, path, { config, query }) };
}

const checks = [await probe('employer.test', 'employer', 'test')];
if (employeeId) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
  const date = formatter.format(new Date());
  const start = new Date(`${date}T00:00:00-03:00`).getTime();
  const end = start + 86400000 - 1;
  checks.push(
    await probe('employer.employee', 'employer', 'employee/find', { tangerinoId: employeeId, ignoreFired: false }),
    await probe('punch.summary', 'punch', 'summary', { employeeId, startDateInMillis: start, endDateInMillis: end, page: 0, size: 20 }),
    await probe('punch.history', 'punch', '', { employeeId, startDateInMillis: start, endDateInMillis: end, page: 0, size: 20, showSecurityCode: false }),
    await probe('punch.hoursBalance', 'punch', 'hoursBalance', { employeeId, startDate: start, endDate: end }),
    await probe('employer.adjustments', 'employer', `v2/adjustments/employees/${employeeId}`, { startDate: start, endDate: end }),
  );
}

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), employeeProbeEnabled: Boolean(employeeId), checks }, null, 2));
if (checks.some((check) => !check.ok)) process.exitCode = 1;
