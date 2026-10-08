import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { containsPossibleSecret } from '../../../scripts/verify.mjs'
import {
  OBSERVER_AUDIT_STAGES,
  assertExpectedRoleDenied,
  assertObserverHostRuntime,
  assertObserverAuditReport,
  assertNoReparseAncestors,
  assertOutsideGitWorktrees,
  buildCanonicalSnapshotDigest,
  buildChildEnvironment,
  buildObserverAuditLease,
  createOwnerCmsDatabase,
  matchesDockerBindMountPath,
  waitForPostgres,
  verifyPostgresAndCreateOwnerCmsDatabase,
  dispatchHarnessCommand,
  observerAuditDockerLabels,
  parseHarnessArguments,
  prepareObserverLease,
  sanitizeDiagnosticOutput,
  validateDockerPreflight,
  validatePrivateBasePath,
  validateObserverDockerContainer,
  validateWindowsConfiguredPrivateParent,
  validateObserverAuditLease,
  validateObserverLeasePath,
} from '../integration/news-protocol-observer-audit.mjs'
import { validateWindowsAncestorChain, validateWindowsProfileIdentity } from '../integration/protocol-finalizer.mjs'

const runId = '8c72f420-c113-4a6c-9b8e-437a9dd0c5b7'
const nonce = 'c'.repeat(64)
const imageId = `sha256:${'a'.repeat(64)}`
const windowsUserSid = 'S-1-5-21-100-200-300-1001'
const windowsFullControlMask = 2032127

function lease(overrides: Record<string, unknown> = {}) {
  return buildObserverAuditLease({ runId, nonce, dockerContext: 'desktop-linux',
    dockerEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine', port: 45321,
    imageRef: 'postgres:16-alpine', imageId, ...overrides })
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    status: 'PASS', installed: true, catalogValid: true, targetDatabase: 'ownerinc_cms', observerRole: 'cms_observer',
    observedCoverageVersion: 0, headSequence: '0', writeBarrier: 'open', ready: false, admissionActivated: false,
    releaseCertified: false, writeCoverageCertified: false, drainVerified: false,
    passwordPresenceCheck: 'not_performed_unprivileged',
    clusterSharedOwnershipCheck: 'performed_read_only_pg_shdepend_check', physicalClusterIdentity: 'not_verified',
    ...overrides,
  }
}

function windowsAce(sid: string, rightsMask: number, overrides: Record<string, unknown> = {}) {
  const appliesToObject = overrides.appliesToObject !== false
  const containerInherit = overrides.containerInherit === true
  const objectInherit = overrides.objectInherit === true
  return {
    sid, type: 'Allow', rights: rightsMask === windowsFullControlMask ? 'FullControl' : 'fixture-rights', rightsMask,
    inherited: false, appliesToObject, inheritOnly: !appliesToObject, containerInherit, objectInherit,
    noPropagateInherit: false, inheritedToChild: containerInherit || objectInherit, tokenMatch: sid === windowsUserSid,
    ...overrides,
  }
}

function windowsAclNode(pathname: string, depth: number, ownerSid: string, entries: object[], overrides: Record<string, unknown> = {}) {
  return {
    path: pathname, depth, reparse: false, ownerSid, daclProtected: true, daclPresent: true, daclNull: false,
    daclInspectable: true, daclEmpty: false, daclAceCount: entries.length,
    daclControlFlags: 'DiscretionaryAclPresent, SelfRelative', entries, ...overrides,
  }
}

function windowsExternalParentFixture(parentPath = 'C:\\Users\\Public\\ownerinc-observer-private-fixture') {
  const systemSid = 'S-1-5-18'
  const administratorsSid = 'S-1-5-32-544'
  const trustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  const fullControl = (sid: string, inherited = false, appliesToObject = true) => windowsAce(sid,
    windowsFullControlMask, { inherited, appliesToObject, inheritOnly: !appliesToObject,
      containerInherit: true, objectInherit: true, inheritedToChild: true })
  const publicEntries = [
    fullControl(systemSid), fullControl(administratorsSid),
    windowsAce('S-1-3-0', windowsFullControlMask, { appliesToObject: false, containerInherit: true,
      objectInherit: true, inheritedToChild: true }),
  ]
  for (const sid of ['S-1-5-3', 'S-1-5-4', 'S-1-5-6']) {
    publicEntries.push(windowsAce(sid, 1179823))
    publicEntries.push(windowsAce(sid, 1245695, { appliesToObject: false, containerInherit: true,
      objectInherit: true, inheritedToChild: true }))
  }
  const parentNode = windowsAclNode(parentPath, 0, windowsUserSid,
    [fullControl(windowsUserSid), fullControl(systemSid)])
  const publicNode = windowsAclNode('C:\\Users\\Public', 1, systemSid, publicEntries)
  const usersNode = windowsAclNode('C:\\Users', 2, systemSid, [
    fullControl(systemSid), fullControl(administratorsSid),
    windowsAce('S-1-1-0', -1610612736, { appliesToObject: false, containerInherit: true,
      objectInherit: true, inheritedToChild: true }),
    windowsAce('S-1-1-0', 1179817),
    windowsAce('S-1-5-32-545', 1179817),
  ])
  const volumeNode = windowsAclNode('C:\\', 3, trustedInstallerSid, [
    fullControl(systemSid), fullControl(administratorsSid),
    windowsAce('S-1-5-11', 4),
    windowsAce('S-1-5-11', -536805376, { appliesToObject: false, containerInherit: true,
      objectInherit: true, inheritedToChild: true }),
  ])
  return [parentNode, publicNode, usersNode, volumeNode]
}

function inspectedDockerContainer(targetLease: ReturnType<typeof lease>, passwordFile: string) {
  const dockerSource = `/run/desktop/mnt/host/${passwordFile.slice(0, 1).toLowerCase()}/`
    + passwordFile.slice(3).replaceAll('\\', '/')
  return {
    Name: `/${targetLease.containerName}`,
    Id: 'd'.repeat(64),
    Image: targetLease.imageId,
    State: { Running: true, Status: 'running' },
    Config: {
      Image: targetLease.imageId,
      Labels: observerAuditDockerLabels(targetLease),
      Env: ['POSTGRES_USER=cms_admin', 'POSTGRES_DB=postgres',
        'POSTGRES_PASSWORD_FILE=/run/secrets/cms_admin_password'],
    },
    Mounts: [
      { Type: 'volume', Name: targetLease.volumeName,
        Source: `/var/lib/docker/volumes/${targetLease.volumeName}/_data`,
        Destination: '/var/lib/postgresql/data', RW: true },
      { Type: 'bind', Name: '', Source: dockerSource,
        Destination: '/run/secrets/cms_admin_password', RW: false },
    ],
    HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(targetLease.port) }] } },
    NetworkSettings: { Networks: { bridge: { IPAddress: '172.19.0.2' } } },
  }
}

test('observer lease schema fixes fresh PostgreSQL resources, and labels bind the nonce without exposing it', () => {
  const prepared = lease()
  assert.equal(validateObserverAuditLease(prepared), prepared)
  assert.equal(Object.isFrozen(prepared), true)
  assert.equal(Object.hasOwn(prepared, 'backendIPv4'), false)
  const labels = observerAuditDockerLabels(prepared)
  assert.equal(labels['com.docker.compose.project'], `ownerinc-payload-observer-audit-${runId.replaceAll('-', '').slice(0, 12)}`)
  assert.equal(labels['ownerinc.payload-observer-audit.run-id'], runId)
  assert.match(labels['ownerinc.payload-observer-audit.lease-nonce-sha256'], /^[0-9a-f]{64}$/u)
  assert.equal(JSON.stringify(labels).includes(nonce), false)
  assert.equal(prepared.host, '127.0.0.1')
  assert.equal(prepared.imageRef, 'postgres:16-alpine')
  assert.throws(() => validateObserverAuditLease({ ...prepared, database: 'other' }), /observer_lease_shape_invalid/u)
  assert.throws(() => validateObserverAuditLease({ ...prepared, backendIPv4: '172.19.0.2' }),
    /observer_lease_shape_invalid/u)
  assert.throws(() => validateObserverAuditLease({ ...prepared, containerName: 'old-fixture' }), /observer_lease_resource_contract_invalid/u)
  assert.throws(() => lease({ dockerEndpoint: 'tcp://127.0.0.1:2375' }), /observer_lease_docker_context_not_local/u)
  assert.throws(() => lease({ imageRef: 'postgres:latest' }), /observer_lease_resource_contract_invalid/u)
})

test('Docker preflight refuses collisions, nonlocal endpoints, stale images and busy ports without writes', () => {
  const prepared = lease()
  const observation = {
    contextName: prepared.dockerContext, contextEndpoint: prepared.dockerEndpoint,
    dockerServerVersion: '27.5.1', imageId, imageRefAvailable: true,
    containerExists: false, volumeExists: false, projectResourcesExist: false, portAvailable: true,
  }
  assert.equal(validateDockerPreflight(prepared, observation), prepared)
  for (const collision of ['containerExists', 'volumeExists', 'projectResourcesExist']) {
    assert.throws(() => validateDockerPreflight(prepared, { ...observation, [collision]: true }),
      /observer_lease_resource_collision_refused/u)
  }
  assert.throws(() => validateDockerPreflight(prepared, { ...observation, imageId: `sha256:${'b'.repeat(64)}` }),
    /observer_lease_cached_postgres16_image_required/u)
  assert.throws(() => validateDockerPreflight(prepared, { ...observation, portAvailable: false }),
    /observer_lease_loopback_port_unavailable/u)
  assert.throws(() => validateDockerPreflight(prepared, { ...observation, dockerContextOverride: 'remote' }),
    /observer_lease_docker_context_mismatch/u)
})

test('Docker inspect accepts only the exact-case Windows Desktop bind-path representation', () => {
  const targetLease = lease()
  const passwordFile = `C:\\Users\\Public\\private\\${targetLease.runId}\\postgres-admin-password`
  const inspection = inspectedDockerContainer(targetLease, passwordFile)
  const backend = validateObserverDockerContainer(targetLease, passwordFile, inspection, 'win32')
  assert.deepEqual(backend, { containerId: 'd'.repeat(64), backendIPv4: '172.19.0.2' })
  assert.equal(Object.isFrozen(backend), true)
  assert.equal(matchesDockerBindMountPath(inspection.Mounts[1].Source, passwordFile, 'win32'), true)
  assert.equal(matchesDockerBindMountPath(inspection.Mounts[1].Source, passwordFile.toLowerCase(), 'win32'), true)
  assert.equal(matchesDockerBindMountPath(passwordFile, passwordFile, 'win32'), false)
  assert.equal(matchesDockerBindMountPath('/run/desktop/mnt/host/c/Users/Public/other/password',
    passwordFile, 'win32'), false)
  assert.equal(matchesDockerBindMountPath('/run/desktop/mnt/host/c/Users/Public/private/../password',
    passwordFile, 'win32'), false)
  const unrecognizedLinuxPath = '/RUN/desktop/mnt/host/c/Users/Public/private/postgres-admin-password'
  assert.equal(matchesDockerBindMountPath(unrecognizedLinuxPath,
    path.win32.resolve('C:\\', unrecognizedLinuxPath), 'win32'), false)
  const caseVariants = [
    inspection.Mounts[1].Source.replace('/run/', '/RUN/'),
    inspection.Mounts[1].Source.replace('/desktop/', '/Desktop/'),
    inspection.Mounts[1].Source.replace('/mnt/', '/MNT/'),
    inspection.Mounts[1].Source.replace('/host/c/', '/host/C/'),
  ]
  for (const source of caseVariants) {
    assert.equal(matchesDockerBindMountPath(source, passwordFile, 'win32'), false)
    const wrongCasePrefix = inspectedDockerContainer(targetLease, passwordFile)
    wrongCasePrefix.Mounts[1].Source = source
    assert.throws(() => validateObserverDockerContainer(targetLease, passwordFile, wrongCasePrefix, 'win32'),
      /observer_docker_container_identity_mismatch/u)
  }

  const changedBind = inspectedDockerContainer(targetLease, passwordFile)
  changedBind.Mounts[1].Source = '/run/desktop/mnt/host/c/Users/Public/other/password'
  assert.throws(() => validateObserverDockerContainer(targetLease, passwordFile, changedBind, 'win32'),
    /observer_docker_container_identity_mismatch/u)

  const exposedPort = inspectedDockerContainer(targetLease, passwordFile)
  exposedPort.HostConfig.PortBindings['5432/tcp'][0].HostIp = '0.0.0.0'
  assert.throws(() => validateObserverDockerContainer(targetLease, passwordFile, exposedPort, 'win32'),
    /observer_docker_container_identity_mismatch/u)

  const wrongVolume = inspectedDockerContainer(targetLease, passwordFile)
  wrongVolume.Mounts[0].Name = 'unexpected-volume'
  assert.throws(() => validateObserverDockerContainer(targetLease, passwordFile, wrongVolume, 'win32'),
    /observer_docker_container_identity_mismatch/u)
})

test('child stages use closed environments and observer receives only its explicit connection URL', () => {
  const parent = {
    PATH: 'safe-path', TEMP: 'safe-temp',
    DATABASE_URL: 'postgresql://ambient/secret', CMS_DATABASE_URL: 'admin',
    CMS_ADMIN_DATABASE_URL: 'admin', CMS_RUNTIME_DATABASE_URL: 'runtime', CMS_OBSERVER_DATABASE_URL: 'ambient-observer',
    NODE_OPTIONS: '--require=hostile', DOCKER_HOST: 'tcp://remote',
  }
  const observer = buildChildEnvironment(parent, 'observer', {
    CMS_OBSERVER_DATABASE_URL: 'postgresql://cms_observer:private@127.0.0.1:45321/ownerinc_cms',
  })
  assert.deepEqual(observer, {
    PATH: 'safe-path', TEMP: 'safe-temp',
    CMS_OBSERVER_DATABASE_URL: 'postgresql://cms_observer:private@127.0.0.1:45321/ownerinc_cms',
  })
  assert.equal('DATABASE_URL' in observer, false)
  assert.equal('CMS_ADMIN_DATABASE_URL' in observer, false)
  assert.equal('CMS_RUNTIME_DATABASE_URL' in observer, false)
  assert.equal('NODE_OPTIONS' in observer, false)
  assert.equal('DOCKER_HOST' in observer, false)
  assert.throws(() => buildChildEnvironment(parent, 'observer', {
    CMS_OBSERVER_DATABASE_URL: 'observer', CMS_ADMIN_DATABASE_URL: 'admin',
  }), /observer_child_environment_contract_invalid/u)
  assert.throws(() => buildChildEnvironment(parent, 'migrate', { DATABASE_URL: 'ambient' }),
    /observer_child_environment_contract_invalid/u)
})

test('harness refuses non-Node-24 hosts or missing installed CMS dependencies without installing anything', () => {
  assert.equal(assertObserverHostRuntime('24.15.0', { tsx: true, pg: true, payloadCli: true }), true)
  for (const [version, dependencies] of [
    ['18.20.0', { tsx: true, pg: true, payloadCli: true }],
    ['24.15.0', { tsx: false, pg: true, payloadCli: true }],
    ['24.15.0', { tsx: true, pg: true, payloadCli: false }],
  ]) assert.throws(() => assertObserverHostRuntime(version, dependencies), /observer_host_node24_cms_dependencies_required/u)
})

test('observer harness remains clean under the repository secret scanner', async () => {
  const harnessPath = new URL('../integration/news-protocol-observer-audit.mjs', import.meta.url)
  const source = await readFile(harnessPath, 'utf8')
  assert.equal(containsPossibleSecret('cms/tests/integration/news-protocol-observer-audit.mjs', source), false)
})

test('write paths require the immutable PG16 probe identity before CREATE DATABASE', async () => {
  const backend = { containerId: 'b'.repeat(64), backendIPv4: '172.19.0.2' }
  const systemIdentifier = '123456789012345'
  const probeClient = {
    connect: async () => {},
    end: async () => {},
    query: async (sql: string) => {
      assert.match(sql, /pg_control_system\(\)/u)
      return { rows: [{ role: 'cms_admin', database: 'postgres', server_address: '172.19.0.2/32',
        server_port: 5432, version_num: 160005, superuser: true, system_identifier: systemIdentifier }] }
    },
  }
  const verifiedBackend = await waitForPostgres(lease(), backend, 'fixture-only', options => {
    assert.match(options.connectionString, /\/postgres$/u)
    return probeClient
  })
  assert.deepEqual(verifiedBackend, { containerId: backend.containerId,
    backendIPv4: backend.backendIPv4, systemIdentifier })
  assert.equal(Object.isFrozen(verifiedBackend), true)
  let invalidBackendReachedProbe = false
  await assert.rejects(waitForPostgres(lease(), { ...backend, backendIPv4: '' }, 'fixture-only', () => {
    invalidBackendReachedProbe = true
    return probeClient
  }), /observer_postgres_docker_backend_identity_invalid/u)
  assert.equal(invalidBackendReachedProbe, false)
  const malformedProbeClient = {
    connect: async () => {},
    end: async () => {},
    query: async () => ({ rows: [{ role: 'cms_admin', database: 'postgres', server_address: '172.19.0.2/32',
      server_port: 5432, version_num: 160005, superuser: true, system_identifier: '12345x' }] }),
  }
  await assert.rejects(waitForPostgres(lease(), backend, 'fixture-only', () => malformedProbeClient),
    /observer_postgres_bootstrap_identity_mismatch/u)

  const passwords = { cms_admin: 'fixture-only' }
  const queryLog = (identity: Record<string, unknown> = {}, observedSystemIdentifier = systemIdentifier) => {
    const queries: string[] = []
    const client = {
      query: async (sql: string) => {
        queries.push(sql)
        if (sql.includes('current_user AS role')) return { rows: [{ role: 'cms_admin', session_role: 'cms_admin',
          database: 'postgres', server_address: '172.19.0.2/32', server_port: 5432,
          version_num: 160005, superuser: true, ...identity }] }
        if (sql.includes('pg_control_system()')) {
          return { rows: [{ system_identifier: observedSystemIdentifier }] }
        }
        if (sql.includes('pg_catalog.pg_database')) return { rowCount: 0, rows: [] }
        return { rowCount: 0, rows: [] }
      },
    }
    let clientRunnerCalled = false
    const clientRunner = async (_connectionString: string,
      operation: (target: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) => {
      clientRunnerCalled = true
      return operation(client)
    }
    return { queries, clientRunner, wasClientRunnerCalled: () => clientRunnerCalled }
  }
  const databaseLease = lease()

  for (const missingBackend of [undefined, null, { backendIPv4: backend.backendIPv4 },
    { backendIPv4: backend.backendIPv4, systemIdentifier }]) {
    const missingIdentity = queryLog()
    await assert.rejects(createOwnerCmsDatabase(databaseLease, passwords, missingBackend, backend,
      missingIdentity.clientRunner),
      /observer_postgres_verified_identity_required/u)
    assert.equal(missingIdentity.wasClientRunnerCalled(), false)
    assert.equal(missingIdentity.queries.some(sql => /^CREATE DATABASE\b/u.test(sql)), false)
  }

  for (const [changedContainer, expectedFailure] of [
    [undefined, /observer_postgres_docker_backend_identity_invalid/u],
    [{ backendIPv4: backend.backendIPv4 }, /observer_postgres_docker_backend_identity_invalid/u],
    [{ ...backend, containerId: 'c'.repeat(64) }, /observer_postgres_docker_backend_identity_mismatch/u],
  ] as const) {
    const unauthorizedContainer = queryLog()
    await assert.rejects(createOwnerCmsDatabase(databaseLease, passwords, verifiedBackend, changedContainer,
      unauthorizedContainer.clientRunner), expectedFailure)
    assert.equal(unauthorizedContainer.wasClientRunnerCalled(), false)
    assert.equal(unauthorizedContainer.queries.some(sql => /^CREATE DATABASE\b/u.test(sql)), false)
  }

  const changedSystem = queryLog({}, '987654321098765')
  await assert.rejects(createOwnerCmsDatabase(databaseLease, passwords, verifiedBackend, backend,
    changedSystem.clientRunner),
    /observer_postgres_system_identifier_mismatch/u)
  assert.equal(changedSystem.queries.some(sql => /^CREATE DATABASE\b/u.test(sql)), false)

  for (const wrongIdentity of [
    { database: 'unexpected_database' },
    { server_address: '172.19.0.9/32' },
    { server_port: 5433 },
  ]) {
    const wrongTarget = queryLog(wrongIdentity)
    await assert.rejects(createOwnerCmsDatabase(databaseLease, passwords, verifiedBackend, backend,
      wrongTarget.clientRunner),
      /observer_postgres_backend_identity_mismatch/u)
    assert.equal(wrongTarget.queries.some(sql => /^CREATE DATABASE\b/u.test(sql)), false)
  }

  const validTarget = queryLog()
  await createOwnerCmsDatabase(databaseLease, passwords, verifiedBackend, backend, validTarget.clientRunner)
  assert.equal(validTarget.queries.some(sql => /^CREATE DATABASE\b/u.test(sql)), true)
})

test('real provisioning prefix preserves the immutable lease through Postgres probe, Docker recheck and CREATE DATABASE', async () => {
  const targetLease = lease()
  const leaseKeys = Object.keys(targetLease).sort()
  const leaseJSON = JSON.stringify(targetLease)
  const passwordFile = `C:\\Users\\Public\\private\\${targetLease.runId}\\postgres-admin-password`
  const rawInspection = inspectedDockerContainer(targetLease, passwordFile)
  const eventOrder: string[] = ['initial-docker-inspection']
  const backend = validateObserverDockerContainer(targetLease, passwordFile, rawInspection, 'win32')
  const systemIdentifier = '123456789012345'
  const stages: string[] = []
  const probeClient = {
    connect: async () => { eventOrder.push('postgres-connect') },
    end: async () => { eventOrder.push('postgres-disconnect') },
    query: async (sql: string) => {
      assert.match(sql, /pg_control_system\(\)/u)
      eventOrder.push('postgres-system-identity-query')
      return { rows: [{ role: 'cms_admin', database: 'postgres', server_address: '172.19.0.2/32',
        server_port: 5432, version_num: 160005, superuser: true, system_identifier: systemIdentifier }] }
    },
  }
  const targetQueries: string[] = []
  const targetClient = {
    query: async (sql: string) => {
      targetQueries.push(sql)
      if (sql.includes('current_user AS role')) return { rows: [{ role: 'cms_admin', session_role: 'cms_admin',
        database: 'postgres', server_address: '172.19.0.2/32', server_port: 5432,
        version_num: 160005, superuser: true }] }
      if (sql.includes('pg_control_system()')) return { rows: [{ system_identifier: systemIdentifier }] }
      if (sql.includes('pg_catalog.pg_database')) return { rowCount: 0, rows: [] }
      return { rowCount: 0, rows: [] }
    },
  }

  const identities = await verifyPostgresAndCreateOwnerCmsDatabase(targetLease, backend,
    { cms_admin: 'fixture-only' }, passwordFile, {
      createClient: options => {
        assert.match(options.connectionString, /\/postgres$/u)
        eventOrder.push('probe-client-created')
        return probeClient
      },
      inspectContainer: (inspectedLease, inspectedPasswordFile) => {
        eventOrder.push('docker-reinspection')
        assert.equal(inspectedLease, targetLease)
        assert.equal(Object.hasOwn(inspectedLease, 'backendIPv4'), false)
        assert.deepEqual(Object.keys(inspectedLease).sort(), leaseKeys)
        return validateObserverDockerContainer(inspectedLease, inspectedPasswordFile, rawInspection, 'win32')
      },
      clientRunner: async (_connectionString, operation) => {
        eventOrder.push('database-write-client')
        return operation(targetClient)
      },
      stageResult: async (name, operation, summarize = (value: unknown) => value) => {
        stages.push(`${name}:start`)
        const result = await operation()
        summarize(result)
        stages.push(`${name}:pass`)
        return result
      },
    })

  assert.deepEqual(Object.keys(targetLease).sort(), leaseKeys)
  assert.equal(JSON.stringify(targetLease), leaseJSON)
  assert.equal(Object.hasOwn(targetLease, 'backendIPv4'), false)
  assert.equal(validateObserverAuditLease(targetLease), targetLease)
  assert.deepEqual(stages, [
    'verify-new-postgres16-system-identity:start', 'verify-new-postgres16-system-identity:pass',
    'reconfirm-new-postgres16-docker-identity:start', 'reconfirm-new-postgres16-docker-identity:pass',
    'create-ownerinc-cms-database:start', 'create-ownerinc-cms-database:pass',
  ])
  assert.deepEqual(OBSERVER_AUDIT_STAGES.slice(2, 5), [
    'verify-new-postgres16-system-identity', 'reconfirm-new-postgres16-docker-identity',
    'create-ownerinc-cms-database',
  ])
  assert.deepEqual(identities.verifiedBackend, { containerId: backend.containerId,
    backendIPv4: backend.backendIPv4, systemIdentifier })
  assert.deepEqual(identities.inspectedBackend, { containerId: backend.containerId,
    backendIPv4: backend.backendIPv4 })
  assert.ok(eventOrder.indexOf('initial-docker-inspection') < eventOrder.indexOf('probe-client-created'))
  assert.ok(eventOrder.indexOf('probe-client-created') < eventOrder.indexOf('postgres-system-identity-query'))
  assert.ok(eventOrder.indexOf('postgres-system-identity-query') < eventOrder.indexOf('docker-reinspection'))
  assert.ok(eventOrder.indexOf('docker-reinspection') < eventOrder.indexOf('database-write-client'))
  const identityQueryIndex = targetQueries.findIndex(sql => sql.includes('current_user AS role'))
  const systemQueryIndex = targetQueries.findIndex(sql => sql.includes('pg_control_system()'))
  const createDatabaseIndex = targetQueries.findIndex(sql => /^CREATE DATABASE\b/u.test(sql))
  assert.ok(identityQueryIndex >= 0 && identityQueryIndex < systemQueryIndex)
  assert.ok(systemQueryIndex < createDatabaseIndex)
})

test('harness CLI is explicit and execution is never reached by preparation dispatch', async () => {
  assert.deepEqual(parseHarnessArguments(['--prepare-lease']), { mode: 'prepare' })
  assert.deepEqual(parseHarnessArguments(['--execute', '--leasepath', 'C:\\Users\\Public\\lease.json']),
    { mode: 'execute', leasePath: 'C:\\Users\\Public\\lease.json' })
  for (const args of [[], ['--prepare'], ['--execute'], ['--execute', '--leasepath', ''],
    ['--prepare-lease', '--execute', '--leasepath', 'x']]) {
    assert.throws(() => parseHarnessArguments(args), /observer_harness_usage_invalid/u)
  }
  let prepared = 0
  let executed = 0
  await dispatchHarnessCommand(['--prepare-lease'], {
    prepare: async () => { prepared += 1 }, execute: async () => { executed += 1 },
  })
  assert.equal(prepared, 1)
  assert.equal(executed, 0)
})

test('preparation writes only after clean resource, cached-image, loopback and private-parent guards', async () => {
  const privateBase = await mkdtemp(path.join(os.tmpdir(), 'observer-audit-prep-'))
  const events: string[] = []
  const facts = {
    contextName: 'desktop-linux', contextEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine',
    dockerServerVersion: '27.5.1', imageRef: 'postgres:16-alpine', imageId,
    imageRefAvailable: true, containerExists: false, volumeExists: false, projectResourcesExist: false,
  }
  try {
    const prepared = await prepareObserverLease({
      inspect: async ({ runId: generatedRunId }: { runId: string }) => {
        events.push('inspect')
        assert.equal(generatedRunId, runId)
        return facts
      },
      reservePort: async () => { events.push('reserve-port'); return 45321 },
      checkPort: async (host: string, port: number) => {
        events.push('check-port')
        assert.equal(host, '127.0.0.1')
        assert.equal(port, 45321)
      },
      privateBase, runId, nonce,
      validateGitBoundary: async () => { events.push('validate-git-boundary'); return true },
      validatePrivateBase: async () => { events.push('validate-private-parent') },
      createPrivateDirectory: async (directory: string) => { events.push('create-directory'); assert.ok(directory.startsWith(privateBase)) },
      writePrivateFile: async (filePath: string, contents: string) => {
        events.push('write-lease')
        assert.ok(filePath.endsWith(path.join(path.basename(path.dirname(filePath)), 'lease.json')))
        assert.equal(JSON.parse(contents).runId, runId)
      },
    })
    assert.equal(prepared.lease.runId, runId)
    const leaseDirectory = `${process.platform === 'win32' ? '.' : ''}ownerinc-payload-observer-audit-${runId}`
    assert.equal(prepared.leasePath, path.join(privateBase, leaseDirectory, 'lease.json'))
    assert.deepEqual(events, ['inspect', 'reserve-port', 'check-port', 'validate-git-boundary',
      'validate-private-parent', 'create-directory', 'write-lease'])

    for (const unsafeFacts of [
      { ...facts, projectResourcesExist: true },
      { ...facts, imageRefAvailable: false },
    ]) {
      let writes = 0
      await assert.rejects(prepareObserverLease({
        inspect: async () => unsafeFacts,
        reservePort: async () => 45321,
        checkPort: async () => {},
        privateBase, runId, nonce,
        validateGitBoundary: async () => true,
        validatePrivateBase: async () => {},
        createPrivateDirectory: async () => { writes += 1 },
        writePrivateFile: async () => { writes += 1 },
      }))
      assert.equal(writes, 0)
    }

    let writesAfterBusyPort = 0
    await assert.rejects(prepareObserverLease({
      inspect: async () => facts,
      reservePort: async () => 45321,
      checkPort: async () => { throw new Error('busy') },
      privateBase, runId, nonce,
      validateGitBoundary: async () => true,
      validatePrivateBase: async () => {},
      createPrivateDirectory: async () => { writesAfterBusyPort += 1 },
      writePrivateFile: async () => { writesAfterBusyPort += 1 },
    }))
    assert.equal(writesAfterBusyPort, 0)
  } finally {
    await rm(privateBase, { recursive: true, force: true })
  }
})

test('strict private path and Git-boundary checks reject alternate, symlinked and repository-owned lease paths', async () => {
  const prepared = lease()
  const base = 'C:\\Users\\Public\\opencode'
  assert.equal(validateObserverLeasePath(path.win32.join(base,
    `.ownerinc-payload-observer-audit-${runId}`, 'lease.json'), base, runId, 'win32'),
  path.win32.join(base, `.ownerinc-payload-observer-audit-${runId}`, 'lease.json'))
  assert.throws(() => validateObserverLeasePath(path.win32.join(base,
    'ownerinc-payload-finalizer-old', 'lease.json'), base, runId, 'win32'), /observer_lease_path_outside_private_state/u)
  assert.throws(() => validateObserverLeasePath(path.win32.join(base,
    `.ownerinc-payload-observer-audit-${runId}`, '..', 'lease.json'), base, runId, 'win32'),
  /observer_lease_path_outside_private_state/u)
  assert.equal(validatePrivateBasePath('C:\\Users\\Public\\opencode', 'win32'), 'C:\\Users\\Public\\opencode')
  assert.throws(() => validatePrivateBasePath('C:\\Users\\Public\\name@secret', 'win32'),
    /observer_private_state_path_invalid/u)
  assert.throws(() => validatePrivateBasePath('postgresql://cms:password@localhost/db', 'win32'),
    /observer_private_state_path_invalid/u)
  const root = path.join(os.tmpdir(), 'observer-audit-git-boundary', runId)
  const marker = path.join(path.dirname(root), '.git')
  const noGit = async (): Promise<any> => { const error = Object.assign(new Error('missing'), { code: 'ENOENT' }); throw error }
  const withGit = async (filename: string): Promise<any> => {
    if (filename === marker) return { isSymbolicLink: () => false }
    return noGit()
  }
  await assertOutsideGitWorktrees(root, noGit as any)
  await assert.rejects(assertOutsideGitWorktrees(root, withGit as any), /observer_private_state_inside_git_worktree/u)
  const safeStat = { isSymbolicLink: () => false }
  await assertNoReparseAncestors(path.resolve(root), (async () => safeStat as any) as any)
  await assert.rejects(assertNoReparseAncestors(path.resolve(root), (async (filename: string) =>
    filename === path.dirname(path.resolve(root)) ? { isSymbolicLink: () => true } : safeStat as any) as any),
  /observer_private_path_missing_or_reparse_point/u)
})

test('external Windows private parent has a distinct protected-ACL contract from the registered profile', async () => {
  const parentPath = 'C:\\Users\\Public\\ownerinc-observer-private-fixture'
  const registeredProfilePath = 'C:\\Users\\OwnerincFixture'
  const ancestors = windowsExternalParentFixture(parentPath)
  assert.equal(validateWindowsProfileIdentity({ currentUserSid: windowsUserSid,
    profilePath: registeredProfilePath, registeredProfilePath }), true)
  assert.throws(() => validateWindowsProfileIdentity({ currentUserSid: windowsUserSid,
    profilePath: parentPath, registeredProfilePath }), /private_windows_profile_identity_mismatch/u)
  assert.throws(() => validateWindowsAncestorChain({ currentUserSid: windowsUserSid,
    profilePath: parentPath, registeredProfilePath: parentPath, ancestors }), /private_windows_profile_parent_invalid/u)
  assert.equal(validateWindowsConfiguredPrivateParent({ currentUserSid: windowsUserSid, parentPath, ancestors }), true)

  const unprotectedParent = windowsExternalParentFixture(parentPath)
  unprotectedParent[0].daclProtected = false
  assert.throws(() => validateWindowsConfiguredPrivateParent({ currentUserSid: windowsUserSid,
    parentPath, ancestors: unprotectedParent }), /observer_private_windows_configured_parent_acl_invalid/u)

  const publicDirectoryAsParent = windowsExternalParentFixture(parentPath)[1]
  publicDirectoryAsParent.depth = 0
  assert.throws(() => validateWindowsConfiguredPrivateParent({ currentUserSid: windowsUserSid,
    parentPath: 'C:\\Users\\Public', ancestors: [publicDirectoryAsParent] }),
  /observer_private_windows_configured_parent_acl_invalid/u)

  const untrustedReplace = windowsExternalParentFixture(parentPath)
  untrustedReplace[1].entries.push(windowsAce('S-1-1-0', windowsFullControlMask))
  untrustedReplace[1].daclAceCount = untrustedReplace[1].entries.length
  assert.throws(() => validateWindowsConfiguredPrivateParent({ currentUserSid: windowsUserSid,
    parentPath, ancestors: untrustedReplace }), /observer_private_windows_configured_parent_untrusted_write_grant/u)

  const reparseAncestor = windowsExternalParentFixture(parentPath)
  reparseAncestor[1].reparse = true
  assert.throws(() => validateWindowsConfiguredPrivateParent({ currentUserSid: windowsUserSid,
    parentPath, ancestors: reparseAncestor }), /observer_private_windows_configured_parent_acl_invalid/u)

  const candidate = path.resolve(os.tmpdir(), 'observer-audit-external-parent-fixture', runId)
  const marker = path.join(path.dirname(candidate), '.git')
  const fakeLstat = async (filename: string): Promise<any> => {
    if (filename === marker) return { isSymbolicLink: () => false }
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
    throw error
  }
  await assert.rejects(assertOutsideGitWorktrees(candidate, fakeLstat as any),
    /observer_private_state_inside_git_worktree/u)
  const symlinkAncestor = path.dirname(candidate)
  await assert.rejects(assertNoReparseAncestors(candidate, (async (filename: string) =>
    filename === symlinkAncestor ? { isSymbolicLink: () => true } : { isSymbolicLink: () => false }) as any),
  /observer_private_path_missing_or_reparse_point/u)
})

test('audit output contract remains observational and denial evidence requires SQLSTATE 42501', () => {
  assert.equal(assertObserverAuditReport(report()).observedCoverageVersion, 0)
  assert.equal(assertObserverAuditReport(report({ observedCoverageVersion: 1 })).observedCoverageVersion, 1)
  for (const invalid of [
    report({ ready: true }), report({ releaseCertified: true }), report({ observedCoverageVersion: 2 }),
    { ...report(), password: 'must-not-appear' },
  ]) assert.throws(() => assertObserverAuditReport(invalid), /observer_audit_report/u)
  assert.equal(assertExpectedRoleDenied({ denied: true, sqlstate: '42501' }), true)
  assert.throws(() => assertExpectedRoleDenied({ denied: true, sqlstate: '00000' }), /observer_expected_select_denial_not_observed/u)
  assert.throws(() => assertExpectedRoleDenied({ denied: false, sqlstate: '42501' }), /observer_expected_select_denial_not_observed/u)
  assert.deepEqual(sanitizeDiagnosticOutput('secret postgresql://cms:pw@host/db\nCMS news protocol diagnostic: phase=audit-identity reason=denied sqlstate=42501'),
    { phase: 'audit-identity', sqlstate: '42501' })
  assert.deepEqual(sanitizeDiagnosticOutput('CMS bootstrap diagnostic: phase=ownership-policy sqlstate=42501'),
    { phase: 'ownership-policy', sqlstate: '42501' })
  assert.deepEqual(sanitizeDiagnosticOutput('Error: secret url postgresql://host/db'), { phase: null, sqlstate: null })
  assert.equal(OBSERVER_AUDIT_STAGES.some(stage => stage.includes('rollback-fixture') || stage.includes('synthetic-migration')), false)
})

test('catalog snapshot digest is canonical for object key order while retaining array order', () => {
  assert.equal(buildCanonicalSnapshotDigest([{ z: 1, a: { y: true, x: 2 } }]),
    buildCanonicalSnapshotDigest([{ a: { x: 2, y: true }, z: 1 }]))
  assert.notEqual(buildCanonicalSnapshotDigest([{ items: [1, 2] }]), buildCanonicalSnapshotDigest([{ items: [2, 1] }]))
})
