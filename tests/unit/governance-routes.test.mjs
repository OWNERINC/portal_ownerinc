import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  boolean, httpUrl, integer, mayViewAll, oneOf, parseListQuery, targetUsers,
  text, uuid, validBody,
} = require('../../api/route-utils');

test('strict payload validation rejects unknown, missing, oversized, and malformed fields', () => {
  const schema = { title: text(10, true), active: boolean, order: integer(0, 10), channel: oneOf('email') };
  assert.equal(validBody({ title: 'Valid', active: true, order: 0, channel: 'email' }, schema, ['title']), true);
  assert.equal(validBody({ active: true }, schema, ['title']), false);
  assert.equal(validBody({ title: undefined }, schema, ['title']), false);
  assert.equal(validBody({ title: '           ' }, schema, ['title']), false);
  assert.equal(validBody({ title: 'Valid', surprise: true }, schema, ['title']), false);
  assert.equal(validBody({ title: 'Valid', active: 'true' }, schema, ['title']), false);
  assert.equal(httpUrl('javascript:alert(1)'), false);
  assert.equal(httpUrl('https://ownerinc.com'), true);
  assert.equal(uuid('e7fa4cd2-70f5-4d75-a77f-b17b5caedfa9'), true);
  assert.equal(targetUsers(['uid-1', 'uid-2']), true);
  assert.equal(targetUsers(['uid-1', 'uid-1']), false);
  assert.equal(targetUsers([1]), false);
});

test('pagination is capped and all-content visibility requires the matching manager permission', () => {
  assert.deepEqual(parseListQuery({}), { limit: 50, offset: 0 });
  assert.deepEqual(parseListQuery({ limit: '100', offset: '10' }), { limit: 100, offset: 10 });
  assert.equal(parseListQuery({ limit: '101' }), null);
  assert.equal(parseListQuery({ unknown: '1' }), null);
  assert.equal(mayViewAll({ role: 'viewer', permissions: { manageBenefits: true } }, 'manageBenefits', 'true'), false);
  assert.equal(mayViewAll({ role: 'admin', permissions: { manageBenefits: true } }, 'manageBenefits', 'true'), true);
  assert.equal(mayViewAll({ role: 'admin', permissions: { manageBenefits: true } }, 'manageBenefits', undefined), false);
});

test('scoped routes delegate failures and privileged changes to the audit helper', async () => {
  for (const name of ['knowledge', 'reminders', 'academy', 'benefits', 'ombudsman', 'job-titles']) {
    const source = await readFile(`api/routes/${name}.js`, 'utf8');
    assert.match(source, /next\(error\)/, `${name} must use generic error handling`);
  }
  for (const name of ['knowledge', 'reminders', 'academy', 'benefits', 'job-titles']) {
    const source = await readFile(`api/routes/${name}.js`, 'utf8');
    assert.match(source, /withAudit/, `${name} must audit privileged mutations`);
    assert.match(source, /X-Total-Count/, `${name} must expose pagination totals`);
  }
  const ombudsman = await readFile('api/routes/ombudsman.js', 'utf8');
  assert.match(ombudsman, /ombudsman\.read/);
  assert.match(ombudsman, /ombudsman\.update/);
});

test('privileged user listing is strict, paginated, counted, and audited', async () => {
  const users = await readFile('api/routes/users.js', 'utf8');
  assert.match(users, /parseListQuery\(req\.query\)/);
  assert.match(users, /LIMIT \$1 OFFSET \$2/);
  assert.match(users, /X-Total-Count/);
  assert.match(users, /user\.list/);
  assert.match(users, /sendInvitation/);
  assert.doesNotMatch(users, /req\.body\.password/);
  for (const action of ['create', 'update', 'disable', 'reactivate']) assert.match(users, new RegExp(`user\\.${action}`));
  const jobTitles = await readFile('api/routes/job-titles.js', 'utf8');
  assert.match(jobTitles, /manageUsers/);
  assert.match(jobTitles, /job_title\.create/);
  assert.match(jobTitles, /job_title\.update/);
  assert.match(jobTitles, /active = TRUE/);
});

test('public content routes provide server-side filters and category metadata', async () => {
  const [knowledge, academy, benefits] = await Promise.all([
    readFile('api/routes/knowledge.js', 'utf8'),
    readFile('api/routes/academy.js', 'utf8'),
    readFile('api/routes/benefits.js', 'utf8'),
  ]);
  assert.match(knowledge, /router\.get\('\/categories'/);
  assert.match(knowledge, /ILIKE/);
  assert.match(knowledge, /category = \$\$\{values\.length\}/);
  assert.match(knowledge, /router\.get\('\/:id'/);
  assert.match(academy, /router\.get\('\/categories'/);
  assert.match(academy, /category = \$1/);
  assert.match(benefits, /router\.get\('\/categories'/);
  assert.match(benefits, /category = \$1/);
});
