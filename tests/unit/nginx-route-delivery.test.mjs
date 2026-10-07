import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const expectedHeaders = new Map([
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['permissions-policy', 'camera=(), geolocation=(), microphone=()'],
]);

function assertSecurityHeaders(response, { csp = true } = {}) {
  if (csp) assert.match(response.headers.get('content-security-policy') ?? '', /^default-src 'self';/);
  for (const [name, expected] of expectedHeaders) {
    assert.equal(response.headers.get(name), expected, `${name} should be present exactly once with its configured value`);
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function quoteNginx(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

test('Nginx delivers direct routes, JavaScript MIME/cache, safe redirects and existing proxies', async t => {
  if (process.platform === 'win32') return t.skip('real Nginx acceptance requires Linux');
  const version = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT') return t.skip('nginx binary is unavailable');
  assert.equal(version.status, 0, version.stderr);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'portal-route-nginx-'));
  const publicRoot = path.resolve('public');
  const staticRoot = path.join(tempDir, 'public');
  const api = createServer((req, res) => { res.end(`api:${req.url}`); });
  const cms = createServer((req, res) => { res.end(`cms:${req.url}`); });
  let nginx;
  let nginxOutput = '';
  t.after(async () => {
    if (nginx && nginx.exitCode === null) {
      const exited = once(nginx, 'exit');
      nginx.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await Promise.all([api, cms].map(server => new Promise(resolve => {
      server.closeAllConnections?.();
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })));
    await rm(tempDir, { recursive: true, force: true });
  });

  const [apiPort, cmsPort, listenPort] = await Promise.all([
    listen(api), listen(cms), reservePort(),
  ]);
  await mkdir(staticRoot);
  // Nginx workers need traversal through the private mkdtemp parent and the
  // synthetic document root; leave the checkout and its permissions untouched.
  await chmod(tempDir, 0o711);
  await chmod(staticRoot, 0o755);
  for (const entry of await readdir(publicRoot, { withFileTypes: true })) {
    await symlink(path.join(publicRoot, entry.name), path.join(staticRoot, entry.name), entry.isDirectory() ? 'dir' : 'file');
  }
  const hiddenFixture = '<!doctype html><title>Hidden fixture</title><p>route-recovery-secret</p>';
  await writeFile(path.join(staticRoot, '.route-recovery-hidden.html'), hiddenFixture);
  const serverConfig = (await readFile('nginx/nginx.conf', 'utf8'))
    .replace(/^    listen 80;$/m, `    listen 127.0.0.1:${listenPort};`)
    .replace('root /usr/share/nginx/html;', `root ${quoteNginx(staticRoot)};`)
    .replace('set $api_upstream http://api:3000;', `set $api_upstream http://127.0.0.1:${apiPort};`)
    .replace('set $cms_upstream http://cms:3001;', `set $cms_upstream http://127.0.0.1:${cmsPort};`);
  const configPath = path.join(tempDir, 'nginx.conf');
  await writeFile(configPath, [
    'worker_processes 1;',
    `pid ${quoteNginx(path.join(tempDir, 'nginx.pid'))};`,
    `error_log ${quoteNginx(path.join(tempDir, 'nginx-error.log'))} notice;`,
    'events { worker_connections 128; }',
    'http {',
    '  access_log off;',
    '  types { text/html html; text/css css; application/javascript js; image/svg+xml svg; }',
    '  default_type application/octet-stream;',
    serverConfig,
    '}',
  ].join('\n'));

  const prefix = `${tempDir}${path.sep}`;
  const checked = spawnSync('nginx', ['-t', '-p', prefix, '-c', configPath], { encoding: 'utf8' });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  nginx = spawn('nginx', ['-e', 'stderr', '-p', prefix, '-c', configPath, '-g', 'daemon off;'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  nginx.stdout.on('data', chunk => { nginxOutput += chunk; });
  nginx.stderr.on('data', chunk => { nginxOutput += chunk; });

  const baseUrl = `http://127.0.0.1:${listenPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    if (nginx.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/index.html`);
      ready = response.status === 200;
      await response.arrayBuffer();
    } catch { /* Nginx is still binding its loopback listener. */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) {
    const errorLog = await readFile(path.join(tempDir, 'nginx-error.log'), 'utf8').catch(error => `Unable to read Nginx error log: ${error.message}`);
    assert.fail(`Nginx did not become ready. stderr/stdout:\n${nginxOutput}\nerror log:\n${errorLog}`);
  }

  for (const route of ['/', '/index.html']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, `${route} should remain the root document`);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/i);
    assertSecurityHeaders(response);
    await response.arrayBuffer();
  }

  const router = await readFile('public/js/router.js', 'utf8');
  const routes = [...router.matchAll(/^\s*'([^']+\.html)': '([^']+)'/gm)];
  assert.equal(routes.length, 14);
  for (const [, route] of routes) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, `${route} should be a directly delivered HTML document`);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/i);
    assertSecurityHeaders(response);
    assert.match(await response.text(), /id="main-content"/, `${route} should be its Portal page, not generic index.html`);
  }

  const alias = await fetch(`${baseUrl}/autocard/`);
  assert.equal(alias.status, 200, '/autocard/ bookmark alias should remain available');
  assert.match(await alias.text(), /url=\.\.\/autocard\.html/);

  for (const resource of ['/js/router-bootstrap.js', '/js/owner-news/asset-path.mjs', '/css/tokens.css']) {
    const response = await fetch(`${baseUrl}${resource}`);
    assert.equal(response.status, 200, `${resource} should be delivered`);
    const contentType = response.headers.get('content-type') ?? '';
    if (resource.endsWith('.css')) assert.match(contentType, /^text\/css\b/i);
    else assert.match(contentType, /^(application|text)\/(javascript|ecmascript)\b/i);
    assert.equal(response.headers.get('cache-control'), 'no-cache', `${resource} should retain expires -1 behavior`);
    assertSecurityHeaders(response);
    await response.arrayBuffer();
  }

  const missingHtml = await fetch(`${baseUrl}/route-recovery-does-not-exist.html`);
  assert.equal(missingHtml.status, 404, 'missing .html must not receive index.html with a success status');
  assertSecurityHeaders(missingHtml);
  assert.equal(missingHtml.headers.get('cache-control'), null, '404 does not receive the success cache policy');
  assert.doesNotMatch(await missingHtml.text(), /class="portal-wrapper"/);

  const missingModule = await fetch(`${baseUrl}/js/route-recovery-does-not-exist.mjs`);
  assert.equal(missingModule.status, 404, 'a missing .mjs dependency must not receive HTML fallback');
  assertSecurityHeaders(missingModule);
  await missingModule.arrayBuffer();

  const hiddenHtml = await fetch(`${baseUrl}/.route-recovery-hidden.html`);
  assert.equal(hiddenHtml.status, 403, 'the hidden-file deny must win before the .html static matcher');
  assertSecurityHeaders(hiddenHtml);
  assert.doesNotMatch(await hiddenHtml.text(), /route-recovery-secret/);

  const editorial = await fetch(`${baseUrl}/editorial`, { redirect: 'manual' });
  assert.equal(editorial.status, 308);
  assert.equal(editorial.headers.get('location'), '/editorial/admin', 'redirect must be origin-relative behind TLS ingress');
  assertSecurityHeaders(editorial, { csp: false });

  const apiProxy = await fetch(`${baseUrl}/api/route-recovery-check.html`);
  assert.equal(apiProxy.status, 200);
  assert.equal(await apiProxy.text(), 'api:/api/route-recovery-check.html');
  assertSecurityHeaders(apiProxy);

  const cmsProxy = await fetch(`${baseUrl}/editorial/api/route-recovery-check.html`);
  assert.equal(cmsProxy.status, 200);
  assert.equal(await cmsProxy.text(), 'cms:/editorial/api/route-recovery-check.html');
  assertSecurityHeaders(cmsProxy, { csp: false });
});
