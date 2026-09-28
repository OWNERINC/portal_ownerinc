import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';

test('real smoke fails on browser-origin rejection even when plain health and readiness pass', async t => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
  const available = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (process.platform === 'win32' && available.error?.code === 'ENOENT') return t.skip('Git Bash is unavailable');
  assert.equal(available.status, 0, available.stderr);
  const source = await readFile('scripts/smoke.sh', 'utf8');
  let rejectOrigin = true;
  const origins = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      if (req.headers.origin) origins.push(req.headers.origin);
      if (req.headers.origin && rejectOrigin) {
        res.writeHead(403); res.end('{"error":"Request not allowed."}');
      } else res.end('{"status":"ok"}');
    } else if (req.url === '/api/ready') res.end('{"status":"ready"}');
    else if (req.url === '/autocard.html') res.end('class="portal-wrapper" class="sidebar" class="topbar" id="main-content" src="./autocard/entry.js"');
    else if (req.url === '/autocard/') res.end('url=../autocard.html href="../autocard.html"');
    else res.end('Portal');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = async () => {
    const child = spawn(bash, ['-c', source], {
      env: { ...process.env, BASE_URL: `${origin}/`, SMOKE_ATTEMPTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'close');
    return { code, output };
  };
  const rejected = await run();
  assert.equal(rejected.code, 1, rejected.output);
  assert.match(rejected.output, /"status":"failed"/);
  rejectOrigin = false;
  const accepted = await run();
  assert.equal(accepted.code, 0, accepted.output);
  assert.match(accepted.output, /"status":"ok"/);
  assert.deepEqual(origins, [origin, origin]);
});
