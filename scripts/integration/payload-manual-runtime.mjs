#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'api/package.json'));
const { Client } = require('pg');
const postgresImage = 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';

export const manualRuntimeStages = Object.freeze([
  'preflight', 'source-network-create', 'source-volume-create', 'source-database-start',
  'empty-database-provision', 'protocol-finalizer', 'protocol-baseline', 'protocol-qualification',
  'private-readiness', 'editor-authorization', 'manual-publication', 'schedule-absence',
  'runtime-restart', 'persistence-verification', 'coordinated-backup', 'restore-target-start',
  'restore-target-readiness', 'restore-target-provision', 'restore-target-control', 'restore-target-observer',
  'restore-protection-backup', 'independent-restore',
  'restored-verification', 'owned-cleanup',
]);

export function parseManualRuntimeOptIn(env) {
  return env.PAYLOAD_MANUAL_RUNTIME_DISPOSABLE === '1';
}

const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'home', 'lang', 'lc_all', 'tz'].includes(key.toLowerCase())));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function command(program, args, { env = cleanEnvironment(), cwd = root, input, binary = false,
  timeout = 300_000, safeStderrPattern } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), stderrBytes = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 512 * 1024 * 1024) child.kill('SIGKILL');
      else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (safeStderrPattern && stderr.length + chunk.length <= 64 * 1024) stderr = Buffer.concat([stderr, chunk]);
      if (stderrBytes > 4 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('manual_runtime_process_unavailable')); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || signal || code !== 0) {
        const safe = safeStderrPattern ? `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`.match(safeStderrPattern)?.[0] : undefined;
        reject(new Error(timedOut ? 'manual_runtime_process_timeout' : safe || 'manual_runtime_process_failed'));
      }
      else resolve(binary ? stdout : stdout.toString('utf8').trim());
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

async function docker(args, options) { return command('docker', args, options); }
async function connect(url) { const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 }); await client.connect(); return client; }

export async function assertHostNetworkIsolated(read = readFile) {
  const [ipv4, ipv6] = await Promise.all([read('/proc/net/route', 'utf8'), read('/proc/net/ipv6_route', 'utf8')]);
  const ipv4Default = ipv4.split('\n').slice(1).some(line => line.trim().split(/\s+/u)[1] === '00000000');
  const ipv6Default = ipv6.split('\n').some(line => {
    const fields = line.trim().split(/\s+/u);
    return fields[0] === '0'.repeat(32) && fields[1] === '00000000';
  });
  if (ipv4Default || ipv6Default) throw new Error('manual_runtime_host_egress_route_present');
}

export async function main(env = process.env) {
  if (!parseManualRuntimeOptIn(env)) {
    process.stdout.write('payload-manual-runtime: NOT_EXECUTED; disposable opt-in required\n');
    return 2;
  }
  if (process.platform !== 'linux') {
    process.stderr.write('payload-manual-runtime: linux_docker_job_required; NOT_EXECUTED\n');
    return 2;
  }

  const marker = randomBytes(16).toString('hex');
  const project = `ownerinc-manual-runtime-${marker}`;
  const container = `${project}-source-postgres`, volume = `${project}-source-postgres`, network = `${project}-network`;
  const targetContainer = `${project}-target-postgres`, targetVolume = `${project}-target-postgres`;
  const directory = await mkdtemp(path.join(env.PAYLOAD_MANUAL_RUNTIME_PRIVATE_PARENT || os.tmpdir(), `${project}-`));
  await chmod(directory, 0o700); await mkdir(path.join(directory, 'uploads'), { mode: 0o700 });
  const restored = path.join(directory, 'restored'); await mkdir(path.join(restored, 'uploads'), { recursive: true, mode: 0o700 });
  const backup = path.join(directory, 'backup'); await mkdir(backup, { mode: 0o700 });
  const protection = path.join(directory, 'restore-protection'); await mkdir(protection, { mode: 0o700 });
  const passwords = Object.fromEntries(['admin', 'migrator', 'runtime', 'controller', 'observer'].map(key => [key, randomBytes(32).toString('hex')]));
  const postgresEnv = path.join(directory, 'postgres.env');
  await writeFile(postgresEnv, `POSTGRES_DB=ownerinc_cms\nPOSTGRES_USER=cms_admin\nPOSTGRES_PASSWORD=${passwords.admin}\n`, { mode: 0o600 });
  const secret = () => randomBytes(32).toString('hex');
  let created = false, targetCreated = false, completed = false, stage = manualRuntimeStages[0], portalServer;
  let cmsChild;
  const step = value => { stage = value; process.stdout.write(`payload-manual-runtime: stage=${value}\n`); };
  const url = (role, password, database, selectedPort = port) => `postgresql://${role}:${encodeURIComponent(password)}@127.0.0.1:${selectedPort}/${database}`;
  let port = 0;
  try {
    await assertHostNetworkIsolated();
    await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 });
    await docker(['image', 'inspect', postgresImage], { timeout: 15_000 });
    step('source-network-create');
    // Port publication is unavailable on a Docker --internal network. The
    // dedicated bridge is created only after assertHostNetworkIsolated proves
    // the Linux namespace has no IPv4/IPv6 default route, so it has no external
    // egress path while still exposing random loopback ports to this driver.
    await docker(['network', 'create', '--label', `ownerinc.manual-runtime=${marker}`, network]);
    step('source-volume-create');
    await docker(['volume', 'create', '--label', `ownerinc.manual-runtime=${marker}`, volume]);
    step('source-database-start');
    await docker(['run', '--detach', '--pull', 'never', '--name', container, '--label', `ownerinc.manual-runtime=${marker}`,
      '--network', network, '--publish', '127.0.0.1::5432', '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      '--env-file', postgresEnv,
      '--security-opt', 'no-new-privileges', '--memory', '768m', '--cpus', '0.5', postgresImage]);
    created = true;
    await rm(postgresEnv, { force: true });
    const binding = await docker(['port', container, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/u.exec(binding); if (!match) throw new Error('manual_runtime_port_binding_invalid');
    port = Number(match[1]);
    let admin;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { admin = await connect(url('cms_admin', passwords.admin, 'ownerinc_cms')); break } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    if (!admin) throw new Error('manual_runtime_database_readiness_timeout');
    try {
      const version = await admin.query("SELECT current_setting('server_version_num')::int AS version, current_database() AS database")
      if (Math.floor(version.rows[0].version / 10000) !== 16 || version.rows[0].database !== 'ownerinc_cms') throw new Error('manual_runtime_database_identity_invalid')
      await admin.query('CREATE DATABASE portal_manual_runtime OWNER cms_admin')
    } finally { await admin.end(); }

    const payloadToPortal = secret(), portalToPayload = secret();
    const editor = { uid: `manual-editor-${marker}`, email: `manual-${marker}@example.invalid`, name: null, canManageNews: true };
    portalServer = http.createServer((request, response) => {
      let bytes = Buffer.alloc(0)
      request.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 16 * 1024) request.destroy() })
      request.on('end', () => {
        if (request.headers.authorization !== `Bearer ${payloadToPortal}`) { response.writeHead(403).end(); return }
        let body = {}; try { body = bytes.length ? JSON.parse(bytes.toString('utf8')) : {} } catch { response.writeHead(400).end(); return }
        response.setHeader('Content-Type', 'application/json')
        if (request.url === '/api/internal/editorial/authority') response.end(JSON.stringify({ mode: 'payload', epoch: 1 }))
        else if (request.url === '/api/internal/editorial/actor/check' && body.uid === editor.uid) response.end(JSON.stringify({ actor: editor }))
        else if (request.url === '/api/internal/editorial/session/resolve' && body.cookie === `editor-${marker}`) response.end(JSON.stringify({ actor: editor, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }))
        else { response.writeHead(403); response.end(JSON.stringify({ reason: 'editorial_permission_denied' })) }
      })
    })
    await new Promise((resolve, reject) => { portalServer.once('error', reject); portalServer.listen(0, '127.0.0.1', resolve) })
    const portalPort = portalServer.address().port
    const common = { ...cleanEnvironment(), NODE_ENV: 'production', CMS_PUBLICATION_MODE: 'manual', NEXT_TELEMETRY_DISABLED: '1',
      PAYLOAD_SECRET: secret(), PORTAL_PUBLIC_URL: 'https://portal.manual.invalid', PORTAL_INTERNAL_URL: `http://127.0.0.1:${portalPort}`,
      PAYLOAD_TO_PORTAL_SECRET: payloadToPortal, PORTAL_TO_PAYLOAD_SECRET: portalToPayload, PAYLOAD_MANUAL_RUNTIME_MARKER: marker };
    await command('npm', ['run', 'build'], { cwd: path.join(root, 'cms'),
      env: { ...cleanEnvironment(), CMS_BUILD_ONLY: 'true', NEXT_PHASE: 'phase-production-build', NEXT_TELEMETRY_DISABLED: '1' }, timeout: 600_000 });
    const provision = async selectedPort => {
      const operation = { ...common, CMS_DATABASE_URL: url('cms_admin', passwords.admin, 'ownerinc_cms', selectedPort),
        CMS_MIGRATOR_PASSWORD: passwords.migrator, CMS_RUNTIME_PASSWORD: passwords.runtime };
      await command(process.execPath, ['--import', 'tsx', 'scripts/provision-db.ts', '--provision'], { cwd: path.join(root, 'cms'), env: operation });
    };
    const controlRoles = async (mode, selectedPort) => command(process.execPath,
      ['--import', 'tsx', 'scripts/provision-db.ts', mode], { cwd: path.join(root, 'cms'),
        env: { ...common, CMS_DATABASE_URL: url('cms_admin', passwords.admin, 'ownerinc_cms', selectedPort),
          CMS_MIGRATOR_PASSWORD: passwords.migrator, CMS_RUNTIME_PASSWORD: passwords.runtime,
          CMS_CONTROLLER_PASSWORD: passwords.controller }, timeout: 120_000 });
    step('empty-database-provision');
    await provision(port);
    await controlRoles('--bootstrap-control', port);
    const cmsEnv = (database, evidenceDirectory, selectedPort = port) => ({ ...common, CMS_DATABASE_URL: url('cms_runtime', passwords.runtime, database, selectedPort),
      CMS_UPLOAD_DIR: path.join(evidenceDirectory, 'uploads'), PAYLOAD_MANUAL_RUNTIME_EVIDENCE: evidenceDirectory });
    const stopCms = async () => {
      if (!cmsChild || cmsChild.exitCode !== null) { cmsChild = undefined; return }
      cmsChild.kill('SIGTERM');
      await Promise.race([new Promise(resolve => cmsChild.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 15_000))]);
      if (cmsChild.exitCode === null) cmsChild.kill('SIGKILL');
      cmsChild = undefined;
    };
    const startCms = async (database = 'ownerinc_cms', evidenceDirectory = directory, selectedPort = port) => {
      const reservation = net.createServer();
      await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) });
      const httpPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
      cmsChild = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(httpPort)], {
        cwd: path.join(root, 'cms'), env: cmsEnv(database, evidenceDirectory, selectedPort), stdio: ['ignore', 'ignore', 'ignore'],
      });
      let lastStatus = 0;
      for (let attempt = 0; attempt < 180; attempt++) {
        if (cmsChild.exitCode !== null) throw new Error('manual_runtime_cms_start_failed')
        try {
          const response = await fetch(`http://127.0.0.1:${httpPort}/editorial/ready`, { signal: AbortSignal.timeout(1000) })
          lastStatus = response.status
          if (response.status === 200 && (await response.json()).status === 'ready') return `http://127.0.0.1:${httpPort}`
        } catch { /* Retry only the owned loopback process. */ }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      throw new Error(lastStatus === 503 ? 'manual_runtime_cms_readiness_unavailable' : 'manual_runtime_cms_readiness_timeout')
    };
    const migrate = async database => command(process.execPath, ['node_modules/payload/bin.js', 'migrate'], {
      cwd: path.join(root, 'cms'), env: { ...cmsEnv(database, database === 'ownerinc_cms' ? directory : restored),
        CMS_DATABASE_URL: url('cms_migrator', passwords.migrator, database) }, timeout: 300_000 });
    await migrate('ownerinc_cms');

    step('protocol-finalizer');
    await command(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-force-exit',
      'tests/integration/manual-runtime-finalizer.ts'], {
      cwd: path.join(root, 'cms'), env: { ...cleanEnvironment(), PAYLOAD_MANUAL_RUNTIME_MARKER: marker,
        CMS_ADMIN_DATABASE_URL: url('cms_admin', passwords.admin, 'ownerinc_cms') },
      safeStderrPattern: /MANUAL_RUNTIME_FINALIZER_DIAGNOSTIC code=canonical_function_mismatch:(?:[a-z0-9_]+:(?:sig|sec|owner|config|source|return|strict|modes|names)=(?:true|false)(?::(?:sig|sec|owner|config|source|return|strict|modes|names)=(?:true|false))*,?)+/u });
    step('protocol-baseline');
    const qualify = await connect(url('cms_admin', passwords.admin, 'ownerinc_cms'));
    try {
      await qualify.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await qualify.query('SELECT pg_advisory_xact_lock(7194030)');
      const head = await qualify.query(`SELECT sequence::text, chain_sha256, coverage_version, write_barrier,
        (SELECT count(*)::int FROM news_articles) articles, (SELECT count(*)::int FROM news_media) media,
        (SELECT count(*)::int FROM news_schedules) schedules,
        (SELECT count(*)::int FROM news_home WHERE _status='published') home_published
        FROM owner_news_mutation_head WHERE singleton=true FOR UPDATE`);
      const row = head.rows[0];
      if (head.rowCount !== 1 || row.sequence !== '0' || row.chain_sha256 !== '0'.repeat(64) || row.coverage_version !== 0 ||
        row.write_barrier !== 'open' || [row.articles, row.media, row.schedules, row.home_published].some(value => value !== 0)) {
        throw new Error('manual_runtime_coverage_baseline_invalid');
      }
      await qualify.query('UPDATE owner_news_mutation_head SET coverage_version=1 WHERE singleton=true AND coverage_version=0');
      await qualify.query('COMMIT');
    } catch (error) { await qualify.query('ROLLBACK').catch(() => {}); throw error; } finally { await qualify.end(); }
    step('protocol-qualification');

    const proof = async (mode, database, evidenceDirectory) => command(process.execPath,
      ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-force-exit', 'tests/integration/manual-runtime-content.ts'],
      { cwd: path.join(root, 'cms'), env: { ...cmsEnv(database, evidenceDirectory), PAYLOAD_MANUAL_RUNTIME_ACTION: mode }, timeout: 240_000,
        safeStderrPattern: /MANUAL_RUNTIME_CONTENT_DIAGNOSTIC action=(?:prepare|capture|verify) stage=(?:config|payload-init|readiness|preflight|editor-projection|capture|verify)/u });
    const protocolProof = async (action, selectedPort = port) => command(process.execPath,
      ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-force-exit', 'tests/integration/manual-runtime-protocol.ts'], {
        cwd: path.join(root, 'cms'), timeout: 240_000,
        env: { ...cleanEnvironment(), PAYLOAD_MANUAL_RUNTIME_MARKER: marker, PAYLOAD_MANUAL_RUNTIME_PROTOCOL_ACTION: action,
          CMS_ADMIN_DATABASE_URL: url('cms_admin', passwords.admin, 'ownerinc_cms', selectedPort),
          CMS_OBSERVER_DATABASE_URL: url('cms_observer', passwords.observer, 'ownerinc_cms', selectedPort),
          CMS_OBSERVER_PASSWORD: passwords.observer },
      });
    await protocolProof('provision-observer');
    await proof('prepare', 'ownerinc_cms', directory);
    step('private-readiness'); let cmsOrigin = await startCms();
    const headers = { 'Content-Type': 'application/json', Cookie: `__Host-ownerinc-editorial=editor-${marker}`,
      Origin: 'https://portal.manual.invalid', 'Sec-Fetch-Site': 'same-origin' }
    const missingSchedule = await fetch(`${cmsOrigin}/editorial/api/news-schedule`, { method: 'POST',
      headers, body: '{}' });
    if (missingSchedule.status !== 404) throw new Error('manual_runtime_schedule_endpoint_present')
    step('editor-authorization'); step('manual-publication'); step('schedule-absence');
    const me = await fetch(`${cmsOrigin}/editorial/api/portal-editors/me`, { headers: { Cookie: headers.Cookie } })
    if (me.status !== 200 || (await me.json()).user?.portalUid !== editor.uid) throw new Error('manual_runtime_http_authentication_failed')
    const denied = await fetch(`${cmsOrigin}/editorial/api/news-articles`, { method: 'POST', headers: { ...headers, Cookie: '__Host-ownerinc-editorial=reader-denied' }, body: '{}' })
    if (![401, 403].includes(denied.status)) throw new Error('manual_runtime_http_authorization_failed')
    const mediaBytes = Buffer.from('%PDF-1.7\nOwnerinc manual runtime proof\nxref\n0 1\n0000000000 65535 f\n%%EOF\n')
    const form = new FormData(); form.append('file', new Blob([mediaBytes], { type: 'application/pdf' }), 'manual-runtime.pdf'); form.append('_payload', '{}')
    const upload = await fetch(`${cmsOrigin}/editorial/api/news-media`, { method: 'POST', headers: { Cookie: headers.Cookie,
      Origin: headers.Origin, 'Sec-Fetch-Site': headers['Sec-Fetch-Site'] }, body: form })
    const uploaded = upload.status === 201 ? (await upload.json()).doc : null
    if (!uploaded?.id || !uploaded.filename) throw new Error('manual_runtime_http_upload_failed')
    const title = 'Manual runtime published by HTTP'
    const create = await fetch(`${cmsOrigin}/editorial/api/news-articles?draft=true`, { method: 'POST', headers,
      body: JSON.stringify({ title: 'Manual runtime article', category: 'Manual runtime',
        editorial: { version: 1, kind: 'article', summary: 'Synthetic runtime proof', author: '', source_label: '', source_date: null },
        body: [{ blockType: 'paragraph', text: 'Manual publication body.' },
          { blockType: 'pdf', media: uploaded.id, title: 'Proof' }], _status: 'draft' }) })
    const draft = create.status === 201 ? (await create.json()).doc : null
    if (!draft?.id) throw new Error('manual_runtime_http_create_failed')
    const save = await fetch(`${cmsOrigin}/editorial/api/news-articles/${draft.id}?draft=true`, { method: 'PATCH', headers,
      body: JSON.stringify({ title }) })
    if (save.status !== 200) throw new Error('manual_runtime_http_draft_save_failed')
    await writeFile(path.join(directory, 'content-proof.json'), JSON.stringify({ schemaVersion: 1, articleId: draft.id,
      mediaId: uploaded.id, filename: uploaded.filename, title, mediaSha256: sha256(mediaBytes) }), { mode: 0o600 })
    await proof('capture', 'ownerinc_cms', directory)
    const publication = await fetch(`${cmsOrigin}/editorial/api/news-articles/${draft.id}`, { method: 'PATCH', headers,
      body: JSON.stringify({ _status: 'published' }) })
    if (publication.status !== 200) throw new Error(`manual_runtime_http_publish_failed_${publication.status}`)
    if ((await publication.json()).doc?._status !== 'published') throw new Error('manual_runtime_http_publish_status_invalid')
    step('runtime-restart');
    await docker(['stop', '--time', '30', container], { timeout: 45_000 });
    let unavailable = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const response = await fetch(`${cmsOrigin}/editorial/ready`, { signal: AbortSignal.timeout(6000) });
        if (response.status === 503) { unavailable = true; break }
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!unavailable) throw new Error('manual_runtime_database_unavailable_readiness_not_observed')
    await stopCms();
    await docker(['start', container], { timeout: 120_000 });
    const restartedBinding = await docker(['port', container, '5432/tcp']);
    const restartedMatch = /^127\.0\.0\.1:(\d+)$/u.exec(restartedBinding)
    if (!restartedMatch) throw new Error('manual_runtime_restart_port_binding_invalid')
    port = Number(restartedMatch[1])
    let adminReady = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { const check = await connect(url('cms_admin', passwords.admin, 'ownerinc_cms')); await check.end(); adminReady = true; break }
      catch { if (attempt === 89) throw new Error('manual_runtime_restart_admin_readiness_timeout'); await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    if (!adminReady) throw new Error('manual_runtime_restart_admin_readiness_timeout')
    try { const check = await connect(url('cms_runtime', passwords.runtime, 'ownerinc_cms')); await check.end() }
    catch { throw new Error('manual_runtime_restart_runtime_connection_failed') }
    cmsOrigin = await startCms();
    if ((await fetch(`${cmsOrigin}/editorial/api/news-schedule`, { method: 'POST', headers, body: '{}' })).status !== 404) {
      throw new Error('manual_runtime_schedule_endpoint_present_after_restart')
    }
    step('persistence-verification'); await proof('verify', 'ownerinc_cms', directory);
    await protocolProof('audit');
    await stopCms();

    step('coordinated-backup');
    const dump = async database => docker(['exec', '-i', container, 'pg_dump', '--format=custom', '--username=cms_admin', `--dbname=${database}`], { binary: true });
    await writeFile(path.join(backup, 'cms-postgres.dump'), await dump('ownerinc_cms'));
    await writeFile(path.join(backup, 'postgres.dump'), await dump('portal_manual_runtime'));
    await command('tar', ['-czf', path.join(backup, 'cms-uploads.tar.gz'), '-C', path.join(directory, 'uploads'), '.']);
    const empty = path.join(directory, 'portal-uploads'); await mkdir(empty, { mode: 0o700 });
    await command('tar', ['-czf', path.join(backup, 'uploads.tar.gz'), '-C', empty, '.']);
    await writeFile(path.join(backup, 'release.images'), `API_IMAGE=fixture.invalid/ownerinc-portal-api@sha256:${'a'.repeat(64)}\nCRON_IMAGE=fixture.invalid/ownerinc-portal-cron@sha256:${'b'.repeat(64)}\nCMS_IMAGE=fixture.invalid/ownerinc-portal-cms@sha256:${'c'.repeat(64)}\nRELEASE_FORMAT=payload-v1\n`);
    await writeFile(path.join(backup, 'operations-proof.json'), JSON.stringify({ schemaVersion: 1, fixture: 'manual-runtime', markerSha256: sha256(marker) }));
    await writeFile(path.join(backup, 'backup.format'), 'payload-v1\n');
    await command('bash', ['-c', '. "$1/scripts/release-manifest.sh"; write_payload_backup_manifest "$2"; verify_storage_archive "$2/uploads.tar.gz"; verify_storage_archive "$2/cms-uploads.tar.gz"', 'fixture', root, backup]);

    step('restore-target-start');
    await docker(['volume', 'create', '--label', `ownerinc.manual-runtime=${marker}`, targetVolume]);
    await writeFile(postgresEnv, `POSTGRES_DB=ownerinc_cms\nPOSTGRES_USER=cms_admin\nPOSTGRES_PASSWORD=${passwords.admin}\n`, { mode: 0o600 });
    await docker(['run', '--detach', '--pull', 'never', '--name', targetContainer, '--label', `ownerinc.manual-runtime=${marker}`,
      '--network', network, '--publish', '127.0.0.1::5432', '--mount', `type=volume,source=${targetVolume},target=/var/lib/postgresql/data`,
      '--env-file', postgresEnv,
      '--security-opt', 'no-new-privileges', '--memory', '768m', '--cpus', '0.5', postgresImage]);
    targetCreated = true;
    await rm(postgresEnv, { force: true });
    const targetBinding = await docker(['port', targetContainer, '5432/tcp']);
    const targetMatch = /^127\.0\.0\.1:(\d+)$/u.exec(targetBinding); if (!targetMatch) throw new Error('manual_runtime_target_port_binding_invalid');
    const targetPort = Number(targetMatch[1]);
    step('restore-target-readiness');
    let targetAdmin;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { targetAdmin = await connect(url('cms_admin', passwords.admin, 'ownerinc_cms', targetPort)); break }
      catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    if (!targetAdmin) throw new Error('manual_runtime_target_readiness_timeout');
    try { await targetAdmin.query('CREATE DATABASE portal_manual_runtime OWNER cms_admin') } finally { await targetAdmin.end() }
    step('restore-target-provision');
    await provision(targetPort);
    step('restore-target-control');
    await controlRoles('--bootstrap-control', targetPort);
    step('restore-target-observer');
    await protocolProof('provision-observer', targetPort);
    step('restore-protection-backup');
    const targetDump = async database => docker(['exec', '-i', targetContainer, 'pg_dump', '--format=custom',
      '--username=cms_admin', `--dbname=${database}`], { binary: true });
    await writeFile(path.join(protection, 'cms-postgres.dump'), await targetDump('ownerinc_cms'));
    await writeFile(path.join(protection, 'postgres.dump'), await targetDump('portal_manual_runtime'));
    await command('tar', ['-czf', path.join(protection, 'cms-uploads.tar.gz'), '-C', path.join(restored, 'uploads'), '.']);
    const protectionNames = ['postgres.dump', 'cms-postgres.dump', 'cms-uploads.tar.gz'];
    await writeFile(path.join(protection, 'manifest.sha256'), (await Promise.all(protectionNames.map(async name =>
      `${sha256(await readFile(path.join(protection, name)))}  ${name}`))).join('\n') + '\n');
    await command('bash', ['-c', 'cd "$1" && sha256sum --check --strict manifest.sha256 >/dev/null', 'fixture', protection]);
    step('independent-restore');
    await docker(['exec', '-i', targetContainer, 'pg_restore', '--single-transaction', '--clean', '--if-exists',
      '--username=cms_admin', '--dbname=ownerinc_cms'], { input: await readFile(path.join(backup, 'cms-postgres.dump')) });
    await docker(['exec', '-i', targetContainer, 'pg_restore', '--single-transaction', '--clean', '--if-exists', '--no-owner', '--no-privileges',
      '--username=cms_admin', '--dbname=portal_manual_runtime'], { input: await readFile(path.join(backup, 'postgres.dump')) });
    await command(process.execPath, ['--import', 'tsx', 'scripts/provision-db.ts', '--grants'], { cwd: path.join(root, 'cms'),
      env: { ...cmsEnv('ownerinc_cms', restored, targetPort), CMS_DATABASE_URL: url('cms_migrator', passwords.migrator, 'ownerinc_cms', targetPort) } });
    await controlRoles('--verify-control', targetPort);
    await protocolProof('audit', targetPort);
    await command('tar', ['-xzf', path.join(backup, 'cms-uploads.tar.gz'), '-C', path.join(restored, 'uploads')]);
    await copyFile(path.join(directory, 'content-proof.json'), path.join(restored, 'content-proof.json'));
    step('restored-verification');
    cmsOrigin = await startCms('ownerinc_cms', restored, targetPort);
    if ((await fetch(`${cmsOrigin}/editorial/api/news-schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status !== 404) {
      throw new Error('manual_runtime_schedule_endpoint_present_after_restore')
    }
    await command(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-force-exit',
      'tests/integration/manual-runtime-content.ts'], { cwd: path.join(root, 'cms'),
      env: { ...cmsEnv('ownerinc_cms', restored, targetPort), PAYLOAD_MANUAL_RUNTIME_ACTION: 'verify' }, timeout: 240_000 });
    await stopCms();
    step('owned-cleanup');
    await docker(['rm', '--force', container]); created = false;
    await docker(['rm', '--force', targetContainer]); targetCreated = false;
    await docker(['volume', 'rm', volume]); await docker(['volume', 'rm', targetVolume]); await docker(['network', 'rm', network]);
    if (env.PAYLOAD_MANUAL_RUNTIME_RETAIN_EVIDENCE !== '1') await rm(directory, { recursive: true, force: true });
    completed = true;
    process.stdout.write('payload-manual-runtime: PASS; disposable manual publication, restart, backup and independent restore verified\n');
    return 0;
  } catch (error) {
    await rm(postgresEnv, { force: true }).catch(() => {});
    if (cmsChild) {
      cmsChild.kill('SIGTERM');
      await Promise.race([new Promise(resolve => cmsChild.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 15_000))]).catch(() => {});
      if (cmsChild.exitCode === null) cmsChild.kill('SIGKILL');
    }
    if (portalServer) await new Promise(resolve => portalServer.close(resolve)).catch(() => {});
    if (created) await docker(['stop', '--time', '30', container], { timeout: 45_000 }).catch(() => {});
    if (targetCreated) await docker(['stop', '--time', '30', targetContainer], { timeout: 45_000 }).catch(() => {});
    const diagnostic = error instanceof Error && /^(?:manual_runtime_[a-z0-9_]+|CMS news protocol diagnostic: phase=[a-z0-9-]+ reason=[a-z0-9_-]+ sqlstate=(?:none|[0-9A-Z]{5})|MANUAL_RUNTIME_CONTENT_DIAGNOSTIC action=(?:prepare|capture|verify) stage=(?:config|payload-init|readiness|preflight|editor-projection|capture|verify)|MANUAL_RUNTIME_FINALIZER_DIAGNOSTIC code=canonical_function_mismatch:(?:[a-z0-9_]+:(?:sig|sec|owner|config|source|return|strict|modes|names)=(?:true|false)(?::(?:sig|sec|owner|config|source|return|strict|modes|names)=(?:true|false))*,?)+)$/u.test(error.message)
      ? ` diagnostic=${error.message}` : '';
    process.stderr.write(`payload-manual-runtime: FAIL stage=${stage}; owned services stopped; private evidence retained${diagnostic}\n`);
    return 1;
  } finally {
    if (completed && portalServer) await new Promise(resolve => portalServer.close(resolve)).catch(() => {});
    if (!completed) process.stderr.write(`payload-manual-runtime: evidence=${directory}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = await main();
