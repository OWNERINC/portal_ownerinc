import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';

test('real smoke checks the checkout shell and router delivery, health, readiness and Origin', async t => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
  const available = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (process.platform === 'win32' && available.error?.code === 'ENOENT') return t.skip('Git Bash is unavailable');
  assert.equal(available.status, 0, available.stderr);
  const files = new Map(await Promise.all([
    ['/', 'public/index.html'],
    ['/autocard.html', 'public/autocard.html'],
    ['/autocard/', 'public/autocard/index.html'],
    ['/js/router-bootstrap.js', 'public/js/router-bootstrap.js'],
    ['/js/router.js', 'public/js/router.js'],
    ['/autocard/entry.js', 'public/autocard/entry.js'],
  ].map(async ([url, file]) => [url, await readFile(file, 'utf8')])));
  const overrides = new Map();
  let rejectOrigin = false;
  const origins = [];
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const override = overrides.get(req.url);
    if (override) {
      res.writeHead(override.status ?? 200, override.headers ?? {});
      res.end(override.body ?? 'Unavailable');
      return;
    }
    if (req.url === '/api/health') {
      if (req.headers.origin) origins.push(req.headers.origin);
      if (req.headers.origin && rejectOrigin) {
        res.writeHead(403); res.end('{"error":"Request not allowed."}');
      } else res.end('{"status":"ok"}');
    } else if (req.url === '/api/ready') res.end('{"status":"ready"}');
    else if (files.has(req.url)) {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(files.get(req.url));
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = async () => {
    const child = spawn(bash, ['scripts/smoke.sh'], {
      env: { ...process.env, BASE_URL: `${origin}/`, SMOKE_ATTEMPTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'close');
    return { code, output };
  };
  await t.test('accepts the real HTML/JS and fetches the bootstrap, router and entry', async () => {
    const accepted = await run();
    assert.equal(accepted.code, 0, accepted.output);
    assert.match(accepted.output, /"status":"ok"/);
    for (const url of files.keys()) assert.ok(requests.includes(url), `Smoke must fetch ${url}`);
    assert.deepEqual(origins, [origin]);
  });
  await t.test('rejects browser Origin even when plain health and readiness pass', async () => {
    rejectOrigin = true;
    try {
      const rejected = await run();
      assert.equal(rejected.code, 1, rejected.output);
      assert.match(rejected.output, /"status":"failed"/);
      assert.equal(origins.at(-1), origin);
    } finally { rejectOrigin = false; }
  });
  const failures = [
    ['liveness unavailable', '/api/health', { status: 503 }],
    ['readiness unavailable', '/api/ready', { status: 503 }],
    ['root unavailable', '/', { status: 404 }],
    ['generic canonical HTML', '/autocard.html', { body: files.get('/') }],
    ['missing shell', '/autocard.html', { body: files.get('/autocard.html').replace('class="sidebar"', 'class="missing-sidebar"') }],
    ['missing module bootstrap tag', '/autocard.html', { body: files.get('/autocard.html').replace('type="module" src="./js/router-bootstrap.js"', 'src="./js/router-bootstrap.js"') }],
    ['broken legacy redirect', '/autocard/', { body: files.get('/autocard/').replaceAll('../autocard.html', '../login.html') }],
    ...['/js/router-bootstrap.js', '/js/router.js', '/autocard/entry.js'].flatMap(url => [
      [`404 for ${url} even with the expected body`, url, { status: 404, body: files.get(url) }],
      [`HTML fallback for ${url}`, url, { body: files.get('/') }],
    ]),
    ['truncated bootstrap without startRouter call', '/js/router-bootstrap.js', { body: files.get('/js/router-bootstrap.js').split('\n')[0] }],
    ['bootstrap with wrong import', '/js/router-bootstrap.js', { body: files.get('/js/router-bootstrap.js').replace('./router.js', './missing-router.js') }],
    ['incomplete bootstrap HTTP transfer', '/js/router-bootstrap.js', {
      body: files.get('/js/router-bootstrap.js'),
      headers: { 'Content-Length': Buffer.byteLength(files.get('/js/router-bootstrap.js')) + 20, Connection: 'close' },
    }],
    ['wrong AutoCard route', '/js/router.js', { body: files.get('/js/router.js').replace("'/autocard.html': '../autocard/entry.js'", "'/autocard.html': './dashboard.js'") }],
    ['truncated router before startRouter', '/js/router.js', { body: files.get('/js/router.js').split('export async function startRouter')[0] }],
    ['entry without mount export', '/autocard/entry.js', { body: files.get('/autocard/entry.js').replace('export function mount', 'function mount') }],
    ['truncated entry body', '/autocard/entry.js', { body: files.get('/autocard/entry.js').trimEnd().slice(0, -1) }],
  ];
  for (const [name, url, response] of failures) {
    await t.test(`rejects ${name}`, async () => {
      overrides.set(url, response);
      try {
        const rejected = await run();
        assert.equal(rejected.code, 1, rejected.output);
        assert.match(rejected.output, /"status":"failed"/);
      } finally { overrides.clear(); }
    });
  }
});
