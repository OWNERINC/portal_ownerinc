import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('optional Compose overlay renders the shared-cluster manual runtime without a scheduled worker', async t => {
  const parserEnvironment = Object.fromEntries(['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const result = spawnSync('docker', ['compose', '--profile', 'cms-bootstrap', '--profile', 'cms-control-roles', '--env-file', '.env.example',
    '-f', 'docker-compose.yml', '-f', 'docker-compose.payload.yml', 'config', '--format', 'json'], {
    encoding: 'utf8', timeout: 20000,
    // Do not inherit real runtime secrets or image settings into the parser.
    env: parserEnvironment,
  });
  if (result.error?.code === 'ENOENT') { t.skip('Docker Compose parser unavailable; no service attempted'); return; }
  assert.equal(result.status, 0, 'Compose parse failed (configuration output intentionally withheld)');
  const config = JSON.parse(result.stdout);
  const s = config.services;
  for (const service of ['postgres', 'cms-cluster-bootstrap', 'cms-provision', 'cms-control-roles', 'cms-migrate', 'cms-preauthority-verify', 'cms']) assert.ok(s[service]);
  assert.equal(s['cms-postgres'], undefined);
  assert.equal(s['cms-worker'], undefined, 'manual runtime must not resolve the scheduled worker');
  for (const service of ['cms-provision', 'cms-control-roles', 'cms-migrate', 'cms-preauthority-verify', 'cms']) assert.equal(s[service].image, s.cms.image);
  assert.equal(config.volumes.cms_postgres_data, undefined);
  assert.equal(s.cms.ports, undefined);
  assert.equal(s.cms.build.context.replaceAll('\\', '/'), path.resolve('.').replaceAll('\\', '/'));
  assert.equal(s.cms.build.dockerfile, 'cms/Dockerfile');
  assert.match(s['cms-migrate'].environment.CMS_DATABASE_URL, /cms_migrator:/);
  for (const service of ['cms-cluster-bootstrap', 'cms-provision', 'cms-control-roles', 'cms-migrate', 'cms-preauthority-verify']) {
    assert.equal(s[service].environment.CMS_PORTAL_DATABASE_NAME, 'portal');
  }
  assert.equal(s.cms.environment.CMS_PORTAL_DATABASE_NAME, undefined,
    'the web runtime does not receive database-administration configuration');
  assert.equal(s['cms-control-roles'].environment.CMS_CONTROLLER_PASSWORD,
    'placeholder-cms-controller-password-for-explicit-bootstrap-only');
  assert.deepEqual(s['cms-control-roles'].command,
    ['node', '--import', 'tsx', 'scripts/provision-db.ts', '--verify-control']);
  assert.deepEqual(s['cms-control-roles'].profiles, ['cms-control-roles']);
  assert.match(s.cms.environment.CMS_DATABASE_URL, /cms_runtime:/);
  assert.equal(s.cms.environment.CMS_PUBLICATION_MODE, 'manual');
  for (const service of ['cms']) {
    assert.equal(s[service].environment.CMS_ADMIN_DATABASE_URL, undefined);
    assert.equal(s[service].environment.CMS_OWNER_DATABASE_URL, undefined);
    assert.equal(s[service].environment.CMS_MIGRATOR_PASSWORD, undefined);
    assert.equal(s[service].environment.DATABASE_URL, undefined);
    assert.equal(s[service].volumes[0].source, 'cms_uploads_data');
    assert.equal(s[service].volumes[0].target, '/var/lib/ownerinc-cms/media');
    assert.equal(s[service].environment.CMS_UPLOAD_DIR, s[service].volumes[0].target);
    assert.ok(!s[service].environment.CMS_UPLOAD_DIR.startsWith('/app/'));
  }
  assert.equal(s['cms-provision'].environment.CMS_CONTROLLER_PASSWORD, undefined,
    'ordinary CMS provisioning never receives the controller credential');
  assert.equal(s['cms-provision'].environment.CMS_MIGRATOR_PASSWORD, undefined);
  assert.equal(s['cms-provision'].environment.CMS_RUNTIME_PASSWORD, undefined);
  assert.match(s['cms-cluster-bootstrap'].environment.CMS_DATABASE_URL, /portal_admin:.*@postgres:5432\/postgres/u);
  for (const secret of ['CMS_POSTGRES_PASSWORD', 'CMS_CONTROLLER_PASSWORD', 'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD']) {
    assert.ok(s['cms-cluster-bootstrap'].environment[secret]);
  }
  assert.equal(s['cms-control-roles'].environment.CMS_MIGRATOR_PASSWORD, undefined);
  assert.equal(s['cms-control-roles'].environment.CMS_RUNTIME_PASSWORD, undefined);
  for (const service of ['cms-provision', 'cms-control-roles', 'cms-migrate', 'cms-preauthority-verify', 'cms']) {
    assert.equal(service === 'cms-cluster-bootstrap' ? null : s[service].environment.POSTGRES_PASSWORD, undefined);
  }
  assert.equal(s.api.environment.CMS_INTERNAL_URL, 'http://cms:3001');
  assert.equal(s.cms.depends_on['cms-migrate'].condition, 'service_completed_successfully');
  assert.match(s['cms-preauthority-verify'].environment.CMS_ADMIN_DATABASE_URL,
    /^postgresql:\/\/cms_admin:placeholder-cms-admin-password-not-for-runtime@postgres:5432\/ownerinc_cms$/u);
  assert.equal(s['cms-preauthority-verify'].environment.CMS_DATABASE_URL, undefined);
  assert.equal(s['cms-preauthority-verify'].restart, 'no');
  assert.equal(s.cron.environment.CRON_BOOTSTRAP_ONLY, 'false', 'production Compose must retain the normal cron default');

  assert.doesNotMatch(await readFile('docker-compose.payload.yml', 'utf8'), /cms-worker|scheduled-publication/);

  const fixtureResult = spawnSync('docker', ['compose', '--env-file', '.env.example', '-f', 'docker-compose.yml',
    '-f', 'docker-compose.payload.yml', '-f', 'scripts/integration/payload-preauthority-fixture.compose.yml',
    '--profile', 'cms-bootstrap', '--profile', 'cms-control-roles', 'config', '--format', 'json'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...parserEnvironment, CMS_IMAGE: 'local/fixture-cms:synthetic' },
  });
  assert.equal(fixtureResult.status, 0, 'disposable fixture Compose parse failed (output intentionally withheld)');
  const fixtureConfig = JSON.parse(fixtureResult.stdout);
  assert.equal(fixtureConfig.services.cron.environment.CRON_BOOTSTRAP_ONLY, 'true',
    'the isolated fixture overlay must forward bootstrap-only mode to the actual cron service');
  const roles = fixtureConfig.services['cms-control-roles'];
  assert.ok(roles, 'the explicitly profiled role service must render for the disposable fixture');
  assert.equal(roles.image, 'local/fixture-cms:synthetic');
  assert.deepEqual(roles.command, ['node', '--import', 'tsx', 'scripts/provision-db.ts', '--verify-control']);
  assert.equal(roles.environment.CMS_CONTROLLER_PASSWORD,
    'placeholder-cms-controller-password-for-explicit-bootstrap-only');
  assert.equal(roles.environment.CMS_DATABASE_URL, fixtureConfig.services['cms-provision'].environment.CMS_DATABASE_URL);
  assert.equal(fixtureConfig.services['cms-provision'].environment.CMS_CONTROLLER_PASSWORD, undefined,
    'the controller credential stays scoped to the one-shot role service');
  assert.ok(roles.profiles.includes('cms-control-roles'));
});

test('Portal and CMS role authorities remain explicitly separate', async () => {
  const [cmsProvisioner, portalProvisioner, migrationDoc] = await Promise.all([
    readFile('cms/scripts/provision-db.ts', 'utf8'),
    readFile('api/db/provision.js', 'utf8'),
    readFile('docs/operations/owner-news-payload-migration.md', 'utf8'),
  ]);
  for (const role of ['cms_admin', 'cms_control', 'cms_controller', 'cms_migrator', 'cms_runtime', 'cms_observer']) {
    assert.match(cmsProvisioner, new RegExp(`CREATE ROLE ${role} `, 'u'));
    assert.doesNotMatch(portalProvisioner, new RegExp(`CREATE ROLE ${role}\\b`, 'u'));
  }
  for (const role of ['portal_api', 'portal_cron']) {
    assert.match(portalProvisioner, new RegExp(`CREATE ROLE ${role} LOGIN`, 'u'));
    assert.doesNotMatch(cmsProvisioner, new RegExp(`CREATE ROLE ${role}\\b`, 'u'));
  }
  assert.match(migrationDoc, /único criador e reconciliador das seis roles CMS/u);
  assert.match(migrationDoc, /api\/db\/provision\.js[\s\S]*portal_api[\s\S]*portal_cron/u);
});

test('owned Docker, Nginx and shell artifacts retain LF', async () => {
  for (const file of ['cms/Dockerfile', 'cms/Dockerfile.dockerignore', 'cms/.dockerignore', 'cron/Dockerfile', 'nginx/nginx.conf', 'docker-compose.payload.yml',
    'scripts/payload-operations.sh', 'scripts/payload-release.sh', 'scripts/release-manifest.sh',
    'scripts/backup.sh', 'scripts/restore.sh', 'scripts/release.sh', 'scripts/backup-s3.sh',
    'ops/deploy-from-ci.sh', 'ops/backup-from-timer.sh', 'ops/payload-operations-guard.sh', 'ops/payload-writer.sh',
    'ops/payload-control', 'deploy.sh']) {
    assert.equal((await readFile(file, 'utf8')).includes('\r'), false, file);
  }
});

test('current recovery runbook uses only the shared cluster, cms.dump, and three-volume contract', async () => {
  const documentation = await readFile('docs/operations/payload-runtime-recovery.md', 'utf8');
  const stack = documentation.slice(documentation.indexOf('## Stack opcional e credenciais'), documentation.indexOf('## Proxy e CSP'));
  const backup = documentation.slice(documentation.indexOf('## Release e formato de backup'), documentation.indexOf('## Lease e barreira externa'));
  const preparation = documentation.slice(documentation.indexOf('## Preparação inicial da infraestrutura'), documentation.indexOf('### Rollback manual'));
  assert.match(stack, /serviço `postgres`[\s\S]*três[\s\S]*`postgres_data`, `uploads_data` e `cms_uploads_data`/u);
  assert.doesNotMatch(stack, /cms-postgres|cms_postgres_data|quatro volumes/u);
  assert.match(backup, /payload-v2-shared-postgres[\s\S]*cms\.dump/u);
  assert.match(backup, /`payload-v1` com[\s\S]*é formato histórico/u);
  assert.doesNotMatch(preparation, /cms-postgres:5432|cms_postgres_data|quatro\s+volumes/u);
  assert.match(documentation, /## Histórico — P3/u);
  assert.match(documentation, /### Histórico — binding de produção v3/u);
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
    'ops/deploy-from-ci.sh', 'ops/backup-from-timer.sh', 'ops/payload-operations-guard.sh', 'ops/payload-writer.sh',
    'ops/payload-control', 'deploy.sh']) {
    const result = spawnSync(bash, ['-n', file], { encoding: 'utf8', timeout: 5000 });
    if (result.error?.code === 'ENOENT') { t.skip('Bash unavailable'); return; }
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('cold deploy signs its legacy source backup before provisioning and never starts the worker', async () => {
  const [receiver, operations, manualRelease, guard, runtime] = await Promise.all([
    readFile('ops/deploy-from-ci.sh', 'utf8'),
    readFile('scripts/payload-operations.sh', 'utf8'),
    readFile('scripts/payload-release.sh', 'utf8'),
    readFile('ops/payload-operations-guard.sh', 'utf8'),
    readFile('ops/payload-control-runtime.py', 'utf8'),
  ]);
  const proof = receiver.indexOf('backup-metadata "$release" "$backup/preauthority-proof.json"');
  const provision = receiver.indexOf('migration_started=true');
  assert.ok(proof >= 0 && provision > proof, 'cold source proof must be durable before migrations/provisioning');
  for (const [name, source] of [['CI deploy', receiver], ['manual deploy', manualRelease]]) {
    const clusterBootstrap = source.indexOf('--profile cms-bootstrap run --rm --no-deps cms-cluster-bootstrap');
    const provisionRoles = source.indexOf('cms-provision', clusterBootstrap);
    const verifyRoles = source.indexOf('--profile cms-control-roles run --rm --no-deps cms-control-roles', provisionRoles);
    const bootstrapRoles = source.indexOf('--bootstrap-control', verifyRoles);
    const nativeMigration = source.indexOf('cms-migrate', bootstrapRoles);
    assert.ok(clusterBootstrap >= 0 && provisionRoles > clusterBootstrap && verifyRoles > provisionRoles && bootstrapRoles > verifyRoles
      && nativeMigration > bootstrapRoles,
    `${name} runs cluster bootstrap before ordinary provisioning, then verifies/bootstrap grants before native migrations`);
    assert.ok(source.slice(verifyRoles - 40, verifyRoles).includes('if !'),
      `${name} keeps bootstrap conditional on the read-only role verification`);
  }
  assert.match(await readFile('docker-compose.payload.yml', 'utf8'),
    /cms-migrate:[\s\S]*npm run migrate && node --import tsx scripts\/provision-db\.ts --grants/u,
    'the shared migration service must run observer relation provisioning through --grants after migrations');
  assert.doesNotMatch(receiver, /cms-worker|scheduled-publication/);
  assert.ok(receiver.indexOf('close-admission "$release" ||') < receiver.indexOf('rollback-check "$release"'),
    'failed deploy rollback must retain the admission fence before recovery checks');
  assert.match(manualRelease, /compose "\$release" stop --timeout 120 nginx api cron cms[\s\S]*?guard close-admission/u);
  assert.doesNotMatch(receiver, /compose_for[^\n]*up[^\n]*cms-worker/u);
  assert.doesNotMatch(operations, /(?:compose\s+)?(?:start|up)[^\n]*cms-worker/u);
  assert.doesNotMatch(manualRelease, /compose[^\n]*up[^\n]*cms-worker/u);
  const manualOperation = manualRelease.slice(manualRelease.indexOf('backup_dir='));
  assert.ok(manualOperation.indexOf('backup_output=') < manualOperation.indexOf('guard close-admission'),
    'the coordinator must run its admission-open release preflight before closing the fence');
  assert.match(manualRelease, /COMPOSE_ENV_FILE=.*production\.runtime\.conf/u);
  assert.ok(manualRelease.lastIndexOf('mv -fT "$current_tmp" "$current_file"') < manualRelease.lastIndexOf('guard open-admission'),
    'manual release must publish the canonical pointer before reopening writer admission');
  assert.ok(receiver.lastIndexOf('mv "$current_tmp" "$current_file"') < receiver.lastIndexOf('open-admission "$release"'),
    'CI deploy must publish the canonical pointer before reopening writer admission');
  assert.match(operations, /compose stop --timeout 120 nginx api cron cms/);
  assert.match(operations, /^PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin\nexport PATH/m,
    'production coordinator must not resolve Docker, lock or archive tools from an operator-controlled PATH');
  assert.match(operations, /env -i PATH="\$PATH" HOME="\$\{HOME:-\/root\}" docker compose/,
    'Compose receives only the protected PATH/home and its explicit env-files, not ambient Docker overrides');
  assert.match(guard, /prepare-restore\|portal-restore-intermediate\|verify-restored/u);
  assert.match(runtime, /'restore-preflight', 'prepare-restore', 'portal-restore-intermediate'/u);
});

test('out-of-band Payload writers require both signed open admission and no closed sentinel', async () => {
  const writer = await readFile('ops/payload-writer.sh', 'utf8');
  assert.match(writer, /verify-admission "\$runtime" open/u);
  assert.match(writer, /! -e \$PORTAL_OPERATION_LOCK\.admission-closed && ! -L/u);
});
