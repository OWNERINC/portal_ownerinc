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

test('API and cron require shared Resend SMTP configuration', async () => {
  const [compose, example, verify] = await Promise.all([
    read('docker-compose.yml'), read('.env.example'), read('scripts/verify.mjs'),
  ]);
  const api = compose.match(/\n  api:\n([\s\S]*?)(?=\n  nginx:)/)?.[1] || '';
  const cron = compose.match(/\n  cron:\n([\s\S]*?)(?=\nvolumes:)/)?.[1] || '';
  const required = ['SMTP_ADDRESS', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'MAILER_SENDER_EMAIL'];

  for (const variable of required) {
    const declaration = new RegExp(`${variable}: \\\${${variable}:\\?Set ${variable}}`);
    assert.match(api, declaration);
    assert.match(cron, declaration);
  }

  assert.doesNotMatch(api, /SENDGRID_API_KEY|SENDGRID_FROM_EMAIL/);
  assert.doesNotMatch(cron, /SENDGRID_API_KEY|SENDGRID_FROM_EMAIL/);
  assert.match(example, /SMTP_ADDRESS=smtp\.resend\.com/);
  assert.match(example, /SMTP_PORT=465/);
  assert.match(example, /SMTP_USERNAME=resend/);
  assert.match(cron, /OPERATIONAL_ALERT_EMAIL: \$\{OPERATIONAL_ALERT_EMAIL:-\}/);
  assert.match(verify, /SMTP_PASSWORD=re_\[A-Za-z0-9_-\]\{10,\}/);
  assert.match(verify, /new Set\(\['\.env\.example'/);
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

test('job title listing hides inactive titles by default', async () => {
  const routes = await read('api/routes/job-titles.js');
  assert.match(routes, /const where = req\.query\.all === 'true' \? '' : 'WHERE jt\.active = TRUE';/);
  assert.match(routes, /COUNT\(\*\)::integer AS count FROM job_titles jt \$\{where\}/);
  assert.match(routes, /LEFT JOIN users u ON u\.job_title_id = jt\.id \$\{where\}/);
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
  assert.match(nginx, /location \^~ \/api\/autocard\/media[\s\S]*client_max_body_size 4m;[\s\S]*limit_req zone=uploads/);
  assert.match(nginx, /location \^~ \/api\/pos-cards\/media[\s\S]*client_max_body_size 4m;[\s\S]*limit_req zone=uploads[\s\S]*proxy_pass \$api_upstream/);
  const cmsAssets = nginx.indexOf('location ^~ /api/cms/assets');
  const genericApi = nginx.indexOf('location /api/');
  assert.ok(cmsAssets >= 0 && cmsAssets < genericApi);
  assert.match(nginx, /location \^~ \/api\/cms\/assets[\s\S]*client_max_body_size 50m;[\s\S]*limit_req zone=uploads[\s\S]*proxy_pass \$api_upstream/);
  assert.doesNotMatch(nginx, /location[^\n]*\/uploads\/cms-private/);
  assert.doesNotMatch(nginx, /script-src[^;"]*'unsafe-inline'/);
  assert.match(nginx, /media-src 'self' blob: https:/);
  assert.doesNotMatch(nginx, /media-src[^;"]*(data:|http:\/\/)/);
  assert.match(nginx, /script-src 'self' https:\/\/unpkg\.com https:\/\/www\.gstatic\.com https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(nginx, /style-src 'self' 'unsafe-inline'/);
  assert.match(nginx, /connect-src 'self' http:\/\/127\.0\.0\.1:9099 http:\/\/localhost:9099 https:\/\/\*\.googleapis\.com https:\/\/\*\.firebaseio\.com/);
  assert.match(nginx, /limit_req_zone[\s\S]*map \$http_sec_fetch_site/);
  assert.match(nginx, /https:\/\/unpkg\.com/);
  assert.match(nginx, /https:\/\/www\.gstatic\.com/);
  assert.match(nginx, /font-src 'self'/);
  assert.match(nginx, /resolver 127\.0\.0\.11 valid=30s/);
  assert.match(nginx, /set \$api_upstream http:\/\/api:3000/);
  assert.match(nginx, /proxy_pass \$api_upstream/);
  assert.match(nginx, /location ~\* \\\.\(css\|js\)\$ \{[\s\S]*expires -1;[\s\S]*Cache-Control "no-cache"/);
  assert.match(nginx, /location ~\* \\\.\(svg\|png\|jpg\|jpeg\|ico\|woff2\)\$ \{[\s\S]*expires 7d;/);
});

test('complete Pos-Card storage filenames are denied before static uploads', async () => {
  const index = await read('api/index.js');
  const deny = index.indexOf("/^\\/pos-card-[0-9a-f-]+\\.webp$/i.test(req.path)");
  const uploads = index.indexOf("app.use('/uploads', express.static('/app/uploads'))");
  assert.ok(deny >= 0 && deny < uploads);
});

test('deployment uses a committed archive, backup, smoke gate, and rollback', async () => {
  const [deploy, release, restore, backup, backupS3, alert] = await Promise.all([
    read('deploy.sh'), read('scripts/release.sh'), read('scripts/restore.sh'), read('scripts/backup.sh'), read('scripts/backup-s3.sh').catch(() => ''), read('cron/sendOperationalAlert.js'),
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
  assert.match(backupS3, /BACKUP_DIR/);
  assert.match(backupS3, /s3 cp --recursive/);
  assert.match(alert, /sendOperationalAlert/);
  const smoke = await read('scripts/smoke.sh');
  assert.match(smoke, /api\/health/);
  assert.match(smoke, /api\/ready/);
  assert.match(smoke, /autocard\//);
});

test('cron health deduplicates SMTP alerts and sends recovery notifications', async () => {
  const [health, compose, example, packageJson] = await Promise.all([
    read('cron/health.js'), read('docker-compose.yml'), read('.env.example'), read('cron/package.json'),
  ]);
  assert.match(health, /alert_signature/);
  assert.match(health, /worker recuperado/);
  assert.match(health, /worker atrasado/);
  assert.match(compose, /OPERATIONAL_ALERT_EMAIL: \$\{OPERATIONAL_ALERT_EMAIL:-\}/);
  assert.match(example, /OPERATIONAL_ALERT_EMAIL=/);
  assert.match(packageJson, /"nodemailer"/);
});

test('AutoCard media retention is scheduled, locked, and volume-safe', async () => {
  const [cron, cleanup, compose] = await Promise.all([
    read('cron/index.js'), read('cron/autocard-media-retention.js'), read('docker-compose.yml'),
  ]);
  assert.match(cron, /enforceAutocardMediaRetention/);
  assert.match(cron, /cron\.schedule\('30 3 \* \* \*', runRetention/);
  assert.match(cron, /retentionTask\.stop\(\)/);
  assert.match(cleanup, /pg_try_advisory_lock/);
  assert.match(cleanup, /pg_advisory_unlock/);
  assert.doesNotMatch(cleanup, /LOCK TABLE autocard_cards IN SHARE MODE/);
  assert.match(cleanup, /7193003/);
  assert.match(cleanup, /autocard_media/);
  assert.match(cleanup, /m\.created_at < NOW\(\) - \(\$1::integer \* INTERVAL '1 day'\)/);
  assert.equal((cleanup.match(/NOT EXISTS \([\s\S]*?autocard_cards[\s\S]*?c\.media_id = m\.id/g) || []).length, 2);
  assert.match(cleanup, /DELETE FROM autocard_media[\s\S]*m\.storage_key ~ '\$\{STORAGE_KEY_SQL_PATTERN\}'[\s\S]*NOT EXISTS/);
  assert.match(cleanup, /autocard-\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/);
  assert.match(cleanup, /isSafeStorageKey/);
  assert.match(cleanup, /path\.join\(uploadDirectory, storageKey\)/);
  assert.match(cleanup, /autocard_media\.retention/);
  assert.match(cleanup, /status: 'pending'/);
  assert.match(cleanup, /status: 'completed'/);
  assert.match(cleanup, /plannedDeletedRows: candidates\.length/);
  assert.match(cleanup, /INSERT INTO audit_log[\s\S]*RETURNING id/);
  assert.match(cleanup, /UPDATE audit_log[\s\S]*RETURNING id/);
  assert.match(cleanup, /autocard_media_retention_audit_update_failed/);
  assert.match(cleanup, /autocard_media_retention_audit_update_failed[\s\S]*throw error/);
  const retentionBody = cleanup.slice(cleanup.indexOf('async function enforceAutocardMediaRetention'));
  const transactionStart = retentionBody.indexOf("await db.query('BEGIN')");
  const pendingAudit = retentionBody.indexOf('const auditId = await insertRetentionAudit');
  const commit = retentionBody.indexOf("await db.query('COMMIT')");
  const fileCleanup = retentionBody.indexOf('await removeDeletedFiles');
  const sweep = retentionBody.indexOf('await sweepOrphanedFiles');
  const auditUpdate = retentionBody.indexOf('await updateRetentionAudit');
  assert.ok(transactionStart >= 0 && pendingAudit > transactionStart && commit > pendingAudit);
  assert.ok(fileCleanup > commit && sweep > commit);
  assert.ok(auditUpdate > fileCleanup && auditUpdate > sweep);
  const cronService = compose.match(/\n  cron:\n([\s\S]*?)(?=\nvolumes:)/)?.[1] || '';
  assert.match(cronService, /UPLOAD_DIR: \/app\/uploads/);
  assert.match(cronService, /AUTOCARD_MEDIA_ORPHAN_DAYS: \$\{AUTOCARD_MEDIA_ORPHAN_DAYS:-7\}/);
  assert.match(cronService, /CMS_ASSET_ORPHAN_RETENTION_DAYS: \$\{CMS_ASSET_ORPHAN_RETENTION_DAYS:-30\}/);
  assert.match(cronService, /volumes:\n\s+- uploads_data:\/app\/uploads/);
});

test('CMS asset retention is scheduled with the shared upload volume', async () => {
  const [cron, cleanup, compose] = await Promise.all([
    read('cron/index.js'), read('cron/cms-asset-retention.js'), read('docker-compose.yml'),
  ]);
  const cronService = compose.match(/\n  cron:\n([\s\S]*?)(?=\nvolumes:)/)?.[1] || '';
  assert.match(cron, /enforceCmsAssetRetention/);
  assert.match(cleanup, /pg_advisory_xact_lock/);
  assert.match(cleanup, /CMS_ASSET_RETENTION_LOCK = 7193029/);
  const lock = cleanup.indexOf("pg_advisory_xact_lock($1)");
  const candidates = cleanup.indexOf('SELECT a.id, a.storage_key');
  const reservation = cleanup.indexOf('SET deleting_at = NOW()');
  const commit = cleanup.indexOf("await client.query('COMMIT')");
  const unlink = cleanup.indexOf('await fileSystem.unlink');
  const rowDelete = cleanup.indexOf('DELETE FROM cms_assets');
  assert.ok(lock >= 0 && candidates > lock && reservation > candidates && commit > reservation && unlink > commit && rowDelete > unlink);
  assert.match(cronService, /CMS_ASSET_ORPHAN_RETENTION_DAYS/);
  assert.match(cronService, /UPLOAD_DIR: \/app\/uploads/);
});

test('CI builds and publishes commit-addressed production images', async () => {
  const [workflow, apiPackage] = await Promise.all([
    read('.github/workflows/ci.yml'), read('api/package.json'),
  ]);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /ownerinc-portal-api:\$\{GITHUB_SHA\}/);
  assert.match(workflow, /docker push \$\{REGISTRY\}\/ownerinc-portal-api:\$\{GITHUB_SHA\}/);
  assert.match(workflow, /docker build --tag ownerinc-portal-cron:\$\{GITHUB_SHA\} --file cron\/Dockerfile \./);
  assert.doesNotMatch(workflow, /docker build --tag ownerinc-portal-cron:\$\{GITHUB_SHA\} cron\s*$/m);
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

test('green main revisions deploy through a restricted serialized production gate', async () => {
  const [workflow, hostDeploy, productionCompose] = await Promise.all([
    read('.github/workflows/ci.yml'), read('ops/deploy-from-ci.sh'),
    read('ops/compose.production.yaml'),
  ]);
  assert.match(workflow, /deploy-production:[\s\S]*needs: validate/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /group: portal-ownerinc-production[\s\S]*cancel-in-progress: false/);
  assert.match(workflow, /--add-virtual-file="\.ci-commit:\$\{GITHUB_SHA\}"/);
  assert.match(workflow, /PORTAL_VPS_SSH_KEY/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(workflow, /ConnectTimeout=15/);
  assert.match(workflow, /sleep \$\(\(attempt \* 10\)\)/);
  assert.match(workflow, /test "\$VPS_USER" != root/);
  assert.match(hostDeploy, /SSH_ORIGINAL_COMMAND/);
  assert.match(hostDeploy, /flock -n/);
  assert.match(hostDeploy, /archive commit does not match requested commit/);
  assert.match(hostDeploy, /pg_dump --format=custom/);
  assert.match(hostDeploy, /pg_restore --clean --if-exists --no-owner --single-transaction/);
  assert.match(hostDeploy, /compose_for "\$release" run --rm migrate/);
  assert.match(hostDeploy, /--profile notifications/);
  assert.match(hostDeploy, /Production readiness did not recover/);
  assert.match(hostDeploy, /restoring the previous production release/);
  assert.match(hostDeploy, /find "\$staging" -type d -exec chmod 0755/);
  assert.match(hostDeploy, /find "\$staging" -type f -exec chmod 0644/);
  assert.match(productionCompose, /postgres:[\s\S]*volumes: !override[\s\S]*postgres_data/);
});
