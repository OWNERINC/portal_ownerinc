import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('compose limits exposure and waits for API readiness', async () => {
  const compose = await read('docker-compose.yml');
  assert.match(compose, /127\.0\.0\.1.*HTTP_PORT/);
  assert.doesNotMatch(compose, /env_file:/);
  assert.match(compose, /api:[\s\S]*healthcheck:[\s\S]*\/api\/ready/);
  assert.match(compose, /nginx:[\s\S]*condition: service_healthy/);
  assert.match(compose, /image: \$\{API_IMAGE:-local\/ownerinc-portal-api:latest\}/);
  assert.match(compose, /migrate:[\s\S]*RUN_MIGRATIONS: "true"[\s\S]*service_completed_successfully/);
  const apiRuntime = compose.match(/\n  api:\n([\s\S]*?)(?=\n  nginx:)/)?.[1] || '';
  assert.doesNotMatch(apiRuntime, /MIGRATION_DATABASE_URL|PORTAL_API_DB_PASSWORD|PORTAL_CRON_DB_PASSWORD/);
  assert.match(compose, /postgres:16-alpine@sha256:/);
  assert.match(compose, /nginx:alpine@sha256:/);
});

test('local simulation isolates Firebase and keeps bootstrap SQL typed', async () => {
  const [compose, emulator, bootstrap] = await Promise.all([
    read('docker-compose.yml'), read('firebase-emulator/Dockerfile'), read('api/db/bootstrap-admin.js'),
  ]);
  assert.match(compose, /firebase-auth:[\s\S]*profiles: \["local"\]/);
  assert.match(compose, /127\.0\.0\.1:9099:9099/);
  assert.match(emulator, /127\\\.0\\\.0\\\.1\/0\.0\.0\.0/);
  assert.match(bootstrap, /jsonb_build_object\('email', \$2::text\)/);
});

test('Sólides credentials stay in the API and release defaults to off', async () => {
  const [compose, example, frontend] = await Promise.all([
    read('docker-compose.yml'), read('.env.example'),
    Promise.all(['dashboard', 'solides', 'admin'].map((name) => read(`public/js/${name}.js`))).then((files) => files.join('\n')),
  ]);
  const api = compose.match(/\n  api:\n([\s\S]*?)(?=\n  nginx:)/)?.[1] || '';
  const nonApi = compose.replace(api, '');
  assert.match(api, /SOLIDES_TOKEN: \$\{SOLIDES_TOKEN:-\}/);
  assert.match(api, /SOLIDES_RELEASE_STAGE: \$\{SOLIDES_RELEASE_STAGE:-off\}/);
  assert.doesNotMatch(nonApi, /SOLIDES_TOKEN:/);
  assert.match(example, /SOLIDES_RELEASE_STAGE=off/);
  assert.doesNotMatch(frontend, /SOLIDES_TOKEN|Authorization:\s*`Basic/);
});

test('runtime API role can read and manage job titles', async () => {
  const provision = await read('api/db/provision.js');
  assert.match(provision, /GRANT SELECT, INSERT, UPDATE, DELETE ON job_titles TO portal_api/);
});

test('Sólides upstream traffic has per-user read and probe budgets', async () => {
  const routes = await readFile('api/routes/solides.js', 'utf8');
  assert.match(routes, /employeeRequestLimit = rateLimit\(\{ windowMs: 5 \* 60 \* 1000, max: 60, key: \(req\) => req\.user\.uid \}\)/);
  assert.match(routes, /adminProbeLimit = rateLimit\(\{ windowMs: 5 \* 60 \* 1000, max: 10, key: \(req\) => req\.user\.uid \}\)/);
  for (const route of ['summary', 'punches', 'hours-balance', 'schedule', 'adjustments']) {
    assert.match(routes, new RegExp(`router\\.get\\('/me/${route}', authMiddleware, employeeRequestLimit`));
  }
  assert.match(routes, /router\.post\('\/admin\/probe', authMiddleware, adminProbeLimit/);
});

test('nginx protects the edge without shadowing uploads', async () => {
  const nginx = await read('nginx/nginx.conf');
  for (const header of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options']) {
    assert.match(nginx, new RegExp(`add_header ${header}`));
  }
  assert.match(nginx, /location \^~ \/uploads\//);
  assert.match(nginx, /client_max_body_size 100k;/);
  assert.match(nginx, /location \^~ \/api\/upload\/[\s\S]*client_max_body_size 4m;[\s\S]*limit_req zone=uploads/);
  assert.doesNotMatch(nginx, /script-src[^;"]*'unsafe-inline'/);
  assert.match(nginx, /limit_req_zone[\s\S]*map \$http_sec_fetch_site/);
  assert.match(nginx, /https:\/\/unpkg\.com/);
  assert.match(nginx, /https:\/\/www\.gstatic\.com/);
  assert.match(nginx, /font-src 'self'/);
});

test('deployment uses a committed archive, backup, smoke gate, and rollback', async () => {
  const [deploy, release, restore, backup] = await Promise.all([
    read('deploy.sh'), read('scripts/release.sh'), read('scripts/restore.sh'), read('scripts/backup.sh'),
  ]);
  assert.match(deploy, /git diff --quiet --exit-code HEAD/);
  assert.match(deploy, /git archive[\s\S]*exclude\)ownerinc-novo-agente/);
  assert.match(release, /scripts\/backup\.sh/);
  assert.match(release, /scripts\/smoke\.sh/);
  assert.match(release, /db\/verify-migrations\.js/);
  assert.match(release, /RUN_MIGRATIONS=false/);
  assert.match(release, /docker pull "\$api_tag"[\s\S]*docker pull "\$cron_tag"/);
  assert.match(release, /RepoDigests[\s\S]*@sha256/);
  assert.doesNotMatch(release, /docker compose[^\n]*\sbuild(?:\s|$)/);
  assert.match(release, /rolling back containers/);
  assert.match(restore, /--confirm && \$\{3:-\} == RESTORE/);
  assert.match(restore, /manifest\.sha256/);
  assert.match(restore, /LEAVE_STOPPED=true/);
  assert.match(restore, /pg_restore --single-transaction/);
  assert.match(restore, /services remain stopped/);
  assert.match(backup, /stop "\$\{stopped\[@\]\}"[\s\S]*pg_dump[\s\S]*uploads[\s\S]*restore_services/);
});

test('CI builds and publishes commit-addressed production images', async () => {
  const [workflow, apiPackage] = await Promise.all([
    read('.github/workflows/ci.yml'), read('api/package.json'),
  ]);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /ownerinc-portal-api:\$\{GITHUB_SHA\}/);
  assert.match(workflow, /docker push \$\{REGISTRY\}\/ownerinc-portal-api:\$\{GITHUB_SHA\}/);
  assert.match(workflow, /Test migrations against PostgreSQL/);
  const actionReferences = [...workflow.matchAll(/^\s*[-]?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(actionReferences.length > 0);
  assert.equal(
    actionReferences.filter((reference) => !/@[0-9a-f]{40}$/.test(reference)).length,
    0,
    'every GitHub Action must be pinned to an immutable commit SHA',
  );
  assert.match(apiPackage, /"sharp": "\^0\.35\.3"/);
});

test('green main commits deploy through a restricted serialized production gate', async () => {
  const [workflow, hostDeploy, productionCompose] = await Promise.all([
    read('.github/workflows/ci.yml'), read('ops/deploy-from-ci.sh'),
    read('ops/compose.production.yaml'),
  ]);
  assert.match(workflow, /deploy-production:[\s\S]*needs: validate/);
  assert.match(workflow, /group: portal-ownerinc-production[\s\S]*cancel-in-progress: false/);
  assert.match(workflow, /--add-virtual-file="\.ci-commit:\$\{GITHUB_SHA\}"/);
  assert.match(workflow, /PORTAL_VPS_SSH_KEY/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /test "\$VPS_USER" != root/);
  assert.match(hostDeploy, /SSH_ORIGINAL_COMMAND/);
  assert.match(hostDeploy, /flock -n/);
  assert.match(hostDeploy, /archive commit does not match requested commit/);
  assert.match(hostDeploy, /pg_dump --format=custom/);
  assert.match(hostDeploy, /pg_restore --clean --if-exists --no-owner --single-transaction/);
  assert.match(hostDeploy, /compose_for "\$release" run --rm migrate/);
  assert.match(hostDeploy, /Production readiness did not recover/);
  assert.match(hostDeploy, /restoring the previous production release/);
  assert.match(hostDeploy, /find "\$staging" -type d -exec chmod 0755/);
  assert.match(hostDeploy, /find "\$staging" -type f -exec chmod 0644/);
  assert.match(productionCompose, /postgres:[\s\S]*volumes: !override[\s\S]*postgres_data/);
});
