// Explicit, lease-gated PostgreSQL 16 acceptance harness for the news protocol
// finalizer. It is never part of unit tests/root verify and never pulls images.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { TextDecoder } from 'node:util'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertOutsideGitWorktrees,
  assertOutsideRepository,
  assertNoReparseAncestors as assertExternalNoReparseAncestors,
  buildObserverAuditLease,
  matchesDockerBindMountPath,
  observerAuditDockerLabels,
  validateDockerPreflight,
  validateObserverAuditLease,
  validateObserverDockerContainer,
  validateWindowsConfiguredPrivateParent,
  verifyPostgresAndCreateOwnerCmsDatabase,
} from './news-protocol-observer-audit.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CMS = path.join(ROOT, 'cms')
const CONTEXT_NAME = 'desktop-linux'
const CONTEXT_ENDPOINT = 'npipe:////./pipe/dockerDesktopLinuxEngine'
const PROJECT_PREFIX = 'ownerinc-payload-protocol-v2'
const FIXTURE_LABEL = 'ownerinc.protocol-finalizer.fixture'
const DB = 'ownerinc_cms'
const LEASE_SCHEMA_VERSION = 2
const SCENARIOS = new Set(['fresh-v2', 'upgrade-v1'])
const LEASE_KEYS = ['schemaVersion', 'scenario', 'project', 'runId', 'nonce', 'dockerContext', 'dockerEndpoint',
  'containerName', 'volumeName', 'host', 'port', 'imageRef', 'imageId'].sort()
const ALLOWED_WINDOWS_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']) // SYSTEM and BUILTIN\Administrators are explicitly trusted local principals.
const ALLOWED_WINDOWS_OWNER_SIDS = new Set([...ALLOWED_WINDOWS_SIDS, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']) // TrustedInstaller may own OS ancestors only.
const WINDOWS_WRITE_OR_REPLACE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000
const WINDOWS_READ_OR_WRITE_MASK = WINDOWS_WRITE_OR_REPLACE_MASK | 0x1 | 0x8 | 0x80 | 0x20000 | 0x80000000
const WINDOWS_AUTHENTICATED_USERS = 'S-1-5-11'
const WINDOWS_POWERSHELL_UTF8_BOOTSTRAP = '$utf8NoBom = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $utf8NoBom; $OutputEncoding = $utf8NoBom'
const MIGRATIONS = [
  '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
]
const BOOTSTRAP_RUN_INSERT_COLUMNS = Object.freeze([
  'id', 'manifest_sha256', 'source_instance', 'source_fingerprint', 'authority_epoch',
  'progress_state', 'admission_state', 'commit_outcome', 'unresolved_exceptions',
])
const { Client } = createRequire(path.join(CMS, 'package.json'))('pg')
const fail = code => { const error = new Error(code); error.code = code; throw error }
const PRIVATE_CLI_OUTPUT = Symbol('private-cli-output')

function suffixFromRunId(runId) { return runId.replaceAll('-', '').slice(0, 12) }

function observerLeaseFromRaw(lease) {
  return {
    schemaVersion: 1, project: lease.project, runId: lease.runId, nonce: lease.nonce,
    dockerContext: lease.dockerContext, dockerEndpoint: lease.dockerEndpoint,
    containerName: lease.containerName, volumeName: lease.volumeName, host: lease.host,
    port: lease.port, imageRef: lease.imageRef, imageId: lease.imageId,
  }
}

// Raw persisted leases have an exact schema. The returned object is an internal
// normalized view with derived fields and must never be sent back through this
// raw-input validator; callers that cross the authorization boundary retain
// and pass the original raw object.
export function validateLease(rawLease) {
  if (!rawLease || Object.getPrototypeOf(rawLease) !== Object.prototype ||
      JSON.stringify(Object.keys(rawLease).sort()) !== JSON.stringify(LEASE_KEYS) ||
      rawLease.schemaVersion !== LEASE_SCHEMA_VERSION || !SCENARIOS.has(rawLease.scenario) ||
      rawLease.dockerContext !== CONTEXT_NAME || rawLease.dockerEndpoint !== CONTEXT_ENDPOINT) {
    fail('lease_identity_invalid')
  }
  const observerLease = validateObserverLease(rawLease)
  const suffix = suffixFromRunId(rawLease.runId)
  return Object.freeze({ ...observerLease, schemaVersion: LEASE_SCHEMA_VERSION, scenario: rawLease.scenario,
    suffix, database: DB, containerPort: 5432, fixtureLabel: FIXTURE_LABEL })
}

function validateObserverLease(rawLease) {
  try { return validateObserverAuditLease(observerLeaseFromRaw(rawLease)) }
  catch { fail('lease_resource_contract_invalid') }
}

// This boundary always accepts the strict persisted/raw shape and returns its
// internal normalized view only after the live Docker observations pass.
export function authorizeDockerPreflight(rawLease, observation) {
  const lease = validateLease(rawLease)
  try { validateDockerPreflight(validateObserverLease(rawLease), observation) }
  catch (error) {
    const mapped = {
      observer_lease_docker_context_mismatch: 'lease_docker_context_mismatch',
      observer_lease_resource_collision_refused: 'lease_resource_collision_refused',
      observer_lease_cached_postgres16_image_required: 'lease_postgres16_image_not_cached',
      observer_lease_loopback_port_unavailable: 'lease_loopback_port_unavailable',
      observer_lease_docker_runtime_unsupported: 'lease_docker_runtime_unsupported',
    }[error?.code]
    if (mapped) fail(mapped)
    throw error
  }
  return lease
}

export function assertBackendIdentity(lease, observed, expectedSystemIdentifier) {
  const address = String(observed?.server_address || '').split('/')[0]
  const identifier = String(observed?.system_identifier || '')
  if (!lease?.backendIPv4 || address !== lease.backendIPv4 || Number(observed?.server_port) !== 5432 ||
      !/^\d{10,20}$/u.test(identifier) || expectedSystemIdentifier && expectedSystemIdentifier !== identifier) {
    fail('lease_postgres_backend_identity_mismatch')
  }
  return identifier
}

export async function reserveCandidateLoopbackPort() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        server.close(error => error ? reject(error) : resolve(typeof address === 'object' && address ? address.port : null))
      })
    }).catch(() => null)
    if (Number.isInteger(port) && port !== 55441) return port
  }
  fail('lease_free_loopback_port_unavailable')
}

function docker(args, { json = false } = {}) {
  const scopedArgs = args[0] === 'context' && args[1] === 'show' ? args : ['--context', CONTEXT_NAME, ...args]
  const result = spawnSync('docker', scopedArgs, { encoding: 'utf8', env: dockerEnvironment(), timeout: 15000,
    windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
  if (result.error || result.signal || result.status !== 0) fail('lease_docker_inspection_or_operation_failed')
  if (!json) return result.stdout.trim()
  try { return JSON.parse(result.stdout) } catch { fail('lease_docker_output_invalid') }
}

function dockerEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'comspec', 'pathext']
      .includes(key.toLowerCase())))
}

function dockerOptional(args) {
  const result = spawnSync('docker', ['--context', CONTEXT_NAME, ...args], { encoding: 'utf8', env: dockerEnvironment(),
    timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 })
  if (result.error || result.signal) fail('lease_docker_inspection_failed')
  if (result.status !== 0) {
    if (/no such (?:object|volume)|not found/iu.test(result.stderr || '')) return null
    fail('lease_docker_inspection_failed')
  }
  try { return JSON.parse(result.stdout) } catch { fail('lease_docker_output_invalid') }
}

export function inspectPreflight(rawLease, dockerInfoReaders = {}) {
  const lease = validateLease(rawLease)
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) fail('lease_docker_environment_override_refused')
  const readDocker = dockerInfoReaders.docker || docker
  const readDockerOptional = dockerInfoReaders.dockerOptional || dockerOptional
  const contextName = readDocker(['context', 'show'])
  const context = readDocker(['context', 'inspect', CONTEXT_NAME], { json: true })[0]
  const image = readDockerOptional(['image', 'inspect', lease.imageRef])
  const container = readDockerOptional(['inspect', lease.containerName])
  const volume = readDockerOptional(['volume', 'inspect', lease.volumeName])
  const dockerServerVersion = readDocker(['version', '--format', '{{.Server.Version}}'])
  const projectContainers = readDocker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${lease.project}`])
  const projectVolumes = readDocker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${lease.project}`])
  // Authorization consumes the unmodified persisted shape, not the normalized
  // view with derived fields returned by validateLease.
  return authorizeDockerPreflight(rawLease, {
    contextName,
    contextEndpoint: context?.Endpoints?.docker?.Host,
    dockerHostOverride: process.env.DOCKER_HOST,
    dockerContextOverride: process.env.DOCKER_CONTEXT,
    dockerServerVersion,
    containerExists: Boolean(container),
    volumeExists: Boolean(volume),
    projectResourcesExist: Boolean(projectContainers || projectVolumes),
    imageId: image?.[0]?.Id,
    imageRefAvailable: Array.isArray(image?.[0]?.RepoTags) && image[0].RepoTags.includes(lease.imageRef),
    portAvailable: undefined,
  })
}

export async function prepareLease(scenario) {
  if (!SCENARIOS.has(scenario)) fail('lease_scenario_invalid')
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) fail('lease_docker_environment_override_refused')
  const contextName = docker(['context', 'show'])
  const context = docker(['context', 'inspect', CONTEXT_NAME], { json: true })[0]
  if (contextName !== CONTEXT_NAME || context?.Endpoints?.docker?.Host !== CONTEXT_ENDPOINT) fail('lease_docker_context_mismatch')
  const dockerServerVersion = docker(['version', '--format', '{{.Server.Version}}'])
  const imageRows = docker(['image', 'ls', '--no-trunc', '--format', '{{json .}}', 'postgres'])
    .split(/\r?\n/u).filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const imageChoice = imageRows.find(row => row.Repository === 'postgres' && /^16(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?$/u.test(row.Tag || ''))
  if (!imageChoice) fail('lease_no_cached_postgres16_image_no_pull_performed')
  const imageRef = `postgres:${imageChoice.Tag}`
  const inspectedImage = docker(['image', 'inspect', imageRef], { json: true })[0]
  const imageId = inspectedImage?.Id
  if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(imageId)) fail('lease_cached_image_identity_invalid')

  const runId = randomUUID()
  const nonce = randomBytes(32).toString('hex')
  const rawLease = { ...buildObserverAuditLease({ runId, nonce, dockerContext: CONTEXT_NAME,
    dockerEndpoint: CONTEXT_ENDPOINT, port: await reserveCandidateLoopbackPort(), imageRef, imageId }),
  schemaVersion: LEASE_SCHEMA_VERSION, scenario }
  const lease = validateLease(rawLease)
  const projectContainers = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${lease.project}`])
  const projectVolumes = docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${lease.project}`])
  validateDockerPreflight(validateObserverLease(rawLease), {
    contextName, contextEndpoint: context?.Endpoints?.docker?.Host, dockerServerVersion,
    dockerHostOverride: process.env.DOCKER_HOST, dockerContextOverride: process.env.DOCKER_CONTEXT,
    containerExists: Boolean(dockerOptional(['inspect', lease.containerName])),
    volumeExists: Boolean(dockerOptional(['volume', 'inspect', lease.volumeName])),
    projectResourcesExist: Boolean(projectContainers || projectVolumes),
    imageId, imageRefAvailable: true, portAvailable: true,
  })
  await inspectApprovedSharedParent()
  await assertPortAvailable(lease.host, lease.port)
  const runDirectory = privateRunDirectory(lease.runId)
  await createPrivateDirectory(runDirectory)
  const leasePath = path.join(runDirectory, 'lease.json')
  await writePrivateFile(leasePath, `${JSON.stringify(leaseDocument(lease), null, 2)}\n`, runDirectory)
  console.log(JSON.stringify({ status: 'lease-plan-ready-not-executed', scenario: lease.scenario,
    runId: lease.runId, leasePath }))
}

async function assertPortAvailable(host, port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', () => { server.close(); reject(new Error('lease_loopback_port_unavailable')) })
    server.listen(port, host, () => server.close(error => error ? reject(error) : resolve()))
  }).catch(() => fail('lease_loopback_port_unavailable'))
}

function privateBase() {
  const pathApi = process.platform === 'win32' ? path.win32 : path
  const selected = process.env.OWNERINC_AUDIT_PRIVATE_PARENT || (process.platform === 'win32'
    ? process.env.LOCALAPPDATA && path.win32.join(process.env.LOCALAPPDATA, 'Temp', 'opencode')
    : process.env.HOME)
  if (typeof selected !== 'string' || !pathApi.isAbsolute(selected) || selected.includes('\0')) fail('lease_private_state_unavailable')
  return pathApi.resolve(selected)
}

function privateRunDirectory(runId) {
  const prefix = process.platform === 'win32' ? `.${PROJECT_PREFIX}-` : `${PROJECT_PREFIX}-`
  return path.join(privateBase(), `${prefix}${runId}`)
}

export function validatePrivateLeaseLocation(leasePath, runId, profileRoot) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId || '') ||
      typeof leasePath !== 'string' || typeof profileRoot !== 'string') fail('lease_file_outside_private_state')
  const pathApi = process.platform === 'win32' ? path.win32 : path
  const prefix = process.platform === 'win32' ? `.${PROJECT_PREFIX}-` : `${PROJECT_PREFIX}-`
  const expected = pathApi.join(pathApi.resolve(profileRoot), `${prefix}${runId}`, 'lease.json')
  const actualPath = pathApi.resolve(leasePath)
  if (process.platform === 'win32' ? actualPath.toLowerCase() !== expected.toLowerCase() : actualPath !== expected) {
    fail('lease_file_outside_private_state')
  }
  return expected
}

export function leaseDocument(normalizedLease) {
  return Object.fromEntries(LEASE_KEYS.map(key => [key, normalizedLease[key]]))
}

const WINDOWS_ANCESTOR_ACL_INSPECT = `$ErrorActionPreference='Stop'
$p=$env:OWNERINC_ACL_PATH; $wi=[Security.Principal.WindowsIdentity]::GetCurrent(); $sid=$wi.User.Value
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

const WINDOWS_ACL_INSPECT = `$ErrorActionPreference='Stop'; $p=$env:OWNERINC_ACL_PATH; $acl=Get-Acl -LiteralPath $p -ErrorAction Stop; $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop; $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0); $daclPresent=(($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent)-ne 0); $daclNull=($daclPresent -and $null -eq $raw.DiscretionaryAcl); $daclInspectable=($daclPresent -and $null -ne $raw.DiscretionaryAcl); $daclAceCount=$null; if($daclInspectable){$daclAceCount=$raw.DiscretionaryAcl.Count}; $daclEmpty=($daclInspectable -and $daclAceCount -eq 0); $entries=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString(); inherited=$_.IsInherited} }); [pscustomobject]@{ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; currentUserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; daclProtected=$acl.AreAccessRulesProtected; reparse=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0); daclPresent=$daclPresent; daclNull=$daclNull; daclInspectable=$daclInspectable; daclEmpty=$daclEmpty; daclAceCount=$daclAceCount; daclControlFlags=$raw.ControlFlags.ToString(); entries=$entries} | ConvertTo-Json -Depth 5 -Compress`
const WINDOWS_ACL_SET_PRIVATE = `$ErrorActionPreference='Stop'; $p=$env:OWNERINC_ACL_PATH; $isDirectory=$env:OWNERINC_ACL_KIND -eq 'directory'; $wi=[Security.Principal.WindowsIdentity]::GetCurrent(); $owner=$wi.User; $acl=Get-Acl -LiteralPath $p -ErrorAction Stop; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($rule)}; $acl.SetOwner($owner); $principals=@($owner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')); $inherit=[Security.AccessControl.InheritanceFlags]::None; if($isDirectory){$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}; foreach($sid in $principals){$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); [void]$acl.AddAccessRule($rule)}; Set-Acl -LiteralPath $p -AclObject $acl -ErrorAction Stop`

export function powershellScriptWithUtf8Output(script) {
  if (typeof script !== 'string') fail('private_windows_script_invalid')
  return `${WINDOWS_POWERSHELL_UTF8_BOOTSTRAP}\n${script}`
}

export function decodeWindowsPowerShellStdout(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('private_windows_output_invalid')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { fail('private_windows_output_encoding_invalid') }
}

function runPowerShell(script, targetPath, kind = 'file') {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'systemroot', 'windir', 'temp', 'tmp', 'localappdata', 'userprofile', 'comspec', 'pathext', 'psmodulepath'].includes(key.toLowerCase())))
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellScriptWithUtf8Output(script)], {
    encoding: null, timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024,
    env: { ...inherited, OWNERINC_ACL_PATH: targetPath, OWNERINC_ACL_KIND: kind },
  })
  if (result.error || result.signal || result.status !== 0) fail('private_windows_acl_operation_failed')
  return decodeWindowsPowerShellStdout(result.stdout).trim()
}

function runPowerShellReadOnly(script, targetPath = '') {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'systemroot', 'windir', 'temp', 'tmp', 'localappdata', 'userprofile', 'comspec', 'pathext', 'psmodulepath'].includes(key.toLowerCase())))
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellScriptWithUtf8Output(script)], {
    encoding: null, timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
    env: { ...inherited, OWNERINC_ACL_PATH: targetPath },
  })
  if (result.error || result.signal || result.status !== 0) fail('private_windows_identity_or_acl_inspection_failed')
  return decodeWindowsPowerShellStdout(result.stdout).trim()
}

export function validatePrivateAclSnapshot(snapshot) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : snapshot?.entries && typeof snapshot.entries === 'object' ? [snapshot.entries] : null
  if (!snapshot || snapshot.reparse === true || typeof snapshot.currentUserSid !== 'string' || !/^S-1-[0-9-]+$/u.test(snapshot.currentUserSid) ||
      snapshot.ownerSid !== snapshot.currentUserSid ||
      snapshot.daclProtected !== true || !validInspectableDacl(snapshot) || !entries || entries.length !== 3 || snapshot.daclAceCount !== entries.length) {
    fail('private_acl_owner_or_protection_invalid')
  }
  const allowed = new Set([snapshot.currentUserSid, ...ALLOWED_WINDOWS_SIDS])
  if (entries.some(entry => !allowed.has(entry.sid) || entry.type !== 'Allow' ||
      entry.rights !== 'FullControl' || entry.inherited !== false)) fail('private_acl_untrusted_access_invalid')
  if (new Set(entries.map(entry => entry.sid)).size !== 3 || !entries.some(entry => entry.sid === snapshot.currentUserSid) ||
      !entries.some(entry => entry.sid === 'S-1-5-18') || !entries.some(entry => entry.sid === 'S-1-5-32-544')) {
    fail('private_acl_required_principal_missing')
  }
  return true
}

function validInspectableDacl(snapshot) {
  return snapshot?.daclPresent === true && snapshot?.daclNull === false && snapshot?.daclInspectable === true &&
    snapshot?.daclEmpty === false && Number.isInteger(snapshot?.daclAceCount) && snapshot.daclAceCount > 0 &&
    typeof snapshot?.daclControlFlags === 'string' && snapshot.daclControlFlags.split(',').map(flag => flag.trim()).includes('DiscretionaryAclPresent')
}

function normalizedWindowsPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.win32.isAbsolute(value)) {
    fail('private_windows_profile_path_invalid')
  }
  return path.win32.normalize(path.win32.resolve(value)).replace(/\\+$/u, '').toLowerCase()
}

export function validateWindowsProfileIdentity({ currentUserSid, profilePath, registeredProfilePath }) {
  if (typeof currentUserSid !== 'string' || !/^S-1-[0-9-]+$/u.test(currentUserSid) ||
      normalizedWindowsPath(profilePath) !== normalizedWindowsPath(registeredProfilePath)) {
    fail('private_windows_profile_identity_mismatch')
  }
  return true
}

function hasWindowsWriteOrReplaceRights(rightsMask) {
  return !Number.isInteger(rightsMask) || (rightsMask & WINDOWS_WRITE_OR_REPLACE_MASK) !== 0
}

function hasWindowsReadOrWriteRights(rightsMask) {
  return !Number.isInteger(rightsMask) || (rightsMask & WINDOWS_READ_OR_WRITE_MASK) !== 0
}

function assertAceInheritanceShape(entry) {
  if (typeof entry?.appliesToObject !== 'boolean' || typeof entry?.inheritOnly !== 'boolean' ||
      typeof entry?.containerInherit !== 'boolean' || typeof entry?.objectInherit !== 'boolean' ||
      typeof entry?.noPropagateInherit !== 'boolean' || typeof entry?.inheritedToChild !== 'boolean' ||
      entry.inheritOnly === entry.appliesToObject ||
      entry.inheritedToChild !== (entry.containerInherit || entry.objectInherit)) {
    fail('private_windows_ace_inheritance_shape_invalid')
  }
}

export function validateTrustedProfileParentAcl(snapshot) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
  const allowed = new Set([snapshot?.currentUserSid, ...ALLOWED_WINDOWS_SIDS])
  if (snapshot?.daclProtected !== true || !validInspectableDacl(snapshot) || snapshot.daclAceCount !== entries.length ||
      !ALLOWED_WINDOWS_OWNER_SIDS.has(snapshot?.ownerSid) ||
      (snapshot.ownerSid !== snapshot.currentUserSid && snapshot.ownerSid !== 'S-1-5-18') ||
      !entries.some(entry => entry.sid === snapshot.currentUserSid && entry.type === 'Allow' && entry.rights === 'FullControl' && entry.inherited === false) ||
      entries.some(entry => {
        if (entry.inherited !== false || entry.type !== 'Allow') return true
        assertAceInheritanceShape(entry)
        if (allowed.has(entry.sid)) return entry.rights !== 'FullControl'
        // Existing profile ACLs may contain traverse/read-attributes-only
        // app-capability ACEs; they must not list files or read leaf contents.
        if (!Number.isInteger(entry.rightsMask)) return true
        return ((entry.appliesToObject || entry.containerInherit || entry.objectInherit) &&
          hasWindowsReadOrWriteRights(entry.rightsMask)) || (entry.rightsMask & ~(0x20 | 0x80 | 0x100000)) !== 0
      })) fail('private_windows_profile_parent_acl_invalid')
  return true
}

export function validateSafeInitialPrivateDirectoryAcl(profileNode, currentUserSid) {
  if (!profileNode || !validInspectableDacl(profileNode) || profileNode.daclAceCount !== profileNode.entries?.length ||
      profileNode.daclProtected !== true || !Array.isArray(profileNode.entries)) fail('private_windows_initial_child_acl_uninspectable')
  for (const entry of profileNode.entries) {
    assertAceInheritanceShape(entry)
    const trusted = entry.sid === currentUserSid || ALLOWED_WINDOWS_SIDS.has(entry.sid)
    const couldReachNewDirectoryOrItsFiles = entry.containerInherit || entry.objectInherit
    if (entry.type === 'Allow' && couldReachNewDirectoryOrItsFiles && !trusted &&
        hasWindowsReadOrWriteRights(entry.rightsMask)) fail('private_windows_initial_child_acl_untrusted_access')
    if (entry.type === 'Deny' && couldReachNewDirectoryOrItsFiles && entry.tokenMatch &&
        hasWindowsWriteOrReplaceRights(entry.rightsMask)) fail('private_windows_initial_child_acl_effective_deny')
  }
  return true
}

export function validateWindowsAncestorChain({ currentUserSid, profilePath, registeredProfilePath, ancestors }) {
  validateWindowsProfileIdentity({ currentUserSid, profilePath, registeredProfilePath })
  if (!Array.isArray(ancestors) || ancestors.length === 0) fail('private_windows_ancestor_inventory_invalid')
  const profile = normalizedWindowsPath(profilePath)
  const ordered = [...ancestors].sort((left, right) => left.depth - right.depth)
  const profileNode = ordered.find(node => normalizedWindowsPath(node.path) === profile)
  if (!profileNode || profileNode.reparse !== false || profileNode.daclProtected !== true ||
      !ALLOWED_WINDOWS_OWNER_SIDS.has(profileNode.ownerSid) || ordered[0]?.depth !== 0 ||
      normalizedWindowsPath(ordered[0]?.path) !== profile ||
      ordered.some((node, index) => node.depth !== index || (index > 0 &&
        normalizedWindowsPath(node.path) !== normalizedWindowsPath(path.win32.dirname(ordered[index - 1].path)))) ||
      normalizedWindowsPath(path.win32.dirname(ordered.at(-1)?.path)) !== normalizedWindowsPath(ordered.at(-1)?.path)) {
    fail('private_windows_profile_parent_invalid')
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const node = ordered[index]
    const nodePath = normalizedWindowsPath(node.path)
    const isProfile = nodePath === profile
    if (node.reparse !== false || !ALLOWED_WINDOWS_OWNER_SIDS.has(node.ownerSid) || !Array.isArray(node.entries)) {
      fail('private_windows_ancestor_identity_or_reparse_invalid')
    }
    if (!validInspectableDacl(node) || node.daclAceCount !== node.entries.length) fail('private_windows_ancestor_dacl_uninspectable')
    if (isProfile) {
      validateTrustedProfileParentAcl({ ...node, currentUserSid })
      validateSafeInitialPrivateDirectoryAcl(node, currentUserSid)
      continue
    }
    for (const entry of node.entries) {
      const trusted = entry.sid === currentUserSid || ALLOWED_WINDOWS_SIDS.has(entry.sid)
      assertAceInheritanceShape(entry)
      if (entry.type === 'Deny') {
        if (entry.appliesToObject && entry.tokenMatch && hasWindowsWriteOrReplaceRights(entry.rightsMask)) {
          fail('private_windows_ancestor_effective_deny_invalid')
        }
        if (!entry.appliesToObject && entry.tokenMatch && hasWindowsWriteOrReplaceRights(entry.rightsMask)) {
          assertInheritedAceBlockedOrInspected(entry, ordered[index - 1])
        }
        continue
      }
      if (entry.type !== 'Allow') fail('private_windows_ancestor_ace_type_invalid')
      if (trusted || !hasWindowsWriteOrReplaceRights(entry.rightsMask)) continue
      if (!entry.appliesToObject) {
        if (entry.containerInherit || entry.objectInherit) assertInheritedAceBlockedOrInspected(entry, ordered[index - 1])
        continue
      }

      // The existing volume-root ACE grants only directory creation, without
      // inheritance or the ability to replace an existing descendant.
      const appendOnlyProfileSiblingCreation = entry.sid === WINDOWS_AUTHENTICATED_USERS &&
        profile.startsWith(`${nodePath}\\`) && entry.containerInherit === false && entry.objectInherit === false &&
        [0x4, 0x100004].includes(entry.rightsMask)
      if (!appendOnlyProfileSiblingCreation) fail('private_windows_ancestor_untrusted_write_grant')
    }
  }
  return true
}

function assertInheritedAceBlockedOrInspected(entry, childNode) {
  if (!entry.containerInherit && !entry.objectInherit) return true
  if (!childNode || childNode.daclProtected !== true) {
    const represented = childNode?.entries?.some(childEntry => childEntry.inherited === true &&
      childEntry.sid === entry.sid && childEntry.type === entry.type && childEntry.rightsMask === entry.rightsMask)
    if (!represented) fail('private_windows_inherited_ace_not_accounted_for')
  }
  return true
}

export function validatePrivatePosixStat(info, expectedKind, currentUid) {
  const correctKind = expectedKind === 'directory' ? info?.isDirectory === true : info?.isFile === true
  if (!info || info.isSymbolicLink === true || !correctKind || info.uid !== currentUid ||
      !Number.isInteger(info.mode) || (info.mode & 0o077) !== 0) fail('private_posix_owner_or_mode_invalid')
  return true
}

async function assertNoReparseAncestors(targetPath) {
  const absolute = path.resolve(targetPath)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const info = await lstat(current).catch(() => null)
    if (!info || info.isSymbolicLink()) fail('private_path_missing_or_reparse_point')
  }
}

async function inspectPrivatePath(targetPath, expectedKind) {
  await assertNoReparseAncestors(targetPath)
  const info = await lstat(targetPath)
  if (expectedKind === 'directory' ? !info.isDirectory() : !info.isFile()) fail('private_path_kind_invalid')
  if (process.platform === 'win32') {
    const output = runPowerShell(WINDOWS_ACL_INSPECT, targetPath, expectedKind)
    let snapshot
    try { snapshot = JSON.parse(output) } catch { fail('private_windows_acl_output_invalid') }
    validatePrivateAclSnapshot(snapshot)
  } else {
    if (typeof process.getuid !== 'function') fail('private_posix_uid_unavailable')
    validatePrivatePosixStat({ uid: info.uid, mode: info.mode, isDirectory: info.isDirectory(),
      isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink() }, expectedKind, process.getuid())
  }
  const real = await realpath(targetPath)
  if (path.resolve(real) !== path.resolve(targetPath)) fail('private_path_resolution_changed')
  return info
}

async function inspectApprovedSharedParent() {
  const parent = privateBase()
  await assertExternalNoReparseAncestors(parent)
  try {
    assertOutsideRepository(await realpath(parent), await realpath(ROOT))
    await assertOutsideGitWorktrees(parent)
  } catch (error) {
    if (error?.code) throw error
    fail('lease_private_parent_boundary_invalid')
  }
  const info = await lstat(parent).catch(() => fail('lease_private_parent_missing'))
  if (!info.isDirectory() || info.isSymbolicLink()) fail('lease_private_parent_invalid')
  if (process.platform === 'win32') {
    const output = runPowerShellReadOnly(WINDOWS_ANCESTOR_ACL_INSPECT, parent)
    let snapshot
    try { snapshot = JSON.parse(output) } catch { fail('lease_private_windows_acl_snapshot_invalid') }
    try {
      validateWindowsConfiguredPrivateParent({ currentUserSid: snapshot?.currentUserSid,
        parentPath: parent, ancestors: snapshot?.ancestors })
    } catch { fail('lease_private_windows_parent_acl_invalid') }
  } else {
    if (typeof process.getuid !== 'function' || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) {
      fail('lease_private_parent_owner_or_permissions_invalid')
    }
  }
}

async function createPrivateDirectory(directory) {
  await inspectApprovedSharedParent()
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const created = await lstat(directory)
  if (created.isSymbolicLink() || !created.isDirectory()) fail('private_directory_create_identity_invalid')
  if (process.platform === 'win32') runPowerShell(WINDOWS_ACL_SET_PRIVATE, directory, 'directory')
  else await chmod(directory, 0o700)
  const aclChecked = await inspectPrivatePath(directory, 'directory')
  if (!sameFileIdentity(created, aclChecked)) fail('private_directory_identity_changed_during_acl_setup')
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() === right.isFile() && left.nlink === right.nlink
}

function assertPrivateFileLinkCount(info) {
  if (!Number.isInteger(info?.nlink) || info.nlink !== 1) fail('private_file_link_count_invalid')
}

async function writePrivateFile(filePath, contents, runDirectory) {
  await inspectApprovedSharedParent()
  await inspectPrivatePath(runDirectory, 'directory')
  const flags = process.platform === 'win32' ? 'wx' : fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0)
  const handle = await open(filePath, flags, 0o600)
  try {
    const opened = await handle.stat()
    assertPrivateFileLinkCount(opened)
    if (process.platform === 'win32') runPowerShell(WINDOWS_ACL_SET_PRIVATE, filePath, 'file')
    else await chmod(filePath, 0o600)
    const aclState = await inspectPrivatePath(filePath, 'file')
    if (!sameFileIdentity(opened, aclState)) fail('private_file_identity_changed_during_acl_setup')
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    const afterWrite = await inspectPrivatePath(filePath, 'file')
    const afterWriteHandle = await handle.stat()
    assertPrivateFileLinkCount(afterWriteHandle)
    if (!sameFileIdentity(afterWriteHandle, afterWrite)) fail('private_file_identity_changed_after_write')
  } finally { await handle.close() }
}

// Lease directories are one-shot execution capabilities. Only the untouched
// prepared lease may be present before this atomic claim; a claim is retained
// after any later failure and report writes are exclusive as a second guard.
export async function runClaimedAttempt(rawLease, runDirectory, report, getStage, operation, storage = {}) {
  const lease = validateLease(rawLease)
  const verifyDirectory = storage.verifyDirectory || (async directory => {
    await inspectApprovedSharedParent()
    await inspectPrivatePath(directory, 'directory')
  })
  const listDirectory = storage.listDirectory || (directory => readdir(directory))
  const claimWriter = storage.claim || ((filePath, contents, directory) => writePrivateFile(filePath, contents, directory))
  const reportWriter = storage.writeReport || ((filePath, contents, directory) => writePrivateFile(filePath, contents, directory))

  await verifyDirectory(runDirectory)
  const existingNames = await listDirectory(runDirectory)
  if (!Array.isArray(existingNames) || existingNames.length !== 1 || existingNames[0] !== 'lease.json') {
    fail('lease_attempt_artifacts_exist')
  }

  const claimPath = path.join(runDirectory, 'execution.claim.json')
  try {
    await claimWriter(claimPath, `${JSON.stringify({ runId: lease.runId, claimed: true })}\n`, runDirectory)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('lease_attempt_already_claimed')
    throw error
  }

  let operationError
  try {
    return await operation(lease)
  } catch (error) {
    operationError = error
    report.status = 'blocked_or_failed_fixture_preserved'
    const rawCode = typeof error?.code === 'string' ? error.code : ''
    const sqlstate = /^[0-9A-Z]{5}$/u.test(rawCode) ? rawCode : null
    const code = /^[a-z][a-z0-9_]{0,80}$/u.test(rawCode) ? rawCode : 'unexpected_failure'
    report.failure = { stage: getStage(), code, sqlstate,
      stageResult: error?.stageResult && typeof error.stageResult === 'object' ? error.stageResult : null }
    throw error
  } finally {
    report.resourceDisposition = 'preserved; no automatic container, volume, database, role, or fixture cleanup'
    const reportPath = path.join(runDirectory, 'report.json')
    try { await reportWriter(reportPath, `${JSON.stringify(report, null, 2)}\n`, runDirectory) }
    catch (reportError) { if (!operationError) throw reportError }
  }
}

async function readPrivateFile(filePath, runDirectory) {
  await inspectApprovedSharedParent()
  await inspectPrivatePath(runDirectory, 'directory')
  const pathState = await inspectPrivatePath(filePath, 'file')
  const flags = process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
  const handle = await open(filePath, flags)
  try {
    const opened = await handle.stat()
    assertPrivateFileLinkCount(opened)
    const checked = await inspectPrivatePath(filePath, 'file')
    if (!sameFileIdentity(opened, pathState) || !sameFileIdentity(opened, checked)) fail('private_file_identity_changed_during_read')
    const contents = await handle.readFile('utf8')
    const afterRead = await inspectPrivatePath(filePath, 'file')
    const afterReadHandle = await handle.stat()
    assertPrivateFileLinkCount(afterReadHandle)
    if (!sameFileIdentity(afterReadHandle, afterRead)) fail('private_file_identity_changed_after_read')
    return contents
  } finally { await handle.close() }
}

function makeConnectionString(user, password, database, port) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`
}

function syntheticEnvironment(extra = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'comspec', 'pathext'].includes(key.toLowerCase())))
  return { ...inherited, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', ...extra }
}

function redact(output, secrets) {
  let text = String(output || '')
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]')
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/giu, '[redacted-db-url]')
}

const FINALIZER_DIAGNOSTIC_PHASES = new Set([
  'connection-configuration', 'admin-connect', 'transaction-begin', 'transaction-lock',
  'precondition-identity', 'precondition-migrations', 'precondition-relations', 'precondition-columns',
  'precondition-sequences', 'precondition-enums', 'precondition-constraints', 'precondition-indexes',
  'precondition-foreign-keys', 'precondition-control-columns', 'precondition-control-roles',
  'precondition-protocol-inventory', 'precondition-control-ownership', 'precondition-native-privileges',
  'precondition-installed-state', 'protocol-head-read', 'protocol-ledger-ddl', 'protocol-trigger-ddl',
  'protocol-binding-ddl', 'protocol-grants', 'protocol-bootstrap-ddl', 'verify-installed', 'transaction-commit',
  'transaction-rollback',
])
const FINALIZER_DIAGNOSTIC_REASONS = new Set([
  'admin_database_url_required', 'unsafe_admin_database_url', 'unsafe_admin_target',
  'native_migration_ledger_mismatch', 'native_relation_inventory_mismatch', 'mutation_relation_inventory_mismatch',
  'native_column_inventory_mismatch', 'native_serial_sequence_binding_or_configuration_mismatch',
  'native_enum_catalog_mismatch', 'native_required_constraint_missing', 'native_snapshot_index_missing_or_mismatched',
  'native_snapshot_foreign_key_mismatch', 'native_control_column_types_mismatch', 'native_item_run_id_type_mismatch',
  'control_role_contract_mismatch', 'partial_protocol_installation_manual_recovery_required',
  'protocol_upgrade_required', 'protocol_upgrade_requires_v1',
  'unsafe_preinstallation_control_state', 'diagnostic_installed_protocol_deep_check_skipped',
  'ledger_head_invalid_or_coverage_activated', 'canonical_function_mismatch', 'canonical_function_inventory_unavailable',
  'trigger_inventory_count_mismatch', 'trigger_key_missing', 'trigger_key_duplicate',
  'trigger_relation_schema_mismatch', 'trigger_enabled_state_mismatch', 'trigger_function_identity_mismatch',
  'trigger_function_schema_mismatch', 'trigger_event_mask_mismatch', 'trigger_column_inventory_mismatch',
  'trigger_catalog_type_mismatch', 'trigger_argument_inventory_mismatch', 'trigger_condition_mismatch',
  'trigger_definition_mismatch', 'runtime_verifier_role_switch_failed', 'runtime_protocol_acl_mismatch',
  'admin_role_restore_failed', 'control_role_table_acl_mismatch', 'control_role_column_acl_mismatch',
  'control_role_sequence_acl_mismatch', 'public_function_execute_outside_allowlist', 'protocol_acl_mismatch',
  'unexpected_control_owned_objects', 'database_error',
])
const FINALIZER_TRIGGER_DETAIL_KEYS = [
  'trigger_index', 'expected_count', 'observed_count', 'matched_count', 'relation_schema_match', 'enabled_match',
  'function_name_match', 'function_schema_match', 'function_identity_match', 'event_mask', 'expected_event_mask',
  'attribute_count', 'attribute_type_match', 'attribute_text_shape_match', 'argument_count', 'argument_bytes',
  'no_condition', 'definition_exact', 'definition_normalized',
]
const FINALIZER_NUMBER = '(?:none|0|[1-9][0-9]*)'
const FINALIZER_BOOLEAN = '(?:yes|no|none)'
const FINALIZER_TRIGGER_DETAILS_PATTERN = new RegExp(`^${FINALIZER_TRIGGER_DETAIL_KEYS.map((key, index) => {
  const value = ['relation_schema_match', 'enabled_match', 'function_name_match', 'function_schema_match',
    'function_identity_match', 'attribute_type_match', 'attribute_text_shape_match', 'no_condition',
    'definition_exact', 'definition_normalized'].includes(key) ? FINALIZER_BOOLEAN : FINALIZER_NUMBER
  return `${index === 0 ? '' : ' '}${key}=${value}`
}).join('')}$`, 'u')
const KNOWN_SIGNALS = new Set([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL',
  'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGSTOP', 'SIGTERM', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGUSR1', 'SIGUSR2',
])

function parseFixedFinalizerDiagnostic(output) {
  const lines = String(output).split(/\r?\n/u)
  const diagnosticLines = lines.filter(line => line.startsWith('CMS news protocol diagnostic:'))
  if (diagnosticLines.length === 0) return { status: 'missing', diagnostic: null }
  if (diagnosticLines.length !== 1) return { status: 'ambiguous', diagnostic: null }
  const match = /^CMS news protocol diagnostic: phase=([a-z-]+) reason=([a-z_]+) sqlstate=(none|[0-9A-Z]{5})(?: (.*))?$/u.exec(diagnosticLines[0])
  if (!match) return { status: 'malformed', diagnostic: null }
  const [, phase, reason, sqlstate, detailText] = match
  if (!FINALIZER_DIAGNOSTIC_PHASES.has(phase) || !FINALIZER_DIAGNOSTIC_REASONS.has(reason)) {
    return { status: 'unknown_enum', diagnostic: null }
  }
  let triggerDetails = null
  if (detailText !== undefined) {
    if (!FINALIZER_TRIGGER_DETAILS_PATTERN.test(detailText)) return { status: 'malformed', diagnostic: null }
    const values = Object.fromEntries(detailText.split(' ').map(field => {
      const separator = field.indexOf('=')
      return [field.slice(0, separator), field.slice(separator + 1)]
    }))
    const numericValues = Object.entries(values).filter(([key, value]) =>
      !['relation_schema_match', 'enabled_match', 'function_name_match', 'function_schema_match',
        'function_identity_match', 'attribute_type_match', 'attribute_text_shape_match', 'no_condition',
        'definition_exact', 'definition_normalized'].includes(key) && value !== 'none')
    if (numericValues.some(([, value]) => !Number.isSafeInteger(Number(value)))) {
      return { status: 'malformed', diagnostic: null }
    }
    triggerDetails = Object.fromEntries(FINALIZER_TRIGGER_DETAIL_KEYS.map(key => {
      const value = values[key]
      return [key, value === 'yes' ? true : value === 'no' ? false
        : value === 'none' ? null : Number(value)]
    }))
  }
  return { status: 'parsed', diagnostic: { phase, reason, sqlstate, ...(triggerDetails ? { triggerDetails } : {}) } }
}

export function createAtomicRollbackEvidenceRecord() {
  return {
    label: 'atomic-install-rollback', status: null, expectedStatus: 1,
    expectedPublicFunctionRejection: null, roguePublicFunctionRejected: null,
    finalizerCli: null, protocolCreateTableObserved: null, persistedProtocolObjects: null,
    nativeStateCompared: false, nativeStateUnchanged: null, nativeBefore: null, nativeAfter: null,
  }
}

export function recordFinalizerCliEvidence(record, { status, signal = null, timedOut = false, output, secrets = [] }) {
  const safeOutput = redact(output, secrets)
  const parsed = parseFixedFinalizerDiagnostic(safeOutput)
  const numericExitCode = Number.isInteger(status) && status >= 0 && status <= 255 ? status : null
  const termination = numericExitCode !== null ? 'exit'
    : status === 'timeout' ? 'timeout' : 'spawn-error'
  record.finalizerCli = {
    exitCode: numericExitCode,
    termination,
    signal: typeof signal === 'string' && KNOWN_SIGNALS.has(signal) ? signal : signal ? 'other' : null,
    timedOut: timedOut === true,
    expectedPublicFunctionRejection: isExpectedPublicFunctionRejection(status, safeOutput),
    diagnosticStatus: parsed.status,
    diagnostic: parsed.diagnostic,
    sanitizedOutputSha256: sha256(safeOutput),
  }
  record.status = numericExitCode ?? termination
  record.expectedPublicFunctionRejection = record.finalizerCli.expectedPublicFunctionRejection
  record.roguePublicFunctionRejected = record.expectedPublicFunctionRejection
  return record.finalizerCli
}

function compactNativeEvidence(evidence) {
  const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : null
  const tableRows = Array.isArray(evidence?.tableRows) ? evidence.tableRows : null
  const sequenceState = Array.isArray(evidence?.nativeSequenceState) ? evidence.nativeSequenceState : null
  if (!evidence || !tableRows || !sequenceState
    || !tableRows.every(row => typeof row?.rowCount === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(row.rowCount))) {
    return null
  }
  let totalRows = 0n
  for (const row of tableRows) totalRows += BigInt(row.rowCount)
  return {
    tableCount: Number(evidence.tableCount), tableRows: tableRows.length,
    totalRows: totalRows.toString(), schemaSha256: hash(evidence.schemaSha256),
    rowsSha256: hash(evidence.dataSha256), migrationLedgerRows: Number(evidence.migrationLedgerRows),
    migrationLedgerSha256: hash(evidence.migrationLedgerSha256), sequences: sequenceState.length,
    sequencesSha256: hash(evidence.nativeSequenceStateSha256),
  }
}

export function recordAtomicRollbackSnapshot(record, position, evidence) {
  if (position !== 'before' && position !== 'after') fail('atomic_rollback_snapshot_position_invalid')
  const summary = compactNativeEvidence(evidence)
  if (!summary || Object.values(summary).some(value => value === null)
    || !Number.isSafeInteger(summary.tableCount) || !Number.isSafeInteger(summary.migrationLedgerRows)) {
    fail('atomic_rollback_snapshot_evidence_invalid')
  }
  record[position === 'before' ? 'nativeBefore' : 'nativeAfter'] = summary
  return summary
}

export function recordAtomicRollbackCheck(record, key, result) {
  if (!['protocolCreateTableObserved', 'persistedProtocolObjects'].includes(key)
    || typeof result !== 'boolean') fail('atomic_rollback_check_invalid')
  record[key] = result
}

export function recordAtomicRollbackComparison(record, unchanged) {
  if (!record.nativeBefore || !record.nativeAfter || typeof unchanged !== 'boolean') {
    fail('atomic_rollback_comparison_evidence_invalid')
  }
  record.nativeStateCompared = true
  record.nativeStateUnchanged = unchanged
}

export function isExpectedPublicFunctionRejection(status, output) {
  const expectedOutput = [
    'CMS news protocol finalization failed; inspect target privately and use manual recovery for partial state',
    'CMS news protocol diagnostic: phase=verify-installed reason=public_function_execute_outside_allowlist sqlstate=none',
  ].join('\n')
  return status === 1 && typeof output === 'string' && output.trim() === expectedOutput
}

async function runCli(label, executable, args, env, directory, secrets, expectedStatus = 0, captureSanitizedOutcome = null) {
  const result = spawnSync(executable, args, { cwd: directory, env, encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`, secrets)
  const status = result.status ?? (result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'spawn-error')
  if (typeof captureSanitizedOutcome === 'function') {
    captureSanitizedOutcome({ status, signal: result.signal || null,
      timedOut: result.error?.code === 'ETIMEDOUT', output })
  }
  if (status !== expectedStatus || result.error || result.signal) {
    const error = new Error(`cli_stage_failed:${label}`)
    error.code = 'protocol_finalizer_cli_stage_failed'
    const parsed = parseFixedFinalizerDiagnostic(output)
    error.stageResult = { label, status: Number.isInteger(status) ? status : 'nonzero',
      signal: typeof result.signal === 'string' && KNOWN_SIGNALS.has(result.signal) ? result.signal : result.signal ? 'other' : null,
      timeout: result.error?.code === 'ETIMEDOUT', diagnosticStatus: parsed.status, diagnostic: parsed.diagnostic }
    throw error
  }
  const summary = { label, status }
  Object.defineProperty(summary, PRIVATE_CLI_OUTPUT, { value: output })
  return summary
}

async function connect(connectionString) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 6000, query_timeout: 15000 })
  await client.connect()
  return client
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function sha256(value) { return createHash('sha256').update(value).digest('hex') }

export function buildNativeStateEvidence({ expectedTables, actualTables, schema, data, migrationLedger }) {
  const expected = [...expectedTables].sort()
  const actual = [...actualTables].sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('native_state_table_inventory_mismatch')
  const expectedData = [...data].sort((left, right) => left.tableName < right.tableName ? -1 : left.tableName > right.tableName ? 1 : 0)
  if (expectedData.length !== expected.length || expected.some((name, index) => expectedData[index]?.tableName !== name)) {
    fail('native_state_table_data_inventory_mismatch')
  }
  const tableEvidence = expectedData.map(table => {
    if (typeof table.rowCount !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(table.rowCount) || typeof table.canonicalRows !== 'string') {
      fail('native_state_table_digest_input_invalid')
    }
    return { tableName: table.tableName, rowCount: table.rowCount, sha256: sha256(table.canonicalRows) }
  })
  const schemaText = JSON.stringify(canonicalize(schema))
  const ledgerText = JSON.stringify(canonicalize(migrationLedger))
  const dataText = JSON.stringify(tableEvidence)
  return {
    tableCount: String(expected.length), schemaSha256: sha256(schemaText),
    dataSha256: sha256(dataText), migrationLedgerSha256: sha256(ledgerText),
    migrationLedgerRows: String(migrationLedger.length), tableRows: tableEvidence,
  }
}

export function compareNativeStateEvidence(before, after) {
  return JSON.stringify(canonicalize(before)) === JSON.stringify(canonicalize(after))
}

function quoteIdentifier(identifier) {
  if (typeof identifier !== 'string' || !/^[a-z_][a-z0-9_]*$/u.test(identifier)) fail('native_state_identifier_invalid')
  return `"${identifier}"`
}

const PROTOCOL_FUNCTION_NAMES = [
  'owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row', 'owner_news_seal_run',
  'owner_news_migration_item_binding_guard', 'owner_news_bootstrap_run',
]

async function snapshotNativeState(client, { ignoreProtocolOverlay = false } = {}) {
  const snapshotPath = path.join(CMS, 'src/migrations/20261006_181424_z_owner_news_native.json')
  const nativeSnapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  const tableNames = Object.values(nativeSnapshot.tables).map(table => table.name).sort()
  if (tableNames.length !== 46) fail('native_state_expected_table_count_mismatch')
  const sequenceNames = Object.entries(nativeSnapshot.tables).flatMap(([key, table]) =>
    Object.values(table.columns).filter(column => column.type === 'serial').map(column => `${table.name}_${column.name}_seq`))

  await client.query('SELECT pg_advisory_lock(7194030)')
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const relations = await client.query(`SELECT c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence,
      pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS row_security,
      c.relforcerowsecurity AS force_row_security, c.relreplident::text AS replica_identity,
      c.reloptions::text AS options, CASE WHEN $2::boolean THEN NULL ELSE c.relacl::text END AS acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [tableNames, ignoreProtocolOverlay])
    const columns = await client.query(`SELECT c.relname AS table_name, a.attnum::text AS ordinal,
      a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
      type_ns.nspname AS type_schema, t.typname AS type_name, a.attnotnull AS not_null,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression, a.attidentity AS identity_kind,
      a.attgenerated AS generated_kind, a.attcollation::regcollation::text AS collation,
      a.attstorage AS storage, a.attcompression AS compression, a.attstattarget::text AS statistics_target,
      a.attinhcount::text AS inheritance_count
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace type_ns ON type_ns.oid=t.typnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`, [tableNames])
    const constraints = await client.query(`SELECT c.relname AS table_name, con.conname AS name,
      con.contype AS kind, pg_catalog.pg_get_constraintdef(con.oid,true) AS definition,
      con.convalidated AS validated, con.condeferrable AS deferrable, con.condeferred AS initially_deferred,
      con.connoinherit AS no_inherit
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,con.conname`, [tableNames])
    const indexes = await client.query(`SELECT t.relname AS table_name, i.relname AS name,
      pg_catalog.pg_get_indexdef(i.oid) AS definition, am.amname AS access_method,
      ix.indisunique AS is_unique, ix.indisprimary AS is_primary, ix.indisvalid AS is_valid,
      ix.indisready AS is_ready, ix.indisreplident AS replica_identity, i.reloptions::text AS options
      FROM pg_index ix JOIN pg_class t ON t.oid=ix.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_am am ON am.oid=i.relam
      WHERE n.nspname='public' AND t.relname=ANY($1::text[]) ORDER BY t.relname,i.relname`, [tableNames])
    const triggers = await client.query(`SELECT c.relname AS table_name, t.tgname AS name,
      pg_catalog.pg_get_triggerdef(t.oid,false) AS definition, t.tgenabled AS enabled,
      t.tgisinternal AS internal, p.proname AS function_name, pn.nspname AS function_schema,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS function_arguments
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])
        AND (NOT $2::boolean OR t.tgname NOT LIKE 'owner_news_%') ORDER BY c.relname,t.tgname`,
    [tableNames, ignoreProtocolOverlay])
    const enums = await client.query(`SELECT t.typname AS name, n.nspname AS schema,
      array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
      WHERE n.nspname='public' GROUP BY t.oid,n.nspname ORDER BY t.typname`)
    const sequences = await client.query(`SELECT c.relname AS name, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
      s.seqtypid::regtype::text AS data_type, s.seqstart::text AS start_value,
      s.seqincrement::text AS increment_by, s.seqmin::text AS minimum_value,
      s.seqmax::text AS maximum_value, s.seqcache::text AS cache_size, s.seqcycle AS cycles,
      dep.deptype AS dependency_type, owner_table.relname AS owned_table,
      owner_column.attname AS owned_column
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid
      LEFT JOIN pg_depend dep ON dep.classid='pg_class'::regclass AND dep.objid=c.oid
        AND dep.refclassid='pg_class'::regclass AND dep.deptype='a'
      LEFT JOIN pg_class owner_table ON owner_table.oid=dep.refobjid
      LEFT JOIN pg_attribute owner_column ON owner_column.attrelid=dep.refobjid AND owner_column.attnum=dep.refobjsubid
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [sequenceNames])
    const functions = await client.query(`SELECT n.nspname AS schema, p.proname AS name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
      pg_catalog.pg_get_function_result(p.oid) AS result_type, p.prokind AS kind,
      p.prosecdef AS security_definer, p.proconfig::text AS configuration,
      pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosrc AS source,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE grantee_role.rolname END,
        'privilege',acl.privilege_type,'grantable',acl.is_grantable) ORDER BY acl.grantee,acl.privilege_type)
        FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl LEFT JOIN pg_roles grantee_role ON grantee_role.oid=acl.grantee),'[]'::jsonb)::text AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        AND (NOT $1::boolean OR p.proname <> ALL($2::name[])) ORDER BY p.proname,identity_arguments`,
    [ignoreProtocolOverlay, PROTOCOL_FUNCTION_NAMES])
    const eventTriggers = await client.query(`SELECT e.evtname AS name, e.evtevent AS event,
      e.evtenabled AS enabled, pg_catalog.pg_get_userbyid(e.evtowner) AS owner,
      p.proname AS function_name, n.nspname AS function_schema,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS function_arguments
      FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace
      ORDER BY e.evtname`)
    const policies = await client.query(`SELECT c.relname AS table_name, p.polname AS name,
      p.polcmd AS command, p.polpermissive AS permissive,
      ARRAY(SELECT pg_catalog.pg_get_userbyid(roles.role_oid)
        FROM unnest(p.polroles) AS roles(role_oid) ORDER BY roles.role_oid)::text AS roles,
      pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expression,
      pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,p.polname`, [tableNames])
    const migrationRows = await client.query('SELECT name, batch::text AS batch FROM public.payload_migrations ORDER BY name COLLATE "C"')
    const data = []
    for (const tableName of tableNames) {
      const result = await client.query(`SELECT count(*)::text AS row_count,
        COALESCE(jsonb_agg(to_jsonb(native_row) ORDER BY to_jsonb(native_row)::text),'[]'::jsonb)::text AS canonical_rows
        FROM public.${quoteIdentifier(tableName)} AS native_row`)
      data.push({ tableName, rowCount: result.rows[0]?.row_count, canonicalRows: result.rows[0]?.canonical_rows })
    }
    const sequenceState = []
    for (const sequenceName of sequenceNames) {
      const result = await client.query(`SELECT last_value::text AS last_value, is_called FROM public.${quoteIdentifier(sequenceName)}`)
      sequenceState.push({ sequenceName, lastValue: result.rows[0]?.last_value, isCalled: result.rows[0]?.is_called })
    }
    const schema = {
      relations: relations.rows, columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows,
      triggers: triggers.rows, enums: enums.rows, sequences: sequences.rows, functions: functions.rows,
      eventTriggers: eventTriggers.rows, policies: policies.rows,
    }
    const evidence = buildNativeStateEvidence({ expectedTables: tableNames,
      actualTables: relations.rows.map(row => row.name), schema, data,
      migrationLedger: migrationRows.rows.map(row => ({ name: row.name, batch: row.batch })) })
    evidence.nativeSequenceStateSha256 = sha256(JSON.stringify(canonicalize(sequenceState)))
    evidence.nativeSequenceState = sequenceState.map(({ sequenceName, lastValue, isCalled }) => ({ sequenceName, lastValue, isCalled }))
    return evidence
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    await client.query('SELECT pg_advisory_unlock(7194030)').catch(() => {})
  }
}

async function captureNativeState(adminURL, target = null, passwords = null, options = {}) {
  const client = target && passwords
    ? await connectTarget(target, passwords, 'cms_admin', DB)
    : await connect(adminURL)
  try { return await snapshotNativeState(client, options) }
  finally { await client.end() }
}

function inspectTargetBackend(target) {
  const verifiedBackend = target?.verifiedBackendIdentity
  if (!verifiedBackend || !Object.isFrozen(verifiedBackend)
    || verifiedBackend.containerId !== target.containerId
    || verifiedBackend.backendIPv4 !== target.backendIPv4
    || verifiedBackend.systemIdentifier !== target.systemIdentifier) {
    fail('lease_postgres_backend_identity_changed')
  }
  assertCreatedVolumeIdentity(target)
  const inspected = docker(['inspect', target.containerName], { json: true })[0]
  const backend = validateObserverDockerContainer(observerLeaseFromRaw(target), target.passwordFile, inspected)
  if (backend.containerId !== verifiedBackend.containerId || backend.backendIPv4 !== verifiedBackend.backendIPv4) {
    fail('lease_postgres_backend_identity_changed')
  }
  return backend
}

async function assertTargetPhysicalIdentity(target, passwords, database = DB) {
  const before = inspectTargetBackend(target)
  const client = await connect(makeConnectionString('cms_admin', passwords.cms_admin, database, target.port))
  try {
    const identity = await client.query(`SELECT current_user AS role, session_user AS session_role,
      current_database() AS database, inet_server_addr()::text AS server_address,
      inet_server_port() AS server_port, current_setting('server_version_num')::integer AS version_num,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser,
      (pg_catalog.pg_control_system()).system_identifier::text AS system_identifier`)
    const row = identity.rows[0]
    if (row?.role !== 'cms_admin' || row?.session_role !== 'cms_admin' || row?.database !== database
      || String(row?.server_address || '').split('/')[0] !== before.backendIPv4
      || Number(row?.server_port) !== 5432 || row?.superuser !== true
      || Math.floor(Number(row?.version_num) / 10000) !== 16
      || String(row?.system_identifier) !== target.systemIdentifier) fail('lease_postgres_target_identity_mismatch')
    const after = inspectTargetBackend(target)
    if (after.containerId !== before.containerId || after.backendIPv4 !== before.backendIPv4) {
      fail('lease_postgres_backend_identity_changed')
    }
    return true
  } finally { await client.end() }
}

async function connectTarget(target, passwords, role, database = DB) {
  await assertTargetPhysicalIdentity(target, passwords, database)
  const before = inspectTargetBackend(target)
  const client = await connect(makeConnectionString(role, passwords[role], database, target.port))
  try {
    const identity = await client.query(`SELECT current_user AS role, session_user AS session_role,
      current_database() AS database, inet_server_addr()::text AS server_address,
      inet_server_port() AS server_port, current_setting('server_version_num')::integer AS version_num`)
    const row = identity.rows[0]
    if (row?.role !== role || row?.session_role !== role || row?.database !== database
      || String(row?.server_address || '').split('/')[0] !== before.backendIPv4
      || Number(row?.server_port) !== 5432 || Math.floor(Number(row?.version_num) / 10000) !== 16) {
      fail('lease_postgres_application_identity_mismatch')
    }
    const after = inspectTargetBackend(target)
    if (after.containerId !== before.containerId || after.backendIPv4 !== before.backendIPv4) {
      fail('lease_postgres_backend_identity_changed')
    }
    return client
  } catch (error) {
    await client.end().catch(() => {})
    throw error
  }
}

function generateUniqueSecret(used = new Set()) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const secret = randomBytes(36).toString('hex')
    if (!used.has(secret)) { used.add(secret); return secret }
  }
  fail('lease_random_secret_uniqueness_unavailable')
}

function generatePasswords() {
  const used = new Set()
  return Object.fromEntries(['cms_admin', 'cms_migrator', 'cms_runtime', 'cms_controller', 'cms_observer',
    'protocol_probe'].map(role => [role, generateUniqueSecret(used)]))
}

function dockerLabels(lease) {
  const labels = { ...observerAuditDockerLabels(observerLeaseFromRaw(lease)),
    [FIXTURE_LABEL]: 'true', 'ownerinc.protocol-finalizer.run-id': lease.runId,
    'ownerinc.protocol-finalizer.scenario': lease.scenario }
  return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`])
}

function dockerVolumeLabels(lease) {
  return { ...observerAuditDockerLabels(observerLeaseFromRaw(lease)),
    [FIXTURE_LABEL]: 'true', 'ownerinc.protocol-finalizer.run-id': lease.runId,
    'ownerinc.protocol-finalizer.scenario': lease.scenario }
}

function assertCreatedVolumeIdentity(lease) {
  const volume = docker(['volume', 'inspect', lease.volumeName], { json: true })[0]
  const labels = volume?.Labels || {}
  const expectedLabels = dockerVolumeLabels(lease)
  if (volume?.Name !== lease.volumeName || Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)) {
    fail('lease_created_volume_identity_mismatch')
  }
  return volume
}

async function createCluster(lease, secretsPath, passwords, report) {
  const volumeLabels = dockerVolumeLabels(lease)
  docker(['volume', 'create', ...Object.entries(volumeLabels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), lease.volumeName])
  report.volumeCreated = true
  assertCreatedVolumeIdentity(lease)
  const envFile = path.join(secretsPath, 'postgres-init.env')
  const passwordFile = path.join(secretsPath, 'postgres-admin-password')
  if (/[\0\r\n,]/u.test(passwordFile)) fail('lease_private_bind_path_unsafe')
  await writePrivateFile(passwordFile, `${passwords.cms_admin}\n`, secretsPath)
  const postgresEnvironment = {
    POSTGRES_USER: 'cms_admin',
    POSTGRES_DB: 'postgres',
    POSTGRES_PASSWORD_FILE: '/run/secrets/cms_admin_password',
  }
  const postgresEnvironmentText = Object.entries(postgresEnvironment)
    .map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
  await writePrivateFile(envFile, postgresEnvironmentText, secretsPath)
  docker(['create', '--name', lease.containerName, ...dockerLabels(lease), '--network', 'bridge',
    '--publish', `${lease.host}:${lease.port}:5432`, '--mount', `type=volume,source=${lease.volumeName},target=/var/lib/postgresql/data`,
    '--mount', `type=bind,source=${passwordFile},target=/run/secrets/cms_admin_password,readonly`,
    '--env-file', envFile, '--memory', '1g', '--cpus', '1.5', '--pids-limit', '256', '--restart', 'no', lease.imageId])
  report.containerCreated = true
  docker(['start', lease.containerName])
  assertCreatedVolumeIdentity(lease)
  const inspected = docker(['inspect', lease.containerName], { json: true })[0]
  const backend = validateObserverDockerContainer(observerLeaseFromRaw(lease), passwordFile, inspected)
  const environment = Array.isArray(inspected?.Config?.Env) ? inspected.Config.Env : []
  if (inspected?.Config?.Labels?.[FIXTURE_LABEL] !== 'true' ||
      inspected?.Config?.Labels?.['ownerinc.protocol-finalizer.run-id'] !== lease.runId ||
      inspected?.Config?.Labels?.['ownerinc.protocol-finalizer.scenario'] !== lease.scenario ||
      !environment.includes('POSTGRES_PASSWORD_FILE=/run/secrets/cms_admin_password') ||
      environment.some(value => value.startsWith('POSTGRES_PASSWORD='))) fail('lease_created_container_identity_mismatch')
  report.containerIdSha256 = sha256(backend.containerId)
  report.backendAddressSha256 = sha256(backend.backendIPv4)
  report.secretBindValidated = matchesDockerBindMountPath(
    inspected?.Mounts?.find(mount => mount?.Destination === '/run/secrets/cms_admin_password')?.Source,
    passwordFile)
  if (!report.secretBindValidated) fail('lease_created_secret_mount_mismatch')
  return { ...backend, passwordFile }
}

async function provisionAndMigrate(lease, passwords, logs) {
  const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DB, lease.port)
  const migratorURL = makeConnectionString('cms_migrator', passwords.cms_migrator, DB, lease.port)
  const base = syntheticEnvironment()
  const secrets = Object.values(passwords)
  let migrationLedgerSha256
  const adminEnv = { ...base, CMS_DATABASE_URL: adminURL, CMS_MIGRATOR_PASSWORD: passwords.cms_migrator,
    CMS_RUNTIME_PASSWORD: passwords.cms_runtime, CMS_CONTROLLER_PASSWORD: passwords.cms_controller }
  const provisionScript = path.join(CMS, 'scripts/provision-db.ts')
  const nodeArgs = ['--import', 'tsx', provisionScript]
  await assertTargetPhysicalIdentity(lease, passwords)
  logs.push(await runCli('provision-native-roles', process.execPath, [...nodeArgs, '--provision'], adminEnv, CMS, secrets))
  await assertTargetPhysicalIdentity(lease, passwords)
  logs.push(await runCli('verify-migrator', process.execPath, [...nodeArgs, '--verify-migrator'],
    { ...base, CMS_DATABASE_URL: migratorURL }, CMS, secrets))

  const uniqueSecrets = new Set(Object.values(passwords))
  const migrationEnv = { ...base, CMS_DATABASE_URL: migratorURL,
    CMS_UPLOAD_DIR: path.join(privateRunDirectory(lease.runId), 'uploads'),
    PAYLOAD_SECRET: generateUniqueSecret(uniqueSecrets), PAYLOAD_TO_PORTAL_SECRET: generateUniqueSecret(uniqueSecrets),
    PORTAL_TO_PAYLOAD_SECRET: generateUniqueSecret(uniqueSecrets),
    PORTAL_PUBLIC_URL: 'http://127.0.0.1:19991', PORTAL_INTERNAL_URL: 'http://127.0.0.1:19992' }
  secrets.push(migrationEnv.PAYLOAD_SECRET, migrationEnv.PAYLOAD_TO_PORTAL_SECRET, migrationEnv.PORTAL_TO_PAYLOAD_SECRET)
  await createPrivateDirectory(migrationEnv.CMS_UPLOAD_DIR)
  await assertTargetPhysicalIdentity(lease, passwords)
  logs.push(await runCli('payload-migrate', process.execPath, ['node_modules/payload/bin.js', 'migrate'], migrationEnv, CMS, secrets))
  const migrator = await connectTarget(lease, passwords, 'cms_migrator')
  try {
    const rows = await migrator.query('SELECT name, batch FROM public.payload_migrations ORDER BY name')
    assert.deepEqual(rows.rows.map(row => row.name), MIGRATIONS, 'actual Payload migration ledger must contain the exact six native migrations')
    assert.equal(rows.rows.length, 6)
    const runRows = await migrator.query('SELECT count(*)::text AS count FROM public.news_migration_runs')
    if (runRows.rows[0]?.count !== '0') fail('native_migrations_seeded_protocol_run')
    const appliedMigrations = rows.rows.map(row => ({ name: row.name, batch: String(row.batch) }))
    migrationLedgerSha256 = sha256(JSON.stringify(canonicalize(appliedMigrations)))
    logs.push({ label: 'migration-ledger-exact-six-and-empty-runs', status: 0,
      migrationCount: rows.rows.length, migrationLedgerSha256, runCount: 0 })
  } finally { await migrator.end() }

  await assertTargetPhysicalIdentity(lease, passwords)
  logs.push(await runCli('bootstrap-control', process.execPath, [...nodeArgs, '--bootstrap-control'], adminEnv, CMS, secrets))
  await assertTargetPhysicalIdentity(lease, passwords)
  logs.push(await runCli('verify-control', process.execPath, [...nodeArgs, '--verify-control'], adminEnv, CMS, secrets))
  return { migrationLedgerSha256 }
}

function protocolSummary(snapshot) {
  return { headRows: snapshot.head.length, headSequence: snapshot.head[0]?.sequence ?? null,
    headChainSha256: snapshot.head[0]?.chain_sha256 ?? null,
    coverageVersion: snapshot.head[0]?.coverage_version ?? null, writeBarrier: snapshot.head[0]?.write_barrier ?? null,
    barrierRunIdPresent: snapshot.head[0]?.barrier_run_id !== null && snapshot.head[0]?.barrier_run_id !== undefined,
    barrierEpoch: snapshot.head[0]?.barrier_epoch ?? null,
    runCount: snapshot.runs.length, runRowsSha256: snapshot.runRowsSha256,
    eventCount: snapshot.events.length, eventRowsSha256: snapshot.eventRowsSha256,
    catalogSha256: snapshot.catalogSha256, migrationCount: snapshot.migrations.length,
    migrationLedgerSha256: snapshot.migrationLedgerSha256 }
}

async function protocolSnapshot(target, passwords) {
  const client = await connectTarget(target, passwords, 'cms_admin')
  try {
    const head = await client.query(`SELECT singleton, sequence::text AS sequence, chain_sha256, coverage_version,
      write_barrier, barrier_run_id::text AS barrier_run_id, barrier_epoch, barrier_receipt_sha256
      FROM public.owner_news_mutation_head WHERE singleton=true`)
    const events = await client.query(`SELECT to_jsonb(e) AS row FROM public.owner_news_mutation_events e ORDER BY e.sequence`)
    const runs = await client.query(`SELECT to_jsonb(r) AS row FROM public.news_migration_runs r ORDER BY r.id`)
    const functions = await client.query(`SELECT p.oid::text AS oid, p.xmin::text AS xmin, p.proname AS name,
      pg_catalog.oidvectortypes(p.proargtypes) AS argument_types,
      pg_catalog.pg_get_function_result(p.oid) AS result_type,
      p.prokind AS kind, p.prosecdef AS security_definer, p.proisstrict AS strict,
      p.proconfig::text AS configuration, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
      p.prosrc AS source,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee_role.rolname END,
        'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid=a.grantee),'[]'::jsonb)::text AS acl
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1::name[]) ORDER BY p.proname,argument_types`, [PROTOCOL_FUNCTION_NAMES])
    const triggers = await client.query(`SELECT t.oid::text AS oid, t.xmin::text AS xmin, c.relname AS table_name,
      t.tgname AS name, t.tgenabled AS enabled, t.tgisinternal AS internal,
      pg_catalog.pg_get_triggerdef(t.oid,false) AS definition, p.proname AS function_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS function_arguments
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname='public' AND t.tgname LIKE 'owner_news_%' ORDER BY t.tgname,c.relname`)
    const protocolRelations = await client.query(`SELECT c.oid::text AS oid, c.xmin::text AS xmin, c.relname AS name,
      c.relkind AS kind, pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('owner_news_mutation_head','owner_news_mutation_events','news_migration_runs')
      ORDER BY c.relname`)
    const columnAcls = await client.query(`SELECT c.relname AS table_name, a.attnum::text AS ordinal,
      a.attname AS column_name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS not_null, pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression,
      a.attidentity AS identity_kind, a.attgenerated AS generated_kind,
      a.attcollation::regcollation::text AS collation, a.attstorage AS storage,
      a.attcompression AS compression, a.attinhcount::text AS inheritance_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE grantee_role.rolname END,
        'privilege',acl.privilege_type,'grantable',acl.is_grantable) ORDER BY acl.grantee,acl.privilege_type)
        FROM pg_catalog.aclexplode(a.attacl) acl LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid=acl.grantee),
        '[]'::jsonb)::text AS acl FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='news_migration_runs' AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY a.attnum`)
    const migrations = await client.query('SELECT name,batch::text AS batch FROM public.payload_migrations ORDER BY name COLLATE "C"')
    const catalog = { functions: functions.rows.map(({ source, ...row }) => ({ ...row,
      source_sha256: sha256(String(source || '')) })), triggers: triggers.rows,
      relations: protocolRelations.rows, columnAcls: columnAcls.rows }
    const signatures = functions.rows.map(row => `${row.name}(${String(row.argument_types || '').replaceAll(' ', '')})`).sort()
    const snapshot = { head: head.rows, events: events.rows, runs: runs.rows, catalog,
      signatures, migrations: migrations.rows,
      runRowsSha256: sha256(JSON.stringify(canonicalize(runs.rows))),
      eventRowsSha256: sha256(JSON.stringify(canonicalize(events.rows))),
      catalogSha256: sha256(JSON.stringify(canonicalize(catalog))),
      migrationLedgerSha256: sha256(JSON.stringify(canonicalize(migrations.rows))) }
    snapshot.summary = protocolSummary(snapshot)
    return snapshot
  } finally { await client.end() }
}

const V1_SIGNATURES = [
  'owner_news_migration_item_binding_guard()', 'owner_news_mutation_capture_row()',
  'owner_news_mutation_guard_stmt()', 'owner_news_seal_run(uuid,text,integer,bigint,text,text,text)',
].sort()
const V2_SIGNATURES = [...V1_SIGNATURES, 'owner_news_bootstrap_run(uuid,text,text,text,integer)'].sort()

function assertProtocolVersion(snapshot, expectedVersion) {
  const expected = expectedVersion === 1 ? V1_SIGNATURES : V2_SIGNATURES
  if (JSON.stringify(snapshot.signatures) !== JSON.stringify(expected)) fail('protocol_catalog_inventory_mismatch')
  if (expectedVersion === 2) {
    const bootstrap = snapshot.catalog.functions.find(row => row.name === 'owner_news_bootstrap_run')
    const acl = bootstrap ? JSON.parse(bootstrap.acl || '[]') : []
    const allowedExecute = new Set(['cms_control', 'cms_controller'])
    if (!bootstrap || bootstrap.argument_types.replaceAll(' ', '') !== 'uuid,text,text,text,integer'
      || bootstrap.result_type !== 'TABLE(id uuid)' || bootstrap.kind !== 'f'
      || bootstrap.security_definer !== true || bootstrap.strict !== false || bootstrap.owner !== 'cms_control'
      || !String(bootstrap.configuration || '').includes('search_path=pg_catalog, public')
      || acl.some(grant => grant.privilege === 'EXECUTE' && !allowedExecute.has(grant.grantee))
      || !acl.some(grant => grant.grantee === 'cms_controller' && grant.privilege === 'EXECUTE' && grant.grantable === false)
      || !acl.some(grant => grant.grantee === 'cms_control' && grant.privilege === 'EXECUTE')) {
      fail('protocol_bootstrap_catalog_contract_mismatch')
    }
  }
  return true
}

export function assertNoBootstrapRunInsertPrivileges(grantState) {
  if (!grantState || grantState.tableInsert !== false
    || !Array.isArray(grantState.effectiveColumnInsert) || grantState.effectiveColumnInsert.length !== 0
    || !Array.isArray(grantState.explicitColumnInsert) || grantState.explicitColumnInsert.length !== 0) {
    fail('cms_control_bootstrap_insert_privileges_persisted')
  }
  return true
}

export function assertDirectRunInsertDenialEvidence({ sqlstate, rollbackSucceeded, before, after }) {
  if (rollbackSucceeded !== true || !before || !after
    || JSON.stringify(canonicalize(before)) !== JSON.stringify(canonicalize(after))) {
    fail('direct_run_insert_denial_changed_protocol_state')
  }
  if (sqlstate !== '42501') fail('direct_run_insert_not_denied_by_privilege')
  return true
}

export function hasSingleBootstrapGrantAbortMarker(marker) {
  let value
  try { value = BigInt(marker?.value) } catch { return false }
  return marker?.is_called === true && value === 1n
}

function summarizeBootstrapInsertGrantState(grantState) {
  return { tableInsert: grantState.tableInsert,
    effectiveColumnCount: grantState.effectiveColumnInsert.length,
    explicitColumnCount: grantState.explicitColumnInsert.length }
}

async function inspectBootstrapInsertGrantState(target, passwords) {
  const client = await connectTarget(target, passwords, 'cms_admin')
  try {
    const result = await client.query(`SELECT
      pg_catalog.has_table_privilege('cms_control','public.news_migration_runs','INSERT') AS table_insert,
      ARRAY(SELECT a.attname::text
        FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid='public.news_migration_runs'::pg_catalog.regclass::pg_catalog.oid
          AND a.attnum>0 AND NOT a.attisdropped
          AND pg_catalog.has_column_privilege('cms_control',a.attrelid,a.attnum::integer,'INSERT')
        ORDER BY a.attnum) AS effective_column_insert,
      ARRAY(SELECT DISTINCT a.attname::text
        FROM pg_catalog.pg_attribute AS a
        CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
        WHERE a.attrelid='public.news_migration_runs'::pg_catalog.regclass::pg_catalog.oid
          AND a.attnum>0 AND NOT a.attisdropped
          AND acl.grantee='cms_control'::pg_catalog.regrole::pg_catalog.oid
          AND acl.privilege_type='INSERT'
        ORDER BY 1) AS explicit_column_insert`)
    const row = result.rows[0]
    return { tableInsert: row?.table_insert,
      effectiveColumnInsert: row?.effective_column_insert,
      explicitColumnInsert: row?.explicit_column_insert }
  } finally { await client.end() }
}

async function protocolIsAbsent(target, passwords) {
  const client = await connectTarget(target, passwords, 'cms_admin')
  try {
    const result = await client.query(`SELECT
      to_regclass('public.owner_news_mutation_head') IS NULL AS no_head,
      to_regclass('public.owner_news_mutation_events') IS NULL AS no_events,
      (SELECT count(*)=0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN ('owner_news_mutation_guard_stmt','owner_news_mutation_capture_row',
          'owner_news_seal_run','owner_news_migration_item_binding_guard','owner_news_bootstrap_run')) AS no_functions,
      (SELECT count(*)=0 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND t.tgname IN ('owner_news_mutation_guard_stmt','owner_news_mutation_capture_row',
          'owner_news_migration_item_binding_guard','owner_news_migration_run_binding_guard')) AS no_triggers`)
    return Object.values(result.rows[0] || {}).every(value => value === true)
  } finally { await client.end() }
}

async function proveInstallRollback(lease, passwords, adminURL, logs) {
  const rollbackEvidence = createAtomicRollbackEvidenceRecord()
  logs.push(rollbackEvidence)
  const functionName = `owner_news_finalizer_fixture_${lease.suffix}`
  const captureFunction = `owner_news_finalizer_ddl_capture_${lease.suffix}`
  const captureSequence = `owner_news_finalizer_ddl_seen_${lease.suffix}_seq`
  const eventTrigger = `owner_news_finalizer_ddl_observer_${lease.suffix}`
  const client = await connectTarget(lease, passwords, 'cms_admin')
  try {
    await client.query(`CREATE FUNCTION public.${functionName}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`)
    const acl = await client.query(`SELECT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [functionName])
    if (acl.rows[0]?.public_execute !== true) fail('atomic_fixture_not_public_executable')
    await client.query(`CREATE SEQUENCE public.${captureSequence}`)
    await client.query(`CREATE FUNCTION public.${captureFunction}() RETURNS event_trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger_ddl_commands() ddl
          WHERE ddl.command_tag='CREATE TABLE' AND ddl.classid='pg_class'::regclass
            AND ddl.objid=pg_catalog.to_regclass('public.owner_news_mutation_head')::oid) THEN
          PERFORM pg_catalog.nextval('public.${captureSequence}'::regclass);
        END IF;
      END;
      $fixture$`)
    await client.query(`REVOKE ALL ON FUNCTION public.${captureFunction}() FROM PUBLIC, cms_runtime, cms_controller, cms_control`)
    await client.query(`CREATE EVENT TRIGGER ${eventTrigger} ON ddl_command_end EXECUTE FUNCTION public.${captureFunction}()`)
    const markerBefore = await client.query(`SELECT last_value::text AS value, is_called FROM public.${captureSequence}`)
    if (markerBefore.rows[0]?.is_called !== false) fail('atomic_ddl_observer_initial_state_invalid')
  } finally { await client.end() }

  const nativeBefore = await captureNativeState(adminURL, lease, passwords)
  recordAtomicRollbackSnapshot(rollbackEvidence, 'before', nativeBefore)
  const runTableEvidence = nativeBefore.tableRows.find(table => table.tableName === 'news_migration_runs')
  if (!runTableEvidence || runTableEvidence.rowCount !== '0') fail('native_rollback_fixture_run_table_not_empty')

  const env = syntheticEnvironment({ CMS_ADMIN_DATABASE_URL: adminURL })
  await assertTargetPhysicalIdentity(lease, passwords)
  await runCli('expected-finalizer-rejection-for-public-fixture', process.execPath,
    ['--import', 'tsx', path.join(CMS, 'scripts/finalize-news-protocol.ts'), '--finalize-protocol'], env, CMS,
    [adminURL], 1, outcome => recordFinalizerCliEvidence(rollbackEvidence, outcome))
  // The finalizer must reject the PUBLIC-executable rogue function and roll
  // back all protocol DDL. The event trigger advances a nontransactional
  // sequence only when the protocol-head CREATE TABLE command is reached,
  // proving the failed finalizer transaction entered its DDL section.
  if (!rollbackEvidence.finalizerCli) fail('atomic_fixture_cli_outcome_unavailable')
  const observer = await connectTarget(lease, passwords, 'cms_admin')
  let markerAfter
  try {
    const marker = await observer.query(`SELECT last_value::text AS value, is_called FROM public.${captureSequence}`)
    markerAfter = marker.rows[0]
  } finally { await observer.end() }
  recordAtomicRollbackCheck(rollbackEvidence, 'protocolCreateTableObserved', markerAfter?.is_called === true)
  rollbackEvidence.nonTransactionalMarkerAdvanced = markerAfter?.is_called === true
  const protocolAbsent = await protocolIsAbsent(lease, passwords)
  recordAtomicRollbackCheck(rollbackEvidence, 'persistedProtocolObjects', !protocolAbsent)
  const nativeAfter = await captureNativeState(adminURL, lease, passwords)
  recordAtomicRollbackSnapshot(rollbackEvidence, 'after', nativeAfter)
  const nativeStateUnchanged = compareNativeStateEvidence(nativeBefore, nativeAfter)
  recordAtomicRollbackComparison(rollbackEvidence, nativeStateUnchanged)

  if (!rollbackEvidence.expectedPublicFunctionRejection) fail('atomic_fixture_expected_public_function_rejection_not_observed')
  if (rollbackEvidence.protocolCreateTableObserved !== true) fail('atomic_fixture_did_not_observe_protocol_ddl')
  if (rollbackEvidence.persistedProtocolObjects !== false) fail('finalizer_installation_rollback_incomplete')
  if (rollbackEvidence.nativeStateUnchanged !== true) fail('native_state_changed_by_finalizer_rollback')

  const cleanup = await connectTarget(lease, passwords, 'cms_admin')
  try {
    await cleanup.query(`DROP EVENT TRIGGER ${eventTrigger}`)
    await cleanup.query(`DROP FUNCTION public.${captureFunction}()`)
    await cleanup.query(`DROP SEQUENCE public.${captureSequence}`)
    await cleanup.query(`DROP FUNCTION public.${functionName}()`)
  }
  finally { await cleanup.end() }
}

function lastJsonLine(output, code) {
  const lines = String(output || '').trim().split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]) } catch { /* The CLI may emit fixed progress lines before JSON. */ }
  }
  fail(code)
}

async function runFinalizerCli(label, target, passwords, command, installedExpected, logs) {
  await assertTargetPhysicalIdentity(target, passwords)
  const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DB, target.port)
  const result = await runCli(label, process.execPath,
    ['--import', 'tsx', path.join(CMS, 'scripts/finalize-news-protocol.ts'), command],
    syntheticEnvironment({ CMS_ADMIN_DATABASE_URL: adminURL }), CMS, [passwords.cms_admin])
  const response = lastJsonLine(result[PRIVATE_CLI_OUTPUT], 'finalizer_success_output_invalid')
  if (response.installed !== installedExpected || response.ready !== false || response.coverageVersion !== 0) {
    fail('finalizer_disabled_readiness_contract_mismatch')
  }
  logs.push({ label, status: 0, result: { installed: response.installed, ready: false, coverageVersion: 0 } })
  return response
}

async function expectFinalizerFailure(label, target, passwords, command, expectedReason) {
  await assertTargetPhysicalIdentity(target, passwords)
  const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DB, target.port)
  let evidence
  await runCli(label, process.execPath,
    ['--import', 'tsx', path.join(CMS, 'scripts/finalize-news-protocol.ts'), command],
    syntheticEnvironment({ CMS_ADMIN_DATABASE_URL: adminURL }), CMS, [passwords.cms_admin], 1,
    outcome => { evidence = {}; recordFinalizerCliEvidence(evidence, outcome) })
  if (evidence?.finalizerCli?.diagnostic?.reason !== expectedReason) fail('finalizer_expected_diagnostic_not_observed')
  return evidence.finalizerCli
}

async function installCanonicalV1Fixture(target, passwords, logs) {
  const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DB, target.port)
  const installer = `
    import { Client } from 'pg'
    import { NEWS_MUTATION_LEDGER_DDL } from './src/publication/mutation-ledger.ts'
    import { buildNewsMutationTriggersDDL } from './src/publication/mutation-triggers.ts'
    import { NEWS_MIGRATION_ITEM_BINDING_DDL } from './scripts/finalize-news-protocol.ts'
    import { grantsSQL } from './scripts/provision-db.ts'
    const client = new Client({ connectionString: process.env.CMS_ADMIN_DATABASE_URL, connectionTimeoutMillis: 5000 })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL search_path = pg_catalog, public')
      await client.query('SELECT pg_catalog.pg_advisory_xact_lock(7194030)')
      await client.query(NEWS_MUTATION_LEDGER_DDL)
      await client.query(buildNewsMutationTriggersDDL())
      await client.query(NEWS_MIGRATION_ITEM_BINDING_DDL)
      await client.query(grantsSQL)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { await client.end() }
  `
  await assertTargetPhysicalIdentity(target, passwords)
  await runCli('install-exact-canonical-v1-fixture', process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', installer],
    syntheticEnvironment({ CMS_ADMIN_DATABASE_URL: adminURL }), CMS, [passwords.cms_admin])
  const snapshot = await protocolSnapshot(target, passwords)
  assertProtocolVersion(snapshot, 1)
  if (snapshot.head.length !== 1 || snapshot.head[0].coverage_version !== 0
    || snapshot.head[0].sequence !== '0' || snapshot.head[0].write_barrier !== 'open'
    || snapshot.runs.length !== 0 || snapshot.events.length !== 0) fail('canonical_v1_fixture_not_pristine')
  logs.push({ label: 'exact-canonical-v1-installed-without-run-seed', status: 0,
    functionCount: snapshot.signatures.length, runCount: 0, eventCount: 0 })
  return snapshot
}

async function provisionObserverAndProbeRoles(target, passwords, logs) {
  const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DB, target.port)
  const provision = `
    import { Client } from 'pg'
    import { buildNewsProtocolObserverProvisioningSQL } from './scripts/news-protocol-observer-contract.ts'
    const client = new Client({ connectionString: process.env.CMS_ADMIN_DATABASE_URL, connectionTimeoutMillis: 5000 })
    await client.connect()
    try {
      const observerPassword = process.env.CMS_OBSERVER_PASSWORD
      const probePassword = process.env.PROTOCOL_PROBE_PASSWORD
      if (!/^[a-f0-9]{72}$/.test(observerPassword || '') || !/^[a-f0-9]{72}$/.test(probePassword || '')) {
        throw new Error('fixture_role_secret_invalid')
      }
      await client.query(buildNewsProtocolObserverProvisioningSQL(observerPassword))
      await client.query("CREATE ROLE protocol_probe LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '" + probePassword + "'")
      await client.query('GRANT CONNECT ON DATABASE ownerinc_cms TO protocol_probe')
      await client.query('GRANT USAGE ON SCHEMA public TO protocol_probe')
    } finally { await client.end() }
  `
  await assertTargetPhysicalIdentity(target, passwords)
  await runCli('provision-read-only-observer-and-unrelated-probe', process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', provision],
    syntheticEnvironment({ CMS_ADMIN_DATABASE_URL: adminURL, CMS_OBSERVER_PASSWORD: passwords.cms_observer,
      PROTOCOL_PROBE_PASSWORD: passwords.protocol_probe }), CMS, [passwords.cms_admin, passwords.cms_observer,
      passwords.protocol_probe])
  logs.push({ label: 'observer-and-unrelated-role-created', status: 0 })
}

async function runObserverAudit(target, passwords, expectedVersion, logs) {
  const before = await protocolSnapshot(target, passwords)
  if (before.runs.length !== 0 || before.events.length !== 0 || before.head[0]?.sequence !== '0') {
    fail('observer_prebootstrap_fixture_not_empty')
  }
  const observerURL = makeConnectionString('cms_observer', passwords.cms_observer, DB, target.port)
  await assertTargetPhysicalIdentity(target, passwords)
  const result = await runCli(`observer-read-only-v${expectedVersion}`, process.execPath,
    ['--import', 'tsx', path.join(CMS, 'scripts/verify-news-protocol.ts'), '--audit-protocol'],
    syntheticEnvironment({ CMS_OBSERVER_DATABASE_URL: observerURL }), CMS, [passwords.cms_observer])
  const audit = lastJsonLine(result[PRIVATE_CLI_OUTPUT], 'observer_audit_output_invalid')
  if (audit?.status !== 'PASS' || audit?.installed !== true || audit?.catalogValid !== true
    || audit?.observedProtocolVersion !== expectedVersion || audit?.observedCoverageVersion !== 0
    || audit?.headSequence !== '0' || audit?.writeBarrier !== 'open' || audit?.ready !== false
    || audit?.admissionActivated !== false || audit?.releaseCertified !== false
    || audit?.writeCoverageCertified !== false || audit?.drainVerified !== false) {
    fail('observer_read_only_version_contract_mismatch')
  }
  const after = await protocolSnapshot(target, passwords)
  if (JSON.stringify(canonicalize(before)) !== JSON.stringify(canonicalize(after))) {
    fail('observer_audit_changed_fixture_state')
  }
  logs.push({ label: `observer-read-only-v${expectedVersion}-before-bootstrap`, status: 0,
    protocolVersion: expectedVersion, observedCoverageVersion: 0, ready: false, stateUnchanged: true })
  return { observedProtocolVersion: expectedVersion, observedCoverageVersion: 0 }
}

async function proveV1UpgradeRollback(target, passwords, adminURL, logs) {
  const evidence = { label: 'atomic-v1-upgrade-rollback', status: null, finalizerCli: null,
    markerAdvanced: false, bootstrapFunctionAbsent: null, exactV1CatalogRestored: null,
    nativeStateCompared: false, nativeStateUnchanged: null, nativeBefore: null, nativeAfter: null,
    protocolBefore: null, protocolAfter: null, controlInsertPrivilegesBefore: null,
    allBootstrapInsertGrantsObservedBeforeAbort: false, controlInsertPrivilegesAfter: null,
    controlInsertPrivilegesAbsentAfterRollback: null, coverageVersionUnchanged: null }
  logs.push(evidence)
  const captureFunction = `owner_news_v2_ddl_capture_${target.suffix}`
  const captureSequence = `owner_news_v2_ddl_seen_${target.suffix}_seq`
  const eventTrigger = `owner_news_v2_ddl_observer_${target.suffix}`
  const insertColumnList = BOOTSTRAP_RUN_INSERT_COLUMNS.map(column => `'${column}'`).join(',')
  const client = await connectTarget(target, passwords, 'cms_admin')
  try {
    await client.query(`CREATE SEQUENCE public.${captureSequence}`)
    await client.query(`CREATE FUNCTION public.${captureFunction}() RETURNS event_trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        -- PostgreSQL 16 fires ddl_command_end for GRANT after catalog changes.
        -- The marker advances only once the exact RPC is owned by cms_control
        -- and every narrow INSERT column ACL is visible; nextval is not rolled
        -- back when the following fixed exception aborts the upgrade transaction.
        IF TG_TAG='GRANT'
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
            WHERE p.oid=pg_catalog.to_regprocedure('public.owner_news_bootstrap_run(uuid,text,text,text,integer)')::pg_catalog.oid
              AND p.proowner='cms_control'::pg_catalog.regrole::pg_catalog.oid)
          AND (SELECT pg_catalog.count(DISTINCT a.attname)
            FROM pg_catalog.pg_attribute a
            CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
            WHERE a.attrelid='public.news_migration_runs'::pg_catalog.regclass::pg_catalog.oid
              AND a.attname=ANY(ARRAY[${insertColumnList}]::pg_catalog.name[])
              AND acl.grantee='cms_control'::pg_catalog.regrole::pg_catalog.oid
              AND acl.privilege_type='INSERT' AND acl.is_grantable IS FALSE)
            = ${BOOTSTRAP_RUN_INSERT_COLUMNS.length} THEN
          PERFORM pg_catalog.nextval('public.${captureSequence}'::regclass);
          RAISE EXCEPTION 'protocol_v2_upgrade_fixture_abort' USING ERRCODE='P0001';
        END IF;
      END;
      $fixture$`)
    await client.query(`REVOKE ALL ON FUNCTION public.${captureFunction}() FROM PUBLIC, cms_runtime, cms_controller, cms_control`)
    await client.query(`CREATE EVENT TRIGGER ${eventTrigger} ON ddl_command_end EXECUTE FUNCTION public.${captureFunction}()`)
    const marker = await client.query(`SELECT is_called FROM public.${captureSequence}`)
    if (marker.rows[0]?.is_called !== false) fail('v1_upgrade_marker_initial_state_invalid')
  } finally { await client.end() }

  const v1Before = await protocolSnapshot(target, passwords)
  assertProtocolVersion(v1Before, 1)
  const grantsBefore = await inspectBootstrapInsertGrantState(target, passwords)
  assertNoBootstrapRunInsertPrivileges(grantsBefore)
  evidence.controlInsertPrivilegesBefore = summarizeBootstrapInsertGrantState(grantsBefore)
  evidence.protocolBefore = v1Before.summary
  const nativeBefore = await captureNativeState(adminURL, target, passwords)
  recordAtomicRollbackSnapshot(evidence, 'before', nativeBefore)

  await assertTargetPhysicalIdentity(target, passwords)
  await runCli('expected-v1-upgrade-event-trigger-rollback', process.execPath,
    ['--import', 'tsx', path.join(CMS, 'scripts/finalize-news-protocol.ts'), '--upgrade-protocol-v1-to-v2'],
    syntheticEnvironment({ CMS_ADMIN_DATABASE_URL: adminURL }), CMS, [passwords.cms_admin], 1,
    outcome => recordFinalizerCliEvidence(evidence, outcome))

  const observed = await connectTarget(target, passwords, 'cms_admin')
  let markerAfter
  try {
    const marker = await observed.query(`SELECT last_value::text AS value, is_called FROM public.${captureSequence}`)
    markerAfter = marker.rows[0]
  } finally { await observed.end() }
  evidence.markerAdvanced = hasSingleBootstrapGrantAbortMarker(markerAfter)
  evidence.allBootstrapInsertGrantsObservedBeforeAbort = evidence.markerAdvanced
  const v1After = await protocolSnapshot(target, passwords)
  evidence.protocolAfter = v1After.summary
  assertProtocolVersion(v1After, 1)
  evidence.bootstrapFunctionAbsent = !v1After.signatures.includes('owner_news_bootstrap_run(uuid,text,text,text,integer)')
  evidence.exactV1CatalogRestored = v1After.catalogSha256 === v1Before.catalogSha256
    && JSON.stringify(canonicalize(v1After.head)) === JSON.stringify(canonicalize(v1Before.head))
    && v1After.runRowsSha256 === v1Before.runRowsSha256 && v1After.eventRowsSha256 === v1Before.eventRowsSha256
    && v1After.migrationLedgerSha256 === v1Before.migrationLedgerSha256
  const nativeAfter = await captureNativeState(adminURL, target, passwords)
  recordAtomicRollbackSnapshot(evidence, 'after', nativeAfter)
  evidence.nativeStateCompared = true
  evidence.nativeStateUnchanged = compareNativeStateEvidence(nativeBefore, nativeAfter)
  const grantsAfter = await inspectBootstrapInsertGrantState(target, passwords)
  evidence.controlInsertPrivilegesAfter = summarizeBootstrapInsertGrantState(grantsAfter)
  evidence.controlInsertPrivilegesAbsentAfterRollback = assertNoBootstrapRunInsertPrivileges(grantsAfter)
  evidence.coverageVersionUnchanged = v1Before.head[0]?.coverage_version === v1After.head[0]?.coverage_version
    && v1Before.head[0]?.coverage_version === 0
  const diagnostic = evidence.finalizerCli?.diagnostic
  if (diagnostic?.reason !== 'database_error' || diagnostic?.sqlstate !== 'P0001'
    || evidence.markerAdvanced !== true || evidence.allBootstrapInsertGrantsObservedBeforeAbort !== true
    || evidence.bootstrapFunctionAbsent !== true || evidence.controlInsertPrivilegesAbsentAfterRollback !== true
    || evidence.exactV1CatalogRestored !== true || evidence.coverageVersionUnchanged !== true
    || evidence.nativeStateUnchanged !== true) {
    fail('v1_upgrade_rollback_evidence_incomplete')
  }

  const cleanup = await connectTarget(target, passwords, 'cms_admin')
  try {
    await cleanup.query(`DROP EVENT TRIGGER ${eventTrigger}`)
    await cleanup.query(`DROP FUNCTION public.${captureFunction}()`)
    await cleanup.query(`DROP SEQUENCE public.${captureSequence}`)
  } finally { await cleanup.end() }
  return { v1Before, v1After }
}

async function assertNoFinalizerMutation(target, passwords, command, label, logs) {
  const before = await protocolSnapshot(target, passwords)
  const nativeBefore = await captureNativeState(makeConnectionString('cms_admin', passwords.cms_admin, DB, target.port),
    target, passwords, { ignoreProtocolOverlay: true })
  await runFinalizerCli(label, target, passwords, command, false, logs)
  const after = await protocolSnapshot(target, passwords)
  const nativeAfter = await captureNativeState(makeConnectionString('cms_admin', passwords.cms_admin, DB, target.port),
    target, passwords, { ignoreProtocolOverlay: true })
  assertProtocolVersion(after, 2)
  if (JSON.stringify(canonicalize(before)) !== JSON.stringify(canonicalize(after))
    || !compareNativeStateEvidence(nativeBefore, nativeAfter)) fail('v2_finalizer_retry_changed_state')
  logs.push({ label: `${label}-snapshot-comparison`, status: 0, protocolVersion: 2,
    protocolBefore: before.summary, protocolAfter: after.summary,
    nativeBefore: compactNativeEvidence(nativeBefore), nativeAfter: compactNativeEvidence(nativeAfter),
    noDdlOrStateChange: true })
  return after
}

function assertUpgradeDelta(v1, v2) {
  assertProtocolVersion(v1, 1)
  assertProtocolVersion(v2, 2)
  const oldFunctionNames = new Set(V1_SIGNATURES.map(signature => signature.slice(0, signature.indexOf('('))))
  const v1Functions = v1.catalog.functions.filter(row => oldFunctionNames.has(row.name))
  const v2Functions = v2.catalog.functions.filter(row => oldFunctionNames.has(row.name))
  const v1Columns = new Map(v1.catalog.columnAcls.map(row => [row.column_name, row]))
  const v2Columns = new Map(v2.catalog.columnAcls.map(row => [row.column_name, row]))
  const insertedColumns = new Set(BOOTSTRAP_RUN_INSERT_COLUMNS)
  let exactColumnGrantDelta = v1Columns.size === v2Columns.size
  for (const [column, before] of v1Columns) {
    const after = v2Columns.get(column)
    if (!after) { exactColumnGrantDelta = false; break }
    const { acl: beforeAcl, ...beforeShape } = before
    const { acl: afterAcl, ...afterShape } = after
    if (JSON.stringify(canonicalize(beforeShape)) !== JSON.stringify(canonicalize(afterShape))) {
      exactColumnGrantDelta = false
      break
    }
    const expected = JSON.parse(beforeAcl || '[]')
    if (insertedColumns.has(column)) expected.push({ grantee: 'cms_control', privilege: 'INSERT', grantable: false })
    const sortAcl = entries => entries.sort((left, right) =>
      `${left.grantee}/${left.privilege}/${left.grantable}`.localeCompare(`${right.grantee}/${right.privilege}/${right.grantable}`))
    if (JSON.stringify(canonicalize(sortAcl(expected))) !== JSON.stringify(canonicalize(sortAcl(JSON.parse(afterAcl || '[]'))))) {
      exactColumnGrantDelta = false
      break
    }
  }
  if (JSON.stringify(canonicalize(v1Functions)) !== JSON.stringify(canonicalize(v2Functions))
    || JSON.stringify(canonicalize(v1.catalog.triggers)) !== JSON.stringify(canonicalize(v2.catalog.triggers))
    || JSON.stringify(canonicalize(v1.catalog.relations)) !== JSON.stringify(canonicalize(v2.catalog.relations))
    || JSON.stringify(canonicalize(v1.head)) !== JSON.stringify(canonicalize(v2.head))
    || v1.runRowsSha256 !== v2.runRowsSha256 || v1.eventRowsSha256 !== v2.eventRowsSha256
    || v1.migrationLedgerSha256 !== v2.migrationLedgerSha256 || !exactColumnGrantDelta) {
    fail('v1_to_v2_upgrade_delta_not_narrow')
  }
  return true
}

async function runBootstrapRpc(client, input) {
  const result = await client.query(`SELECT id::text AS id FROM public.owner_news_bootstrap_run(
    $1::uuid,$2::text,$3::text,$4::text,$5::integer)`, [input.runId, input.manifest, input.source,
    input.fingerprint, input.epoch])
  return result.rows
}

async function expectRpcFailure(target, passwords, role, input, sqlstate, code = null) {
  const client = await connectTarget(target, passwords, role)
  try {
    await assert.rejects(runBootstrapRpc(client, input), error => error?.code === sqlstate
      && (code === null || String(error?.message).includes(code)))
  } finally { await client.end() }
}

function rowFromProtocolSnapshot(snapshot, runId) {
  return snapshot.runs.map(item => item.row).find(row => row.id === runId)
}

async function proveRunTableInsertDenied(target, passwords, role, values) {
  const before = await protocolSnapshot(target, passwords)
  const writer = await connectTarget(target, passwords, role)
  let statementError
  let rollbackFailed = false
  try {
    await writer.query('BEGIN')
    try {
      await writer.query(`INSERT INTO public.news_migration_runs
        (${BOOTSTRAP_RUN_INSERT_COLUMNS.join(',')})
        VALUES ($1::uuid,$2::text,$3::text,$4::text,$5::integer,
          'preparing','open','acknowledged','[]'::jsonb)`, values)
    } catch (error) { statementError = error }
    try { await writer.query('ROLLBACK') } catch { rollbackFailed = true }
  } finally { await writer.end() }
  const after = await protocolSnapshot(target, passwords)
  const unchanged = JSON.stringify(canonicalize(before)) === JSON.stringify(canonicalize(after))
  assertDirectRunInsertDenialEvidence({ sqlstate: statementError?.code ?? null,
    rollbackSucceeded: !rollbackFailed, before: before.summary, after: after.summary })
  return { before: before.summary, after: after.summary, unchanged, deniedByPrivilege: true, rolledBack: true }
}

async function proveBootstrapRpc(target, passwords, logs) {
  const before = await protocolSnapshot(target, passwords)
  assertProtocolVersion(before, 2)
  const input = { runId: randomUUID(), manifest: 'c'.repeat(64), source: `protocol-finalizer-${target.scenario}`,
    fingerprint: 'd'.repeat(64), epoch: target.scenario === 'fresh-v2' ? 1 : 7 }
  const controller = await connectTarget(target, passwords, 'cms_controller')
  try {
    const auth = await controller.query('SELECT current_user AS role, session_user AS session_role')
    if (auth.rows[0]?.role !== 'cms_controller' || auth.rows[0]?.session_role !== 'cms_controller') {
      fail('controller_network_session_identity_mismatch')
    }
    const created = await runBootstrapRpc(controller, input)
    if (created.length !== 1 || created[0].id !== input.runId) fail('bootstrap_rpc_return_identity_mismatch')
  } finally { await controller.end() }
  const afterCreate = await protocolSnapshot(target, passwords)
  const createdRun = rowFromProtocolSnapshot(afterCreate, input.runId)
  const newEvents = afterCreate.events.map(item => item.row).filter(row =>
    row.table_name === 'news_migration_runs' && row.operation === 'INSERT' && row.row_key === input.runId)
  if (afterCreate.runs.length !== before.runs.length + 1 || afterCreate.events.length !== before.events.length + 1
    || newEvents.length !== 1 || afterCreate.head[0]?.sequence !== String(Number(before.head[0]?.sequence) + 1)
    || afterCreate.head[0]?.coverage_version !== 0 || afterCreate.head[0]?.write_barrier !== 'open'
    || !createdRun || createdRun.manifest_sha256 !== input.manifest || createdRun.source_instance !== input.source
    || createdRun.source_fingerprint !== input.fingerprint || Number(createdRun.authority_epoch) !== input.epoch
    || createdRun.progress_state !== 'preparing' || createdRun.admission_state !== 'open'
    || createdRun.commit_outcome !== 'acknowledged'
    || JSON.stringify(createdRun.unresolved_exceptions) !== '[]'
    || createdRun.reconciliation_sequence !== null || createdRun.sealed_at !== null || createdRun.activation_epoch !== null) {
    fail('bootstrap_rpc_initial_state_or_trigger_event_mismatch')
  }

  const retryBefore = await protocolSnapshot(target, passwords)
  const retryClient = await connectTarget(target, passwords, 'cms_controller')
  try {
    const retried = await runBootstrapRpc(retryClient, input)
    if (retried.length !== 1 || retried[0].id !== input.runId) fail('bootstrap_rpc_retry_identity_mismatch')
  } finally { await retryClient.end() }
  const retryAfter = await protocolSnapshot(target, passwords)
  const exactRetryNoDml = JSON.stringify(canonicalize(retryBefore)) === JSON.stringify(canonicalize(retryAfter))
  if (!exactRetryNoDml) fail('bootstrap_rpc_exact_retry_performed_dml')

  const invalid = { ...input, runId: randomUUID() }
  const invalidBefore = await protocolSnapshot(target, passwords)
  await expectRpcFailure(target, passwords, 'cms_controller', { ...invalid, runId: null }, '22023', 'owner_news_bootstrap_invalid_identity')
  const invalidAfter = await protocolSnapshot(target, passwords)
  if (JSON.stringify(canonicalize(invalidBefore)) !== JSON.stringify(canonicalize(invalidAfter))) {
    fail('bootstrap_rpc_null_input_changed_state')
  }

  for (const collision of [
    { ...input, manifest: 'e'.repeat(64) },
    { ...input, runId: randomUUID() },
    { ...input, fingerprint: 'f'.repeat(64) },
    { ...input, source: `${input.source}-drift` },
    { ...input, epoch: input.epoch + 1 },
  ]) {
    const collisionBefore = await protocolSnapshot(target, passwords)
    await expectRpcFailure(target, passwords, 'cms_controller', collision, '40001', 'owner_news_bootstrap_identity_conflict')
    const collisionAfter = await protocolSnapshot(target, passwords)
    if (JSON.stringify(canonicalize(collisionBefore)) !== JSON.stringify(canonicalize(collisionAfter))) {
      fail('bootstrap_rpc_collision_changed_state')
    }
  }

  const denied = {}
  for (const role of ['cms_runtime', 'cms_observer', 'protocol_probe']) {
    await expectRpcFailure(target, passwords, role, { ...input, runId: randomUUID(), manifest: randomBytes(32).toString('hex') },
      '42501')
    denied[role] = true
  }
  const validDirectInsertValues = [randomUUID(), randomBytes(32).toString('hex'),
    'protocol-direct-insert-probe', randomBytes(32).toString('hex'), 1]
  const directInsertEvidence = {}
  for (const role of ['cms_controller', 'cms_runtime']) {
    const comparison = await proveRunTableInsertDenied(target, passwords, role, validDirectInsertValues)
    directInsertEvidence[role] = comparison
    denied[`${role}-direct-run-insert`] = true
    logs.push({ label: `${role}-valid-shape-direct-run-insert-denied`, status: 0,
      sqlstate: '42501', transactionRolledBack: true, stateUnchanged: comparison.unchanged,
      before: comparison.before, after: comparison.after })
  }
  for (const [label, sql, values] of [
    ['head-update', 'UPDATE public.owner_news_mutation_head SET sequence=sequence WHERE singleton=true', []],
    ['event-insert', `INSERT INTO public.owner_news_mutation_events
      (sequence,table_name,operation,row_key,transaction_id,previous_sha256,event_sha256)
      VALUES (999,'news_migration_runs','INSERT','denied','0',$1,$1)`, ['0'.repeat(64)]],
  ]) {
    const writer = await connectTarget(target, passwords, 'cms_controller')
    try { await assert.rejects(writer.query(sql, values), error => error?.code === '42501') }
    finally { await writer.end() }
    denied[label] = true
  }
  const afterDenied = await protocolSnapshot(target, passwords)
  if (JSON.stringify(canonicalize(retryAfter)) !== JSON.stringify(canonicalize(afterDenied))) {
    fail('bootstrap_rpc_denial_changed_state')
  }

  const lockOrdering = await proveBootstrapLockOrdering(target, passwords)
  logs.push({ label: 'controller-rpc-contract', status: 0, createdCount: 1, generatedEventCount: 1,
    exactRetryNoDml, collisionAndInvalidInputsNoDml: true, deniedRolesAndDirectWrites: denied,
    validShapeDirectInsertEvidence: directInsertEvidence,
    lockOrdering, before: before.summary, afterCreate: afterCreate.summary,
    retryBefore: retryBefore.summary, retryAfter: retryAfter.summary,
    denialSnapshot: afterDenied.summary })
  return { inputSha256: sha256(JSON.stringify({ manifest: input.manifest, source: input.source,
    fingerprint: input.fingerprint, epoch: input.epoch })), exactRetryNoDml, after: retryAfter.summary }
}

async function waitForAdvisoryWait(admin, pid) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const state = await admin.query(`SELECT wait_event_type,state FROM pg_catalog.pg_stat_activity WHERE pid=$1`, [pid])
    if (state.rows[0]?.wait_event_type === 'Lock' && state.rows[0]?.state === 'active') return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

async function proveBootstrapLockOrdering(target, passwords) {
  const input = { runId: randomUUID(), manifest: randomBytes(32).toString('hex'),
    source: `protocol-lock-${target.scenario}`, fingerprint: randomBytes(32).toString('hex'), epoch: 2 }
  const holder = await connectTarget(target, passwords, 'cms_admin')
  const controller = await connectTarget(target, passwords, 'cms_controller')
  let rowLocker
  let pid
  let pending
  let holderOpen = false
  let rowLockerOpen = false
  let acquiredBeforeRelease = false
  try {
    await holder.query('BEGIN')
    holderOpen = true
    await holder.query('SELECT pg_catalog.pg_advisory_xact_lock(7194030)')
    await controller.query("SET application_name='owner_news_protocol_v2_lock_order_probe'")
    const backendPid = await controller.query('SELECT pg_backend_pid() AS pid')
    pid = Number(backendPid.rows[0]?.pid)
    pending = controller.query(`SELECT id::text AS id FROM public.owner_news_bootstrap_run(
      $1::uuid,$2::text,$3::text,$4::text,$5::integer)`, [input.runId, input.manifest, input.source, input.fingerprint, input.epoch])
      .then(value => ({ ok: true, value }), error => ({ ok: false, error }))
    if (!await waitForAdvisoryWait(holder, pid)) fail('bootstrap_rpc_advisory_wait_not_observed')

    rowLocker = await connectTarget(target, passwords, 'cms_admin')
    await rowLocker.query('BEGIN')
    rowLockerOpen = true
    try {
      await rowLocker.query('SELECT singleton FROM public.owner_news_mutation_head WHERE singleton=true FOR UPDATE NOWAIT')
      acquiredBeforeRelease = true
      await rowLocker.query('COMMIT')
      rowLockerOpen = false
    } catch (error) {
      await rowLocker.query('ROLLBACK').catch(() => {})
      rowLockerOpen = false
      if (error?.code === '55P03') fail('bootstrap_rpc_locked_head_before_advisory')
      throw error
    }
    if (!acquiredBeforeRelease) fail('bootstrap_rpc_lock_order_not_proven')
    await holder.query('COMMIT')
    holderOpen = false
    const outcome = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve({ ok: false, timeout: true }), 8000))])
    if (!outcome?.ok || outcome.value.rows?.length !== 1 || outcome.value.rows[0]?.id !== input.runId) {
      fail('bootstrap_rpc_did_not_complete_after_advisory_release')
    }
    return { advisoryWaitObserved: true, headNowaitAcquiredBeforeRelease: true, rpcCompletedAfterRelease: true }
  } catch (error) {
    if (pid) await holder.query('SELECT pg_catalog.pg_cancel_backend($1)', [pid]).catch(() => {})
    if (pending) await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 1000))])
    throw error
  } finally {
    if (rowLockerOpen) await rowLocker?.query('ROLLBACK').catch(() => {})
    if (holderOpen) await holder.query('ROLLBACK').catch(() => {})
    await rowLocker?.end().catch(() => {})
    await controller.end().catch(() => {})
    await holder.end().catch(() => {})
  }
}

async function closeBarrierForRetry(target, passwords, input) {
  const admin = await connectTarget(target, passwords, 'cms_admin')
  try {
    await admin.query('BEGIN')
    await admin.query('SET LOCAL ROLE cms_control')
    await admin.query(`UPDATE public.owner_news_mutation_head SET write_barrier='frozen',
      barrier_run_id=$1::uuid, barrier_epoch=$2, barrier_receipt_sha256=$3 WHERE singleton=true`,
    [input.runId, input.epoch, '9'.repeat(64)])
    await admin.query('COMMIT')
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => {})
    throw error
  } finally { await admin.end() }
}

async function proveClosedBarrierRetry(target, passwords, logs) {
  const input = { runId: randomUUID(), manifest: randomBytes(32).toString('hex'),
    source: `protocol-closed-barrier-${target.scenario}`, fingerprint: randomBytes(32).toString('hex'), epoch: 9 }
  const controller = await connectTarget(target, passwords, 'cms_controller')
  try {
    const result = await runBootstrapRpc(controller, input)
    if (result.length !== 1 || result[0].id !== input.runId) fail('closed_barrier_seed_rpc_invalid')
  } finally { await controller.end() }
  await closeBarrierForRetry(target, passwords, input)
  const closed = await protocolSnapshot(target, passwords)
  if (closed.head[0]?.write_barrier !== 'frozen') fail('closed_barrier_fixture_not_committed')
  await expectRpcFailure(target, passwords, 'cms_controller', input, '55000', 'owner_news_bootstrap_barrier_closed')
  const after = await protocolSnapshot(target, passwords)
  if (JSON.stringify(canonicalize(closed)) !== JSON.stringify(canonicalize(after))) {
    fail('closed_barrier_retry_performed_dml')
  }
  logs.push({ label: 'closed-barrier-exact-retry-denied-without-dml', status: 0,
    barrierRemainsClosed: true, runCount: after.runs.length, eventCount: after.events.length })
}

export function parseHarnessArguments(args) {
  if (!Array.isArray(args)) return null
  if (args.length === 3 && args[0] === '--prepare-lease' && args[1] === '--scenario' && SCENARIOS.has(args[2])) {
    return { mode: 'prepare', scenario: args[2] }
  }
  if (args.length === 5 && args[0] === '--execute' && args[1] === '--scenario' && SCENARIOS.has(args[2])
    && args[3] === '--lease' && typeof args[4] === 'string' && args[4].length > 0) {
    return { mode: 'execute', scenario: args[2], leasePath: args[4] }
  }
  return null
}

export function assertLeaseScenario(rawLease, expectedScenario) {
  const lease = validateLease(rawLease)
  if (!SCENARIOS.has(expectedScenario) || lease.scenario !== expectedScenario) fail('lease_scenario_mismatch')
  return lease
}

export async function verifyFinalizerClusterAndCreateDatabase(target, createdCluster, passwords, options = {}) {
  // createCluster returns the inspected Docker identity plus its private mount
  // path. The shared observer probe intentionally accepts only its exact
  // two-field backend identity, so map only values produced by that validator.
  const inspectedBackend = {
    containerId: createdCluster?.containerId,
    backendIPv4: createdCluster?.backendIPv4,
  }
  const identity = await verifyPostgresAndCreateOwnerCmsDatabase(observerLeaseFromRaw(target), inspectedBackend,
    passwords, createdCluster?.passwordFile, options)
  const verifiedBackend = identity.verifiedBackend
  const boundTarget = Object.freeze({ ...target,
    containerId: verifiedBackend.containerId,
    backendIPv4: verifiedBackend.backendIPv4,
    systemIdentifier: verifiedBackend.systemIdentifier,
    passwordFile: createdCluster.passwordFile,
    verifiedBackendIdentity: verifiedBackend })
  return Object.freeze({ ...identity, boundTarget })
}

async function execute(rawLease, leasePath, expectedScenario) {
  const lease = assertLeaseScenario(rawLease, expectedScenario)
  const evidenceDir = privateRunDirectory(lease.runId)
  await inspectApprovedSharedParent()
  await inspectPrivatePath(evidenceDir, 'directory')
  const reread = JSON.parse(await readPrivateFile(leasePath, evidenceDir))
  if (JSON.stringify(leaseDocument(validateLease(reread))) !== JSON.stringify(leaseDocument(lease))) fail('lease_changed_after_initial_read')
  const report = { status: 'running', schemaVersion: LEASE_SCHEMA_VERSION, scenario: lease.scenario,
    runId: lease.runId, databaseCreated: false, containerCreated: false, volumeCreated: false,
    serverMajorVersion: 16, coverageVersion: 0, ready: false, stages: [] }
  let passwords
  let stage = 'guarded-preflight'
  return runClaimedAttempt(rawLease, evidenceDir, report, () => stage, async () => {
    const target = inspectPreflight(rawLease)
    await assertPortAvailable(target.host, target.port)
    await inspectPrivatePath(evidenceDir, 'directory')
    const lastLeaseRead = JSON.parse(await readPrivateFile(leasePath, evidenceDir))
    if (JSON.stringify(leaseDocument(validateLease(lastLeaseRead))) !== JSON.stringify(leaseDocument(lease))) fail('lease_changed_before_execution')
    passwords = generatePasswords()
    await writePrivateFile(path.join(evidenceDir, 'secrets.json'), `${JSON.stringify(passwords)}\n`, evidenceDir)
    report.stages.push({ name: 'guarded-local-preflight', result: 'pass' })
    stage = 'create-new-volume-and-container'
    const inspectedBackend = await createCluster(target, evidenceDir, passwords, report)
    stage = 'verify-new-cluster-system-identity-before-application-ddl'
    const identity = await verifyFinalizerClusterAndCreateDatabase(target, inspectedBackend, passwords,
      { stageResult: async (_name, operation) => operation(),
        inspectContainer: (observerLease, passwordFile) => validateObserverDockerContainer(observerLease,
          passwordFile, docker(['inspect', observerLease.containerName], { json: true })[0]) })
    const boundTarget = identity.boundTarget
    report.systemIdentifierSha256 = sha256(identity.verifiedBackend.systemIdentifier)
    report.databaseCreated = true
    report.stages.push({ name: 'new-postgres16-immutable-system-identity', result: 'pass',
      verifiedContainerId: true, verifiedBackendAddress: true, verifiedSystemIdentifier: true })

    const logs = report.stages
    stage = 'provision-migrate-and-bootstrap-control'
    const migrationEvidence = await provisionAndMigrate(boundTarget, passwords, logs)
    report.migrationCount = MIGRATIONS.length
    report.migrationLedgerSha256 = migrationEvidence.migrationLedgerSha256
    const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DB, boundTarget.port)

    if (boundTarget.scenario === 'fresh-v2') {
      stage = 'preserve-existing-atomic-install-rollback-regression'
      await proveInstallRollback(boundTarget, passwords, adminURL, logs)
      report.atomicInstallRollback = { preserved: true, initiallyEmptyRunTable: true, protocolObjectsRolledBack: true }
      if (!await protocolIsAbsent(boundTarget, passwords)) fail('atomic_install_rollback_left_protocol_objects')

      const nativeBefore = await captureNativeState(adminURL, boundTarget, passwords, { ignoreProtocolOverlay: true })
      stage = 'cold-install-protocol-v2'
      await runFinalizerCli('cold-finalizer-install-v2', boundTarget, passwords, '--finalize-protocol', true, logs)
      const installed = await protocolSnapshot(boundTarget, passwords)
      assertProtocolVersion(installed, 2)
      if (installed.head.length !== 1 || installed.head[0].coverage_version !== 0
        || installed.head[0].sequence !== '0' || installed.head[0].write_barrier !== 'open'
        || installed.head[0].barrier_run_id !== null || installed.head[0].barrier_epoch !== null
        || installed.head[0].barrier_receipt_sha256 !== null || installed.events.length !== 0 || installed.runs.length !== 0) {
        fail('cold_v2_install_not_pristine')
      }
      const nativeAfter = await captureNativeState(adminURL, boundTarget, passwords, { ignoreProtocolOverlay: true })
      const nativeUnchanged = compareNativeStateEvidence(nativeBefore, nativeAfter)
      if (!nativeUnchanged) fail('cold_v2_install_changed_native_schema_or_data')
      report.coldInstall = { exactV2: true, nativeMigrationStateUnchanged: true,
        protocolSnapshot: installed.summary, nativeBefore: compactNativeEvidence(nativeBefore),
        nativeAfter: compactNativeEvidence(nativeAfter), readinessDisabled: true }

      stage = 'provision-observer-and-negative-role-fixtures'
      await provisionObserverAndProbeRoles(boundTarget, passwords, logs)
      stage = 'observer-v2-read-only-before-bootstrap'
      const audit = await runObserverAudit(boundTarget, passwords, 2, logs)
      stage = 'cold-v2-finalizer-no-ddl-reentry'
      await assertNoFinalizerMutation(boundTarget, passwords, '--finalize-protocol', 'cold-v2-finalizer-idempotent-reentry', logs)
      stage = 'controller-bootstrap-rpc-contract'
      const rpc = await proveBootstrapRpc(boundTarget, passwords, logs)
      report.observer = audit
      report.bootstrap = { createdOneRunAndTriggerEvent: true, exactRetryNoDml: rpc.exactRetryNoDml,
        inputIdentitySha256: rpc.inputSha256, snapshot: rpc.after }
      stage = 'closed-barrier-retry-denial'
      await proveClosedBarrierRetry(boundTarget, passwords, logs)
      const closedState = await protocolSnapshot(boundTarget, passwords)
      report.closedBarrier = { exactRetryDeniedWithoutDml: true,
        writeBarrier: closedState.head[0]?.write_barrier, remainsClosed: true,
        snapshot: closedState.summary }
    } else {
      stage = 'install-exact-v1-using-canonical-builders'
      await installCanonicalV1Fixture(boundTarget, passwords, logs)
      stage = 'provision-observer-and-negative-role-fixtures'
      await provisionObserverAndProbeRoles(boundTarget, passwords, logs)
      stage = 'observer-v1-read-only-before-bootstrap'
      report.observerV1 = await runObserverAudit(boundTarget, passwords, 1, logs)

      stage = 'ordinary-finalizer-must-reject-v1-without-ddl'
      const v1BeforeReject = await protocolSnapshot(boundTarget, passwords)
      const nativeBeforeReject = await captureNativeState(adminURL, boundTarget, passwords)
      const rejection = await expectFinalizerFailure('ordinary-finalizer-v1-upgrade-required', boundTarget, passwords,
        '--finalize-protocol', 'protocol_upgrade_required')
      const v1AfterReject = await protocolSnapshot(boundTarget, passwords)
      const nativeAfterReject = await captureNativeState(adminURL, boundTarget, passwords)
      assertProtocolVersion(v1AfterReject, 1)
      if (JSON.stringify(canonicalize(v1BeforeReject)) !== JSON.stringify(canonicalize(v1AfterReject))
        || !compareNativeStateEvidence(nativeBeforeReject, nativeAfterReject)) fail('v1_ordinary_finalizer_changed_state')
      logs.push({ label: 'ordinary-v1-finalizer-rejected-without-ddl', status: 0,
        reason: rejection.diagnostic.reason, stateUnchanged: true,
        before: v1BeforeReject.summary, after: v1AfterReject.summary,
        nativeBefore: compactNativeEvidence(nativeBeforeReject), nativeAfter: compactNativeEvidence(nativeAfterReject) })

      stage = 'atomic-v1-upgrade-rollback-fixture'
      const rollback = await proveV1UpgradeRollback(boundTarget, passwords, adminURL, logs)
      stage = 'v1-upgrade-success-path'
      const cleanV1 = rollback.v1After
      const nativeBeforeUpgrade = await captureNativeState(adminURL, boundTarget, passwords, { ignoreProtocolOverlay: true })
      await runFinalizerCli('explicit-v1-to-v2-upgrade', boundTarget, passwords,
        '--upgrade-protocol-v1-to-v2', false, logs)
      const upgraded = await protocolSnapshot(boundTarget, passwords)
      assertUpgradeDelta(cleanV1, upgraded)
      const nativeAfterUpgrade = await captureNativeState(adminURL, boundTarget, passwords, { ignoreProtocolOverlay: true })
      if (!compareNativeStateEvidence(nativeBeforeUpgrade, nativeAfterUpgrade)) {
        fail('v1_to_v2_upgrade_changed_native_schema_or_data')
      }
      report.upgrade = { exactV1ToV2: true, previousV1FunctionsAndTriggersUnchanged: true,
        nativeMigrationStateUnchanged: true, v1Before: cleanV1.summary,
        v2After: upgraded.summary, nativeBefore: compactNativeEvidence(nativeBeforeUpgrade),
        nativeAfter: compactNativeEvidence(nativeAfterUpgrade) }

      stage = 'observer-v2-read-only-before-bootstrap'
      report.observerV2 = await runObserverAudit(boundTarget, passwords, 2, logs)
      stage = 'v2-explicit-upgrade-idempotent-no-ddl'
      await assertNoFinalizerMutation(boundTarget, passwords, '--upgrade-protocol-v1-to-v2',
        'v2-explicit-upgrade-idempotent-reentry', logs)
      stage = 'ordinary-v2-finalizer-idempotent-no-ddl'
      await assertNoFinalizerMutation(boundTarget, passwords, '--finalize-protocol',
        'v2-ordinary-finalizer-idempotent-reentry', logs)

      stage = 'controller-bootstrap-rpc-contract'
      const rpc = await proveBootstrapRpc(boundTarget, passwords, logs)
      report.bootstrap = { createdOneRunAndTriggerEvent: true, exactRetryNoDml: rpc.exactRetryNoDml,
        inputIdentitySha256: rpc.inputSha256, snapshot: rpc.after }

      stage = 'closed-barrier-retry-denial'
      await proveClosedBarrierRetry(boundTarget, passwords, logs)
      const closedState = await protocolSnapshot(boundTarget, passwords)
      report.closedBarrier = { exactRetryDeniedWithoutDml: true,
        writeBarrier: closedState.head[0]?.write_barrier, remainsClosed: true,
        snapshot: closedState.summary }
    }

    report.protocol = { protocolVersion: 2,
      coverageVersion: 0, ready: false, admissionActivated: false,
      migrationCount: MIGRATIONS.length, stages: logs.length }
    report.status = 'pass'
    return report
  })
}

async function main() {
  const command = parseHarnessArguments(process.argv.slice(2))
  if (!command) {
    console.error('Usage: node tests/integration/protocol-finalizer.mjs --prepare-lease --scenario <fresh-v2|upgrade-v1> | --execute --scenario <fresh-v2|upgrade-v1> --lease <private-lease.json>')
    process.exitCode = 2
    return
  }
  if (command.mode === 'prepare') {
    await prepareLease(command.scenario)
    return
  }
  const requestedLeasePath = path.resolve(command.leasePath)
  const root = privateBase()
  const requestedDirectory = path.dirname(requestedLeasePath)
  const prefix = process.platform === 'win32' ? `.${PROJECT_PREFIX}-` : `${PROJECT_PREFIX}-`
  const runId = path.basename(requestedDirectory).startsWith(prefix) ? path.basename(requestedDirectory).slice(prefix.length) : ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)) fail('lease_file_outside_private_state')
  const leasePath = validatePrivateLeaseLocation(requestedLeasePath, runId, root)
  await inspectApprovedSharedParent()
  await inspectPrivatePath(requestedDirectory, 'directory')
  const rawLease = JSON.parse(await readPrivateFile(leasePath, requestedDirectory))
  const validated = assertLeaseScenario(rawLease, command.scenario)
  if (validated.runId !== runId) fail('lease_path_run_id_mismatch')
  const report = await execute(rawLease, leasePath, command.scenario)
  console.log(`protocol-finalizer: ${report.status} scenario=${report.scenario} run=${report.runId}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`protocol-finalizer: ${error?.code || 'harness_failed'}`)
    process.exitCode = 1
  })
}
