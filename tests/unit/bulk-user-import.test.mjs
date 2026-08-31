import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { parseCsv, validateRows } = require('./services/bulk-user-import');

test('bulk parser handles UTF-8 BOM and quoted commas without dependencies', () => {
  const rows = parseCsv('\uFEFFname,email,job_title,contract_type,pj_due_day,phone\n"José, Silva",jose@example.com,Analista,pj,15,+55 61 9999-9999');
  assert.deepEqual(rows[0], { name: 'José, Silva', email: 'jose@example.com', job_title: 'Analista', contract_type: 'pj', pj_due_day: '15', phone: '+55 61 9999-9999' });
});

test('bulk validation marks duplicates and inactive or unknown titles per row', () => {
  const titles = new Map([['analista', { id: 'title-1' }]]);
  const rows = validateRows([
    { name: 'A', email: 'a@example.com', job_title: 'Analista', contract_type: 'clt', pj_due_day: '', phone: '' },
    { name: 'B', email: 'a@example.com', job_title: 'Inativo', contract_type: 'clt', pj_due_day: '', phone: '' },
  ], titles, new Set());
  assert.equal(rows[0].status, 'ready');
  assert.deepEqual(rows[1].errors, ['duplicate_email', 'unknown_or_inactive_job_title']);
});

test('bulk parser rejects malformed column counts and more than 500 users', () => {
  assert.throws(() => parseCsv('name,email,job_title,contract_type,pj_due_day,phone\na,b,c,clt,'), /exactly six columns/);
  const header = 'name,email,job_title,contract_type,pj_due_day,phone';
  assert.throws(() => parseCsv(`${header}\n${Array.from({ length: 501 }, (_, i) => `n${i},a${i}@x.com,t,clt,,`).join('\n')}`), /more than 500/);
});
