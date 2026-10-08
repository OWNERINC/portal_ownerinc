import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  buildObserverAuditLease,
  matchesDockerBindMountPath,
  observerAuditDockerLabels,
  validateObserverDockerContainer,
} from '../integration/news-protocol-observer-audit.mjs'
import { assertLeaseScenario, parseHarnessArguments, validateLease } from '../integration/protocol-finalizer.mjs'

const RUN_ID = '8c72f420-c113-4a6c-9b8e-437a9dd0c5b7'
const NONCE = 'c'.repeat(64)
const IMAGE_ID = `sha256:${'a'.repeat(64)}`
type UUID = `${string}-${string}-${string}-${string}-${string}`

function scenarioLease(scenario: 'fresh-v2' | 'upgrade-v1', runId: UUID = RUN_ID, nonce = NONCE) {
  return {
    ...buildObserverAuditLease({ runId, nonce, dockerContext: 'desktop-linux',
      dockerEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine', port: 56391,
      imageRef: 'postgres:16.4-alpine', imageId: IMAGE_ID }),
    schemaVersion: 2,
    scenario,
  }
}

test('protocol finalizer CLI requires one of the two explicit scenario-bound modes', () => {
  assert.deepEqual(parseHarnessArguments(['--prepare-lease', '--scenario', 'fresh-v2']),
    { mode: 'prepare', scenario: 'fresh-v2' })
  assert.deepEqual(parseHarnessArguments(['--prepare-lease', '--scenario', 'upgrade-v1']),
    { mode: 'prepare', scenario: 'upgrade-v1' })
  assert.deepEqual(parseHarnessArguments(['--execute', '--scenario', 'fresh-v2', '--lease', 'C:\\private\\lease.json']),
    { mode: 'execute', scenario: 'fresh-v2', leasePath: 'C:\\private\\lease.json' })
  assert.deepEqual(parseHarnessArguments(['--execute', '--scenario', 'upgrade-v1', '--lease', 'C:\\private\\lease.json']),
    { mode: 'execute', scenario: 'upgrade-v1', leasePath: 'C:\\private\\lease.json' })

  for (const invalid of [
    [], ['--prepare-lease'], ['--prepare-lease', '--scenario', 'observer-audit'],
    ['--execute', '--lease', 'C:\\private\\lease.json'],
    ['--execute', '--scenario', 'fresh-v2', '--lease', 'C:\\private\\lease.json', '--execute'],
    ['--prepare-lease', '--scenario', 'fresh-v2', '--execute'],
  ]) assert.equal(parseHarnessArguments(invalid), null)
})

test('scenario leases reject legacy observer/finalizer leases and stay bound to fresh UUID namespaces', () => {
  const cold = scenarioLease('fresh-v2')
  const upgrade = scenarioLease('upgrade-v1', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'd'.repeat(64))
  const normalizedCold = validateLease(cold)
  const normalizedUpgrade = validateLease(upgrade)
  assert.equal(normalizedCold.scenario, 'fresh-v2')
  assert.equal(normalizedUpgrade.scenario, 'upgrade-v1')
  assert.notEqual(normalizedCold.project, normalizedUpgrade.project)
  assert.notEqual(normalizedCold.containerName, normalizedUpgrade.containerName)
  assert.notEqual(normalizedCold.volumeName, normalizedUpgrade.volumeName)
  assert.notEqual(normalizedCold.nonce, normalizedUpgrade.nonce)
  assert.notEqual(normalizedCold.project, 'ownerinc-payload-local')
  assert.equal(assertLeaseScenario(cold, 'fresh-v2').scenario, 'fresh-v2')
  assert.throws(() => assertLeaseScenario(cold, 'upgrade-v1'), { code: 'lease_scenario_mismatch' })

  assert.throws(() => validateLease({ ...cold, scenario: 'fresh-v2-observer' }))
  assert.throws(() => validateLease({ ...cold, schemaVersion: 1 }))
  const legacy = { ...cold, schemaVersion: 1 }
  delete (legacy as Partial<typeof legacy>).scenario
  delete (legacy as Partial<typeof legacy>).nonce
  assert.throws(() => validateLease(legacy))
})

test('Docker Desktop mount and immutable container identity checks are reused from the observer harness', () => {
  const lease = buildObserverAuditLease({ runId: RUN_ID, nonce: NONCE, dockerContext: 'desktop-linux',
    dockerEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine', port: 56391,
    imageRef: 'postgres:16.4-alpine', imageId: IMAGE_ID })
  const passwordFile = `C:\\Users\\fixture-owner\\private\\${RUN_ID}\\postgres-admin-password`
  const dockerSource = `/run/desktop/mnt/host/c/Users/fixture-owner/private/${RUN_ID}/postgres-admin-password`
  assert.equal(matchesDockerBindMountPath(dockerSource, passwordFile, 'win32'), true)
  assert.equal(matchesDockerBindMountPath(dockerSource.replace('/run/', '/RUN/'), passwordFile, 'win32'), false)

  const inspected = {
    Name: `/${lease.containerName}`, Id: 'd'.repeat(64), Image: lease.imageId,
    State: { Running: true }, Config: { Labels: observerAuditDockerLabels(lease),
      Env: ['POSTGRES_USER=cms_admin', 'POSTGRES_PASSWORD_FILE=/run/secrets/cms_admin_password'] },
    Mounts: [
      { Type: 'volume', Name: lease.volumeName, Destination: '/var/lib/postgresql/data', RW: true },
      { Type: 'bind', Source: dockerSource, Destination: '/run/secrets/cms_admin_password', RW: false },
    ],
    HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(lease.port) }] } },
    NetworkSettings: { Networks: { bridge: { IPAddress: '172.19.0.2' } } },
  }
  const identity = validateObserverDockerContainer(lease, passwordFile, inspected, 'win32')
  assert.deepEqual(identity, { containerId: 'd'.repeat(64), backendIPv4: '172.19.0.2' })
  assert.equal(Object.isFrozen(identity), true)
  assert.throws(() => validateObserverDockerContainer(lease, passwordFile,
    { ...inspected, Id: 'not-a-container-id' }, 'win32'))
  assert.throws(() => validateObserverDockerContainer(lease, passwordFile,
    { ...inspected, NetworkSettings: { Networks: { bridge: { IPAddress: 'not-an-ip' } } } }, 'win32'))
})

test('acceptance harness contains no committed synthetic cold-start run seeder and imports reviewed safeguards', async () => {
  const harnessPath = fileURLToPath(new URL('../integration/protocol-finalizer.mjs', import.meta.url))
  const source = await readFile(harnessPath, 'utf8')
  assert.doesNotMatch(source, /insertCommittedNativeFixture/u)
  assert.match(source, /verifyPostgresAndCreateOwnerCmsDatabase/u)
  assert.match(source, /validateWindowsConfiguredPrivateParent/u)
  assert.match(source, /validateObserverDockerContainer/u)
  assert.match(source, /matchesDockerBindMountPath/u)
  assert.match(source, /owner_news_bootstrap_run/u)
  assert.match(source, /scenario/u)
  assert.equal(path.basename(harnessPath), 'protocol-finalizer.mjs')
})

test('V1 rollback failpoint observes the final GRANT only after all narrow INSERT ACLs are catalog-visible', async () => {
  const harnessPath = fileURLToPath(new URL('../integration/protocol-finalizer.mjs', import.meta.url))
  const source = await readFile(harnessPath, 'utf8')
  const triggerStart = source.indexOf("IF TG_TAG='GRANT'")
  const triggerEnd = source.indexOf('      $fixture$', triggerStart)
  assert.notEqual(triggerStart, -1)
  assert.notEqual(triggerEnd, -1)
  const failpoint = source.slice(triggerStart, triggerEnd)
  const ownerGate = failpoint.indexOf("p.proowner='cms_control'")
  const grantInventory = failpoint.indexOf('count(DISTINCT a.attname)')
  const marker = failpoint.indexOf('nextval(')
  const abort = failpoint.indexOf("RAISE EXCEPTION 'protocol_v2_upgrade_fixture_abort'")
  assert.ok(ownerGate >= 0 && ownerGate < grantInventory)
  assert.ok(grantInventory < marker && marker < abort)
  assert.match(failpoint, /acl\.privilege_type='INSERT' AND acl\.is_grantable IS FALSE/u)
  assert.match(failpoint, /= \$\{BOOTSTRAP_RUN_INSERT_COLUMNS\.length\}/u)
  assert.match(failpoint, /a\.attname=ANY\(ARRAY\[\$\{insertColumnList\}\]::pg_catalog\.name\[\]\)/u)
  assert.doesNotMatch(failpoint, /pg_event_trigger_ddl_commands/u)

  const inspectionStart = source.indexOf('async function inspectBootstrapInsertGrantState')
  const inspectionEnd = source.indexOf('async function protocolIsAbsent', inspectionStart)
  const inspection = source.slice(inspectionStart, inspectionEnd)
  assert.notEqual(inspectionStart, -1)
  assert.notEqual(inspectionEnd, -1)
  assert.match(inspection, /a\.attnum>0 AND NOT a\.attisdropped/u)
  assert.match(inspection, /has_column_privilege\('cms_control',a\.attrelid,a\.attnum::integer,'INSERT'\)/u)
  assert.match(inspection, /acl\.grantee='cms_control'::pg_catalog\.regrole::pg_catalog\.oid[\s\S]*?acl\.privilege_type='INSERT'/u)
})

test('direct run-row denial proof covers controller and runtime with a shared valid-shape row', async () => {
  const harnessPath = fileURLToPath(new URL('../integration/protocol-finalizer.mjs', import.meta.url))
  const source = await readFile(harnessPath, 'utf8')
  assert.match(source, /const validDirectInsertValues = \[randomUUID\(\), randomBytes\(32\)\.toString\('hex'\),[\s\S]*?'protocol-direct-insert-probe'/u)
  assert.match(source, /BOOTSTRAP_RUN_INSERT_COLUMNS\.join\(','\)[\s\S]*?'preparing','open','acknowledged','\[\]'::jsonb/u)
  assert.match(source, /for \(const role of \['cms_controller', 'cms_runtime'\]\) \{\s*const comparison = await proveRunTableInsertDenied/u)
  assert.match(source, /assertDirectRunInsertDenialEvidence\(\{ sqlstate: statementError\?\.code \?\? null,[\s\S]*?before: before\.summary, after: after\.summary \}\)/u)
})
