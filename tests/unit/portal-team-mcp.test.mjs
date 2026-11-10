import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../../scripts/portal-team-mcp.mjs', import.meta.url));
const target = 'public/css/dashboard-home.css';
const sha = text => createHash('sha256').update(text).digest('hex');

test('portal pilot inspects and replaces only the dashboard stylesheet with CAS', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'portal-team-'));
  await mkdir(path.dirname(path.join(root, target)), { recursive: true });
  await writeFile(path.join(root, target), '.home { display: block; }\n');
  const child = spawn(process.execPath, [server], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await rm(root, { recursive: true, force: true }); });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  async function request(method, params) {
    const sent = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent, method, params })}\n`);
    const line = await lines.next();
    assert.equal(line.done, false, stderr);
    const response = JSON.parse(line.value);
    assert.equal(response.id, sent);
    return response.error ?? response.result;
  }
  const call = async (name, args) => request('tools/call', { name, arguments: args });

  assert.equal((await request('initialize', {})).protocolVersion, '2025-06-18');
  assert.deepEqual((await request('tools/list')).tools.map(tool => tool.name), ['inspect_dashboard', 'replace_dashboard_snippet', 'write_review']);
  assert.equal((await call('inspect_dashboard', { path: 'api/server.js' })).isError, true);
  const initial = JSON.parse((await call('inspect_dashboard', {})).content[0].text);
  assert.equal(initial.path, target);
  assert.equal(initial.text, '.home { display: block; }\n');
  assert.equal(initial.bytes_hex, Buffer.from(initial.text).toString('hex'));
  assert.equal(initial.sha256, sha(initial.text));
  assert.equal(initial.ending, 'lf');

  const change = { task_id: 'portal-home-pilot', expected_sha256: initial.sha256, old_text: 'display: block', new_text: 'display: grid' };
  for (const invalid of [
    { expected_sha256: sha('stale') },
    { old_text: 'missing' },
    { new_text: 'display: grid\r\n' },
    { task_id: '../api' },
    { path: 'api/server.js' },
  ]) {
    assert.equal((await call('replace_dashboard_snippet', { ...change, ...invalid })).isError, true);
    assert.equal(await readFile(path.join(root, target), 'utf8'), initial.text);
  }
  const receipt = JSON.parse((await call('replace_dashboard_snippet', change)).content[0].text);
  assert.equal(receipt.path, target);
  assert.equal(receipt.previous_sha256, initial.sha256);
  assert.equal(receipt.current_sha256, sha('.home { display: grid; }\n'));
  assert.equal(await readFile(path.join(root, target), 'utf8'), '.home { display: grid; }\n');
  assert.equal((await call('replace_dashboard_snippet', change)).isError, true);

  const review = { task_id: 'portal-home-pilot', expected_sha256: receipt.current_sha256, markdown: 'Review of exact CSS version' };
  assert.equal((await call('write_review', { ...review, expected_sha256: initial.sha256 })).isError, true);
  assert.equal((await call('write_review', { ...review, task_id: 'README' })).isError, true);
  assert.equal(JSON.parse((await call('write_review', review)).content[0].text).revision, 1);
  assert.equal(JSON.parse((await call('write_review', { ...review, markdown: 'Second review' })).content[0].text).revision, 2);
  const report = await readFile(path.join(root, 'docs/operations/agent-reviews/portal-home-pilot.md'), 'utf8');
  assert.match(report, /## Revisão 1/);
  assert.match(report, /## Revisão 2/);
  assert.equal((await call('write_review', { ...review, markdown: '## Revisão 99' })).isError, true);
  assert.equal((await call('unknown', {})).code, -32602);
  assert.equal(stderr, '');
});
