import { sql, type PostgresAdapter } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest } from 'payload'
import { readCmsEnvironment } from '../config/environment'
import { requireCmsTransaction } from '../publication/transaction'
import { privateImportDirectory } from './private-paths'
import { assertImportBinding } from './identity'
import { importDatabaseIdentityFingerprint, readImportDatabaseIdentity, readLiveImportDatabaseIdentity,
  readObservedImportDatabaseIdentity } from './target'
import { isClaimedImportPreflightArtifact } from './preflight'

type AdapterClient = {
  query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>
  release: (destroy?: boolean) => void
  on?: (event: 'error', listener: () => void) => unknown
}
type AdapterConnection = { connect?: () => Promise<AdapterClient> }

export type ImportOperatorIdentity = Readonly<{
  actorUid: string
  runId: string
  manifestSha256: string
  expectedEpoch: number
}>

/** Kept only in a WeakMap; neither file paths nor database URLs enter preflight JSON. */
export type ImportPreflightArtifact = Readonly<{
  bundle: unknown
  manifestSha256: string
  sourceInstance: string
  sourceFingerprint: string
  expectedEpoch: number
  targetDatabaseURL: string
  targetDatabaseIdentitySha256: string
  targetUploadDir: string
}>

const pendingCapabilities = new WeakMap<PayloadRequest, {
  payload: Payload
  bundle: unknown
  artifact: ImportPreflightArtifact
  identity: ImportOperatorIdentity
  activeRequest?: PayloadRequest
}>()
const activeCapabilities = new WeakMap<PayloadRequest, {
  incoming: PayloadRequest
  payload: Payload
  bundle: unknown
  artifact: ImportPreflightArtifact
  identity: ImportOperatorIdentity
  session: unknown
}>()
const admittedArtifacts = new WeakSet<object>()

function deny(code: string): never { throw new Error(code) }
function safeTargetCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : ''
  return message === 'import_target_binding_mismatch' || message === 'import_target_binding_unavailable' ? message : null
}

function identity(value: ImportOperatorIdentity): ImportOperatorIdentity {
  if (typeof value.actorUid !== 'string' || !value.actorUid || value.actorUid.length > 128) deny('import_operator_actor_invalid')
  assertImportBinding({ runId: value.runId, manifestSha256: value.manifestSha256, authorityEpoch: value.expectedEpoch })
  return Object.freeze({ actorUid: value.actorUid, runId: value.runId,
    manifestSha256: value.manifestSha256, expectedEpoch: value.expectedEpoch })
}

function sameIdentity(left: ImportOperatorIdentity, right: ImportOperatorIdentity) {
  return left.actorUid === right.actorUid && left.runId === right.runId &&
    left.manifestSha256 === right.manifestSha256 && left.expectedEpoch === right.expectedEpoch
}

function requestActorMatches(req: PayloadRequest, actorUid: string) {
  const user = req.user as { collection?: unknown; portalUid?: unknown; portalActor?: { uid?: unknown; canManageNews?: unknown } } | null
  return user?.collection === 'portal-editors' && user.portalUid === actorUid &&
    user.portalActor?.uid === actorUid && user.portalActor.canManageNews === true
}

function urlParts(value: string) {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) deny('import_target_binding_mismatch')
  const databaseName = decodeURIComponent(url.pathname.slice(1))
  if (!databaseName || databaseName.includes('/')) deny('import_target_binding_mismatch')
  return {
    protocol: 'postgres:', hostname: url.hostname.toLowerCase(), port: url.port || '5432', databaseName,
    username: url.username, password: url.password, search: url.search,
    canonical: url.href,
  }
}

function sameDatabaseLocation(left: string, right: string) {
  const a = urlParts(left), b = urlParts(right)
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port && a.databaseName === b.databaseName
}

function adapter(payload: Payload) {
  const value = payload.db as unknown as PostgresAdapter & { pool?: AdapterConnection; poolOptions?: { connectionString?: unknown } }
  if (!value.pool || typeof value.pool.connect !== 'function' || typeof value.poolOptions?.connectionString !== 'string') {
    deny('import_target_binding_unavailable')
  }
  return value
}

async function configuredTarget(payload: Payload, artifact: ImportPreflightArtifact) {
  let environment: ReturnType<typeof readCmsEnvironment>
  let db: ReturnType<typeof adapter>
  let configuredUploadDir: unknown
  try {
    environment = readCmsEnvironment(process.env)
    db = adapter(payload)
    const collections = (payload.config as unknown as { collections?: { slug?: string; upload?: { staticDir?: unknown } }[] })?.collections
    configuredUploadDir = collections?.find(collection => collection.slug === 'news-media')?.upload?.staticDir
    const adapterURL = db.poolOptions!.connectionString as string
    const adapterLocation = urlParts(adapterURL)
    const environmentLocation = urlParts(environment.databaseURL)
    if (adapterLocation.canonical !== environmentLocation.canonical ||
      !sameDatabaseLocation(adapterURL, artifact.targetDatabaseURL)) deny('import_target_binding_mismatch')

    const [runtimeUpload, payloadUpload, preflightUpload] = await Promise.all([
      privateImportDirectory(environment.uploadDir),
      typeof configuredUploadDir === 'string' ? privateImportDirectory(configuredUploadDir) : Promise.reject(new Error()),
      privateImportDirectory(artifact.targetUploadDir),
    ])
    if (runtimeUpload !== payloadUpload || runtimeUpload !== preflightUpload) deny('import_target_binding_mismatch')
    return { db, environment, databaseName: adapterLocation.databaseName }
  } catch (error) {
    deny(safeTargetCode(error) ?? 'import_target_binding_mismatch')
  }
}

const physicalIdentitySQL = `SELECT current_database() AS database_name,
  (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
  (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system_identifier,
  pg_catalog.pg_is_in_recovery() AS in_recovery,
  current_setting('transaction_read_only') AS transaction_read_only`

function assertPhysicalIdentity(row: Record<string, unknown>, artifact: ImportPreflightArtifact,
  databaseName: string, probe: 'preflight' | 'live' | 'observed') {
  try {
    const actual = probe === 'preflight' ? readImportDatabaseIdentity(row, databaseName)
      : probe === 'live' ? readLiveImportDatabaseIdentity(row, databaseName)
        : readObservedImportDatabaseIdentity(row, databaseName)
    if (importDatabaseIdentityFingerprint(actual) !== artifact.targetDatabaseIdentitySha256) deny('import_target_binding_mismatch')
  } catch {
    deny('import_target_binding_mismatch')
  }
}

/** Before Portal projection or any content mutation, probe through the actual Payload adapter pool. */
export async function assertPayloadTargetBinding(payload: Payload, artifact: ImportPreflightArtifact) {
  const configured = await configuredTarget(payload, artifact)
  let client: AdapterClient | undefined
  let destroy = false
  try {
    client = await configured.db.pool!.connect!()
    client.on?.('error', () => {})
    const result = await client.query(physicalIdentitySQL)
    if (result.rows.length !== 1) deny('import_target_binding_mismatch')
    assertPhysicalIdentity(result.rows[0], artifact, configured.databaseName, 'observed')
  } catch (error) {
    destroy = true
    deny(safeTargetCode(error) ?? 'import_target_binding_unavailable')
  } finally {
    if (client) {
      try { client.release(destroy) } catch { /* Do not expose driver diagnostics or URLs. */ }
    }
  }
}

async function assertRequestTargetBinding(payload: Payload, req: PayloadRequest, artifact: ImportPreflightArtifact) {
  const configured = await configuredTarget(payload, artifact)
  try {
    const session = await requireCmsTransaction(payload, req)
    const result = await session.execute(sql`SELECT current_database() AS database_name,
      (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
      (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system_identifier,
      pg_catalog.pg_is_in_recovery() AS in_recovery,
      current_setting('transaction_read_only') AS transaction_read_only`)
    if (!result.rows || result.rows.length !== 1) deny('import_target_binding_mismatch')
    assertPhysicalIdentity(result.rows[0] as Record<string, unknown>, artifact, configured.databaseName, 'live')
    return session
  } catch (error) {
    deny(safeTargetCode(error) ?? 'import_target_binding_unavailable')
  }
}

/** Binds the server-only import call to one exact request until it returns. */
export async function withOperatorImportCapability<T>(req: PayloadRequest, payload: Payload, bundle: unknown,
  artifact: ImportPreflightArtifact, suppliedIdentity: ImportOperatorIdentity, operation: () => Promise<T>): Promise<T> {
  const binding = identity(suppliedIdentity)
  if (req.payload !== payload || pendingCapabilities.has(req) || !bundle || bundle !== artifact.bundle ||
    !isClaimedImportPreflightArtifact(artifact) || admittedArtifacts.has(artifact) ||
    binding.manifestSha256 !== artifact.manifestSha256 ||
    binding.expectedEpoch !== artifact.expectedEpoch) {
    deny('import_operator_admission_invalid')
  }
  admittedArtifacts.add(artifact)
  const scope = { payload, bundle, artifact, identity: binding } as {
    payload: Payload; bundle: unknown; artifact: ImportPreflightArtifact; identity: ImportOperatorIdentity; activeRequest?: PayloadRequest
  }
  pendingCapabilities.set(req, scope)
  try { return await operation() }
  finally {
    if (scope.activeRequest) activeCapabilities.delete(scope.activeRequest)
    pendingCapabilities.delete(req)
  }
}

export function assertOperatorImportPending(req: PayloadRequest, payload: Payload, bundle: unknown,
  suppliedIdentity: ImportOperatorIdentity) {
  const scope = pendingCapabilities.get(req)
  const binding = identity(suppliedIdentity)
  if (!scope || scope.payload !== payload || scope.bundle !== bundle || !sameIdentity(scope.identity, binding) ||
    !requestActorMatches(req, binding.actorUid) || scope.activeRequest) {
    deny('import_operator_admission_required')
  }
}

/** Called as the first step on the actual transaction request, before the importer writes. */
export async function activateOperatorImportCapability(incoming: PayloadRequest, req: PayloadRequest, payload: Payload,
  bundle: unknown, suppliedIdentity: ImportOperatorIdentity) {
  assertOperatorImportPending(incoming, payload, bundle, suppliedIdentity)
  const scope = pendingCapabilities.get(incoming)!
  if (req.payload !== payload || activeCapabilities.has(req) || !requestActorMatches(req, scope.identity.actorUid)) {
    deny('import_operator_admission_mismatch')
  }
  const session = await assertRequestTargetBinding(payload, req, scope.artifact)
  scope.activeRequest = req
  activeCapabilities.set(req, { incoming, payload, bundle, artifact: scope.artifact, identity: scope.identity, session })
}

/** Recheck exact req, active adapter session and immutable run/bundle binding before COMMIT. */
export async function assertOperatorImportActive(req: PayloadRequest, payload: Payload, bundle: unknown,
  suppliedIdentity: ImportOperatorIdentity) {
  const scope = activeCapabilities.get(req)
  const binding = identity(suppliedIdentity)
  const pending = scope ? pendingCapabilities.get(scope.incoming) : undefined
  if (!scope || scope.payload !== payload || scope.bundle !== bundle || !sameIdentity(scope.identity, binding) ||
    scope.identity.manifestSha256 !== scope.artifact.manifestSha256 || scope.identity.expectedEpoch !== scope.artifact.expectedEpoch ||
    !pending || pending.activeRequest !== req || pending.payload !== payload || pending.bundle !== bundle ||
    pending.artifact !== scope.artifact || !requestActorMatches(req, binding.actorUid)) {
    deny('import_operator_admission_mismatch')
  }
  if (scope.session !== await requireCmsTransaction(payload, req)) deny('import_operator_admission_mismatch')
}
