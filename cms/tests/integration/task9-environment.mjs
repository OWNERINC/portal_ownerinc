import path from 'node:path'

const approvedPortalOrigin = 'http://127.0.0.1:19091'
const trustedParentEnvironmentKeys = Object.freeze([
  'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'ComSpec', 'PATHEXT',
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SystemDrive', 'USERDOMAIN', 'USERNAME', 'WINDIR',
])
const snapshotConfigurationKeys = Object.freeze([
  'NODE_ENV', 'NEXT_TELEMETRY_DISABLED', 'PAYLOAD_SECRET', 'PAYLOAD_TO_PORTAL_SECRET',
  'PORTAL_TO_PAYLOAD_SECRET', 'PORTAL_PUBLIC_URL', 'PORTAL_INTERNAL_URL',
  'CMS_DATABASE_URL', 'TASK9_PORTAL_DATABASE_URL',
])
const ignoredLegacySnapshotKeys = new Set([
  ...trustedParentEnvironmentKeys,
  'LOCALAPPDATA', 'TASK9_PRIVATE_DIR', 'CMS_UPLOAD_DIR', 'TASK9_WEBPACK',
].map(key => key.toLowerCase()))
const executableSnapshotKeys = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'PYTHONPATH',
].map(key => key.toLowerCase()))
const allowedRuntimeEnvironmentKeys = new Set([
  ...trustedParentEnvironmentKeys,
  ...snapshotConfigurationKeys,
  'LOCALAPPDATA', 'TASK9_PRIVATE_DIR', 'CMS_UPLOAD_DIR', 'TASK9_WEBPACK',
].map(key => key.toLowerCase()))

function readEnvironmentValue(environment, key) {
  const actualKey = Object.keys(environment || {}).find(candidate => candidate.toLowerCase() === key.toLowerCase())
  return actualKey ? environment[actualKey] : undefined
}

function validateTask9SnapshotKeys(snapshotEnvironment) {
  const reasons = []
  const seen = new Set()
  const allowed = new Set([...snapshotConfigurationKeys.map(key => key.toLowerCase()), ...ignoredLegacySnapshotKeys])
  for (const key of Object.keys(snapshotEnvironment || {})) {
    const normalized = key.toLowerCase()
    if (seen.has(normalized)) reasons.push('TASK9_SNAPSHOT_DUPLICATE_KEY')
    seen.add(normalized)
    if (executableSnapshotKeys.has(normalized)) reasons.push('TASK9_SNAPSHOT_EXECUTION_SETTING_REJECTED')
    else if (!allowed.has(normalized)) reasons.push('TASK9_SNAPSHOT_KEY_UNSUPPORTED')
  }
  return [...new Set(reasons)]
}

/** Parse and validate only the snapshot's key contract; never return parser details. */
export function parseTask9EnvironmentSnapshot(source) {
  try {
    const snapshotEnvironment = JSON.parse(source)
    if (!snapshotEnvironment || typeof snapshotEnvironment !== 'object' || Array.isArray(snapshotEnvironment)) {
      return { valid: false, reasonCodes: ['TASK9_SNAPSHOT_INVALID'], snapshotEnvironment: {} }
    }
    const reasonCodes = validateTask9SnapshotKeys(snapshotEnvironment)
    return { valid: reasonCodes.length === 0, reasonCodes, snapshotEnvironment }
  } catch {
    return { valid: false, reasonCodes: ['TASK9_SNAPSHOT_INVALID'], snapshotEnvironment: {} }
  }
}

export function validateTask9Snapshot(snapshotEnvironment) {
  const reasonCodes = validateTask9SnapshotKeys(snapshotEnvironment)
  return { valid: reasonCodes.length === 0, reasonCodes }
}

function pathImplementation(...values) {
  return values.some(value => typeof value === 'string' && path.win32.isAbsolute(value)) ? path.win32 : path
}

function canonicalPath(value, pathAPI) {
  let normalized = pathAPI.normalize(value)
  if (pathAPI === path.win32) normalized = normalized.toLowerCase()
  return normalized.replace(/[\\/]+$/u, '')
}

/** Strictly keep one immediate ownerinc-task9-* child beneath the supplied OS temp root. */
export function validateTask9PrivateDirectory(directory, localAppData) {
  const reasons = []
  if (typeof localAppData !== 'string' || !localAppData) reasons.push('LOCALAPPDATA_MISSING')
  if (typeof directory !== 'string' || !directory) reasons.push('PRIVATE_DIR_MISSING')
  if (reasons.length) return { valid: false, reasonCodes: reasons }

  const pathAPI = pathImplementation(localAppData, directory)
  const expectedParent = pathAPI.join(localAppData, 'Temp', 'opencode')
  const actualParent = pathAPI.dirname(directory)
  if (canonicalPath(actualParent, pathAPI) !== canonicalPath(expectedParent, pathAPI)) {
    reasons.push('PRIVATE_DIR_PARENT_MISMATCH')
  }
  if (!pathAPI.basename(directory).startsWith('ownerinc-task9-')) reasons.push('PRIVATE_DIR_PREFIX_INVALID')
  return { valid: reasons.length === 0, reasonCodes: reasons }
}

function databaseIdentityMatches(value, expected) {
  try {
    const url = new URL(value)
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:')
      && !url.search
      && !url.hash
      && url.hostname === '127.0.0.1'
      && url.port === '55441'
      && url.pathname === `/${expected.database}`
      && url.username === expected.username
  } catch {
    return false
  }
}

function portalOriginReason(value, name) {
  if (typeof value !== 'string' || !value) return `${name}_MISSING`
  try {
    if (new URL(value).hostname !== '127.0.0.1') return `${name}_NOT_LOOPBACK`
  } catch {
    return `${name}_NOT_APPROVED_ORIGIN`
  }
  return value === approvedPortalOrigin ? null : `${name}_NOT_APPROVED_ORIGIN`
}

/** Pure Task9 guard. Its output contains only fixed reason codes and booleans. */
export function validateTask9Environment(environment) {
  const env = environment || {}
  const checks = {
    localAppDataPresent: typeof readEnvironmentValue(env, 'LOCALAPPDATA') === 'string'
      && Boolean(readEnvironmentValue(env, 'LOCALAPPDATA')),
    privateDirectoryParentMatches: false,
    privateDirectoryPrefixMatches: false,
    cmsDatabaseIdentityMatches: false,
    portalDatabaseIdentityMatches: false,
    portalPublicOriginMatches: false,
    portalInternalOriginMatches: false,
    uploadDirectoryMatchesPrivateDirectory: false,
    task9RuntimeModeMatches: false,
    telemetryDisabled: false,
    requiredSecretsPresent: false,
    directionalSecretsDistinct: false,
    noExecutionInjectionSettings: false,
  }
  const reasons = []
  if (Object.keys(env).some(key => !allowedRuntimeEnvironmentKeys.has(key.toLowerCase()))) {
    reasons.push('TASK9_RUNTIME_KEY_UNSUPPORTED')
  }
  const localAppData = readEnvironmentValue(env, 'LOCALAPPDATA')
  const directory = readEnvironmentValue(env, 'TASK9_PRIVATE_DIR')
  const privateDirectory = validateTask9PrivateDirectory(directory, localAppData)
  reasons.push(...privateDirectory.reasonCodes)
  checks.privateDirectoryParentMatches = !privateDirectory.reasonCodes.includes('PRIVATE_DIR_PARENT_MISMATCH')
    && !privateDirectory.reasonCodes.includes('LOCALAPPDATA_MISSING')
    && !privateDirectory.reasonCodes.includes('PRIVATE_DIR_MISSING')
  checks.privateDirectoryPrefixMatches = !privateDirectory.reasonCodes.includes('PRIVATE_DIR_PREFIX_INVALID')
    && !privateDirectory.reasonCodes.includes('PRIVATE_DIR_MISSING')

  const databaseSpecs = [
    ['CMS_DATABASE_URL', 'CMS_DATABASE_IDENTITY_INVALID', { database: 'cms_task9_test', username: 'cms_runtime' }, 'cmsDatabaseIdentityMatches'],
    ['TASK9_PORTAL_DATABASE_URL', 'PORTAL_DATABASE_IDENTITY_INVALID', { database: 'portal_task9_test', username: 'portal_api' }, 'portalDatabaseIdentityMatches'],
  ]
  for (const [key, reason, expected, check] of databaseSpecs) {
    const matches = databaseIdentityMatches(readEnvironmentValue(env, key), expected)
    checks[check] = matches
    if (!matches) reasons.push(reason)
  }

  const endpointSpecs = [
    ['PORTAL_PUBLIC_URL', 'PORTAL_PUBLIC_URL', 'portalPublicOriginMatches'],
    ['PORTAL_INTERNAL_URL', 'PORTAL_INTERNAL_URL', 'portalInternalOriginMatches'],
  ]
  for (const [key, name, check] of endpointSpecs) {
    const reason = portalOriginReason(readEnvironmentValue(env, key), name)
    checks[check] = reason === null
    if (reason) reasons.push(reason)
  }

  const pathAPI = pathImplementation(directory || '', readEnvironmentValue(env, 'CMS_UPLOAD_DIR') || '')
  const expectedUploadDirectory = directory ? pathAPI.join(directory, 'uploads') : ''
  const uploadDirectory = readEnvironmentValue(env, 'CMS_UPLOAD_DIR')
  checks.uploadDirectoryMatchesPrivateDirectory = Boolean(uploadDirectory && expectedUploadDirectory
    && canonicalPath(uploadDirectory, pathAPI) === canonicalPath(expectedUploadDirectory, pathAPI))
  if (!checks.uploadDirectoryMatchesPrivateDirectory) reasons.push('UPLOAD_DIR_NOT_PRIVATE_CHILD')

  checks.task9RuntimeModeMatches = readEnvironmentValue(env, 'NODE_ENV') === 'development'
  if (!checks.task9RuntimeModeMatches) reasons.push('NODE_ENV_INVALID')
  checks.telemetryDisabled = readEnvironmentValue(env, 'NEXT_TELEMETRY_DISABLED') === '1'
  if (!checks.telemetryDisabled) reasons.push('NEXT_TELEMETRY_DISABLED_INVALID')

  const payloadSecret = readEnvironmentValue(env, 'PAYLOAD_SECRET')
  const payloadToPortalSecret = readEnvironmentValue(env, 'PAYLOAD_TO_PORTAL_SECRET')
  const portalToPayloadSecret = readEnvironmentValue(env, 'PORTAL_TO_PAYLOAD_SECRET')
  checks.requiredSecretsPresent = [payloadSecret, payloadToPortalSecret, portalToPayloadSecret]
    .every(secret => typeof secret === 'string' && secret.trim().length >= 32)
  if (!checks.requiredSecretsPresent) reasons.push('TASK9_REQUIRED_SECRET_MISSING_OR_INVALID')
  checks.directionalSecretsDistinct = typeof payloadToPortalSecret === 'string'
    && typeof portalToPayloadSecret === 'string' && payloadToPortalSecret !== portalToPayloadSecret
  if (!checks.directionalSecretsDistinct) reasons.push('TASK9_DIRECTIONAL_SECRETS_NOT_DISTINCT')

  const webpack = readEnvironmentValue(env, 'TASK9_WEBPACK')
  if (webpack !== undefined && webpack !== '1') reasons.push('TASK9_WEBPACK_INVALID')
  checks.noExecutionInjectionSettings = [...executableSnapshotKeys]
    .every(key => readEnvironmentValue(env, key) === undefined)
  if (!checks.noExecutionInjectionSettings) reasons.push('TASK9_EXECUTION_SETTING_PRESENT')

  const reasonCodes = [...new Set(reasons)]
  return { valid: reasonCodes.length === 0, reasonCodes, checks }
}

/**
 * Build the exact child environment used by Task9 launchers. Snapshot values are
 * copied only from the Task9 configuration allowlist; trusted launcher OS values
 * are separately allowlisted and explicit root overrides cannot be snapshot-led.
 */
export function createTask9ChildEnvironment({ parentEnvironment, snapshotEnvironment, directory, webpack = false }) {
  const snapshot = snapshotEnvironment || {}
  const snapshotReasons = validateTask9Snapshot(snapshot).reasonCodes
  const environment = {}
  for (const key of trustedParentEnvironmentKeys) {
    const value = readEnvironmentValue(parentEnvironment, key)
    if (value !== undefined) environment[key] = value
  }
  const parentLocalAppData = readEnvironmentValue(parentEnvironment, 'LOCALAPPDATA')
  environment.LOCALAPPDATA = parentLocalAppData
  for (const key of snapshotConfigurationKeys) {
    const value = readEnvironmentValue(snapshot, key)
    if (value !== undefined) environment[key] = value
  }
  environment.TASK9_PRIVATE_DIR = directory
  const pathAPI = pathImplementation(directory)
  environment.CMS_UPLOAD_DIR = typeof directory === 'string' && directory
    ? pathAPI.join(directory, 'uploads')
    : ''
  if (webpack) environment.TASK9_WEBPACK = '1'
  const validation = validateTask9Environment(environment)
  const reasonCodes = [...new Set([...snapshotReasons, ...validation.reasonCodes])]
  return {
    environment,
    validation: { valid: reasonCodes.length === 0, reasonCodes, checks: validation.checks },
  }
}
