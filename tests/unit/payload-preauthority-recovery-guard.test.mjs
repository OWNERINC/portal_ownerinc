import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  candidateImagesValid, createFixtureProjectNames, createInventory, legacyAnnouncementLookupSql,
  normalizePgDumpForSnapshot, validateRecoveryInputs,
} from '../../scripts/integration/payload-preauthority-fixture.mjs';

const digest = (service, value) => `ghcr.io/ownerinc/ownerinc-portal-${service}@sha256:${value.repeat(64)}`;

test('recovery inputs are bound to a root-owned disposable Linux run and immutable published images', () => {
  const images = { api: digest('api', 'a'), cron: digest('cron', 'b'), cms: digest('cms', 'c') };
  assert.equal(candidateImagesValid(images), true);
  assert.equal(validateRecoveryInputs({
    platform: 'linux', uid: 0, images, commit: 'd'.repeat(40), runId: '12345', runAttempt: '2',
  }), true);

  assert.throws(() => validateRecoveryInputs({
    platform: 'linux', uid: 1000, images, commit: 'd'.repeat(40), runId: '12345', runAttempt: '2',
  }), /disposable_linux_root_runner_required/u);
  assert.throws(() => validateRecoveryInputs({
    platform: 'linux', uid: 0, images: { ...images, cms: 'ghcr.io/ownerinc/ownerinc-portal-cms:latest' },
    commit: 'd'.repeat(40), runId: '12345', runAttempt: '2',
  }), /immutable_candidate_images_required/u);
  assert.throws(() => validateRecoveryInputs({
    platform: 'linux', uid: 0, images, commit: 'd'.repeat(40), runId: '12345', runAttempt: '2',
    dockerEnvironment: { DOCKER_HOST: 'tcp://attacker.invalid:2375' },
  }), /docker_endpoint_override_forbidden/u);
  assert.equal(candidateImagesValid({ ...images, api: 'ghcr.io/ownerinc/ownerinc-portal-api:latest' }), false);
  assert.equal(candidateImagesValid({ ...images, cms: 'ghcr.io/other/ownerinc-portal-cms@sha256:' + 'c'.repeat(64) }), false);
});

test('fixture inventory uses isolated projects, explicit four-volume mounts, and explicit trust identity', () => {
  const runIdentity = { commit: 'd'.repeat(40), runId: '12345678901234567890', runAttempt: '987654321' };
  // Exercise the exact object passed by the recovery runner, not a helper-only shape.
  const names = createFixtureProjectNames(runIdentity);
  assert.notEqual(names.source, names.target);
  assert.match(names.source, /^payload-preauth-[a-z0-9-]+-source$/u);
  assert.match(names.target, /^payload-preauth-[a-z0-9-]+-target$/u);
  assert.ok(names.source.length <= 63 && names.target.length <= 63);
  assert.doesNotMatch(`${names.source} ${names.target}`, /ownerinc-portal-prod|production/iu);

  const root = path.resolve(os.tmpdir(), 'preauthority-guard-fixture');
  const source = createInventory({ project: names.source, root });
  const target = createInventory({ project: names.target, root: `${root}-target`,
    trustedSourceInventoryIdentities: [source.identity] });
  assert.equal(source.document.trustedSourceInventoryIdentities.length, 0);
  assert.deepEqual(target.document.trustedSourceInventoryIdentities, [source.identity]);
  assert.notEqual(source.identity, target.identity);
  assert.deepEqual(Object.keys(source.document.volumes).sort(), [
    'cmsPostgres', 'cmsUploads', 'portalPostgres', 'portalUploads',
  ]);
  assert.equal(source.document.volumes.portalPostgres.name, `${names.source}_postgres_data`);
  assert.deepEqual(source.document.volumes.portalUploads.mounts.map(item => item.service), ['api', 'cron']);
  assert.equal(source.document.volumes.cmsUploads.mounts.find(item => item.service === 'cms-worker').required, false);
  assert.throws(() => createInventory({ project: 'ownerinc-portal-prod', root }), /non_disposable_project/u);
  assert.throws(() => createFixtureProjectNames({ runId: 'not-a-run', runAttempt: '1' }), /invalid_run_identity/u);
});

test('legacy announcement lookup is bound to a captured source document UUID', () => {
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const targetSeedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const query = legacyAnnouncementLookupSql(sourceId);
  assert.match(query, new RegExp(`WHERE d\\.id='${sourceId}'$`, 'u'));
  assert.doesNotMatch(query, /LIKE|project|WHERE d\.title/u);
  assert.notEqual(query, legacyAnnouncementLookupSql(targetSeedId));
  assert.throws(() => legacyAnnouncementLookupSql('not-a-uuid'), /invalid_legacy_announcement_id/u);
});

test('snapshot normalization removes only the paired pg_dump boundary keys and retains row/sequence data', () => {
  const dump = (key, row = 'before', sequence = 17) => [
    '-- PostgreSQL database dump', '', `\\restrict ${key}`, '-- Dumped by pg_dump',
    'COPY public.fixture_rows (value) FROM stdin;',
    '\\restrict literal-copy-row', '\\unrestrict literal-copy-row', '\\.',
    `INSERT INTO public.fixture_rows (value) VALUES ('${row}');`,
    `SELECT pg_catalog.setval('public.fixture_rows_id_seq', ${sequence}, true);`,
    '-- PostgreSQL database dump complete', '', `\\unrestrict ${key}`, '',
  ].join('\n');
  const first = normalizePgDumpForSnapshot(Buffer.from(dump('key-first')));
  const repeated = normalizePgDumpForSnapshot(Buffer.from(dump('key-second')));
  assert.deepEqual(repeated, first, 'different random psql restriction keys must not alter snapshot identity');
  const retained = first.toString('utf8');
  assert.match(retained, /\\restrict literal-copy-row\n\\unrestrict literal-copy-row/u,
    'COPY payload lines that resemble psql commands must remain untouched');
  assert.notDeepEqual(normalizePgDumpForSnapshot(Buffer.from(dump('key-third', 'after'))), first,
    'changed database rows must remain visible to snapshot comparison');
  assert.notDeepEqual(normalizePgDumpForSnapshot(Buffer.from(dump('key-fourth', 'before', 18))), first,
    'changed sequence state must remain visible to snapshot comparison');
  assert.deepEqual(normalizePgDumpForSnapshot(Buffer.from('plain dump without psql controls\n')),
    Buffer.from('plain dump without psql controls\n'));
});
