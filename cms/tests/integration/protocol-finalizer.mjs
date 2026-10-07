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

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CMS = path.join(ROOT, 'cms')
const CONTEXT_NAME = 'desktop-linux'
const CONTEXT_ENDPOINT = 'npipe:////./pipe/dockerDesktopLinuxEngine'
const PROJECT_LABEL = 'ownerinc-payload-local'
const FIXTURE_LABEL = 'ownerinc.protocol-finalizer.fixture'
const DB = 'ownerinc_cms'
const LEASE_SCHEMA_VERSION = 1
const LEASE_KEYS = ['schemaVersion', 'project', 'dockerContext', 'dockerEndpoint', 'runId', 'containerName',
  'volumeName', 'host', 'port', 'imageRef', 'imageId'].sort()
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
const { Client } = createRequire(path.join(CMS, 'package.json'))('pg')
const fail = code => { const error = new Error(code); error.code = code; throw error }

function suffixFromRunId(runId) { return runId.replaceAll('-', '').slice(0, 12) }

// Raw persisted leases have an exact schema. The returned object is an internal
// normalized view with derived fields and must never be sent back through this
// raw-input validator; callers that cross the authorization boundary retain
// and pass the original raw object.
export function validateLease(rawLease) {
  const lease = rawLease
  if (!lease || Object.getPrototypeOf(lease) !== Object.prototype ||
      JSON.stringify(Object.keys(lease).sort()) !== JSON.stringify(LEASE_KEYS) ||
      lease.schemaVersion !== LEASE_SCHEMA_VERSION || lease.project !== PROJECT_LABEL || lease.dockerContext !== CONTEXT_NAME ||
      lease.dockerEndpoint !== CONTEXT_ENDPOINT || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(lease.runId || '')) {
    fail('lease_identity_invalid')
  }
  const suffix = suffixFromRunId(lease.runId)
  if (lease.containerName !== `ownerinc-payload-finalizer-${suffix}` ||
      lease.volumeName !== `ownerinc-payload-finalizer-pgdata-${suffix}` ||
      lease.host !== '127.0.0.1' || !Number.isInteger(lease.port) || lease.port < 1024 || lease.port > 65535 ||
      [55441, 19091, 19092, 9299].includes(lease.port) ||
      typeof lease.imageRef !== 'string' || !/^postgres:16(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?$/u.test(lease.imageRef) ||
      typeof lease.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(lease.imageId)) fail('lease_resource_contract_invalid')
  return { schemaVersion: LEASE_SCHEMA_VERSION, project: lease.project, dockerContext: lease.dockerContext,
    dockerEndpoint: lease.dockerEndpoint, runId: lease.runId, containerName: lease.containerName,
    volumeName: lease.volumeName, host: lease.host, port: lease.port, imageRef: lease.imageRef,
    imageId: lease.imageId, suffix, database: DB, containerPort: 5432, fixtureLabel: FIXTURE_LABEL }
}

// This boundary always accepts the strict persisted/raw shape and returns its
// internal normalized view only after the live Docker observations pass.
export function authorizeDockerPreflight(rawLease, observation) {
  const lease = validateLease(rawLease)
  if (observation?.contextName !== CONTEXT_NAME || observation?.contextEndpoint !== CONTEXT_ENDPOINT ||
      observation?.dockerHostOverride || observation?.dockerContextOverride) fail('lease_docker_context_mismatch')
  if (observation?.containerExists || observation?.volumeExists) fail('lease_resource_collision_refused')
  if (observation?.imageId !== lease.imageId || observation?.imageRefAvailable !== true) fail('lease_postgres16_image_not_cached')
  if (observation?.portAvailable !== undefined && observation.portAvailable !== true) fail('lease_loopback_port_unavailable')
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
  const result = spawnSync('docker', scopedArgs, { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
  if (result.error || result.signal || result.status !== 0) fail('lease_docker_inspection_or_operation_failed')
  if (!json) return result.stdout.trim()
  try { return JSON.parse(result.stdout) } catch { fail('lease_docker_output_invalid') }
}

function dockerOptional(args) {
  const result = spawnSync('docker', ['--context', CONTEXT_NAME, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 })
  if (result.error || result.signal) fail('lease_docker_inspection_failed')
  if (result.status !== 0) return null
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
  // Authorization consumes the unmodified persisted shape, not the normalized
  // view with derived fields returned by validateLease.
  return authorizeDockerPreflight(rawLease, {
    contextName,
    contextEndpoint: context?.Endpoints?.docker?.Host,
    dockerHostOverride: process.env.DOCKER_HOST,
    dockerContextOverride: process.env.DOCKER_CONTEXT,
    containerExists: Boolean(container),
    volumeExists: Boolean(volume),
    imageId: image?.[0]?.Id,
    imageRefAvailable: Array.isArray(image?.[0]?.RepoTags) && image[0].RepoTags.includes(lease.imageRef),
    portAvailable: undefined,
  })
}

async function prepareLease() {
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) fail('lease_docker_environment_override_refused')
  const contextName = docker(['context', 'show'])
  const context = docker(['context', 'inspect', CONTEXT_NAME], { json: true })[0]
  if (contextName !== CONTEXT_NAME || context?.Endpoints?.docker?.Host !== CONTEXT_ENDPOINT) fail('lease_docker_context_mismatch')
  const imageRows = docker(['image', 'ls', '--no-trunc', '--format', '{{json .}}', 'postgres'])
    .split(/\r?\n/u).filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const imageChoice = imageRows.find(row => row.Repository === 'postgres' && /^16(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?$/u.test(row.Tag || ''))
  if (!imageChoice) fail('lease_no_cached_postgres16_image_no_pull_performed')
  const imageRef = `postgres:${imageChoice.Tag}`
  const inspectedImage = docker(['image', 'inspect', imageRef], { json: true })[0]
  const imageId = inspectedImage?.Id
  if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(imageId)) fail('lease_cached_image_identity_invalid')

  const base = privateBase()
  await assertNoReparseAncestors(base)
  const runId = randomUUID()
  const suffix = suffixFromRunId(runId)
  const lease = validateLease({ schemaVersion: LEASE_SCHEMA_VERSION, project: PROJECT_LABEL, dockerContext: CONTEXT_NAME, dockerEndpoint: CONTEXT_ENDPOINT,
    runId, containerName: `ownerinc-payload-finalizer-${suffix}`,
    volumeName: `ownerinc-payload-finalizer-pgdata-${suffix}`, host: '127.0.0.1',
    port: await reserveCandidateLoopbackPort(), imageRef, imageId })
  if (dockerOptional(['inspect', lease.containerName]) || dockerOptional(['volume', 'inspect', lease.volumeName])) fail('lease_resource_collision_refused')
  await assertPortAvailable(lease.host, lease.port)
  const runDirectory = privateRunDirectory(lease.runId)
  await createPrivateDirectory(runDirectory)
  const leasePath = path.join(runDirectory, 'lease.json')
  await writePrivateFile(leasePath, `${JSON.stringify(leaseDocument(lease), null, 2)}\n`, runDirectory)
  console.log(JSON.stringify({ status: 'lease-plan-ready-not-executed', leasePath, ...leaseDocument(lease) }))
}

async function assertPortAvailable(host, port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', () => { server.close(); reject(new Error('lease_loopback_port_unavailable')) })
    server.listen(port, host, () => server.close(error => error ? reject(error) : resolve()))
  }).catch(() => fail('lease_loopback_port_unavailable'))
}

function privateBase() {
  if (process.platform === 'win32') return getVerifiedWindowsProfilePath()
  if (!process.env.LOCALAPPDATA) fail('lease_private_state_unavailable')
  return path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode')
}

function privateRunDirectory(runId) {
  const prefix = process.platform === 'win32' ? '.ownerinc-payload-finalizer-' : 'ownerinc-payload-finalizer-'
  return path.join(privateBase(), `${prefix}${runId}`)
}

export function validatePrivateLeaseLocation(leasePath, runId, profileRoot) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId || '') ||
      typeof leasePath !== 'string' || typeof profileRoot !== 'string') fail('lease_file_outside_private_state')
  const pathApi = process.platform === 'win32' ? path.win32 : path
  const prefix = process.platform === 'win32' ? '.ownerinc-payload-finalizer-' : 'ownerinc-payload-finalizer-'
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

const WINDOWS_PROFILE_DISCOVERY = String.raw`$ErrorActionPreference='Stop'
$wi=[Security.Principal.WindowsIdentity]::GetCurrent(); $sid=$wi.User.Value
if($sid -notmatch '^S-1-[0-9-]+$'){throw 'identity'}
$key='Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$sid
$registered=(Get-ItemProperty -LiteralPath $key -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
$registered=[string]$registered
if(-not $registered -or $registered.Contains('%')){throw 'profile'}
$known=[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if(-not $known -or -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($known).TrimEnd('\'),[IO.Path]::GetFullPath($registered).TrimEnd('\'))){throw 'profile'}
[pscustomobject]@{currentUserSid=$sid;profilePath=[IO.Path]::GetFullPath($known);registeredProfilePath=[IO.Path]::GetFullPath($registered)} | ConvertTo-Json -Compress`

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

function getVerifiedWindowsProfilePath() {
  return getVerifiedWindowsProfileIdentity().profilePath
}

function getVerifiedWindowsProfileIdentity() {
  const output = runPowerShellReadOnly(WINDOWS_PROFILE_DISCOVERY)
  let identity
  try { identity = JSON.parse(output) } catch { fail('private_windows_profile_discovery_invalid') }
  validateWindowsProfileIdentity(identity)
  return identity
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
  await assertNoReparseAncestors(parent)
  if (process.platform === 'win32') {
    const identity = getVerifiedWindowsProfileIdentity()
    if (normalizedWindowsPath(parent) !== normalizedWindowsPath(identity.profilePath)) fail('private_windows_profile_path_changed')
    const output = runPowerShellReadOnly(WINDOWS_ANCESTOR_ACL_INSPECT, parent)
    let snapshot
    try { snapshot = JSON.parse(output) } catch { fail('private_windows_ancestor_acl_output_invalid') }
    if (snapshot?.currentUserSid !== identity.currentUserSid) fail('private_windows_token_identity_changed')
    validateWindowsAncestorChain({ ...identity, ancestors: snapshot.ancestors })
  } else {
    const info = await lstat(parent)
    if (typeof process.getuid !== 'function' || info.uid !== process.getuid() || !info.isDirectory() ||
        (info.mode & 0o022) !== 0) fail('private_parent_owner_or_permissions_invalid')
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
    report.failure = { stage: getStage(), code: error?.code || 'protocol_finalizer_harness_failed',
      stageResult: error?.stageResult }
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
  'protocol-binding-ddl', 'protocol-grants', 'verify-installed', 'transaction-commit',
  'transaction-rollback',
])
const FINALIZER_DIAGNOSTIC_REASONS = new Set([
  'admin_database_url_required', 'unsafe_admin_database_url', 'unsafe_admin_target',
  'native_migration_ledger_mismatch', 'native_relation_inventory_mismatch', 'mutation_relation_inventory_mismatch',
  'native_column_inventory_mismatch', 'native_serial_sequence_binding_or_configuration_mismatch',
  'native_enum_catalog_mismatch', 'native_required_constraint_missing', 'native_snapshot_index_missing_or_mismatched',
  'native_snapshot_foreign_key_mismatch', 'native_control_column_types_mismatch', 'native_item_run_id_type_mismatch',
  'control_role_contract_mismatch', 'partial_protocol_installation_manual_recovery_required',
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
    error.stageResult = { label, status, signal: result.signal || null, timeout: result.error?.code === 'ETIMEDOUT', output: output.slice(-12000) }
    throw error
  }
  return { label, status, output }
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

async function snapshotNativeState(client) {
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
      c.reloptions::text AS options, c.relacl::text AS acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [tableNames])
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
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,t.tgname`, [tableNames])
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
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,identity_arguments`)
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

async function captureNativeState(adminURL) {
  const client = await connect(adminURL)
  try { return await snapshotNativeState(client) }
  finally { await client.end() }
}

async function waitForPostgres(connectionString, lease) {
  const deadline = Date.now() + 90000
  let lastError
  while (Date.now() < deadline) {
    let client
    try {
      client = await connect(connectionString)
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 750))
      continue
    }
    let identity
    try {
      identity = await client.query(`SELECT current_user AS role, current_database() AS database,
        inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
        (pg_control_system()).system_identifier::text AS system_identifier,
        current_setting('server_version_num')::integer AS version_num,
        (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)
    } catch (error) { lastError = error }
    finally { await client.end().catch(() => {}) }
    if (!identity) { await new Promise(resolve => setTimeout(resolve, 750)); continue }
    const row = identity.rows[0]
    lease.systemIdentifier = assertBackendIdentity(lease, row)
    if (row?.role !== 'cms_admin' || row?.database !== 'postgres' || Math.floor(Number(row?.version_num) / 10000) !== 16 || row?.superuser !== true) {
      fail('lease_postgres_bootstrap_identity_mismatch')
    }
    return
  }
  const error = new Error('lease_postgres_readiness_timeout')
  error.code = 'lease_postgres_readiness_timeout'
  error.cause = lastError
  throw error
}

async function createOwnerCmsDatabase(lease, password) {
  const client = await connect(makeConnectionString('cms_admin', password, 'postgres', lease.port))
  try {
    const identity = await client.query(`SELECT current_user AS role, current_database() AS database,
      inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
      (pg_control_system()).system_identifier::text AS system_identifier,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)
    assertBackendIdentity(lease, identity.rows[0], lease.systemIdentifier)
    if (identity.rows[0]?.role !== 'cms_admin' || identity.rows[0]?.database !== 'postgres' || identity.rows[0]?.superuser !== true) {
      fail('lease_postgres_admin_identity_changed_before_ddl')
    }
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [DB])
    if (existing.rowCount !== 0) fail('lease_target_database_collision_refused')
    await client.query(`CREATE DATABASE ${DB} OWNER cms_admin TEMPLATE template0`)
  } finally { await client.end() }
}

function generatePasswords() {
  return Object.fromEntries(['cms_admin', 'cms_migrator', 'cms_runtime', 'cms_controller'].map(role => [role, randomBytes(36).toString('hex')]))
}

function dockerLabels(lease) {
  return [
    '--label', `com.docker.compose.project=${PROJECT_LABEL}`,
    '--label', 'com.docker.compose.service=protocol-finalizer-fixture',
    '--label', `${FIXTURE_LABEL}=true`,
    '--label', `ownerinc.protocol-finalizer.run-id=${lease.runId}`,
  ]
}

async function createCluster(lease, secretsPath, passwords, report) {
  docker(['volume', 'create', '--label', `${FIXTURE_LABEL}=true`, '--label', `ownerinc.protocol-finalizer.run-id=${lease.runId}`, lease.volumeName])
  report.volumeCreated = true
  const volume = docker(['volume', 'inspect', lease.volumeName], { json: true })[0]
  if (volume?.Name !== lease.volumeName || volume?.Labels?.[FIXTURE_LABEL] !== 'true' ||
      volume?.Labels?.['ownerinc.protocol-finalizer.run-id'] !== lease.runId) fail('lease_created_volume_identity_mismatch')
  const envFile = path.join(secretsPath, 'postgres.env')
  const postgresEnvironment = {
    POSTGRES_USER: 'cms_admin',
    POSTGRES_DB: 'postgres',
    POSTGRES_PASSWORD: passwords.cms_admin,
  }
  const postgresEnvironmentText = Object.entries(postgresEnvironment)
    .map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
  await writePrivateFile(envFile, postgresEnvironmentText, secretsPath)
  docker(['create', '--name', lease.containerName, ...dockerLabels(lease),
    '--publish', `127.0.0.1:${lease.port}:5432`, '--mount', `type=volume,source=${lease.volumeName},target=/var/lib/postgresql/data`,
    '--env-file', envFile, lease.imageId])
  report.containerCreated = true
  docker(['start', lease.containerName])
  const inspected = docker(['inspect', lease.containerName], { json: true })[0]
  const labels = inspected?.Config?.Labels || {}
  const addressEntries = Object.entries(inspected?.NetworkSettings?.Networks || {})
  const ips = [...new Set(addressEntries.map(([, entry]) => entry?.IPAddress).filter(value => typeof value === 'string' && net.isIPv4(value)))]
  const bindings = inspected?.HostConfig?.PortBindings?.['5432/tcp']
  const dataMounts = (inspected?.Mounts || []).filter(mount => mount?.Destination === '/var/lib/postgresql/data')
  if (inspected?.Name !== `/${lease.containerName}` || inspected?.State?.Running !== true ||
      inspected?.Image !== lease.imageId || labels[FIXTURE_LABEL] !== 'true' || labels['ownerinc.protocol-finalizer.run-id'] !== lease.runId ||
      labels['com.docker.compose.project'] !== PROJECT_LABEL || labels['com.docker.compose.service'] !== 'protocol-finalizer-fixture' || ips.length !== 1 ||
      dataMounts.length !== 1 || dataMounts[0]?.Type !== 'volume' || dataMounts[0]?.Name !== lease.volumeName ||
      !Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1' || String(bindings[0]?.HostPort) !== String(lease.port)) {
    fail('lease_created_container_identity_mismatch')
  }
  report.containerId = inspected.Id
  lease.backendIPv4 = ips[0]
}

async function provisionAndMigrate(lease, passwords, logs) {
  const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DB, lease.port)
  const migratorURL = makeConnectionString('cms_migrator', passwords.cms_migrator, DB, lease.port)
  const base = syntheticEnvironment()
  const secrets = Object.values(passwords)
  const adminEnv = { ...base, CMS_DATABASE_URL: adminURL, CMS_MIGRATOR_PASSWORD: passwords.cms_migrator,
    CMS_RUNTIME_PASSWORD: passwords.cms_runtime, CMS_CONTROLLER_PASSWORD: passwords.cms_controller }
  const provisionScript = path.join(CMS, 'scripts/provision-db.ts')
  const nodeArgs = ['--import', 'tsx', provisionScript]
  logs.push(await runCli('provision-native-roles', process.execPath, [...nodeArgs, '--provision'], adminEnv, CMS, secrets))
  logs.push(await runCli('verify-migrator', process.execPath, [...nodeArgs, '--verify-migrator'],
    { ...base, CMS_DATABASE_URL: migratorURL }, CMS, secrets))

  const migrationEnv = { ...base, CMS_DATABASE_URL: migratorURL,
    CMS_UPLOAD_DIR: path.join(privateRunDirectory(lease.runId), 'uploads'),
    PAYLOAD_SECRET: randomBytes(36).toString('hex'), PAYLOAD_TO_PORTAL_SECRET: randomBytes(36).toString('hex'),
    PORTAL_TO_PAYLOAD_SECRET: randomBytes(36).toString('hex'),
    PORTAL_PUBLIC_URL: 'http://127.0.0.1:19991', PORTAL_INTERNAL_URL: 'http://127.0.0.1:19992' }
  secrets.push(migrationEnv.PAYLOAD_SECRET, migrationEnv.PAYLOAD_TO_PORTAL_SECRET, migrationEnv.PORTAL_TO_PAYLOAD_SECRET)
  await createPrivateDirectory(migrationEnv.CMS_UPLOAD_DIR)
  logs.push(await runCli('payload-migrate', process.execPath, ['node_modules/payload/bin.js', 'migrate'], migrationEnv, CMS, secrets))
  const migrator = await connect(migratorURL)
  try {
    const rows = await migrator.query('SELECT name, batch FROM public.payload_migrations ORDER BY name')
    assert.deepEqual(rows.rows.map(row => row.name), MIGRATIONS, 'actual Payload migration ledger must contain the exact six native migrations')
    assert.equal(rows.rows.length, 6)
    lease.migrationBatches = rows.rows.map(row => Number(row.batch))
  } finally { await migrator.end() }

  logs.push(await runCli('bootstrap-control', process.execPath, [...nodeArgs, '--bootstrap-control'], adminEnv, CMS, secrets))
  logs.push(await runCli('verify-control', process.execPath, [...nodeArgs, '--verify-control'], adminEnv, CMS, secrets))
}

async function protocolSnapshot(adminURL) {
  const client = await connect(adminURL)
  try {
    const head = await client.query(`SELECT singleton, sequence::text AS sequence, chain_sha256, coverage_version,
      write_barrier, barrier_run_id::text AS barrier_run_id, barrier_epoch, barrier_receipt_sha256
      FROM public.owner_news_mutation_head WHERE singleton=true`)
    const events = await client.query(`SELECT sequence::text AS sequence, event_id::text AS event_id,
      table_name, operation, row_key, transaction_id, before_sha256, after_sha256, previous_sha256,
      event_sha256, created_at::text AS created_at FROM public.owner_news_mutation_events ORDER BY sequence`)
    const seals = await client.query(`SELECT count(*)::integer AS count FROM public.news_migration_runs
      WHERE admission_state='sealed' OR sealed_at IS NOT NULL`)
    return { head: head.rows, events: events.rows, sealedRuns: Number(seals.rows[0]?.count) }
  } finally { await client.end() }
}

async function protocolIsAbsent(adminURL) {
  const client = await connect(adminURL)
  try {
    const result = await client.query(`SELECT
      to_regclass('public.owner_news_mutation_head') IS NULL AS no_head,
      to_regclass('public.owner_news_mutation_events') IS NULL AS no_events,
      (SELECT count(*)=0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN ('owner_news_mutation_guard_stmt','owner_news_mutation_capture_row',
          'owner_news_seal_run','owner_news_migration_item_binding_guard')) AS no_functions,
      (SELECT count(*)=0 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND t.tgname IN ('owner_news_mutation_guard_stmt','owner_news_mutation_capture_row',
          'owner_news_migration_item_binding_guard','owner_news_migration_run_binding_guard')) AS no_triggers`)
    return Object.values(result.rows[0] || {}).every(value => value === true)
  } finally { await client.end() }
}

async function proveInstallRollback(lease, adminURL, logs) {
  const rollbackEvidence = createAtomicRollbackEvidenceRecord()
  logs.push(rollbackEvidence)
  const functionName = `owner_news_finalizer_fixture_${lease.suffix}`
  const captureFunction = `owner_news_finalizer_ddl_capture_${lease.suffix}`
  const captureSequence = `owner_news_finalizer_ddl_seen_${lease.suffix}_seq`
  const eventTrigger = `owner_news_finalizer_ddl_observer_${lease.suffix}`
  const client = await connect(adminURL)
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

  const nativeBefore = await captureNativeState(adminURL)
  recordAtomicRollbackSnapshot(rollbackEvidence, 'before', nativeBefore)
  const runTableEvidence = nativeBefore.tableRows.find(table => table.tableName === 'news_migration_runs')
  if (!runTableEvidence || BigInt(runTableEvidence.rowCount) < 1n) fail('native_rollback_fixture_table_not_nonempty')

  const env = syntheticEnvironment({ CMS_ADMIN_DATABASE_URL: adminURL })
  try {
    await runCli('expected-finalizer-rejection-for-public-fixture', process.execPath,
      ['--import', 'tsx', path.join(CMS, 'scripts/finalize-news-protocol.ts'), '--finalize-protocol'], env, CMS,
      [adminURL], 1, outcome => recordFinalizerCliEvidence(rollbackEvidence, outcome))
  } catch (error) {
    // runCli has already persisted its bounded outcome via the callback before
    // its exit-status assertion. Continue only the existing rollback checks;
    // their results are captured before the fixture reports failure.
    if (error?.code !== 'protocol_finalizer_cli_stage_failed') throw error
  }
  // The finalizer must reject the PUBLIC-executable rogue function and roll
  // back all protocol DDL. The event trigger advances a nontransactional
  // sequence only when the protocol-head CREATE TABLE command is reached,
  // proving the failed finalizer transaction entered its DDL section.
  if (!rollbackEvidence.finalizerCli) fail('atomic_fixture_cli_outcome_unavailable')
  const observer = await connect(adminURL)
  let markerAfter
  try {
    const marker = await observer.query(`SELECT last_value::text AS value, is_called FROM public.${captureSequence}`)
    markerAfter = marker.rows[0]
  } finally { await observer.end() }
  recordAtomicRollbackCheck(rollbackEvidence, 'protocolCreateTableObserved', markerAfter?.is_called === true)
  const protocolAbsent = await protocolIsAbsent(adminURL)
  recordAtomicRollbackCheck(rollbackEvidence, 'persistedProtocolObjects', !protocolAbsent)
  const nativeAfter = await captureNativeState(adminURL)
  recordAtomicRollbackSnapshot(rollbackEvidence, 'after', nativeAfter)
  const nativeStateUnchanged = compareNativeStateEvidence(nativeBefore, nativeAfter)
  recordAtomicRollbackComparison(rollbackEvidence, nativeStateUnchanged)

  if (!rollbackEvidence.expectedPublicFunctionRejection) fail('atomic_fixture_expected_public_function_rejection_not_observed')
  if (rollbackEvidence.protocolCreateTableObserved !== true) fail('atomic_fixture_did_not_observe_protocol_ddl')
  if (rollbackEvidence.persistedProtocolObjects !== false) fail('finalizer_installation_rollback_incomplete')
  if (rollbackEvidence.nativeStateUnchanged !== true) fail('native_state_changed_by_finalizer_rollback')

  const cleanup = await connect(adminURL)
  try {
    await cleanup.query(`DROP EVENT TRIGGER ${eventTrigger}`)
    await cleanup.query(`DROP FUNCTION public.${captureFunction}()`)
    await cleanup.query(`DROP SEQUENCE public.${captureSequence}`)
    await cleanup.query(`DROP FUNCTION public.${functionName}()`)
  }
  finally { await cleanup.end() }
}

async function insertCommittedNativeFixture(lease, passwords) {
  const migratorURL = makeConnectionString('cms_migrator', passwords.cms_migrator, DB, lease.port)
  const client = await connect(migratorURL)
  const id = randomUUID()
  try {
    await client.query(`INSERT INTO public.news_migration_runs
      (id,manifest_sha256,source_instance,source_fingerprint,authority_epoch)
      VALUES ($1,$2,$3,$4,1)`, [id, 'b'.repeat(64), `finalizer-fixture-${lease.suffix}`, 'a'.repeat(64)])
  } finally { await client.end() }
  return id
}

async function runFinalizerCli(label, adminURL, installedExpected, logs, secrets) {
  const result = await runCli(label, process.execPath, ['--import', 'tsx', path.join(CMS, 'scripts/finalize-news-protocol.ts'), '--finalize-protocol'],
    syntheticEnvironment({ CMS_ADMIN_DATABASE_URL: adminURL }), CMS, secrets)
  const output = result.output.trim().split(/\r?\n/u).at(-1)
  let response
  try { response = JSON.parse(output) } catch { fail('finalizer_success_output_invalid') }
  if (response.installed !== installedExpected || response.ready !== false || response.coverageVersion !== 0) fail('finalizer_disabled_readiness_contract_mismatch')
  logs.push({ label, status: 0, result: { installed: response.installed, ready: response.ready, coverageVersion: response.coverageVersion } })
}

async function execute(rawLease, leasePath) {
  const lease = validateLease(rawLease)
  const evidenceDir = privateRunDirectory(lease.runId)
  await inspectApprovedSharedParent()
  await inspectPrivatePath(evidenceDir, 'directory')
  const reread = JSON.parse(await readPrivateFile(leasePath, evidenceDir))
  if (JSON.stringify(leaseDocument(validateLease(reread))) !== JSON.stringify(leaseDocument(lease))) fail('lease_changed_after_initial_read')
  const report = { status: 'running', runId: lease.runId, project: PROJECT_LABEL, dockerContext: CONTEXT_NAME,
    host: lease.host, port: lease.port, containerName: lease.containerName, volumeName: lease.volumeName,
    imageRef: lease.imageRef, imageId: lease.imageId, database: DB, stages: [], coverageVersion: 0, ready: false,
    evidenceDirectory: evidenceDir, containerCreated: false, volumeCreated: false }
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
    await createCluster(target, evidenceDir, passwords, report)
    stage = 'verify-new-cluster-system-identity-before-application-ddl'
    await waitForPostgres(makeConnectionString('cms_admin', passwords.cms_admin, 'postgres', target.port), target)
    report.backendIPv4 = target.backendIPv4
    report.systemIdentifier = target.systemIdentifier
    report.serverMajorVersion = 16
    report.stages.push({ name: 'new-postgres16-backend-identity', result: 'pass' })
    stage = 'create-ownerinc-cms-after-system-identity'
    await createOwnerCmsDatabase(target, passwords.cms_admin)
    report.stages.push({ name: 'create-new-ownerinc-cms', result: 'pass' })

    const logs = report.stages
    stage = 'provision-migrate-and-bootstrap-control'
    await provisionAndMigrate(target, passwords, logs)
    report.migrationLedger = MIGRATIONS
    report.stages.push({ name: 'actual-migrations-and-control-cli', result: 'pass' })
    const nativeFixtureId = await insertCommittedNativeFixture(target, passwords)
    report.nativeFixture = { relation: 'news_migration_runs', synthetic: true, committed: true, rowId: nativeFixtureId }

    const adminURL = makeConnectionString('cms_admin', passwords.cms_admin, DB, target.port)
    stage = 'atomic-finalizer-install-rollback-fixture'
    await proveInstallRollback(target, adminURL, logs)
    report.stages.push({ name: 'public-acl-install-rollback', result: 'pass' })

    const secretsForCli = [passwords.cms_admin]
    stage = 'finalizer-first-install-and-reentry'
    await runFinalizerCli('finalizer-first-install', adminURL, true, logs, secretsForCli)
    const beforeReentry = await protocolSnapshot(adminURL)
    if (beforeReentry.head.length !== 1 || beforeReentry.head[0].coverage_version !== 0 ||
        beforeReentry.head[0].write_barrier !== 'open' || beforeReentry.head[0].barrier_run_id !== null ||
        beforeReentry.head[0].barrier_epoch !== null || beforeReentry.head[0].barrier_receipt_sha256 !== null ||
        beforeReentry.events.length !== 0 || beforeReentry.sealedRuns !== 0) fail('finalizer_head_not_disabled_or_empty')
    await runFinalizerCli('finalizer-idempotent-reentry', adminURL, false, logs, secretsForCli)
    const afterReentry = await protocolSnapshot(adminURL)
    if (JSON.stringify(afterReentry) !== JSON.stringify(beforeReentry)) fail('finalizer_reentry_changed_head_or_events')
    report.protocol = { firstInstall: true, reentry: true, head: beforeReentry.head[0], eventCount: beforeReentry.events.length,
      sealedRuns: beforeReentry.sealedRuns, admissionActivated: false }
    report.status = 'pass'
    return report
  })
}

async function main() {
  if (process.argv[2] === '--prepare-lease' && process.argv.length === 3) {
    await prepareLease()
    return
  }
  if (process.argv[2] !== '--execute' || process.argv.length !== 5 || process.argv[3] !== '--lease') {
    console.error('Usage: node tests/integration/protocol-finalizer.mjs --prepare-lease | --execute --lease <private-lease.json>')
    process.exitCode = 2
    return
  }
  const requestedLeasePath = path.resolve(process.argv[4])
  const root = privateBase()
  const requestedDirectory = path.dirname(requestedLeasePath)
  const prefix = process.platform === 'win32' ? '.ownerinc-payload-finalizer-' : 'ownerinc-payload-finalizer-'
  const runId = path.basename(requestedDirectory).startsWith(prefix) ? path.basename(requestedDirectory).slice(prefix.length) : ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)) fail('lease_file_outside_private_state')
  const leasePath = validatePrivateLeaseLocation(requestedLeasePath, runId, root)
  await inspectApprovedSharedParent()
  await inspectPrivatePath(requestedDirectory, 'directory')
  const rawLease = JSON.parse(await readPrivateFile(leasePath, requestedDirectory))
  if (validateLease(rawLease).runId !== runId) fail('lease_path_run_id_mismatch')
  const report = await execute(rawLease, leasePath)
  console.log(`protocol-finalizer: ${report.status} run=${report.runId} port=${report.port} evidence=${report.evidenceDirectory}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`protocol-finalizer: ${error?.code || 'harness_failed'}`)
    process.exitCode = 1
  })
}
