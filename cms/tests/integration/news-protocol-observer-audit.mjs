// Fresh, lease-gated PostgreSQL 16 harness for the installed-protocol observer
// audit. Preparation is Docker-inspection-only; execution is a separate explicit
// command and intentionally preserves its container, volume, and private report.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  decodeWindowsPowerShellStdout,
  powershellScriptWithUtf8Output,
  validatePrivateAclSnapshot,
  validatePrivatePosixStat,
  validateWindowsProfileIdentity,
} from './protocol-finalizer.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CMS = path.join(ROOT, 'cms')
const DATABASE = 'ownerinc_cms'
const PROJECT_PREFIX = 'ownerinc-payload-observer-audit'
const FIXTURE_LABEL = 'ownerinc.payload-observer-audit.fixture'
const RUN_LABEL = 'ownerinc.payload-observer-audit.run-id'
const NONCE_LABEL = 'ownerinc.payload-observer-audit.lease-nonce-sha256'
const LEASE_VERSION = 1
const FORBIDDEN_RELATIONS = ['news_articles', 'news_media', 'news_schedules', 'payload_jobs', 'owner_news_mutation_events']
const MIGRATIONS = [
  '20261002_181423_owner_news_initial',
  '20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication',
  '20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum',
  '20261006_181424_z_owner_news_native',
]
const LEASE_KEYS = [
  'schemaVersion', 'project', 'runId', 'nonce', 'dockerContext', 'dockerEndpoint',
  'containerName', 'volumeName', 'host', 'port', 'imageRef', 'imageId',
].sort()
const SAFE_PARENT_ENV_KEYS = new Set([
  'path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'home', 'appdata',
  'localappdata', 'comspec', 'pathext', 'lang', 'lc_all', 'tz',
])
const EXPLICIT_ENV_KEYS = {
  provision: new Set(['CMS_DATABASE_URL', 'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD', 'CMS_CONTROLLER_PASSWORD']),
  migrate: new Set(['CMS_DATABASE_URL', 'CMS_UPLOAD_DIR', 'PAYLOAD_SECRET', 'PAYLOAD_TO_PORTAL_SECRET',
    'PORTAL_TO_PAYLOAD_SECRET', 'PORTAL_PUBLIC_URL', 'PORTAL_INTERNAL_URL', 'NODE_ENV', 'NEXT_TELEMETRY_DISABLED']),
  verify: new Set(['CMS_DATABASE_URL']),
  bootstrap: new Set(['CMS_DATABASE_URL', 'CMS_CONTROLLER_PASSWORD']),
  finalizer: new Set(['CMS_ADMIN_DATABASE_URL']),
  observer: new Set(['CMS_OBSERVER_DATABASE_URL']),
}
const cmsRequire = createRequire(path.join(CMS, 'package.json'))
const { Client } = cmsRequire('pg')
const fail = code => { const error = new Error(code); error.code = code; throw error }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const postgresSystemIdentifierPattern = /^\d{10,20}$/u
const verifiedBackendIdentities = new WeakSet()
const WINDOWS_SYSTEM_SID = 'S-1-5-18'
const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544'
const WINDOWS_TRUSTED_INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
const WINDOWS_PRIVATE_PARENT_OWNER_SIDS = new Set([
  WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID, WINDOWS_TRUSTED_INSTALLER_SID,
])
// Mirrored from the finalizer's write/replace classification so external path
// checks reject delete, replacement, ownership, and ACL mutation grants.
const WINDOWS_PRIVATE_PARENT_WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000
  | 0x40000 | 0x80000 | 0x10000000 | 0x40000000
// Only non-inheriting child creation plus directory traversal/read is allowed
// on an ancestor; the configured parent itself has a protected exact ACL.
const WINDOWS_PRIVATE_PARENT_SAFE_ADD_MASK = 0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x80 | 0x20000 | 0x100000

function suffixFromRunId(runId) { return runId.replaceAll('-', '').slice(0, 12) }
function projectFromRunId(runId) { return `${PROJECT_PREFIX}-${suffixFromRunId(runId)}` }

function exactPlainObjectKeys(value, expectedKeys, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expectedKeys].sort())) fail(code)
}

export function assertLocalDockerContext(contextName, endpoint) {
  if (typeof contextName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u.test(contextName)
    || typeof endpoint !== 'string' || endpoint.includes('\0') || endpoint.includes('?') || endpoint.includes('#')) {
    fail('observer_lease_docker_context_invalid')
  }
  const windowsPipe = contextName === 'desktop-linux' && endpoint === 'npipe:////./pipe/dockerDesktopLinuxEngine'
  const unixSocket = endpoint.startsWith('unix:///') && !endpoint.slice('unix://'.length).split('/').includes('..')
  if (!windowsPipe && !unixSocket) fail('observer_lease_docker_context_not_local')
  return true
}

export function buildObserverAuditLease({ runId = randomUUID(), nonce = randomBytes(32).toString('hex'),
  dockerContext, dockerEndpoint, port, imageRef, imageId }) {
  if (!uuidPattern.test(runId) || !/^[0-9a-f]{64}$/u.test(nonce)) fail('observer_lease_identity_invalid')
  assertLocalDockerContext(dockerContext, dockerEndpoint)
  const suffix = suffixFromRunId(runId)
  const lease = {
    schemaVersion: LEASE_VERSION,
    project: projectFromRunId(runId),
    runId,
    nonce,
    dockerContext,
    dockerEndpoint,
    containerName: `${PROJECT_PREFIX}-${suffix}`,
    volumeName: `${PROJECT_PREFIX}-pgdata-${suffix}`,
    host: '127.0.0.1',
    port,
    imageRef,
    imageId,
  }
  validateObserverAuditLease(lease)
  return lease
}

export function validateObserverAuditLease(rawLease) {
  exactPlainObjectKeys(rawLease, LEASE_KEYS, 'observer_lease_shape_invalid')
  if (rawLease.schemaVersion !== LEASE_VERSION || !uuidPattern.test(rawLease.runId || '')
    || !/^[0-9a-f]{64}$/u.test(rawLease.nonce || '')) fail('observer_lease_identity_invalid')
  const suffix = suffixFromRunId(rawLease.runId)
  if (rawLease.project !== projectFromRunId(rawLease.runId)
    || rawLease.containerName !== `${PROJECT_PREFIX}-${suffix}`
    || rawLease.volumeName !== `${PROJECT_PREFIX}-pgdata-${suffix}`
    || rawLease.host !== '127.0.0.1' || !Number.isInteger(rawLease.port)
    || rawLease.port < 1024 || rawLease.port > 65535 || [55441, 19091, 19092, 9299].includes(rawLease.port)
    || typeof rawLease.imageRef !== 'string' || !/^postgres:16(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?$/u.test(rawLease.imageRef)
    || typeof rawLease.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(rawLease.imageId)) {
    fail('observer_lease_resource_contract_invalid')
  }
  assertLocalDockerContext(rawLease.dockerContext, rawLease.dockerEndpoint)
  return Object.freeze(rawLease)
}

export function observerAuditDockerLabels(lease) {
  const target = validateObserverAuditLease(lease)
  return {
    'com.docker.compose.project': target.project,
    'com.docker.compose.service': 'observer-audit-postgres',
    [FIXTURE_LABEL]: 'true',
    [RUN_LABEL]: target.runId,
    [NONCE_LABEL]: createHash('sha256').update(target.nonce).digest('hex'),
  }
}

export function validateDockerPreflight(lease, observation) {
  const target = validateObserverAuditLease(lease)
  if (observation?.contextName !== target.dockerContext || observation?.contextEndpoint !== target.dockerEndpoint
    || observation?.dockerHostOverride || observation?.dockerContextOverride) fail('observer_lease_docker_context_mismatch')
  if (observation?.dockerServerVersion !== undefined && !isSupportedDockerVersion(observation.dockerServerVersion)) {
    fail('observer_lease_docker_runtime_unsupported')
  }
  if (observation?.containerExists || observation?.volumeExists || observation?.projectResourcesExist) {
    fail('observer_lease_resource_collision_refused')
  }
  if (observation?.imageId !== target.imageId || observation?.imageRefAvailable !== true) {
    fail('observer_lease_cached_postgres16_image_required')
  }
  if (observation?.portAvailable !== undefined && observation.portAvailable !== true) {
    fail('observer_lease_loopback_port_unavailable')
  }
  return target
}

function isSupportedDockerVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/u.exec(String(value || ''))
  if (!match) return false
  const major = Number(match[1]), minor = Number(match[2])
  return major > 20 || (major === 20 && minor >= 10)
}

export function buildChildEnvironment(parentEnvironment, purpose, explicit = {}) {
  const allowed = EXPLICIT_ENV_KEYS[purpose]
  if (!allowed || !explicit || Object.getPrototypeOf(explicit) !== Object.prototype
    || Object.keys(explicit).some(key => !allowed.has(key))) fail('observer_child_environment_contract_invalid')
  const inherited = Object.fromEntries(Object.entries(parentEnvironment || {}).filter(([key, value]) =>
    SAFE_PARENT_ENV_KEYS.has(key.toLowerCase()) && typeof value === 'string'))
  if (purpose === 'observer' && Object.keys(explicit).length !== 1) fail('observer_child_environment_contract_invalid')
  return { ...inherited, ...explicit }
}

export function validateObserverLeasePath(leasePath, privateBase, runId, platform = process.platform) {
  if (!uuidPattern.test(runId || '') || typeof leasePath !== 'string' || typeof privateBase !== 'string') {
    fail('observer_lease_path_outside_private_state')
  }
  const pathApi = platform === 'win32' ? path.win32 : path
  const prefix = platform === 'win32' ? `.${PROJECT_PREFIX}-` : `${PROJECT_PREFIX}-`
  const directoryName = `${prefix}${runId}`
  const expected = pathApi.join(pathApi.resolve(privateBase), directoryName, 'lease.json')
  const actual = pathApi.resolve(leasePath)
  if (platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) {
    fail('observer_lease_path_outside_private_state')
  }
  return expected
}

export function validatePrivateBasePath(candidatePath, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path
  if (typeof candidatePath !== 'string' || !pathApi.isAbsolute(candidatePath)
    || /[\0\r\n,@?#]/u.test(candidatePath) || /[a-z][a-z0-9+.-]*:\/\//iu.test(candidatePath)) {
    fail('observer_private_state_path_invalid')
  }
  return pathApi.resolve(candidatePath)
}

function normalizedWindowsPrivatePath(candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath || candidatePath.includes('\0')
    || !path.win32.isAbsolute(candidatePath)) fail('observer_private_windows_configured_parent_invalid')
  const normalized = path.win32.normalize(path.win32.resolve(candidatePath))
  const root = path.win32.parse(normalized).root
  return (normalized.toLowerCase() === root.toLowerCase()
    ? root : normalized.replace(/\\+$/u, '')).toLowerCase()
}

function validateWindowsPrivateParentAce(entry) {
  if (!entry || typeof entry.sid !== 'string' || !/^S-1-[0-9-]+$/u.test(entry.sid)
    || !['Allow', 'Deny'].includes(entry.type) || !Number.isInteger(entry.rightsMask)
    || typeof entry.inherited !== 'boolean' || typeof entry.appliesToObject !== 'boolean'
    || typeof entry.inheritOnly !== 'boolean' || typeof entry.containerInherit !== 'boolean'
    || typeof entry.objectInherit !== 'boolean' || typeof entry.noPropagateInherit !== 'boolean'
    || typeof entry.inheritedToChild !== 'boolean' || typeof entry.tokenMatch !== 'boolean'
    || entry.inheritOnly === entry.appliesToObject
    || entry.inheritedToChild !== (entry.containerInherit || entry.objectInherit)) {
    fail('observer_private_windows_configured_parent_acl_invalid')
  }
  return entry
}

function validateWindowsPrivateParentNode(node, expectedDepth) {
  const entries = node?.entries
  if (!node || node.depth !== expectedDepth || node.reparse !== false || typeof node.daclProtected !== 'boolean'
    || !Array.isArray(entries) || entries.length === 0
    || !Number.isInteger(node.daclAceCount) || node.daclAceCount !== entries.length
    || node.daclPresent !== true || node.daclNull !== false || node.daclInspectable !== true
    || node.daclEmpty !== false || typeof node.daclControlFlags !== 'string'
    || !node.daclControlFlags.split(',').map(flag => flag.trim()).includes('DiscretionaryAclPresent')) {
    fail('observer_private_windows_configured_parent_acl_invalid')
  }
  for (const entry of entries) validateWindowsPrivateParentAce(entry)
  return entries
}

export function validateWindowsConfiguredPrivateParent({ currentUserSid, parentPath, ancestors }) {
  if (typeof currentUserSid !== 'string' || !/^S-1-[0-9-]+$/u.test(currentUserSid)
    || !Array.isArray(ancestors) || ancestors.length === 0) {
    fail('observer_private_windows_configured_parent_invalid')
  }
  const parent = normalizedWindowsPrivatePath(parentPath)
  const ordered = [...ancestors].sort((left, right) => left?.depth - right?.depth)
  const baseNode = ordered[0]
  const baseEntries = validateWindowsPrivateParentNode(baseNode, 0)
  if (normalizedWindowsPrivatePath(baseNode.path) !== parent || baseNode.ownerSid !== currentUserSid
    || baseNode.daclProtected !== true || ![2, 3].includes(baseEntries.length)) {
    fail('observer_private_windows_configured_parent_acl_invalid')
  }

  const baseAllowed = new Set([currentUserSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID])
  const baseSeen = new Set()
  for (const entry of baseEntries) {
    if (!baseAllowed.has(entry.sid) || baseSeen.has(entry.sid) || entry.type !== 'Allow'
      || entry.rights !== 'FullControl' || entry.rightsMask !== 2032127 || entry.inherited !== false) {
      fail('observer_private_windows_configured_parent_acl_invalid')
    }
    baseSeen.add(entry.sid)
  }
  if (!baseSeen.has(currentUserSid) || !baseSeen.has(WINDOWS_SYSTEM_SID)) {
    fail('observer_private_windows_configured_parent_acl_invalid')
  }

  const trustedOwners = new Set([currentUserSid, ...WINDOWS_PRIVATE_PARENT_OWNER_SIDS])
  const trustedPrincipals = trustedOwners
  for (let index = 0; index < ordered.length; index += 1) {
    const node = ordered[index]
    const entries = index === 0 ? baseEntries : validateWindowsPrivateParentNode(node, index)
    const normalizedNode = normalizedWindowsPrivatePath(node.path)
    const expectedPath = index === 0
      ? parent
      : normalizedWindowsPrivatePath(path.win32.dirname(ordered[index - 1].path))
    if (normalizedNode !== expectedPath || !trustedOwners.has(node.ownerSid)) {
      fail('observer_private_windows_configured_parent_ancestry_invalid')
    }

    const child = index === 0 ? null : ordered[index - 1]
    for (const rawEntry of entries) {
      const entry = validateWindowsPrivateParentAce(rawEntry)
      if (entry.type === 'Deny') {
        if (entry.tokenMatch && (entry.rightsMask & WINDOWS_PRIVATE_PARENT_WRITE_MASK) !== 0
          && (entry.appliesToObject || entry.inheritedToChild && child?.daclProtected !== true)) {
          fail('observer_private_windows_configured_parent_effective_deny')
        }
        continue
      }
      if (trustedPrincipals.has(entry.sid)
        || (entry.rightsMask & WINDOWS_PRIVATE_PARENT_WRITE_MASK) === 0) continue

      if (!entry.appliesToObject) {
        if (entry.inheritedToChild && child?.daclProtected !== true) {
          fail('observer_private_windows_configured_parent_inherited_write_grant')
        }
        continue
      }
      const safeAddOnly = index > 0 && entry.containerInherit === false && entry.objectInherit === false
        && (entry.rightsMask & ~WINDOWS_PRIVATE_PARENT_SAFE_ADD_MASK) === 0
        && (entry.rightsMask & (0x2 | 0x4)) !== 0
      if (!safeAddOnly) fail('observer_private_windows_configured_parent_untrusted_write_grant')
    }
  }

  const last = ordered.at(-1)
  if (normalizedWindowsPrivatePath(path.win32.dirname(last.path)) !== normalizedWindowsPrivatePath(last.path)) {
    fail('observer_private_windows_configured_parent_ancestry_invalid')
  }
  return true
}

export function assertObserverHostRuntime(nodeVersion, dependencyState) {
  const major = /^(\d+)\./u.exec(String(nodeVersion || ''))
  if (!major || Number(major[1]) !== 24 || dependencyState?.tsx !== true
    || dependencyState?.pg !== true || dependencyState?.payloadCli !== true) {
    fail('observer_host_node24_cms_dependencies_required')
  }
  return true
}

export function assertOutsideRepository(candidatePath, repositoryPath, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path
  const candidate = pathApi.resolve(candidatePath)
  const repository = pathApi.resolve(repositoryPath)
  const relative = pathApi.relative(repository, candidate)
  if (relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))) {
    fail('observer_private_state_inside_repository')
  }
  return true
}

export async function assertOutsideGitWorktrees(candidatePath, lstatImpl = lstat) {
  if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) fail('observer_private_state_path_invalid')
  let current = path.resolve(candidatePath)
  while (true) {
    const marker = path.join(current, '.git')
    const markerInfo = await lstatImpl(marker).catch(error => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
      fail('observer_git_boundary_inspection_failed')
    })
    if (markerInfo) fail('observer_private_state_inside_git_worktree')
    const parent = path.dirname(current)
    if (parent === current) return true
    current = parent
  }
}

export async function assertNoReparseAncestors(targetPath, lstatImpl = lstat) {
  const absolute = path.resolve(targetPath)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const info = await lstatImpl(current).catch(() => null)
    if (!info || info.isSymbolicLink()) fail('observer_private_path_missing_or_reparse_point')
  }
  return true
}

export function buildCanonicalSnapshotDigest(rows) {
  if (!Array.isArray(rows)) fail('observer_state_snapshot_invalid')
  const canonicalize = value => Array.isArray(value) ? value.map(canonicalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
      : value
  return createHash('sha256').update(JSON.stringify(canonicalize(rows))).digest('hex')
}

export function assertObserverAuditReport(report) {
  const expectedKeys = [
    'status', 'installed', 'catalogValid', 'targetDatabase', 'observerRole', 'observedCoverageVersion',
    'headSequence', 'writeBarrier', 'ready', 'admissionActivated', 'releaseCertified',
    'writeCoverageCertified', 'drainVerified', 'passwordPresenceCheck', 'clusterSharedOwnershipCheck',
    'physicalClusterIdentity',
  ]
  exactPlainObjectKeys(report, expectedKeys, 'observer_audit_report_shape_invalid')
  if (report.status !== 'PASS' || report.installed !== true || report.catalogValid !== true
    || report.targetDatabase !== DATABASE || report.observerRole !== 'cms_observer'
    || ![0, 1].includes(report.observedCoverageVersion) || !/^(0|[1-9][0-9]*)$/u.test(String(report.headSequence))
    || !['open', 'sealed', 'frozen'].includes(report.writeBarrier)
    || report.ready !== false || report.admissionActivated !== false || report.releaseCertified !== false
    || report.writeCoverageCertified !== false || report.drainVerified !== false
    || report.passwordPresenceCheck !== 'not_performed_unprivileged'
    || report.clusterSharedOwnershipCheck !== 'performed_read_only_pg_shdepend_check'
    || report.physicalClusterIdentity !== 'not_verified') fail('observer_audit_report_contract_failed')
  return report
}

export function sanitizeDiagnosticOutput(output) {
  const empty = { phase: null, sqlstate: null }
  for (const line of String(output || '').split(/\r?\n/u)) {
    const finalizerMatch = /^CMS news protocol diagnostic: phase=([a-z-]+) reason=[a-z_]+ sqlstate=(none|[0-9A-Z]{5})$/u.exec(line)
    if (finalizerMatch) return { phase: finalizerMatch[1], sqlstate: finalizerMatch[2] === 'none' ? null : finalizerMatch[2] }
    const bootstrapMatch = /^CMS bootstrap diagnostic: phase=([a-z-]+) sqlstate=(none|[0-9A-Z]{5})$/u.exec(line)
    if (bootstrapMatch) return { phase: bootstrapMatch[1], sqlstate: bootstrapMatch[2] === 'none' ? null : bootstrapMatch[2] }
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed?.status !== 'FAIL' || typeof parsed.phase !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(parsed.phase)
      || !(parsed.sqlstate === null || parsed.sqlstate === undefined || parsed.sqlstate === 'none'
        || typeof parsed.sqlstate === 'string' && /^[0-9A-Z]{5}$/u.test(parsed.sqlstate))) continue
    return { phase: parsed.phase, sqlstate: parsed.sqlstate === 'none' ? null : parsed.sqlstate || null }
  }
  return empty
}

export function assertExpectedRoleDenied(result) {
  if (result?.denied !== true || result?.sqlstate !== '42501') fail('observer_expected_select_denial_not_observed')
  return true
}

export const OBSERVER_AUDIT_STAGES = Object.freeze([
  'inspect-local-docker-and-cached-image',
  'create-fresh-postgres16-volume-and-container',
  'verify-new-postgres16-system-identity',
  'reconfirm-new-postgres16-docker-identity',
  'create-ownerinc-cms-database',
  'provision-native-roles',
  'verify-migrator-and-apply-six-native-migrations',
  'verify-six-migration-ledger-and-bootstrap-control-roles',
  'install-protocol-with-one-shot-finalizer',
  'provision-observer-with-reviewed-builder',
  'prove-observer-pg-shdepend-read-visibility',
  'snapshot-before-audit',
  'run-read-only-observer-audit-cli',
  'snapshot-after-audit-and-compare',
  'prove-observer-denials-with-rolled-back-transactions',
  'verify-post-probe-snapshot-unchanged',
])

export function parseHarnessArguments(args) {
  if (JSON.stringify(args) === JSON.stringify(['--prepare-lease'])) return { mode: 'prepare' }
  if (args.length === 3 && args[0] === '--execute' && args[1] === '--leasepath'
    && typeof args[2] === 'string' && args[2].length > 0) return { mode: 'execute', leasePath: args[2] }
  fail('observer_harness_usage_invalid')
}

export async function dispatchHarnessCommand(args, handlers) {
  const command = parseHarnessArguments(args)
  if (command.mode === 'prepare') return handlers.prepare()
  return handlers.execute(command.leasePath)
}

export async function prepareObserverLease({ inspect, reservePort, checkPort, privateBase, createPrivateDirectory,
  writePrivateFile, validatePrivateBase, validateGitBoundary = assertOutsideGitWorktrees,
  runId = randomUUID(), nonce = randomBytes(32).toString('hex') }) {
  const facts = await inspect({ runId })
  if (!facts || facts.containerExists || facts.volumeExists || facts.projectResourcesExist) {
    fail('observer_lease_resource_collision_refused')
  }
  assertLocalDockerContext(facts.contextName, facts.contextEndpoint)
  if (!isSupportedDockerVersion(facts.dockerServerVersion)) fail('observer_lease_docker_runtime_unsupported')
  const port = await reservePort()
  const lease = buildObserverAuditLease({ runId, nonce, dockerContext: facts.contextName,
    dockerEndpoint: facts.contextEndpoint, port, imageRef: facts.imageRef, imageId: facts.imageId })
  validateDockerPreflight(lease, { ...facts, portAvailable: true })
  if (typeof checkPort !== 'function') fail('observer_lease_preflight_unavailable')
  await checkPort(lease.host, lease.port)
  const prefix = process.platform === 'win32' ? `.${PROJECT_PREFIX}-` : `${PROJECT_PREFIX}-`
  const safePrivateBase = validatePrivateBasePath(privateBase)
  const leaseDirectory = path.join(safePrivateBase, `${prefix}${lease.runId}`)
  if (/[\0\r\n,]/u.test(path.join(leaseDirectory, 'postgres-admin-password'))) {
    fail('observer_private_bind_path_unsafe')
  }
  assertOutsideRepository(leaseDirectory, ROOT)
  await validateGitBoundary(leaseDirectory)
  if (typeof validatePrivateBase !== 'function') fail('observer_lease_private_parent_unverified')
  await validatePrivateBase(privateBase)
  await createPrivateDirectory(leaseDirectory)
  const leasePath = path.join(leaseDirectory, 'lease.json')
  await writePrivateFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, leaseDirectory)
  return { leasePath, lease }
}

function currentOSPathEnvironment() {
  if (process.platform === 'win32') {
    const sidScript = String.raw`$ErrorActionPreference='Stop'; $wi=[Security.Principal.WindowsIdentity]::GetCurrent(); $sid=$wi.User.Value; if($sid -notmatch '^S-1-[0-9-]+$'){throw 'identity'}; $key='Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$sid; $registered=[string](Get-ItemProperty -LiteralPath $key -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath; $known=[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile); if(-not $known -or $registered.Contains('%')){throw 'profile'}; [pscustomobject]@{currentUserSid=$sid;profilePath=[IO.Path]::GetFullPath($known);registeredProfilePath=[IO.Path]::GetFullPath($registered)} | ConvertTo-Json -Compress`
    const result = runPowerShellReadOnly(sidScript)
    let identity
    try { identity = JSON.parse(result) } catch { fail('observer_private_windows_profile_invalid') }
    validateWindowsProfileIdentity(identity)
    const localAppData = process.env.LOCALAPPDATA
    if (typeof localAppData !== 'string' || !path.win32.isAbsolute(localAppData)
      || path.win32.resolve(localAppData).toLowerCase() !== path.win32.join(identity.profilePath, 'AppData', 'Local').toLowerCase()) {
      fail('observer_private_windows_profile_identity_mismatch')
    }
    const defaultParent = path.win32.join(localAppData, 'Temp', 'opencode')
    const selectedParent = process.env.OWNERINC_AUDIT_PRIVATE_PARENT || defaultParent
    if (!path.win32.isAbsolute(selectedParent) || selectedParent.includes('\0')) fail('observer_private_state_path_invalid')
    return path.win32.resolve(selectedParent)
  }
  const selectedParent = process.env.OWNERINC_AUDIT_PRIVATE_PARENT || os.homedir()
  if (!path.isAbsolute(selectedParent) || selectedParent.includes('\0')) fail('observer_private_state_unavailable')
  return path.resolve(selectedParent)
}

function privateDirectoryName(runId) {
  const prefix = process.platform === 'win32' ? `.${PROJECT_PREFIX}-` : `${PROJECT_PREFIX}-`
  return `${prefix}${runId}`
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory()
}

function validWindowsPrivateSnapshot(snapshot, kind) {
  validatePrivateAclSnapshot(snapshot)
  const current = snapshot.currentUserSid
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [snapshot.entries]
  const expected = new Set([current, 'S-1-5-18', 'S-1-5-32-544'])
  if (entries.length !== expected.size || new Set(entries.map(entry => entry.sid)).size !== expected.size
    || entries.some(entry => !expected.has(entry.sid) || entry.type !== 'Allow' || entry.rights !== 'FullControl'
      || entry.inherited !== false)) fail('observer_private_windows_acl_invalid')
  if (kind === 'directory' && snapshot.reparse === true) fail('observer_private_windows_acl_invalid')
  return true
}

const WINDOWS_ACL_SET_PRIVATE = String.raw`$ErrorActionPreference='Stop'; $p=$env:OWNERINC_AUDIT_PRIVATE_PATH; $isDirectory=$env:OWNERINC_AUDIT_PRIVATE_KIND -eq 'directory'; $wi=[Security.Principal.WindowsIdentity]::GetCurrent(); $owner=$wi.User; $acl=Get-Acl -LiteralPath $p -ErrorAction Stop; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($rule)}; $acl.SetOwner($owner); $principals=@($owner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')); $inherit=[Security.AccessControl.InheritanceFlags]::None; if($isDirectory){$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}; foreach($sid in $principals){$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); [void]$acl.AddAccessRule($rule)}; Set-Acl -LiteralPath $p -AclObject $acl -ErrorAction Stop`
const WINDOWS_ACL_INSPECT = String.raw`$ErrorActionPreference='Stop'; $p=$env:OWNERINC_AUDIT_PRIVATE_PATH; $acl=Get-Acl -LiteralPath $p -ErrorAction Stop; $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop; $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0); $present=(($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent)-ne 0); $nullDacl=($present -and $null -eq $raw.DiscretionaryAcl); $inspectable=($present -and $null -ne $raw.DiscretionaryAcl); $count=$null; if($inspectable){$count=$raw.DiscretionaryAcl.Count}; $entries=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {[pscustomobject]@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString();inherited=$_.IsInherited}}); [pscustomobject]@{ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;currentUserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;daclProtected=$acl.AreAccessRulesProtected;reparse=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0);daclPresent=$present;daclNull=$nullDacl;daclInspectable=$inspectable;daclEmpty=($inspectable -and $count -eq 0);daclAceCount=$count;daclControlFlags=$raw.ControlFlags.ToString();entries=$entries} | ConvertTo-Json -Depth 5 -Compress`
const WINDOWS_ANCESTOR_ACL_INSPECT = String.raw`$ErrorActionPreference='Stop'
$p=$env:OWNERINC_AUDIT_ACL_PATH; $wi=[Security.Principal.WindowsIdentity]::GetCurrent(); $sid=$wi.User.Value
$groups=@($wi.Groups | ForEach-Object {$_.Value}); $root=[IO.DirectoryInfo]::new([IO.Path]::GetFullPath($p)); $nodes=[Collections.Generic.List[object]]::new(); $depth=0
while($null -ne $root){
  $acl=Get-Acl -LiteralPath $root.FullName -ErrorAction Stop; $item=Get-Item -LiteralPath $root.FullName -Force -ErrorAction Stop
  $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
  $daclPresent=(($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent)-ne 0)
  $daclNull=($daclPresent -and $null -eq $raw.DiscretionaryAcl); $daclInspectable=($daclPresent -and $null -ne $raw.DiscretionaryAcl)
  $daclAceCount=$null; if($daclInspectable){$daclAceCount=$raw.DiscretionaryAcl.Count}; $daclEmpty=($daclInspectable -and $daclAceCount -eq 0)
  $entries=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
    $sidEntry=$_.IdentityReference.Value
    $applies=(($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)-eq 0)
    $containerInherit=(($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit)-ne 0)
    $objectInherit=(($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit)-ne 0)
    $inheritOnly=(($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)-ne 0)
    $noPropagateInherit=(($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit)-ne 0)
    [pscustomobject]@{sid=$sidEntry;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString();rightsMask=[int]$_.FileSystemRights
      inherited=$_.IsInherited;appliesToObject=$applies;inheritOnly=$inheritOnly;containerInherit=$containerInherit
      objectInherit=$objectInherit;noPropagateInherit=$noPropagateInherit;inheritedToChild=($containerInherit -or $objectInherit)
      tokenMatch=(($sidEntry -eq $sid) -or ($groups -contains $sidEntry))}
  })
  $nodes.Add([pscustomobject]@{path=$root.FullName;depth=$depth;reparse=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0)
    ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;daclProtected=$acl.AreAccessRulesProtected
    daclPresent=$daclPresent;daclNull=$daclNull;daclInspectable=$daclInspectable;daclEmpty=$daclEmpty;daclAceCount=$daclAceCount
    daclControlFlags=$raw.ControlFlags.ToString();entries=$entries})
  if($null -eq $root.Parent){break}; $root=$root.Parent; $depth++
}
[pscustomobject]@{currentUserSid=$sid;ancestors=@($nodes)} | ConvertTo-Json -Depth 8 -Compress`

function powershellEnvironment(extra = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    SAFE_PARENT_ENV_KEYS.has(key.toLowerCase()) || key.toLowerCase() === 'psmodulepath'))
  return { ...inherited, ...extra }
}

function runPowerShell(script, targetPath, kind) {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellScriptWithUtf8Output(script)], {
    env: powershellEnvironment({ OWNERINC_AUDIT_PRIVATE_PATH: targetPath, OWNERINC_AUDIT_PRIVATE_KIND: kind }),
    encoding: null, timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0) fail('observer_private_windows_acl_operation_failed')
  try { return decodeWindowsPowerShellStdout(result.stdout).trim() } catch { fail('observer_private_windows_acl_output_invalid') }
}

function runPowerShellReadOnly(script, extra = {}) {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellScriptWithUtf8Output(script)], {
    env: powershellEnvironment(extra), encoding: null, timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0) fail('observer_private_windows_identity_check_failed')
  try { return decodeWindowsPowerShellStdout(result.stdout).trim() } catch { fail('observer_private_windows_identity_output_invalid') }
}

async function inspectPrivatePath(targetPath, kind) {
  await assertNoReparseAncestors(targetPath)
  const info = await lstat(targetPath)
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
    fail('observer_private_path_kind_invalid')
  }
  if (process.platform === 'win32') {
    let snapshot
    try { snapshot = JSON.parse(runPowerShell(WINDOWS_ACL_INSPECT, targetPath, kind)) }
    catch (error) { if (error?.code) throw error; fail('observer_private_windows_acl_output_invalid') }
    validWindowsPrivateSnapshot(snapshot, kind)
  } else {
    if (typeof process.getuid !== 'function') fail('observer_private_posix_uid_unavailable')
    validatePrivatePosixStat({ uid: info.uid, mode: info.mode, isDirectory: info.isDirectory(),
      isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink() }, kind, process.getuid())
  }
  const resolved = await realpath(targetPath)
  if (path.resolve(resolved) !== path.resolve(targetPath)) fail('observer_private_path_resolution_changed')
  return info
}

async function inspectPrivateBase(privateBase) {
  validatePrivateBasePath(privateBase)
  await assertNoReparseAncestors(privateBase)
  assertOutsideRepository(await realpath(privateBase), await realpath(ROOT))
  await assertOutsideGitWorktrees(privateBase)
  const info = await lstat(privateBase)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('observer_private_parent_invalid')
  if (process.platform === 'win32') {
    const identityScript = String.raw`$ErrorActionPreference='Stop'; $wi=[Security.Principal.WindowsIdentity]::GetCurrent(); $sid=$wi.User.Value; $key='Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$sid; $registered=[string](Get-ItemProperty -LiteralPath $key -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath; $known=[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile); if(-not $known -or $registered.Contains('%')){throw 'profile'}; [pscustomobject]@{currentUserSid=$sid;profilePath=[IO.Path]::GetFullPath($known);registeredProfilePath=[IO.Path]::GetFullPath($registered)} | ConvertTo-Json -Compress`
    let identity
    try { identity = JSON.parse(runPowerShellReadOnly(identityScript)) } catch { fail('observer_private_windows_profile_invalid') }
    validateWindowsProfileIdentity(identity)
    const defaultBase = path.win32.join(identity.profilePath, 'AppData', 'Local', 'Temp', 'opencode')
    const configuredBase = process.env.OWNERINC_AUDIT_PRIVATE_PARENT || defaultBase
    if (!path.win32.isAbsolute(configuredBase)
      || path.win32.resolve(configuredBase).toLowerCase() !== path.win32.resolve(privateBase).toLowerCase()) {
      fail('observer_private_windows_profile_identity_mismatch')
    }
    let snapshot
    try {
      snapshot = JSON.parse(runPowerShellReadOnly(WINDOWS_ANCESTOR_ACL_INSPECT,
        { OWNERINC_AUDIT_ACL_PATH: privateBase }))
    } catch { fail('observer_private_windows_ancestor_acl_output_invalid') }
    if (snapshot?.currentUserSid !== identity.currentUserSid) fail('observer_private_windows_token_identity_changed')
    validateWindowsConfiguredPrivateParent({ currentUserSid: identity.currentUserSid,
      parentPath: privateBase, ancestors: snapshot.ancestors })
  } else if (typeof process.getuid !== 'function' || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) {
    fail('observer_private_parent_owner_or_permissions_invalid')
  }
  return true
}

async function createPrivateDirectory(directory, privateBase) {
  await inspectPrivateBase(privateBase)
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const created = await lstat(directory)
  if (created.isSymbolicLink() || !created.isDirectory()) fail('observer_private_directory_create_identity_invalid')
  if (process.platform === 'win32') runPowerShell(WINDOWS_ACL_SET_PRIVATE, directory, 'directory')
  else await chmod(directory, 0o700)
  const checked = await inspectPrivatePath(directory, 'directory')
  if (!sameFileIdentity(created, checked)) fail('observer_private_directory_identity_changed')
}

async function writePrivateFile(filePath, contents, runDirectory) {
  await inspectPrivatePath(runDirectory, 'directory')
  const flags = process.platform === 'win32' ? 'wx'
    : fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0)
  const handle = await open(filePath, flags, 0o600)
  try {
    const opened = await handle.stat()
    if (opened.nlink !== 1) fail('observer_private_file_link_count_invalid')
    if (process.platform === 'win32') runPowerShell(WINDOWS_ACL_SET_PRIVATE, filePath, 'file')
    else await chmod(filePath, 0o600)
    const beforeWrite = await inspectPrivatePath(filePath, 'file')
    if (!sameFileIdentity(opened, beforeWrite)) fail('observer_private_file_identity_changed')
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    const afterWrite = await inspectPrivatePath(filePath, 'file')
    const afterHandle = await handle.stat()
    if (afterHandle.nlink !== 1 || !sameFileIdentity(afterHandle, afterWrite)) {
      fail('observer_private_file_identity_changed')
    }
  } finally { await handle.close() }
}

async function readPrivateFile(filePath, runDirectory) {
  await inspectPrivatePath(runDirectory, 'directory')
  const before = await inspectPrivatePath(filePath, 'file')
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
  const handle = await open(filePath, flags)
  try {
    const opened = await handle.stat()
    if (opened.nlink !== 1 || !sameFileIdentity(opened, before)) fail('observer_private_file_identity_changed')
    const contents = await handle.readFile('utf8')
    if (contents.length > 16384) fail('observer_lease_file_too_large')
    const after = await inspectPrivatePath(filePath, 'file')
    const afterHandle = await handle.stat()
    if (afterHandle.nlink !== 1 || !sameFileIdentity(afterHandle, after)) fail('observer_private_file_identity_changed')
    return contents
  } finally { await handle.close() }
}

function dockerEnvironment() {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => SAFE_PARENT_ENV_KEYS.has(key.toLowerCase())))
  return inherited
}

function docker(contextName, args, { json = false, timeout = 15000 } = {}) {
  const result = spawnSync('docker', ['--context', contextName, ...args], {
    encoding: 'utf8', env: dockerEnvironment(), timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0) fail('observer_docker_operation_failed')
  if (!json) return result.stdout.trim()
  try { return JSON.parse(result.stdout) } catch { fail('observer_docker_output_invalid') }
}

function dockerContextShow() {
  const result = spawnSync('docker', ['context', 'show'], {
    encoding: 'utf8', env: dockerEnvironment(), timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0) fail('observer_docker_inspection_failed')
  return result.stdout.trim()
}

function dockerOptional(contextName, args, expectedMissing) {
  const result = spawnSync('docker', ['--context', contextName, ...args], {
    encoding: 'utf8', env: dockerEnvironment(), timeout: 12000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error || result.signal) fail('observer_docker_inspection_failed')
  if (result.status !== 0) {
    if (expectedMissing && /no such (?:object|volume)|not found/iu.test(result.stderr || '')) return null
    fail('observer_docker_inspection_failed')
  }
  try { return JSON.parse(result.stdout) } catch { fail('observer_docker_output_invalid') }
}

async function reserveCandidateLoopbackPort() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        server.close(error => error ? reject(error) : resolve(typeof address === 'object' && address ? address.port : null))
      })
    }).catch(() => null)
    if (Number.isInteger(port) && ![55441, 19091, 19092, 9299].includes(port)) return port
  }
  fail('observer_lease_loopback_port_unavailable')
}

async function assertPortAvailable(host, port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', () => { server.close(); reject(new Error('busy')) })
    server.listen(port, host, () => server.close(error => error ? reject(error) : resolve()))
  }).catch(() => fail('observer_lease_loopback_port_unavailable'))
}

function inspectDockerReadOnly() {
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) fail('observer_docker_environment_override_refused')
  const contextName = dockerContextShow()
  const contextRows = docker(contextName, ['context', 'inspect', contextName], { json: true })
  const endpoint = contextRows?.[0]?.Endpoints?.docker?.Host
  assertLocalDockerContext(contextName, endpoint)
  const serverVersion = docker(contextName, ['version', '--format', '{{.Server.Version}}'])
  if (!isSupportedDockerVersion(serverVersion)) fail('observer_docker_runtime_unsupported')
  const imageRows = docker(contextName,
    ['image', 'ls', '--no-trunc', '--format', '{{json .}}', 'postgres']).split(/\r?\n/u).filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const candidate = imageRows.filter(row => row.Repository === 'postgres'
    && /^16(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?$/u.test(row.Tag || '')).sort((left, right) =>
    String(right.Tag).localeCompare(String(left.Tag), 'en'))[0]
  if (!candidate) fail('observer_no_cached_postgres16_image_no_pull_performed')
  const imageRef = `postgres:${candidate.Tag}`
  const imageRowsDetail = docker(contextName, ['image', 'inspect', imageRef], { json: true })
  const image = imageRowsDetail?.[0]
  if (typeof image?.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(image.Id)
    || !Array.isArray(image.RepoTags) || !image.RepoTags.includes(imageRef)) fail('observer_cached_image_identity_invalid')
  return { contextName, contextEndpoint: endpoint, dockerServerVersion: serverVersion,
    imageRef, imageId: image.Id, imageRefAvailable: true }
}

function inspectLeaseDocker(rawLease) {
  const lease = validateObserverAuditLease(rawLease)
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) fail('observer_docker_environment_override_refused')
  const currentContext = dockerContextShow()
  const contexts = docker(lease.dockerContext, ['context', 'inspect', lease.dockerContext], { json: true })
  const endpoint = contexts?.[0]?.Endpoints?.docker?.Host
  const serverVersion = docker(lease.dockerContext, ['version', '--format', '{{.Server.Version}}'])
  const imageRows = dockerOptional(lease.dockerContext, ['image', 'inspect', lease.imageRef], false)
  const container = dockerOptional(lease.dockerContext, ['inspect', lease.containerName], true)
  const volume = dockerOptional(lease.dockerContext, ['volume', 'inspect', lease.volumeName], true)
  const projectContainers = docker(lease.dockerContext,
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${lease.project}`])
  const projectVolumes = docker(lease.dockerContext,
    ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${lease.project}`])
  const portAvailable = true
  const facts = {
    contextName: currentContext, contextEndpoint: endpoint,
    dockerHostOverride: process.env.DOCKER_HOST, dockerContextOverride: process.env.DOCKER_CONTEXT,
    dockerServerVersion: serverVersion,
    imageId: imageRows?.[0]?.Id,
    imageRefAvailable: Array.isArray(imageRows?.[0]?.RepoTags) && imageRows[0].RepoTags.includes(lease.imageRef),
    containerExists: Boolean(container), volumeExists: Boolean(volume),
    projectResourcesExist: Boolean(projectContainers || projectVolumes), portAvailable,
  }
  if (imageRows?.[0]?.Id !== lease.imageId) facts.imageId = imageRows?.[0]?.Id
  validateDockerPreflight(lease, facts)
  return { contextName: lease.dockerContext, image: imageRows[0] }
}

function makeConnectionString(user, password, database, port) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`
}

function randomSecret() { return randomBytes(36).toString('hex') }

async function withClient(connectionString, operation, options = {}) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 15000,
    statement_timeout: 10000, ...options })
  let connected = false
  try {
    await client.connect()
    connected = true
    return await operation(client)
  } finally {
    if (connected) await client.end().catch(() => {})
  }
}

function assertDockerBackendIdentity(backend) {
  exactPlainObjectKeys(backend, ['backendIPv4', 'containerId'], 'observer_postgres_docker_backend_identity_invalid')
  if (typeof backend.backendIPv4 !== 'string' || !net.isIPv4(backend.backendIPv4)
    || typeof backend.containerId !== 'string' || !/^[a-f0-9]{64}$/u.test(backend.containerId)) {
    fail('observer_postgres_docker_backend_identity_invalid')
  }
  return backend
}

function createVerifiedBackendIdentity(backend, systemIdentifier) {
  assertDockerBackendIdentity(backend)
  if (typeof systemIdentifier !== 'string' || !postgresSystemIdentifierPattern.test(systemIdentifier)) {
    fail('observer_postgres_system_identifier_invalid')
  }
  const verified = Object.freeze({ containerId: backend.containerId, backendIPv4: backend.backendIPv4, systemIdentifier })
  verifiedBackendIdentities.add(verified)
  return verified
}

function assertVerifiedBackendIdentity(verifiedBackend) {
  if (!verifiedBackend || typeof verifiedBackend !== 'object' || !verifiedBackendIdentities.has(verifiedBackend)
    || !Object.isFrozen(verifiedBackend)) fail('observer_postgres_verified_identity_required')
  exactPlainObjectKeys(verifiedBackend, ['backendIPv4', 'containerId', 'systemIdentifier'],
    'observer_postgres_verified_identity_required')
  if (typeof verifiedBackend.containerId !== 'string' || !/^[a-f0-9]{64}$/u.test(verifiedBackend.containerId)
    || typeof verifiedBackend.backendIPv4 !== 'string' || !net.isIPv4(verifiedBackend.backendIPv4)
    || typeof verifiedBackend.systemIdentifier !== 'string'
    || !postgresSystemIdentifierPattern.test(verifiedBackend.systemIdentifier)) {
    fail('observer_postgres_verified_identity_required')
  }
  return verifiedBackend
}

async function assertBackendIdentity(client, expected) {
  const identity = await client.query(`SELECT current_user AS role, session_user AS session_role,
    current_database() AS database, inet_server_addr()::text AS server_address,
    inet_server_port() AS server_port, current_setting('server_version_num')::integer AS version_num,
    (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser`)
  const row = identity.rows[0]
  const address = String(row?.server_address || '').split('/')[0]
  if (row?.role !== expected.role || row?.session_role !== expected.role || row?.database !== expected.database
    || address !== expected.backendIPv4 || Number(row?.server_port) !== 5432
    || expected.superuser !== undefined && row?.superuser !== expected.superuser
    || Math.floor(Number(row?.version_num) / 10000) !== 16) fail('observer_postgres_backend_identity_mismatch')
  return row
}

function assertAuthorizedDockerBackend(verifiedBackend, inspectedBackend) {
  const trustedBackend = assertVerifiedBackendIdentity(verifiedBackend)
  assertDockerBackendIdentity(inspectedBackend)
  if (inspectedBackend.containerId !== trustedBackend.containerId
    || inspectedBackend.backendIPv4 !== trustedBackend.backendIPv4) {
    fail('observer_postgres_docker_backend_identity_mismatch')
  }
  return Object.freeze({ containerId: inspectedBackend.containerId, backendIPv4: inspectedBackend.backendIPv4 })
}

async function assertVerifiedPostgresBackendIdentity(client, expected) {
  const verifiedBackend = assertVerifiedBackendIdentity(expected.verifiedBackend)
  if (expected.backendIPv4 !== verifiedBackend.backendIPv4) fail('observer_postgres_backend_identity_mismatch')
  const row = await assertBackendIdentity(client, expected)
  const system = await client.query('SELECT (pg_catalog.pg_control_system()).system_identifier::text AS system_identifier')
  const actual = system.rows[0]?.system_identifier
  if (typeof actual !== 'string' || !postgresSystemIdentifierPattern.test(actual)
    || actual !== verifiedBackend.systemIdentifier) fail('observer_postgres_system_identifier_mismatch')
  return row
}

async function assertWritableBackendIdentity(client, expected) {
  assertAuthorizedDockerBackend(expected.verifiedBackend, expected.inspectedBackend)
  return assertVerifiedPostgresBackendIdentity(client, expected)
}

async function withVerifiedWriteClient(connectionString, verifiedBackend, inspectedBackend, expected, operation,
  clientRunner = withClient) {
  assertVerifiedBackendIdentity(verifiedBackend)
  const authorizedDockerBackend = assertAuthorizedDockerBackend(verifiedBackend, inspectedBackend)
  return clientRunner(connectionString, async client => {
    await assertWritableBackendIdentity(client, { ...expected, backendIPv4: verifiedBackend.backendIPv4,
      verifiedBackend, inspectedBackend: authorizedDockerBackend })
    return operation(client)
  })
}

async function assertWriteTargetIdentity(connectionString, lease, passwordFile, verifiedBackend, expected) {
  const inspectedBackend = inspectAuthorizedDockerBackend(lease, passwordFile, verifiedBackend)
  return withVerifiedWriteClient(connectionString, verifiedBackend, inspectedBackend, expected, async () => true)
}

function dockerLabelsArgs(lease) {
  return Object.entries(observerAuditDockerLabels(lease)).flatMap(([key, value]) => ['--label', `${key}=${value}`])
}

export function matchesDockerBindMountPath(inspectedSource, expectedPath, platform = process.platform) {
  if (typeof inspectedSource !== 'string' || typeof expectedPath !== 'string'
    || inspectedSource.includes('\0') || expectedPath.includes('\0')) return false
  if (platform === 'win32') {
    // Docker Desktop reports Windows host mounts through its Linux VM path;
    // translate only that exact form before the strict host-path comparison.
    const desktopMount = /^\/run\/desktop\/mnt\/host\/([a-z])\/(.+)$/u.exec(inspectedSource)
    if (!desktopMount) return false
    const components = desktopMount[2].split('/')
    if (components.some(component => !component || component === '.' || component === '..'
      || component.includes(':') || component.includes('\\'))) return false
    const sourcePath = `${desktopMount[1].toUpperCase()}:\\${components.join('\\')}`
    if (!path.win32.isAbsolute(sourcePath) || !path.win32.isAbsolute(expectedPath)) return false
    return path.win32.resolve(sourcePath).toLowerCase() === path.win32.resolve(expectedPath).toLowerCase()
  }
  if (!path.isAbsolute(inspectedSource) || !path.isAbsolute(expectedPath)) return false
  return path.resolve(inspectedSource) === path.resolve(expectedPath)
}

export function validateObserverDockerContainer(lease, passwordFile, inspected, platform = process.platform) {
  const labels = inspected?.Config?.Labels || {}
  const expectedLabels = observerAuditDockerLabels(lease)
  const inspectedMounts = inspected?.Mounts || []
  const mounts = inspectedMounts.filter(mount => mount?.Destination === '/var/lib/postgresql/data')
  const secretMounts = inspectedMounts.filter(mount => mount?.Destination === '/run/secrets/cms_admin_password')
  const bindings = inspected?.HostConfig?.PortBindings?.['5432/tcp']
  const environment = Array.isArray(inspected?.Config?.Env) ? inspected.Config.Env : []
  const networks = Object.entries(inspected?.NetworkSettings?.Networks || {})
  const ips = [...new Set(networks.map(([, item]) => item?.IPAddress).filter(value => typeof value === 'string' && net.isIPv4(value)))]
  if (inspected?.Name !== `/${lease.containerName}` || inspected?.State?.Running !== true
    || inspected?.Image !== lease.imageId || !inspected?.Id
    || Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)
    || labels['com.docker.compose.project'] !== lease.project
    || networks.length !== 1 || ips.length !== 1
    || inspectedMounts.length !== 2
    || mounts.length !== 1 || mounts[0]?.Type !== 'volume' || mounts[0]?.Name !== lease.volumeName
    || secretMounts.length !== 1 || secretMounts[0]?.Type !== 'bind' || secretMounts[0]?.RW !== false
    || !matchesDockerBindMountPath(secretMounts[0]?.Source, passwordFile, platform)
    || environment.some(value => value.startsWith('POSTGRES_PASSWORD='))
    || !Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1'
    || String(bindings[0]?.HostPort) !== String(lease.port)) fail('observer_docker_container_identity_mismatch')
  return Object.freeze(assertDockerBackendIdentity({ containerId: inspected.Id, backendIPv4: ips[0] }))
}

function dockerInspectContainer(lease, passwordFile) {
  const rows = docker(lease.dockerContext, ['inspect', lease.containerName], { json: true })
  return validateObserverDockerContainer(lease, passwordFile, rows?.[0])
}

function inspectAuthorizedDockerBackend(lease, passwordFile, verifiedBackend) {
  return assertAuthorizedDockerBackend(verifiedBackend, dockerInspectContainer(lease, passwordFile))
}

function dockerInspectVolume(lease) {
  const row = docker(lease.dockerContext, ['volume', 'inspect', lease.volumeName], { json: true })?.[0]
  if (row?.Name !== lease.volumeName || row?.Labels?.[FIXTURE_LABEL] !== 'true'
    || row?.Labels?.[RUN_LABEL] !== lease.runId
    || row?.Labels?.[NONCE_LABEL] !== createHash('sha256').update(lease.nonce).digest('hex')
    || row?.Labels?.['com.docker.compose.project'] !== lease.project) {
    fail('observer_docker_volume_identity_mismatch')
  }
}

async function createFreshCluster(lease, runDirectory, passwords, report) {
  const preflight = inspectLeaseDocker(lease)
  await assertPortAvailable(lease.host, lease.port)
  const volumeBefore = dockerOptional(lease.dockerContext, ['volume', 'inspect', lease.volumeName], true)
  const containerBefore = dockerOptional(lease.dockerContext, ['inspect', lease.containerName], true)
  if (volumeBefore || containerBefore) fail('observer_lease_resource_collision_refused')

  docker(lease.dockerContext, ['volume', 'create', '--label', `${FIXTURE_LABEL}=true`, '--label', `${RUN_LABEL}=${lease.runId}`,
    '--label', `${NONCE_LABEL}=${createHash('sha256').update(lease.nonce).digest('hex')}`,
    '--label', `com.docker.compose.project=${lease.project}`, lease.volumeName])
  report.volumeCreated = true
  dockerInspectVolume(lease)

  const envFile = path.join(runDirectory, 'postgres-init.env')
  const passwordFile = path.join(runDirectory, 'postgres-admin-password')
  if (/[\0\r\n,]/u.test(passwordFile)) fail('observer_private_bind_path_unsafe')
  await writePrivateFile(passwordFile, `${passwords.cms_admin}\n`, runDirectory)
  const contents = 'POSTGRES_USER=cms_admin\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD_FILE=/run/secrets/cms_admin_password\n'
  await writePrivateFile(envFile, contents, runDirectory)
  try {
    docker(lease.dockerContext, ['create', '--name', lease.containerName, ...dockerLabelsArgs(lease), '--network', 'bridge',
      '--publish', `${lease.host}:${lease.port}:5432`, '--mount',
      `type=volume,source=${lease.volumeName},target=/var/lib/postgresql/data`,
      '--mount', `type=bind,source=${passwordFile},target=/run/secrets/cms_admin_password,readonly`,
      '--env-file', envFile, '--memory', '1g', '--cpus', '1.5', '--pids-limit', '256', '--restart', 'no', lease.imageId])
  } finally { await unlink(envFile).catch(() => {}) }
  report.containerCreated = true
  docker(lease.dockerContext, ['start', lease.containerName])
  dockerInspectVolume(lease)
  const backend = dockerInspectContainer(lease, passwordFile)
  report.containerId = backend.containerId
  report.backendIPv4 = backend.backendIPv4
  report.imageRef = lease.imageRef
  report.imageId = preflight.image?.Id
  return backend
}

export async function waitForPostgres(lease, backend, password, createClient = options => new Client(options)) {
  assertDockerBackendIdentity(backend)
  const deadline = Date.now() + 90000
  let connected = false
  while (Date.now() < deadline) {
    const client = createClient({ connectionString: makeConnectionString('cms_admin', password, 'postgres', lease.port),
      connectionTimeoutMillis: 3000, query_timeout: 8000 })
    try {
      await client.connect()
      connected = true
      const identity = await client.query(`SELECT current_user AS role, current_database() AS database,
        inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
        current_setting('server_version_num')::integer AS version_num,
        (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser,
        (pg_catalog.pg_control_system()).system_identifier::text AS system_identifier`)
      const row = identity.rows[0]
      const identifier = row?.system_identifier
      if (row?.role !== 'cms_admin' || row?.database !== 'postgres' || row?.superuser !== true
        || String(row?.server_address || '').split('/')[0] !== backend.backendIPv4
        || Number(row?.server_port) !== 5432 || Math.floor(Number(row?.version_num) / 10000) !== 16
        || typeof identifier !== 'string' || !postgresSystemIdentifierPattern.test(identifier)) {
        fail('observer_postgres_bootstrap_identity_mismatch')
      }
      return createVerifiedBackendIdentity(backend, identifier)
    } catch (error) {
      if (error?.code && error.code !== 'ECONNREFUSED' && error.code !== 'ETIMEDOUT' && error.code !== '57P03') throw error
    } finally {
      if (connected) await client.end().catch(() => {})
      connected = false
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  fail('observer_postgres_readiness_timeout')
}

export async function createOwnerCmsDatabase(lease, passwords, verifiedBackend, inspectedBackend,
  clientRunner = withClient) {
  await withVerifiedWriteClient(makeConnectionString('cms_admin', passwords.cms_admin, 'postgres', lease.port),
    verifiedBackend, inspectedBackend, { role: 'cms_admin', database: 'postgres', superuser: true }, async client => {
    const exists = await client.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1', [DATABASE])
    if (exists.rowCount !== 0) fail('observer_target_database_collision_refused')
    await client.query(`CREATE DATABASE ${DATABASE} OWNER cms_admin TEMPLATE template0`)
  }, clientRunner)
}

export async function verifyPostgresAndCreateOwnerCmsDatabase(lease, backend, passwords, passwordFile, {
  createClient = options => new Client(options),
  inspectContainer = dockerInspectContainer,
  clientRunner = withClient,
  stageResult = async (_name, operation) => operation(),
} = {}) {
  const targetLease = validateObserverAuditLease(lease)
  const verifiedBackend = await stageResult('verify-new-postgres16-system-identity',
    () => waitForPostgres(targetLease, backend, passwords.cms_admin, createClient))
  const inspectedBackend = await stageResult('reconfirm-new-postgres16-docker-identity',
    () => assertAuthorizedDockerBackend(verifiedBackend, inspectContainer(targetLease, passwordFile)),
    value => ({ containerId: value.containerId, backendIPv4: value.backendIPv4 }))
  await stageResult('create-ownerinc-cms-database',
    () => createOwnerCmsDatabase(targetLease, passwords, verifiedBackend, inspectedBackend, clientRunner),
    () => ({ database: DATABASE }))
  return Object.freeze({ verifiedBackend, inspectedBackend })
}

function spawnCmsStage(label, args, purpose, explicit, timeout = 300000) {
  const env = buildChildEnvironment(process.env, purpose, explicit)
  const result = spawnSync(process.execPath, args, { cwd: CMS, env, encoding: 'utf8', timeout, windowsHide: true,
    maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.signal || result.status !== 0) {
    const diagnostic = sanitizeDiagnosticOutput(`${result.stdout || ''}\n${result.stderr || ''}`)
    const error = new Error('observer_cms_cli_stage_failed')
    error.code = 'observer_cms_cli_stage_failed'
    error.label = label
    error.diagnostic = diagnostic
    error.sqlstate = diagnostic.sqlstate || safeSqlstate(result.error?.code)
    throw error
  }
  // Captured output is parsed by the caller but never printed or placed into evidence.
  return { label, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function parseSingleJsonOutput(result, code) {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (lines.length !== 1) fail(code)
  try { return JSON.parse(lines[0]) } catch { fail(code) }
}

function exactFinalizerOutput(result, expectedInstalled) {
  const output = parseSingleJsonOutput(result, 'observer_finalizer_output_invalid')
  exactPlainObjectKeys(output, ['installed', 'ready', 'coverageVersion', 'message'], 'observer_finalizer_output_shape_invalid')
  if (output.installed !== expectedInstalled || output.ready !== false || output.coverageVersion !== 0
    || output.message !== 'protocol installed/verified; native writes and readiness remain disabled') {
    fail('observer_finalizer_disabled_readiness_contract_failed')
  }
  return { installed: output.installed, ready: false, coverageVersion: 0 }
}

async function provisionNativeRolesAndMigrate(lease, passwords, verifiedBackend, passwordFile) {
  assertVerifiedBackendIdentity(verifiedBackend)
  const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DATABASE, lease.port)
  const migratorURL = makeConnectionString('cms_migrator', passwords.cms_migrator, DATABASE, lease.port)
  const script = ['--import', 'tsx', path.join(CMS, 'scripts/provision-db.ts')]
  await assertWriteTargetIdentity(adminURL, lease, passwordFile, verifiedBackend,
    { role: 'cms_admin', database: DATABASE, superuser: true })
  spawnCmsStage('provision-native-roles', [...script, '--provision'], 'provision', {
    CMS_DATABASE_URL: adminURL,
    CMS_MIGRATOR_PASSWORD: passwords.cms_migrator,
    CMS_RUNTIME_PASSWORD: passwords.cms_runtime,
    CMS_CONTROLLER_PASSWORD: passwords.cms_controller,
  })
  spawnCmsStage('verify-migrator', [...script, '--verify-migrator'], 'verify', { CMS_DATABASE_URL: migratorURL })

  // Keep Payload's upload directory outside the checkout and inside this lease.
  const actualUploadDir = path.join(await privateDirectoryForLease(lease), 'uploads')
  await createPrivateDirectory(actualUploadDir, await privateBaseForLease(lease))
  const payloadSecrets = { PAYLOAD_SECRET: randomSecret(), PAYLOAD_TO_PORTAL_SECRET: randomSecret(),
    PORTAL_TO_PAYLOAD_SECRET: randomSecret() }
  await assertWriteTargetIdentity(adminURL, lease, passwordFile, verifiedBackend,
    { role: 'cms_admin', database: DATABASE, superuser: true })
  spawnCmsStage('payload-migrate-six-native', ['node_modules/payload/bin.js', 'migrate'], 'migrate', {
    CMS_DATABASE_URL: migratorURL,
    CMS_UPLOAD_DIR: actualUploadDir,
    ...payloadSecrets,
    PORTAL_PUBLIC_URL: 'http://127.0.0.1:19991',
    PORTAL_INTERNAL_URL: 'http://127.0.0.1:19992',
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
  })

  const migrations = await withClient(migratorURL, async client => {
    await assertBackendIdentity(client, { role: 'cms_migrator', database: DATABASE,
      backendIPv4: verifiedBackend.backendIPv4, superuser: false })
    const result = await client.query('SELECT name, batch::text AS batch FROM public.payload_migrations ORDER BY name COLLATE "C"')
    const names = result.rows.map(row => row.name)
    if (result.rows.length !== MIGRATIONS.length || JSON.stringify(names) !== JSON.stringify(MIGRATIONS)) {
      fail('observer_native_migration_ledger_mismatch')
    }
    return { count: result.rows.length, sha256: buildCanonicalSnapshotDigest(result.rows) }
  })

  const adminEnv = { CMS_DATABASE_URL: adminURL, CMS_CONTROLLER_PASSWORD: passwords.cms_controller }
  await assertWriteTargetIdentity(adminURL, lease, passwordFile, verifiedBackend,
    { role: 'cms_admin', database: DATABASE, superuser: true })
  spawnCmsStage('bootstrap-control-roles', [...script, '--bootstrap-control'], 'bootstrap', adminEnv)
  spawnCmsStage('verify-control-roles', [...script, '--verify-control'], 'bootstrap', adminEnv)
  return migrations
}

// The lease path is already strictly validated before this helper is called.
async function privateBaseForLease() { return currentOSPathEnvironment() }
async function privateDirectoryForLease(lease) {
  const base = await privateBaseForLease()
  return path.join(base, privateDirectoryName(lease.runId))
}

async function provisionObserverRole(lease, passwords, verifiedBackend, passwordFile) {
  assertVerifiedBackendIdentity(verifiedBackend)
  const { buildNewsProtocolObserverProvisioningSQL } = await import(pathToFileURL(
    path.join(CMS, 'scripts/news-protocol-observer-contract.ts')).href)
  const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DATABASE, lease.port)
  const sql = buildNewsProtocolObserverProvisioningSQL(passwords.cms_observer)
  const inspectedBackend = inspectAuthorizedDockerBackend(lease, passwordFile, verifiedBackend)
  await withVerifiedWriteClient(adminURL, verifiedBackend, inspectedBackend,
    { role: 'cms_admin', database: DATABASE, superuser: true }, async client => {
    await client.query(sql)
  })
  return { roleCreated: true, builder: 'buildNewsProtocolObserverProvisioningSQL' }
}

async function snapshotInstalledProtocol(lease, passwords, verifiedBackend) {
  return withClient(makeConnectionString('cms_admin', passwords.cms_admin, DATABASE, lease.port), async client => {
    await assertVerifiedPostgresBackendIdentity(client, { role: 'cms_admin', database: DATABASE,
      backendIPv4: verifiedBackend.backendIPv4, superuser: true, verifiedBackend })
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    let transactionOpen = true
    try {
      await client.query("SET LOCAL statement_timeout = '5s'")
      const transaction = await client.query(`SELECT current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_isolation') AS isolation`)
      if (transaction.rows[0]?.read_only !== 'on' || transaction.rows[0]?.isolation !== 'repeatable read') {
        fail('observer_admin_snapshot_transaction_mismatch')
      }
      const migrations = await client.query('SELECT name, batch::text AS batch FROM public.payload_migrations ORDER BY name COLLATE "C"')
      const names = migrations.rows.map(row => row.name)
      if (names.length !== MIGRATIONS.length || JSON.stringify(names) !== JSON.stringify(MIGRATIONS)) {
        fail('observer_native_migration_ledger_mismatch')
      }
      const catalogs = await client.query(`SELECT jsonb_build_object(
        'schemas', (SELECT jsonb_agg(jsonb_build_object('name', n.nspname,
          'owner', pg_catalog.pg_get_userbyid(n.nspowner), 'acl', n.nspacl::text) ORDER BY n.nspname)
          FROM pg_catalog.pg_namespace n WHERE n.nspname='public'),
        'relations', (SELECT jsonb_agg(jsonb_build_object(
          'name', c.relname, 'kind', c.relkind::text, 'persistence', c.relpersistence::text,
          'owner', pg_catalog.pg_get_userbyid(c.relowner), 'rowSecurity', c.relrowsecurity,
          'forceRowSecurity', c.relforcerowsecurity, 'replicaIdentity', c.relreplident::text,
          'options', c.reloptions::text, 'acl', c.relacl::text,
          'columns', (SELECT jsonb_agg(jsonb_build_object('ordinal', a.attnum,
            'name', a.attname, 'type', pg_catalog.format_type(a.atttypid,a.atttypmod),
            'notNull', a.attnotnull, 'default', pg_catalog.pg_get_expr(d.adbin,d.adrelid),
            'collation', CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END,
            'acl', a.attacl::text) ORDER BY a.attnum)
            FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
          'constraints', (SELECT jsonb_agg(jsonb_build_object('name', con.conname,
            'type', con.contype::text, 'definition', pg_catalog.pg_get_constraintdef(con.oid,true),
            'validated', con.convalidated, 'deferrable', con.condeferrable,
            'initiallyDeferred', con.condeferred) ORDER BY con.conname)
            FROM pg_catalog.pg_constraint con WHERE con.conrelid=c.oid),
          'indexes', (SELECT jsonb_agg(jsonb_build_object('name', ix.relname,
            'definition', pg_catalog.pg_get_indexdef(i.indexrelid,0,true),
            'unique', i.indisunique, 'valid', i.indisvalid, 'ready', i.indisready) ORDER BY ix.relname)
            FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid WHERE i.indrelid=c.oid)
          ) ORDER BY c.relname)
          FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')),
        'functions', (SELECT jsonb_agg(jsonb_build_object(
          'identity', p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
          'owner', pg_catalog.pg_get_userbyid(p.proowner), 'language', l.lanname,
          'securityDefiner', p.prosecdef, 'volatility', p.provolatile::text,
          'strict', p.proisstrict, 'parallel', p.proparallel::text, 'config', p.proconfig::text,
          'acl', p.proacl::text, 'sourceSha256', pg_catalog.md5(p.prosrc))
          ORDER BY p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid))
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public'),
        'triggers', (SELECT jsonb_agg(jsonb_build_object(
          'name', t.tgname, 'relation', c.relname, 'enabled', t.tgenabled::text,
          'type', t.tgtype::integer, 'function', t.tgfoid::regprocedure::text,
          'definition', pg_catalog.pg_get_triggerdef(t.oid,true)) ORDER BY c.relname,t.tgname)
          FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
        'enums', (SELECT jsonb_agg(jsonb_build_object('name', t.typname,
          'labels', (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
            FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid)) ORDER BY t.typname)
          FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname='public' AND t.typtype='e')
      ) AS snapshot`)
      const catalogSnapshot = catalogs.rows[0]?.snapshot
      if (!catalogSnapshot || typeof catalogSnapshot !== 'object') fail('observer_catalog_snapshot_invalid')
      const head = await client.query(`SELECT singleton, sequence::text AS sequence, chain_sha256, coverage_version,
        write_barrier, barrier_run_id::text AS barrier_run_id, barrier_epoch,
        barrier_receipt_sha256 FROM public.owner_news_mutation_head WHERE singleton=true`)
      const row = head.rows[0]
      if (head.rows.length !== 1 || row?.singleton !== true || !/^(0|[1-9][0-9]*)$/u.test(String(row.sequence))
        || !/^[0-9a-f]{64}$/u.test(String(row.chain_sha256)) || ![0, 1].includes(row.coverage_version)
        || !['open', 'sealed', 'frozen'].includes(row.write_barrier)) fail('observer_protocol_head_snapshot_invalid')
      const result = {
        migrationCount: migrations.rows.length,
        migrationSha256: buildCanonicalSnapshotDigest(migrations.rows),
        catalogCount: Number(catalogSnapshot.relations?.length || 0),
        catalogSha256: buildCanonicalSnapshotDigest([catalogSnapshot]),
        headCount: head.rows.length,
        headSha256: buildCanonicalSnapshotDigest(head.rows),
        coverageVersion: row.coverage_version,
        sequence: String(row.sequence),
        writeBarrier: row.write_barrier,
        chainSha256: row.chain_sha256,
        barrierRunId: row.barrier_run_id,
        barrierEpoch: row.barrier_epoch,
        barrierReceiptSha256: row.barrier_receipt_sha256,
      }
      await client.query('COMMIT')
      transactionOpen = false
      return result
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  })
}

function assertFinalizerBaseline(snapshot) {
  if (snapshot.migrationCount !== 6 || !Number.isInteger(snapshot.catalogCount) || snapshot.catalogCount < 1
    || snapshot.coverageVersion !== 0 || snapshot.sequence !== '0'
    || snapshot.writeBarrier !== 'open' || snapshot.chainSha256 !== '0'.repeat(64)
    || snapshot.barrierRunId !== null || snapshot.barrierEpoch !== null || snapshot.barrierReceiptSha256 !== null) {
    fail('observer_finalizer_baseline_contract_failed')
  }
}

function publicSnapshotEvidence(snapshot) {
  return { migrations: { count: snapshot.migrationCount, sha256: snapshot.migrationSha256 },
    catalogs: { count: snapshot.catalogCount, sha256: snapshot.catalogSha256 },
    head: { count: snapshot.headCount, sha256: snapshot.headSha256 } }
}

function snapshotsEqual(left, right) {
  return left.migrationCount === right.migrationCount && left.migrationSha256 === right.migrationSha256
    && left.catalogCount === right.catalogCount && left.catalogSha256 === right.catalogSha256
    && left.headCount === right.headCount && left.headSha256 === right.headSha256
}

async function proveObserverCanReadOwnershipCatalog(lease, passwords, verifiedBackend) {
  assertVerifiedBackendIdentity(verifiedBackend)
  const observerURL = makeConnectionString('cms_observer', passwords.cms_observer, DATABASE, lease.port)
  return withClient(observerURL, async client => {
    await assertBackendIdentity(client, { role: 'cms_observer', database: DATABASE,
      backendIPv4: verifiedBackend.backendIPv4, superuser: false })
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    let open = true
    try {
      await client.query("SET LOCAL statement_timeout = '5s'")
      const tx = await client.query(`SELECT current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_isolation') AS isolation`)
      if (tx.rows[0]?.read_only !== 'on' || tx.rows[0]?.isolation !== 'repeatable read') {
        fail('observer_shdepend_probe_transaction_mismatch')
      }
      const result = await client.query(`SELECT has_table_privilege(current_user, 'pg_catalog.pg_shdepend', 'SELECT') AS can_select,
        count(*) FILTER (WHERE d.refclassid='pg_catalog.pg_authid'::regclass
          AND d.refobjid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AND d.deptype='o')::text AS observer_owned_objects
        FROM pg_catalog.pg_shdepend d`)
      if (result.rows[0]?.can_select !== true || result.rows[0]?.observer_owned_objects !== '0') {
        fail('observer_shdepend_visibility_contract_failed')
      }
      await client.query('ROLLBACK')
      open = false
      return { selectVisible: true, observerOwnedObjects: 0, readOnlyTransaction: true }
    } catch (error) {
      if (open) await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  })
}

function expectedObserverAuditOutput(result) {
  const report = assertObserverAuditReport(parseSingleJsonOutput(result, 'observer_audit_cli_output_invalid'))
  return {
    status: report.status,
    observedCoverageVersion: report.observedCoverageVersion,
    headSequence: report.headSequence,
    writeBarrier: report.writeBarrier,
    readinessCertified: report.ready,
    admissionActivated: report.admissionActivated,
    releaseCertified: report.releaseCertified,
    writeCoverageCertified: report.writeCoverageCertified,
    drainVerified: report.drainVerified,
    clusterSharedOwnershipCheck: report.clusterSharedOwnershipCheck,
  }
}

async function proveObserverReadDenials(lease, passwords, verifiedBackend) {
  assertVerifiedBackendIdentity(verifiedBackend)
  const observerURL = makeConnectionString('cms_observer', passwords.cms_observer, DATABASE, lease.port)
  const denied = []
  for (const relation of FORBIDDEN_RELATIONS) {
    const result = await withClient(observerURL, async client => {
      await assertBackendIdentity(client, { role: 'cms_observer', database: DATABASE,
        backendIPv4: verifiedBackend.backendIPv4, superuser: false })
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      let readDenied = false
      let sqlstate = null
      try {
        await client.query("SET LOCAL statement_timeout = '5s'")
        await client.query(`SELECT * FROM public.${relation} LIMIT 0`)
      } catch (error) {
        sqlstate = safeSqlstate(error?.code)
        readDenied = sqlstate === '42501'
      } finally {
        await client.query('ROLLBACK').catch(() => {})
      }
      return { denied: readDenied, sqlstate }
    })
    assertExpectedRoleDenied(result)
    denied.push({ relation, denied: true, sqlstate: '42501', transactionRolledBack: true })
  }

  const sealExecution = await withClient(observerURL, async client => {
    await assertBackendIdentity(client, { role: 'cms_observer', database: DATABASE,
      backendIPv4: verifiedBackend.backendIPv4, superuser: false })
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      await client.query("SET LOCAL statement_timeout = '5s'")
      const result = await client.query(`SELECT has_function_privilege('cms_observer',
        'public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)', 'EXECUTE') AS can_execute`)
      if (result.rows[0]?.can_execute !== false) fail('observer_seal_function_execution_not_denied')
      await client.query('ROLLBACK')
      return false
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  })
  return { deniedRelations: denied, sealFunctionExecute: sealExecution }
}

function safeSqlstate(value) { return typeof value === 'string' && /^[0-9A-Z]{5}$/u.test(value) ? value : null }

function passwordsForNewCluster() {
  const passwords = {}
  const used = new Set()
  for (const role of ['cms_admin', 'cms_migrator', 'cms_runtime', 'cms_controller', 'cms_observer']) {
    let password
    do { password = randomSecret() } while (used.has(password))
    used.add(password)
    passwords[role] = password
  }
  return passwords
}

function reportTemplate(lease) {
  return {
    status: 'running', runId: lease.runId, project: lease.project, database: DATABASE,
    dockerContext: lease.dockerContext, containerName: lease.containerName, volumeName: lease.volumeName,
    imageRef: lease.imageRef, imageId: lease.imageId, host: lease.host, port: lease.port,
    stages: [], volumeCreated: false, containerCreated: false,
    resourceDisposition: 'preserved; no automatic container, volume, database, role, or fixture cleanup',
  }
}

async function claimOneTimeLease(lease, leasePath, runDirectory) {
  const entries = await readdir(runDirectory)
  if (entries.length !== 1 || entries[0] !== 'lease.json') fail('observer_lease_attempt_artifacts_exist')
  const before = await readPrivateFile(leasePath, runDirectory)
  const raw = JSON.parse(before)
  validateObserverAuditLease(raw)
  if (JSON.stringify(raw) !== JSON.stringify(lease)) fail('observer_lease_changed_before_claim')
  const claim = path.join(runDirectory, 'execution.claim.json')
  try {
    await writePrivateFile(claim, `${JSON.stringify({ runId: lease.runId,
      nonceSha256: createHash('sha256').update(lease.nonce).digest('hex'), claimed: true })}\n`, runDirectory)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('observer_lease_attempt_already_consumed')
    throw error
  }
}

async function executeLease(leasePath) {
  await assertHostRuntime()
  const privateBase = currentOSPathEnvironment()
  await inspectPrivateBase(privateBase)
  const runId = path.basename(path.dirname(path.resolve(leasePath))).replace(
    process.platform === 'win32' ? new RegExp(`^\\.${PROJECT_PREFIX}-`, 'u') : new RegExp(`^${PROJECT_PREFIX}-`, 'u'), '')
  if (!uuidPattern.test(runId)) fail('observer_lease_path_outside_private_state')
  const canonicalLeasePath = validateObserverLeasePath(leasePath, privateBase, runId)
  const runDirectory = path.dirname(canonicalLeasePath)
  assertOutsideRepository(runDirectory, ROOT)
  await assertOutsideGitWorktrees(runDirectory)
  await inspectPrivatePath(runDirectory, 'directory')
  const leaseText = await readPrivateFile(canonicalLeasePath, runDirectory)
  let lease
  try { lease = JSON.parse(leaseText) } catch { fail('observer_lease_file_invalid') }
  validateObserverAuditLease(lease)
  if (lease.runId !== runId) fail('observer_lease_path_run_id_mismatch')
  const report = reportTemplate(lease)
  let stage = 'claim-one-time-private-lease'
  let primaryError
  const stageResult = async (name, operation, summarize = value => value) => {
    stage = name
    const result = await operation()
    report.stages.push({ name, status: 'pass', result: summarize(result) })
    return result
  }
  try {
    await claimOneTimeLease(lease, canonicalLeasePath, runDirectory)
    const freshFacts = await stageResult('inspect-local-docker-and-cached-image', async () => inspectLeaseDocker(lease),
      value => ({ cachedImage: value.image?.Id === lease.imageId, context: lease.dockerContext }))
    void freshFacts
    const passwords = passwordsForNewCluster()
    const passwordFile = path.join(runDirectory, 'postgres-admin-password')

    const backend = await stageResult('create-fresh-postgres16-volume-and-container',
      () => createFreshCluster(lease, runDirectory, passwords, report),
      value => ({ containerId: value.containerId, backendIPv4: value.backendIPv4, volumeCreated: true, containerCreated: true }))
    const verificationStageResult = async (name, operation, summarize) => {
      const result = await stageResult(name, operation, summarize)
      if (name === 'verify-new-postgres16-system-identity') {
        report.serverMajorVersion = 16
        report.systemIdentifierVerified = true
      }
      return result
    }
    const { verifiedBackend } = await verifyPostgresAndCreateOwnerCmsDatabase(lease, backend, passwords,
      passwordFile, { stageResult: verificationStageResult })

    const migrations = await stageResult('verify-migrator-and-apply-six-native-migrations',
      () => provisionNativeRolesAndMigrate(lease, passwords, verifiedBackend, passwordFile), value => value)
    report.migrations = migrations

    const finalizer = await stageResult('install-protocol-with-one-shot-finalizer', async () => {
      const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DATABASE, lease.port)
      await assertWriteTargetIdentity(adminURL, lease, passwordFile, verifiedBackend,
        { role: 'cms_admin', database: DATABASE, superuser: true })
      const result = spawnCmsStage('finalize-protocol', ['--import', 'tsx', path.join(CMS, 'scripts/finalize-news-protocol.ts'),
        '--finalize-protocol'], 'finalizer', { CMS_ADMIN_DATABASE_URL: adminURL })
      return exactFinalizerOutput(result, true)
    }, value => value)
    report.finalizer = finalizer

    const initialSnapshot = await snapshotInstalledProtocol(lease, passwords, verifiedBackend)
    assertFinalizerBaseline(initialSnapshot)
    report.baseline = publicSnapshotEvidence(initialSnapshot)

    const observerProvisioning = await stageResult('provision-observer-with-reviewed-builder',
      () => provisionObserverRole(lease, passwords, verifiedBackend, passwordFile), value => value)
    report.observerProvisioning = observerProvisioning

    const ownershipVisibility = await stageResult('prove-observer-pg-shdepend-read-visibility',
      () => proveObserverCanReadOwnershipCatalog(lease, passwords, verifiedBackend), value => value)
    report.pgShdependVisibility = ownershipVisibility

    const beforeAudit = await stageResult('snapshot-before-audit',
      () => snapshotInstalledProtocol(lease, passwords, verifiedBackend), publicSnapshotEvidence)
    const auditResult = await stageResult('run-read-only-observer-audit-cli', async () => {
      const observerURL = makeConnectionString('cms_observer', passwords.cms_observer, DATABASE, lease.port)
      const child = spawnCmsStage('observer-audit-cli', ['--import', 'tsx', path.join(CMS, 'scripts/verify-news-protocol.ts'),
        '--audit-protocol'], 'observer', { CMS_OBSERVER_DATABASE_URL: observerURL })
      return expectedObserverAuditOutput(child)
    }, value => value)
    report.audit = auditResult

    const afterAudit = await stageResult('snapshot-after-audit-and-compare',
      () => snapshotInstalledProtocol(lease, passwords, verifiedBackend), publicSnapshotEvidence)
    assertFinalizerBaseline(afterAudit)
    if (!snapshotsEqual(beforeAudit, afterAudit) || auditResult.observedCoverageVersion !== 0
      || auditResult.headSequence !== afterAudit.sequence || auditResult.writeBarrier !== afterAudit.writeBarrier) {
      fail('observer_audit_changed_installed_state')
    }
    report.auditOnlyStateUnchanged = true

    const denialEvidence = await stageResult('prove-observer-denials-with-rolled-back-transactions',
      () => proveObserverReadDenials(lease, passwords, verifiedBackend), value => value)
    report.denials = denialEvidence

    const afterProbes = await stageResult('verify-post-probe-snapshot-unchanged',
      () => snapshotInstalledProtocol(lease, passwords, verifiedBackend), publicSnapshotEvidence)
    if (!snapshotsEqual(afterAudit, afterProbes)) fail('observer_probe_changed_installed_state')
    report.probesStateUnchanged = true
    report.status = 'PASS'
    return report
  } catch (error) {
    report.status = 'blocked_or_failed_fixture_preserved'
    report.failure = { stage, code: safeFailureCode(error), diagnostic: {
      phase: typeof error?.diagnostic?.phase === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(error.diagnostic.phase)
        ? error.diagnostic.phase : null,
      sqlstate: safeSqlstate(error?.diagnostic?.sqlstate || error?.sqlstate || error?.code),
    } }
    primaryError = Object.assign(error instanceof Error ? error : new Error('observer_harness_failed'), { stage, safeReport: report })
    throw primaryError
  } finally {
    try {
      await writePrivateFile(path.join(runDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, runDirectory)
      report.persisted = true
    } catch {
      if (!primaryError) {
        report.status = 'blocked_or_failed_fixture_preserved'
        report.failure = { stage: 'persist-private-report', code: 'observer_private_report_write_failed',
          diagnostic: { phase: null, sqlstate: null } }
        primaryError = Object.assign(new Error('observer_private_report_write_failed'), {
          code: 'observer_private_report_write_failed', stage: 'persist-private-report', safeReport: report,
        })
        throw primaryError
      }
    }
  }
}

function safeFailureCode(error) {
  const value = typeof error?.code === 'string' ? error.code : 'observer_harness_failed'
  return /^[a-z][a-z0-9_]{0,95}$/u.test(value) ? value : 'observer_harness_failed'
}

async function prepareCommand() {
  await assertHostRuntime()
  const privateBase = currentOSPathEnvironment()
  await inspectPrivateBase(privateBase)
  const prepared = await prepareObserverLease({
    inspect: async ({ runId }) => {
      const facts = inspectDockerReadOnly()
      const project = projectFromRunId(runId)
      const containerName = `${PROJECT_PREFIX}-${suffixFromRunId(runId)}`
      const volumeName = `${PROJECT_PREFIX}-pgdata-${suffixFromRunId(runId)}`
      const projectContainers = docker(facts.contextName,
        ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])
      const projectVolumes = docker(facts.contextName,
        ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])
      const container = dockerOptional(facts.contextName, ['inspect', containerName], true)
      const volume = dockerOptional(facts.contextName, ['volume', 'inspect', volumeName], true)
      return { ...facts, containerExists: Boolean(container), volumeExists: Boolean(volume),
        projectResourcesExist: Boolean(projectContainers || projectVolumes) }
    },
    reservePort: reserveCandidateLoopbackPort,
    checkPort: assertPortAvailable,
    privateBase,
    validatePrivateBase: inspectPrivateBase,
    createPrivateDirectory: directory => createPrivateDirectory(directory, privateBase),
    writePrivateFile,
  })
  const { lease, leasePath } = prepared
  console.log(JSON.stringify({ status: 'lease-prepared-not-executed', project: lease.project,
    runId: lease.runId, leasePath }))
}

async function assertHostRuntime() {
  let tsxAvailable = false
  let payloadCliAvailable = false
  try { cmsRequire.resolve('tsx'); tsxAvailable = true } catch { /* Fail closed below; no package installation. */ }
  try { payloadCliAvailable = (await lstat(path.join(CMS, 'node_modules', 'payload', 'bin.js'))).isFile() }
  catch { /* Fail closed below; no package installation. */ }
  assertObserverHostRuntime(process.versions.node, { tsx: tsxAvailable, pg: Boolean(Client), payloadCli: payloadCliAvailable })
}

async function main() {
  const command = parseHarnessArguments(process.argv.slice(2))
  if (command.mode === 'prepare') return prepareCommand()
  try {
    const report = await executeLease(command.leasePath)
    console.log(JSON.stringify({ status: report.status, runId: report.runId, project: report.project,
      auditOnlyStateUnchanged: report.auditOnlyStateUnchanged, probesStateUnchanged: report.probesStateUnchanged,
      reportAvailable: report.persisted === true }))
  } catch (error) {
    const report = error?.safeReport
    console.error(JSON.stringify({ status: 'FAIL', stage: report?.failure?.stage || error?.stage || 'lease-validation',
      code: safeFailureCode(error), diagnostic: report?.failure?.diagnostic || { phase: null, sqlstate: safeSqlstate(error?.code) },
      reportAvailable: report?.persisted === true }))
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ status: 'FAIL', stage: 'preparation-or-lease-validation', code: safeFailureCode(error),
      diagnostic: { phase: null, sqlstate: safeSqlstate(error?.code) } }))
    process.exitCode = 1
  })
}
