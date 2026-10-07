import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';

test('real smoke checks route HTML and the delivered local module graph, health, readiness and Origin', async t => {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
  const available = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (process.platform === 'win32' && available.error?.code === 'ENOENT') return t.skip('Git Bash is unavailable');
  assert.equal(available.status, 0, available.stderr);

  const publicRoot = path.resolve('public');
  const files = new Map(await Promise.all([
    ['/autocard.html', 'public/autocard.html'],
    ['/autocard/', 'public/autocard/index.html'],
    ['/index.html', 'public/index.html'],
    ['/js/router-bootstrap.js', 'public/js/router-bootstrap.js'],
    ['/js/router.js', 'public/js/router.js'],
    ['/autocard/entry.js', 'public/autocard/entry.js'],
    ['/js/owner-news/asset-path.mjs', 'public/js/owner-news/asset-path.mjs'],
  ].map(async ([url, file]) => [url, await readFile(file, 'utf8')])));
  const overrides = new Map();
  const origins = [];
  const requests = [];
  const contentTypes = new Map();
  let rejectOrigin = false;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push(pathname);
    const override = overrides.get(pathname);
    if (override) {
      res.writeHead(override.status ?? 200, override.headers ?? {});
      res.end(override.body ?? files.get(pathname) ?? 'Unavailable');
      return;
    }
    if (pathname === '/api/health') {
      if (req.headers.origin) origins.push(req.headers.origin);
      if (req.headers.origin && rejectOrigin) {
        res.writeHead(403); res.end('{"error":"Request not allowed."}');
      } else res.end('{"status":"ok"}');
      return;
    }
    if (pathname === '/api/ready') {
      res.end('{"status":"ready"}');
      return;
    }
    if (pathname === '/editorial') {
      res.writeHead(308, { Location: '/editorial/admin' });
      res.end();
      return;
    }

    let filename = path.resolve(publicRoot, `.${decodeURIComponent(pathname)}`);
    if (filename !== publicRoot && !filename.startsWith(`${publicRoot}${path.sep}`)) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    try {
      if ((await stat(filename)).isDirectory()) filename = path.join(filename, 'index.html');
      const body = await readFile(filename);
      const extension = path.extname(filename).toLowerCase();
      const contentType = extension === '.html' ? 'text/html; charset=utf-8'
        : extension === '.css' ? 'text/css; charset=utf-8'
          : ['.js', '.mjs'].includes(extension) ? 'application/javascript; charset=utf-8'
            : 'application/octet-stream';
      contentTypes.set(pathname, contentType);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(body);
    } catch {
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

  await t.test('accepts the checkout route pages and complete local JS graph with browser MIME', async () => {
    const accepted = await run();
    assert.equal(accepted.code, 0, `${accepted.output}\nrequests: ${requests.join(' ')}`);
    assert.match(accepted.output, /"status":"ok"/);
    const router = await readFile('public/js/router.js', 'utf8');
    const routes = [...router.matchAll(/^\s*'([^']+\.html)': '([^']+)'/gm)];
    assert.equal(routes.length, 14, 'all registered direct-link pages should be checked');
    for (const [, route] of routes) assert.ok(requests.includes(route), `Smoke must fetch ${route}`);
    assert.ok(requests.includes('/js/owner-news/asset-path.mjs'), 'Smoke must fetch the .mjs dependency');
    for (const asset of ['/js/index.js', '/js/auth-shell.js', '/js/sidebar-state.js', '/js/sidebar.js']) {
      assert.ok(requests.includes(asset), `Smoke must fetch local shell dependency ${asset}`);
    }
    assert.match(contentTypes.get('/js/owner-news/asset-path.mjs'), /^(application|text)\/(javascript|ecmascript)/i);
    assert.ok(requests.includes('/__route_recovery_missing__.html'), 'Smoke must reject a missing .html route');
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
    ['generic canonical HTML', '/autocard.html', { body: files.get('/index.html') }],
    ['missing shell', '/autocard.html', { body: files.get('/autocard.html').replace('class="sidebar"', 'class="missing-sidebar"') }],
    ['missing module bootstrap tag', '/autocard.html', { body: files.get('/autocard.html').replace('type="module" src="./js/router-bootstrap.js"', 'src="./js/router-bootstrap.js"') }],
    ['broken legacy alias', '/autocard/', { body: files.get('/autocard/').replaceAll('../autocard.html', '../login.html') }],
    ['HTML fallback for a nonexistent .html route', '/__route_recovery_missing__.html', {
      body: files.get('/index.html'), headers: { 'Content-Type': 'text/html' },
    }],
    ['empty 200 for a nonexistent .html route', '/__route_recovery_missing__.html', { status: 200, body: '' }],
    ['unexpected 503 for a nonexistent .html route', '/__route_recovery_missing__.html', { status: 503, body: '' }],
    ...['/js/router-bootstrap.js', '/js/router.js', '/autocard/entry.js'].flatMap(url => [
      [`404 for ${url} even with the expected body`, url, { status: 404, body: files.get(url) }],
      [`HTML fallback for ${url}`, url, { body: files.get('/index.html'), headers: { 'Content-Type': 'text/html' } }],
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
    ['.mjs served as application/octet-stream', '/js/owner-news/asset-path.mjs', {
      body: files.get('/js/owner-news/asset-path.mjs'), headers: { 'Content-Type': 'application/octet-stream' },
    }],
    ['HTML fallback for .mjs', '/js/owner-news/asset-path.mjs', {
      body: files.get('/index.html'), headers: { 'Content-Type': 'text/html' },
    }],
    ['missing transitive .mjs dependency', '/js/owner-news/asset-path.mjs', {
      status: 404, body: files.get('/js/owner-news/asset-path.mjs'),
    }],
    ['incomplete .mjs HTTP transfer', '/js/owner-news/asset-path.mjs', {
      body: files.get('/js/owner-news/asset-path.mjs'),
      headers: { 'Content-Length': Buffer.byteLength(files.get('/js/owner-news/asset-path.mjs')) + 20, Connection: 'close' },
    }],
    ['absolute editorial redirect', '/editorial', { status: 308, headers: { Location: `${origin}/editorial/admin` } }],
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
