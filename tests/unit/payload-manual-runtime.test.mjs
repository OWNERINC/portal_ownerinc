import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertHostNetworkIsolated, manualRuntimeStages, parseManualRuntimeOptIn } from '../../scripts/integration/payload-manual-runtime.mjs';

test('manual runtime fixture has one exact disposable opt-in and otherwise performs no work', () => {
  assert.equal(parseManualRuntimeOptIn({}), false);
  assert.equal(parseManualRuntimeOptIn({ PAYLOAD_MANUAL_RUNTIME_DISPOSABLE: '0' }), false);
  assert.equal(parseManualRuntimeOptIn({ PAYLOAD_MANUAL_RUNTIME_DISPOSABLE: 'true' }), false);
  assert.equal(parseManualRuntimeOptIn({ PAYLOAD_MANUAL_RUNTIME_DISPOSABLE: '1' }), true);
  const result = spawnSync(process.execPath, ['scripts/integration/payload-manual-runtime.mjs'], {
    encoding: 'utf8', env: {}, timeout: 10000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, 'payload-manual-runtime: NOT_EXECUTED; disposable opt-in required\n');
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /PASS/u);
});

test('manual runtime plan is ordered, manual-only and includes independent restore evidence', async () => {
  assert.deepEqual(manualRuntimeStages, [
    'preflight', 'source-network-create', 'source-volume-create', 'source-database-start',
    'empty-database-provision', 'protocol-finalizer', 'protocol-baseline', 'protocol-qualification',
    'private-readiness', 'editor-authorization', 'manual-publication', 'schedule-absence',
    'runtime-restart', 'persistence-verification', 'coordinated-backup', 'restore-target-start',
    'restore-target-readiness', 'restore-target-provision', 'restore-target-control', 'restore-target-observer',
    'restore-protection-backup', 'restore-cms-database', 'restore-portal-database', 'restore-runtime-verify',
    'restore-control-verify', 'restore-protocol-audit', 'restore-storage',
    'restored-verification', 'owned-cleanup',
  ]);
  const [fixture, contentProof] = await Promise.all([
    readFile('scripts/integration/payload-manual-runtime.mjs', 'utf8'),
    readFile('cms/tests/integration/manual-runtime-content.ts', 'utf8'),
  ]);
  assert.match(fixture, /save\.json\(\)\)\.doc\?\._status !== 'draft'/u);
  assert.match(contentProof, /assert\.equal\(version\.docs\[0\]\.version\._status, 'draft'\)/u);
  assert.match(contentProof, /assert\.equal\(evidence\.versionStatus, 'draft'\)/u);
});

test('manual runtime rejects a host with any IPv4 or IPv6 default egress route', async () => {
  const isolated = async filename => filename.endsWith('ipv6_route') ? '' : 'Iface Destination Gateway Flags\nlo 0000007F 00000000 0001\n';
  await assert.doesNotReject(assertHostNetworkIsolated(isolated));
  await assert.rejects(assertHostNetworkIsolated(async filename => filename.endsWith('ipv6_route') ? '' :
    'Iface Destination Gateway Flags\neth0 00000000 0100007F 0003\n'), /manual_runtime_host_egress_route_present/u);
  await assert.rejects(assertHostNetworkIsolated(async filename => filename.endsWith('ipv6_route') ?
    `${'0'.repeat(32)} 00000000 ${'0'.repeat(32)} 00000000 00000000 00000000 00000000 00000001 lo\n` :
    'Iface Destination Gateway Flags\n'), /manual_runtime_host_egress_route_present/u);
});

test('Compose separates liveness from readiness and gates Nginx on CMS readiness', async () => {
  const [compose, production, route, fixture, nginx] = await Promise.all([
    readFile('docker-compose.payload.yml', 'utf8'), readFile('ops/compose.payload.production.yaml', 'utf8'),
    readFile('cms/src/app/editorial/ready/route.ts', 'utf8'), readFile('scripts/integration/payload-manual-runtime.mjs', 'utf8'),
    readFile('nginx/nginx.conf', 'utf8'),
  ]);
  assert.match(compose, /fetch\("http:\/\/127\.0\.0\.1:3001\/editorial\/ready"\)/u);
  assert.match(compose, /nginx:[\s\S]*?cms:[\s\S]*?condition: service_healthy/u);
  assert.match(route, /assertCmsStorageReady/u);
  assert.match(production, /cms-cluster-bootstrap:[\s\S]*?no-new-privileges:true/u);
  assert.doesNotMatch(production, /cms-postgres|cms-worker|scheduled-publication/u);
  assert.match(fixture, /PAYLOAD_MANUAL_RUNTIME_DISPOSABLE/u);
  assert.match(fixture, /next', 'start'/u);
  assert.match(fixture, /assertHostNetworkIsolated/u);
  assert.match(fixture, /network', 'create', '--label'/u);
  assert.doesNotMatch(fixture, /network', 'create', '--internal'/u);
  assert.match(nginx, /location = \/editorial\/ready \{ return 404; \}/u);
  assert.match(nginx, /location = \/editorial\/health \{ return 404; \}/u);
  assert.doesNotMatch(fixture, /compose[^\n]*down[^\n]*-v|system prune|volume prune/u);
  assert.match(fixture, /docker\(\['volume', 'rm', volume\]\)/u, 'cleanup is restricted to the generated owned volume');
});

test('coordinated restore qualifies each destructive boundary once', async () => {
  const source = await readFile('scripts/payload-operations.sh', 'utf8');
  assert.equal((source.match(/guard prepare-restore "\$backup" guard_prepare_restore_cms_migrate/g) || []).length, 1);
});

test('disposable restore captures and verifies target protection before first mutation', async () => {
  const source = await readFile('scripts/integration/payload-manual-runtime.mjs', 'utf8');
  const protection = source.indexOf("step('restore-protection-backup')");
  const destructive = source.indexOf("'pg_restore', '--single-transaction'", protection);
  assert.ok(protection > 0 && destructive > protection);
  assert.match(source.slice(protection, destructive), /cms\.dump[\s\S]*?targetDump\('ownerinc_cms'\)[\s\S]*?targetDump\('portal_manual_runtime'\)[\s\S]*?uploads\.tar\.gz[\s\S]*?write_payload_backup_manifest[\s\S]*?pg_restore', '--list'/u);
  assert.match(source, /--bootstrap-database[\s\S]*?await clusterBootstrap\(port\)[\s\S]*?await provision\(port\)/u);
  assert.doesNotMatch(source, /cms-postgres\.dump|--username=cms_admin[^\n]*pg_(?:dump|restore)/u);
  assert.match(source.slice(destructive), /backup, 'uploads\.tar\.gz'[\s\S]*?restoredPortalUploads[\s\S]*?readdir\(restoredPortalUploads\)[\s\S]*?sha256\(await readFile/u);
});
