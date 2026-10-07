import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('optional Compose overlay renders isolated roles, volumes and one CMS image without starting Docker', t => {
  const result = spawnSync('docker', ['compose', '--env-file', '.env.example', '-f', 'docker-compose.yml', '-f', 'docker-compose.payload.yml', 'config', '--format', 'json'], {
    encoding: 'utf8', timeout: 20000,
    // Do not inherit real runtime secrets or image settings into the parser.
    env: Object.fromEntries(['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  });
  if (result.error?.code === 'ENOENT') { t.skip('Docker Compose parser unavailable; no service attempted'); return; }
  assert.equal(result.status, 0, 'Compose parse failed (configuration output intentionally withheld)');
  const config = JSON.parse(result.stdout);
  const s = config.services;
  for (const service of ['cms-postgres', 'cms-provision', 'cms-migrate', 'cms', 'cms-worker']) assert.ok(s[service]);
  for (const service of ['cms-provision', 'cms-migrate', 'cms', 'cms-worker']) assert.equal(s[service].image, s.cms.image);
  assert.equal(s['cms-postgres'].ports, undefined);
  assert.equal(s.cms.ports, undefined);
  assert.equal(s.cms.build.context.replaceAll('\\', '/'), path.resolve('.').replaceAll('\\', '/'));
  assert.equal(s.cms.build.dockerfile, 'cms/Dockerfile');
  assert.equal(s['cms-worker'].deploy.replicas, 1);
  assert.match(s['cms-migrate'].environment.CMS_DATABASE_URL, /cms_migrator:/);
  assert.match(s.cms.environment.CMS_DATABASE_URL, /cms_runtime:/);
  assert.equal(s.cms.environment.CMS_DATABASE_URL, s['cms-worker'].environment.CMS_DATABASE_URL);
  for (const service of ['cms', 'cms-worker']) {
    assert.equal(s[service].environment.CMS_ADMIN_DATABASE_URL, undefined);
    assert.equal(s[service].environment.CMS_MIGRATOR_PASSWORD, undefined);
    assert.equal(s[service].environment.DATABASE_URL, undefined);
    assert.equal(s[service].volumes[0].source, 'cms_uploads_data');
    assert.equal(s[service].volumes[0].target, '/var/lib/ownerinc-cms/media');
    assert.equal(s[service].environment.CMS_UPLOAD_DIR, s[service].volumes[0].target);
    assert.ok(!s[service].environment.CMS_UPLOAD_DIR.startsWith('/app/'));
  }
  assert.equal(s['cms-postgres'].volumes[0].source, 'cms_postgres_data');
  assert.equal(s.api.environment.CMS_INTERNAL_URL, 'http://cms:3001');
  assert.equal(s.cms.depends_on['cms-migrate'].condition, 'service_completed_successfully');
});

test('owned Docker, Nginx and shell artifacts retain LF', async () => {
  for (const file of ['cms/Dockerfile', 'cms/Dockerfile.dockerignore', 'cms/.dockerignore', 'cron/Dockerfile', 'nginx/nginx.conf', 'docker-compose.payload.yml',
    'scripts/payload-operations.sh', 'scripts/payload-release.sh', 'scripts/release-manifest.sh',
    'scripts/backup.sh', 'scripts/restore.sh', 'scripts/release.sh', 'scripts/backup-s3.sh',
    'ops/deploy-from-ci.sh', 'ops/backup-from-timer.sh', 'ops/payload-operations-guard.sh', 'ops/payload-writer.sh', 'deploy.sh']) {
    assert.equal((await readFile(file, 'utf8')).includes('\r'), false, file);
  }
});

test('CMS Dockerfile uses an explicit root-context packaging closure, not a broad copy', async () => {
  const dockerfile = await readFile('cms/Dockerfile', 'utf8');
  const ignore = await readFile('cms/Dockerfile.dockerignore', 'utf8');
  assert.match(dockerfile, /WORKDIR \/app\/cms/);
  assert.match(dockerfile, /WORKDIR \/app\/api/);
  assert.match(dockerfile, /COPY scripts\/owner-news-payload\/bundle\.mjs[^\n]* \/app\/scripts\/owner-news-payload\//);
  assert.match(dockerfile, /COPY api\/owner-news\/editorial\.js api\/owner-news\/home\.js api\/owner-news\/authority\.js \/app\/api\/owner-news\//);
  assert.match(dockerfile, /COPY api\/package\.json api\/package-lock\.json/);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(dockerfile, /RUN node --import tsx scripts\/check-runtime-packaging\.mjs/);
  assert.doesNotMatch(dockerfile, /^\s*COPY\s+\.\s+/m);
  assert.doesNotMatch(ignore, /!\.env|!.*state\.json|!.*compose\.env/);
  for (const required of ['!cms/src/**', '!cms/scripts/import-owner-news.ts', '!api/package-lock.json',
    '!api/cms/blocks.js', '!api/owner-news/authority.js', '!scripts/import-owner-news.mjs',
    '!scripts/owner-news-payload/bundle.mjs', '!scripts/owner-news-payload/files.mjs']) assert.ok(ignore.includes(required), required);
  for (const forbidden of ['env.json', 'state.json', 'compose.env', '*.pem', '*.key', '.git', '.superpowers', 'node_modules']) assert.ok(ignore.includes(forbidden), forbidden);
});

test('each owned operational script parses independently', t => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  for (const file of ['scripts/payload-operations.sh', 'scripts/payload-release.sh', 'scripts/release-manifest.sh',
    'scripts/backup.sh', 'scripts/restore.sh', 'scripts/release.sh', 'scripts/backup-s3.sh',
    'ops/deploy-from-ci.sh', 'ops/backup-from-timer.sh', 'ops/payload-operations-guard.sh', 'ops/payload-writer.sh', 'deploy.sh']) {
    const result = spawnSync(bash, ['-n', file], { encoding: 'utf8', timeout: 5000 });
    if (result.error?.code === 'ENOENT') { t.skip('Bash unavailable'); return; }
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
