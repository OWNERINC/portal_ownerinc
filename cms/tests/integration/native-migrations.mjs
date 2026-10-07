// Explicit disposable native-migration probe. Creates only one fresh database
// on the already-authorized local PostgreSQL; never resets or drops anything.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cmsRoot = path.join(root, 'cms')
const directRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
const localAppData = process.env.LOCALAPPDATA
if (!localAppData) throw new Error('private_validation_state_unavailable')
const base = path.join(localAppData, 'Temp', 'opencode')
const statePath = path.join(base, 'ownerinc-payload-local-validation-20261002', 'state.json')
const { Client } = createRequire(path.join(root, 'api/package.json'))('pg')
const host = '127.0.0.1'
const port = 55441
const dockerContext = 'desktop-linux'
const dockerEndpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine'
const dockerContainer = 'ownerinc-payload-local-postgres-1'
const dockerProject = 'ownerinc-payload-local'
const dockerService = 'postgres'
const dockerHostPort = 55441
const postgresContainerPort = 5432
const expectedMigrations = [
  '20261002_181423_owner_news_initial',
  '20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication',
  '20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum',
  '20261006_181424_z_owner_news_native',
]
const report = { status: 'running', host, port, migrationRole: 'cms_migrator', coverageVersion: 0, stages: [] }
let stage = 'preflight'
let evidenceDir
let databaseName
let dbCreated = false
let admin
let dbAdmin
let migrator
let state
let syntheticSecrets = []
let migrationOutput = ''
let authorizedTarget
let authorizedSystemIdentifier

function stop(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function compareRows(before, after) {
  return JSON.stringify(before) === JSON.stringify(after)
}

function connectionString(role, password, database) {
  return `postgresql://${role}:${encodeURIComponent(password)}@${host}:${port}/${database}`
}

function parseIPv4Address(value) {
  if (typeof value !== 'string') return null
  const address = value.split('/')[0]
  return net.isIPv4(address) ? address : null
}

function dockerJSON(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
  if (result.error || result.status !== 0 || result.signal) stop('owned_docker_inspection_failed')
  try { return JSON.parse(result.stdout) } catch { stop('owned_docker_inspection_invalid_json') }
}

export function authorizeOwnedDockerContainer({ contextName, contextEndpoint, dockerHostOverride, dockerContextOverride, container }) {
  if (dockerHostOverride || dockerContextOverride || contextName !== dockerContext || contextEndpoint !== dockerEndpoint) {
    stop('owned_docker_local_context_not_proven')
  }
  if (!container || container.Name !== `/${dockerContainer}` || container.State?.Running !== true ||
      container.Config?.Labels?.['com.docker.compose.project'] !== dockerProject ||
      container.Config?.Labels?.['com.docker.compose.service'] !== dockerService ||
      !/^postgres:16(?:[-@]|$)/u.test(container.Config?.Image || '')) stop('owned_postgres_container_identity_mismatch')

  const networkEntries = Object.entries(container.NetworkSettings?.Networks || {})
  const addresses = [...new Set(networkEntries.map(([, network]) => network?.IPAddress).filter(address => net.isIPv4(address)))]
  if (networkEntries.length !== 1 || addresses.length !== 1) stop('owned_postgres_container_network_ambiguous')
  const bindingKey = `${postgresContainerPort}/tcp`
  const bindings = container.HostConfig?.PortBindings?.[bindingKey]
  if (!Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.HostIp !== host ||
      String(bindings[0]?.HostPort) !== String(dockerHostPort)) stop('owned_postgres_loopback_binding_mismatch')

  return Object.freeze({ contextName, contextEndpoint, container: dockerContainer, composeProject: dockerProject,
    composeService: dockerService, clientHost: host, clientPort: dockerHostPort,
    backendIPv4: addresses[0], backendPort: postgresContainerPort })
}

export function assertOwnedBackendIdentity(target, observed, expectedSystemIdentifier) {
  const observedAddress = parseIPv4Address(observed?.server_address)
  const systemIdentifier = String(observed?.system_identifier ?? '')
  if (!target || !observedAddress || observedAddress !== target.backendIPv4 ||
      Number(observed.server_port) !== target.backendPort || !/^\d{10,20}$/u.test(systemIdentifier) ||
      (expectedSystemIdentifier && systemIdentifier !== expectedSystemIdentifier)) stop('owned_postgres_backend_identity_mismatch')
  return systemIdentifier
}

export function compareNativeSnapshotCatalog(snapshot, { tables, columns }) {
  const expectedTableNames = Object.values(snapshot.tables).map(table => table.name)
  const actualTableNames = tables.map(row => row.tablename)
  const expectedTableSet = new Set(expectedTableNames)
  const actualTableSet = new Set(actualTableNames)
  const missingTables = expectedTableNames.filter(name => !actualTableSet.has(name)).sort()
  const unexpectedTables = actualTableNames.filter(name => !expectedTableSet.has(name)).sort()

  const expectedColumns = new Map()
  for (const table of Object.values(snapshot.tables)) {
    for (const column of Object.values(table.columns)) expectedColumns.set(`${table.name}.${column.name}`, column)
  }
  const actualColumns = new Map(columns.map(column => [`${column.table_name}.${column.column_name}`, column]))
  const missingColumns = []
  const unexpectedColumns = []
  const typeMismatches = []
  const nullabilityMismatches = []
  for (const [key, expected] of expectedColumns) {
    const actual = actualColumns.get(key)
    if (!actual) { missingColumns.push(key); continue }
    const expectedType = expected.type
    const isEnumArray = expectedType.startsWith('enum_') && expectedType.endsWith('[]')
    const enumBase = isEnumArray ? expectedType.slice(0, -2) : expectedType
    const enumType = enumBase.startsWith('enum_')
    const typeMatches = enumType
      ? actual.data_type === (isEnumArray ? 'ARRAY' : 'USER-DEFINED') && actual.udt_name === (isEnumArray ? `_${enumBase}` : enumBase)
      : expectedType === 'varchar'
        ? actual.data_type === 'character varying' && actual.udt_name === 'varchar'
        : expectedType === 'serial'
          ? actual.data_type === 'integer' && actual.udt_name === 'int4'
          : expectedType === 'timestamp(3) with time zone'
            ? actual.data_type === 'timestamp with time zone' && Number(actual.datetime_precision) === 3
            : expectedType.endsWith('[]')
              ? actual.data_type === 'ARRAY' && actual.udt_name === `_${expectedType.slice(0, -2)}`
              : actual.data_type === expectedType
    if (!typeMatches) typeMismatches.push({ column: key, expected: expectedType, actual: actual.data_type, udt: actual.udt_name })
    if ((actual.is_nullable === 'NO') !== Boolean(expected.notNull)) {
      nullabilityMismatches.push({ column: key, expectedNotNull: Boolean(expected.notNull), actual: actual.is_nullable })
    }
  }
  for (const key of actualColumns.keys()) if (!expectedColumns.has(key)) unexpectedColumns.push(key)
  const mismatches = { missingTables, unexpectedTables, missingColumns: missingColumns.sort(), unexpectedColumns: unexpectedColumns.sort(),
    typeMismatches, nullabilityMismatches }
  return { expectedTables: expectedTableNames.length, actualTables: actualTableNames.length,
    expectedColumns: expectedColumns.size, actualColumns: actualColumns.size,
    matches: Object.values(mismatches).every(items => items.length === 0), mismatches }
}

async function verifyConnectedBackend(client, expectedDatabase, expectedRole) {
  const result = await client.query(`SELECT current_user AS role, current_database() AS database,
    inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
    ${expectedRole === 'postgres' ? '(pg_control_system()).system_identifier::text' : 'NULL::text'} AS system_identifier`)
  const row = result.rows[0]
  let systemIdentifier
  if (expectedRole === 'postgres') {
    systemIdentifier = assertOwnedBackendIdentity(authorizedTarget, row, authorizedSystemIdentifier)
    authorizedSystemIdentifier = systemIdentifier
  } else {
    const address = parseIPv4Address(row?.server_address)
    if (!authorizedSystemIdentifier || address !== authorizedTarget.backendIPv4 || Number(row?.server_port) !== authorizedTarget.backendPort) {
      stop('owned_postgres_backend_identity_mismatch')
    }
    systemIdentifier = authorizedSystemIdentifier
  }
  if (row.role !== expectedRole || row.database !== expectedDatabase) stop('owned_postgres_connection_identity_mismatch')
  if (row.system_identifier && row.system_identifier !== authorizedSystemIdentifier) stop('owned_postgres_system_identifier_changed')
  return row
}

async function revalidateOwnedTarget() {
  const inspected = discoverOwnedDockerTarget()
  const fields = ['contextName', 'contextEndpoint', 'container', 'composeProject', 'composeService',
    'clientHost', 'clientPort', 'backendIPv4', 'backendPort']
  if (fields.some(field => inspected[field] !== authorizedTarget[field])) stop('owned_postgres_docker_target_changed')
  if (!admin || !authorizedSystemIdentifier) stop('owned_postgres_system_identity_not_established')
  await verifyConnectedBackend(admin, 'postgres', 'postgres')
}

function discoverOwnedDockerTarget() {
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) stop('owned_docker_environment_override_refused')
  const contextNameResult = spawnSync('docker', ['context', 'show'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  if (contextNameResult.error || contextNameResult.status !== 0 || contextNameResult.signal) stop('owned_docker_context_discovery_failed')
  const contextName = contextNameResult.stdout.trim()
  const context = dockerJSON(['context', 'inspect', dockerContext])[0]
  const container = dockerJSON(['--context', dockerContext, 'inspect', dockerContainer])[0]
  return authorizeOwnedDockerContainer({ contextName, contextEndpoint: context?.Endpoints?.docker?.Host,
    dockerHostOverride: process.env.DOCKER_HOST, dockerContextOverride: process.env.DOCKER_CONTEXT, container })
}

function redact(value) {
  let output = String(value ?? '')
  for (const secret of [...Object.values(state?.passwords || {}), ...syntheticSecrets]) {
    if (secret) output = output.split(secret).join('[redacted]')
  }
  return output.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/giu, '[redacted-db-url]')
}

async function saveReport() {
  if (!evidenceDir) return
  await writeFile(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

async function connect(role, password, database) {
  const client = new Client({ connectionString: connectionString(role, password, database), connectionTimeoutMillis: 5000 })
  await client.connect()
  return client
}

async function roleSnapshot(client) {
  const roles = await client.query(`SELECT a.oid::text AS oid, a.rolname, a.rolsuper, a.rolinherit, a.rolcreaterole,
    a.rolcreatedb, a.rolcanlogin, a.rolreplication, a.rolbypassrls, a.rolconnlimit, a.rolvaliduntil::text,
    r.rolconfig, a.rolpassword FROM pg_authid a JOIN pg_roles r ON r.oid=a.oid ORDER BY a.rolname`)
  const memberships = await client.query(`SELECT granted.rolname AS granted_role, member.rolname AS member_role,
    grantor.rolname AS grantor, m.admin_option, m.inherit_option, m.set_option
    FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid=m.roleid
    JOIN pg_roles member ON member.oid=m.member
    JOIN pg_roles grantor ON grantor.oid=m.grantor
    ORDER BY granted.rolname, member.rolname, grantor.rolname`)
  return { roleHash: hash(roles.rows), membershipHash: hash(memberships.rows), rows: roles.rows }
}

async function databaseSnapshot(client) {
  const result = await client.query(`SELECT d.datname, pg_get_userbyid(d.datdba) AS owner,
    d.datallowconn, d.datconnlimit, d.datistemplate, d.encoding, d.datcollate, d.datctype,
    d.datacl::text AS acl
    FROM pg_database d ORDER BY d.datname`)
  return result.rows
}

function assertMigratorRole(snapshot) {
  const row = snapshot.rows.find(role => role.rolname === 'cms_migrator')
  if (!row || !row.rolcanlogin || row.rolsuper || row.rolcreaterole || row.rolcreatedb || row.rolreplication || row.rolbypassrls) {
    stop('existing_migrator_role_not_low_privilege')
  }
  if (row.rolpassword == null) stop('existing_migrator_password_not_provisioned')
}

async function queryDatabaseMetadata(client) {
  const rows = await databaseSnapshot(client)
  return rows
}

async function applyNewDatabaseGrants() {
  dbAdmin = await connect('postgres', state.passwords.postgres, databaseName)
  await verifyConnectedBackend(dbAdmin, databaseName, 'postgres')
  await dbAdmin.query('BEGIN')
  try {
    await dbAdmin.query('ALTER SCHEMA public OWNER TO cms_migrator')
    await dbAdmin.query(`REVOKE ALL PRIVILEGES ON DATABASE "${databaseName}" FROM PUBLIC`)
    await dbAdmin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO cms_migrator, cms_runtime`)
    await dbAdmin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await dbAdmin.query('GRANT USAGE ON SCHEMA public TO cms_runtime')
    await dbAdmin.query('ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cms_runtime')
    await dbAdmin.query('ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cms_runtime')
    await dbAdmin.query('COMMIT')
  } catch (error) {
    await dbAdmin.query('ROLLBACK').catch(() => {})
    throw error
  }
  const grants = await dbAdmin.query(`SELECT pg_get_userbyid(nspowner) AS schema_owner,
    has_schema_privilege('cms_migrator','public','CREATE') AS migrator_create,
    has_schema_privilege('cms_runtime','public','USAGE') AS runtime_usage,
    has_database_privilege('cms_runtime', current_database(), 'CONNECT') AS runtime_connect
    FROM pg_namespace WHERE nspname='public'`)
  const actual = grants.rows[0]
  if (actual?.schema_owner !== 'cms_migrator' || actual.migrator_create !== true || actual.runtime_usage !== true || actual.runtime_connect !== true) {
    stop('new_database_schema_grants_invalid')
  }
  report.databaseOwner = 'cms_migrator'
  report.schemaOwner = actual.schema_owner
  report.newDatabaseRuntimeGrants = 'new-database-only; no role membership changes'
}

async function verifyMigratorLogin() {
  migrator = await connect('cms_migrator', state.passwords.cms_migrator, databaseName)
  const identity = await verifyConnectedBackend(migrator, databaseName, 'cms_migrator')
  const result = await migrator.query(`SELECT current_user AS role, current_database() AS database,
    r.rolsuper, r.rolcreaterole,
    EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS has_membership
    FROM pg_roles r WHERE r.rolname=current_user`)
  const row = result.rows[0]
  if (!row || row.role !== identity.role || row.database !== identity.database ||
      row.rolsuper || row.rolcreaterole || row.has_membership) stop('actual_migrator_login_or_privilege_check_failed')
  report.migratorLogin = { role: row.role, database: row.database, backendAddress: identity.server_address,
    backendPort: Number(identity.server_port), systemIdentifier: identity.system_identifier,
    superuser: row.rolsuper, createRole: row.rolcreaterole, memberships: row.has_membership }
  await migrator.end()
  migrator = undefined
}

function migrationEnvironment() {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'comspec', 'pathext'].includes(key.toLowerCase())))
  const secret = () => randomBytes(36).toString('hex')
  const environment = {
    ...inherited,
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    CMS_DATABASE_URL: connectionString('cms_migrator', state.passwords.cms_migrator, databaseName),
    CMS_UPLOAD_DIR: path.join(evidenceDir, 'uploads'),
    PAYLOAD_SECRET: secret(),
    PAYLOAD_TO_PORTAL_SECRET: secret(),
    PORTAL_TO_PAYLOAD_SECRET: secret(),
    PORTAL_PUBLIC_URL: 'http://127.0.0.1:19991',
    PORTAL_INTERNAL_URL: 'http://127.0.0.1:19992',
  }
  syntheticSecrets = [environment.PAYLOAD_SECRET, environment.PAYLOAD_TO_PORTAL_SECRET, environment.PORTAL_TO_PAYLOAD_SECRET]
  // Intentionally absent: CMS_BUILD_ONLY, NEXT_PHASE, DATABASE_URL, and every
  // service or production variable not explicitly constructed above.
  return environment
}

function runPayloadMigrate(label, environment) {
  const result = spawnSync(process.execPath, ['node_modules/payload/bin.js', 'migrate'], {
    cwd: cmsRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 110000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`)
  migrationOutput = output
  const record = { label, command: 'node node_modules/payload/bin.js migrate', status: result.status, signal: result.signal || null,
    timeout: result.error?.code === 'ETIMEDOUT', spawnErrorCode: result.error?.code || null }
  report.stages.push(record)
  const log = `${output}\n# ${record.timeout ? 'timeout' : record.signal ? `signal ${record.signal}` : `exit ${record.status}`}\n`
  return writeFile(path.join(evidenceDir, `${label}.log`), log, { mode: 0o600 }).then(() => {
    if (result.status !== 0 || result.error || result.signal) stop(`${label}_failed`)
  })
}

async function migrationRows(client) {
  const result = await client.query('SELECT name, batch FROM public.payload_migrations ORDER BY name')
  return result.rows.map(row => ({ name: row.name, batch: Number(row.batch) }))
}

async function verifySchema(client) {
  const snapshotPath = path.join(cmsRoot, 'src/migrations/20261006_181424_z_owner_news_native.json')
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  const tables = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
  const columns = await client.query(`SELECT table_name, column_name, data_type, udt_name, is_nullable, datetime_precision
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name`)
  const catalog = compareNativeSnapshotCatalog(snapshot, { tables: tables.rows, columns: columns.rows })
  if (!catalog.matches) stop('native_full_snapshot_catalog_mismatch')

  const enums = await client.query(`SELECT e.enumlabel FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public' AND t.typname='enum_news_schedules_state' ORDER BY e.enumsortorder`)
  const enumLabels = enums.rows.map(row => row.enumlabel)
  if (!enumLabels.includes('suspended')) stop('suspended_schedule_enum_label_missing')

  const expectedConstraints = [
    'news_migration_runs_manifest_sha256_check', 'news_migration_runs_source_fingerprint_check',
    'news_migration_runs_source_instance_check', 'news_migration_runs_epoch_integer_check',
    'news_migration_runs_reconciliation_sequence_check', 'news_migration_runs_sealed_sequence_check',
    'news_migration_runs_reconciliation_pair_check', 'news_migration_runs_reconciliation_hashes_check',
    'news_migration_runs_exceptions_array_check', 'news_migration_runs_seal_pair_check',
    'news_migration_runs_seal_hashes_check', 'news_migration_seal_complete',
    'news_migration_items_run_uuid_check', 'news_migration_items_manifest_sha256_check',
    'news_migration_items_expected_hash_check', 'news_migration_items_observed_hash_check',
    'news_migration_items_source_identity_check', 'news_migration_items_destination_id_check',
    'news_migration_items_verified_consistency_check', 'news_schedules_actor_uid_check',
    'news_schedules_import_epoch_check', 'news_schedules_snapshot_hash_check',
    'news_schedules_import_provenance_shape_check', 'legacy_news_revisions_metadata_basis_check',
  ]
  const constraints = await client.query(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='public'`)
  const actualConstraints = new Set(constraints.rows.map(row => row.conname))
  const missingConstraints = expectedConstraints.filter(name => !actualConstraints.has(name))
  if (missingConstraints.length) stop('native_custom_constraints_missing')

  const expectedIndexes = Object.values(snapshot.tables).flatMap(table => Object.values(table.indexes || {}).map(index => ({
    table: table.name, name: index.name, unique: Boolean(index.isUnique), method: index.method,
  })))
  const indexes = await client.query(`SELECT t.relname AS table_name, i.relname AS index_name,
    ix.indisunique AS is_unique, am.amname AS method
    FROM pg_index ix JOIN pg_class t ON t.oid=ix.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_am am ON am.oid=i.relam
    WHERE n.nspname='public' ORDER BY t.relname,i.relname`)
  const actualIndexes = new Map(indexes.rows.map(row => [`${row.table_name}.${row.index_name}`, row]))
  const missingIndexes = expectedIndexes.filter(expected => {
    const actual = actualIndexes.get(`${expected.table}.${expected.name}`)
    return !actual || actual.is_unique !== expected.unique || actual.method !== expected.method
  })
  if (missingIndexes.length) stop('native_snapshot_indexes_missing_or_mismatched')

  const selectedColumns = Object.fromEntries(columns.rows.filter(row => [
    'news_migration_runs.reconciliation_sequence', 'news_migration_runs.sealed_sequence',
    'news_migration_runs.authority_epoch', 'news_migration_items.run_id', 'news_schedules.source_snapshot',
    'news_schedules.source_schedule_key', 'legacy_news_revisions.metadata_basis',
  ].includes(`${row.table_name}.${row.column_name}`)).map(row => [
    `${row.table_name}.${row.column_name}`, { type: row.data_type, nullable: row.is_nullable === 'YES' },
  ]))
  if (selectedColumns['news_migration_runs.reconciliation_sequence']?.type !== 'character varying' ||
      selectedColumns['news_migration_runs.sealed_sequence']?.type !== 'character varying' ||
      selectedColumns['news_migration_runs.authority_epoch']?.type !== 'numeric' ||
      selectedColumns['news_migration_items.run_id']?.type !== 'character varying' ||
      selectedColumns['news_schedules.source_snapshot']?.type !== 'jsonb' ||
      selectedColumns['legacy_news_revisions.metadata_basis']?.type !== 'jsonb') stop('native_exact_string_or_json_schema_mismatch')
  report.schema = { snapshotCatalog: catalog, snapshotIndexes: { expected: expectedIndexes.length,
      matched: expectedIndexes.length - missingIndexes.length, actualInPublicSchema: indexes.rowCount,
      additionalOrUnmatchedCount: indexes.rowCount - expectedIndexes.length,
      comparison: 'snapshot index name, uniqueness, and access method; expressions are not compared' },
    nativeCustomConstraints: { expected: expectedConstraints.length, matched: expectedConstraints.length,
      comparison: 'required native custom constraint names present; targeted check semantics exercised by isolated fixtures' },
    mutationInventoryRelations: 39, enumSuspendedPresent: true, requiredNativeColumns: selectedColumns, coverageVersion: 0 }
}

async function insertRun(client, values = {}) {
  const row = {
    id: randomUUID(), manifest: values.manifest || 'b'.repeat(64), sourceFingerprint: 'a'.repeat(64),
    sourceInstance: 'native-migration-fixture', epoch: values.epoch ?? 1,
    progress: values.progress || 'preparing', admission: values.admission || 'open', outcome: 'acknowledged',
    reconciliationSequence: values.reconciliationSequence ?? null,
    reconciliationChain: values.reconciliationChain ?? null,
    reconciliationHash: values.reconciliationHash ?? null,
    destinationFingerprint: values.destinationFingerprint ?? null,
    exceptions: '[]', sealedSequence: values.sealedSequence ?? null,
    sealedChain: values.sealedChain ?? null, sealedAt: values.sealedAt ?? null,
    activationEpoch: values.activationEpoch ?? null, drainHash: values.drainHash ?? null,
  }
  await client.query(`INSERT INTO public.news_migration_runs (
      id,manifest_sha256,source_instance,source_fingerprint,authority_epoch,progress_state,admission_state,commit_outcome,
      reconciliation_sequence,reconciliation_chain_sha256,reconciliation_sha256,destination_fingerprint,unresolved_exceptions,
      sealed_sequence,sealed_chain_sha256,sealed_at,activation_epoch,drain_receipt_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)`,
  [row.id,row.manifest,row.sourceInstance,row.sourceFingerprint,row.epoch,row.progress,row.admission,row.outcome,
    row.reconciliationSequence,row.reconciliationChain,row.reconciliationHash,row.destinationFingerprint,row.exceptions,
    row.sealedSequence,row.sealedChain,row.sealedAt,row.activationEpoch,row.drainHash])
  return row
}

async function acceptsRollbackFixture(client, label, action) {
  await client.query('BEGIN')
  try {
    const details = await action()
    await client.query('ROLLBACK')
    report.fixtures.push({ label, result: 'accepted-and-rolled-back', details: details || null })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

async function rejectsCheckFixture(client, label, constraint, action) {
  await client.query('BEGIN')
  let caught
  try { await action() } catch (error) { caught = error }
  await client.query('ROLLBACK').catch(() => {})
  if (!caught || caught.code !== '23514' || caught.constraint !== constraint) stop(`${label}_did_not_fail_expected_check`)
  report.fixtures.push({ label, result: 'rejected-and-rolled-back', sqlState: caught.code, constraint: caught.constraint })
}

async function insertItem(client, run, options = {}) {
  await client.query(`INSERT INTO public.news_migration_items
      (run_id,manifest_sha256,entity_kind,source_id,expected_hash,destination_id,observed_hash,state,commit_outcome)
    VALUES ($1,$2,'asset',$3,$4,NULL,$5,$6,'acknowledged')`,
  [run.id,run.manifest,options.sourceId || randomUUID(),options.expectedHash || 'c'.repeat(64),options.observedHash ?? null,options.state || 'planned'])
}

async function insertSchedule(client, run, options = {}) {
  const documentId = options.documentId || randomUUID()
  const revisionId = options.revisionId || randomUUID()
  const instant = '2026-10-06T12:00:00Z'
  const nativeHash = 'd'.repeat(64)
  const snapshot = JSON.stringify({ blocks: [] })
  const sourceSnapshot = JSON.stringify({ legacy: true })
  const stateName = options.state || 'suspended'
  const sourceFields = stateName === 'suspended' ? [
    `${documentId}/${revisionId}/${instant}`, revisionId, run.id, run.manifest, run.epoch || 1,
    instant, 'not_recorded', sourceSnapshot, 'e'.repeat(64), nativeHash,
  ] : [null,null,null,null,null,null,null,null,null,null]
  await client.query(`INSERT INTO public.news_schedules (
      target,document_id,action,version_id,snapshot,snapshot_hash,scheduled_at,actor_uid,generation,state,
      source_schedule_key,source_revision_id,import_run_id,import_manifest_sha256,import_authority_epoch,
      original_scheduled_at,original_actor_evidence,source_snapshot,source_snapshot_hash,native_snapshot_hash)
    VALUES ('news-articles',$1,'publish',$2,$3::jsonb,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`,
  [documentId,revisionId,snapshot,nativeHash,'2026-10-06T12:00:00.000Z',options.actorUid ?? null,stateName,...sourceFields])
}

async function insertLegacyRevision(client, options = {}) {
  const publishedAt = options.publishedAt ?? null
  const metadataBasis = options.metadataBasis === undefined ? null : options.metadataBasis
  await client.query(`INSERT INTO public.legacy_news_revisions (
      legacy_document_id,legacy_revision_id,original_version,original_created_at,original_actor_uid,original_status,
      original_title,original_category,original_published_at,original_body,original_editorial,content_hash,provenance_hash,metadata_basis)
    VALUES ($1,$2,1,'2026-10-06T12:00:00.000Z',NULL,'draft','Synthetic fixture',NULL,$3,'{}'::jsonb,NULL,$4,$5,$6::jsonb)`,
  [options.documentId || randomUUID(),options.revisionId || randomUUID(),publishedAt,'f'.repeat(64),'a'.repeat(64),
    metadataBasis === null ? null : JSON.stringify(metadataBasis)])
}

async function exerciseConstraints(client) {
  report.fixtures = []
  await acceptsRollbackFixture(client, 'prepared_run_counter_zero_exact_string', async () => {
    const run = await insertRun(client, { reconciliationSequence: '0', reconciliationChain: 'c'.repeat(64) })
    const value = await client.query('SELECT reconciliation_sequence FROM public.news_migration_runs WHERE id=$1', [run.id])
    if (value.rows[0].reconciliation_sequence !== '0') stop('counter_zero_not_exact_string')
    return { counter: value.rows[0].reconciliation_sequence }
  })
  await acceptsRollbackFixture(client, 'prepared_run_counter_bigint_max_exact_string', async () => {
    const value = '9223372036854775807'
    const run = await insertRun(client, { reconciliationSequence: value, reconciliationChain: 'c'.repeat(64) })
    const row = await client.query('SELECT reconciliation_sequence FROM public.news_migration_runs WHERE id=$1', [run.id])
    if (row.rows[0].reconciliation_sequence !== value) stop('counter_bigint_max_not_exact_string')
    return { counter: row.rows[0].reconciliation_sequence }
  })
  await acceptsRollbackFixture(client, 'sealed_run_counter_bigint_max_exact_string', async () => {
    const max = '9223372036854775807', chain = 'c'.repeat(64)
    const run = await insertRun(client, { progress: 'reconciled', admission: 'sealed', reconciliationSequence: max,
      reconciliationChain: chain, reconciliationHash: 'd'.repeat(64), destinationFingerprint: 'e'.repeat(64),
      sealedSequence: max, sealedChain: chain, sealedAt: '2026-10-06T12:00:00Z', activationEpoch: 2, drainHash: 'f'.repeat(64) })
    const row = await client.query('SELECT reconciliation_sequence,sealed_sequence,activation_epoch FROM public.news_migration_runs WHERE id=$1', [run.id])
    if (row.rows[0].reconciliation_sequence !== max || row.rows[0].sealed_sequence !== max || Number(row.rows[0].activation_epoch) !== 2) stop('sealed_counter_or_epoch_mismatch')
    return { reconciliationSequence: row.rows[0].reconciliation_sequence, sealedSequence: row.rows[0].sealed_sequence, activationEpoch: 2 }
  })
  await rejectsCheckFixture(client, 'counter_above_bigint_max_rejected', 'news_migration_runs_reconciliation_sequence_check',
    () => insertRun(client, { reconciliationSequence: '9223372036854775808', reconciliationChain: 'c'.repeat(64) }))
  await rejectsCheckFixture(client, 'negative_counter_rejected', 'news_migration_runs_reconciliation_sequence_check',
    () => insertRun(client, { reconciliationSequence: '-1', reconciliationChain: 'c'.repeat(64) }))
  await rejectsCheckFixture(client, 'leading_zero_counter_rejected', 'news_migration_runs_reconciliation_sequence_check',
    () => insertRun(client, { reconciliationSequence: '01', reconciliationChain: 'c'.repeat(64) }))
  await rejectsCheckFixture(client, 'authority_epoch_plus_one_overflow_rejected', 'news_migration_runs_epoch_integer_check',
    () => insertRun(client, { epoch: 2147483647 }))
  await rejectsCheckFixture(client, 'sealed_null_activation_epoch_rejected', 'news_migration_seal_complete', () => insertRun(client, {
    progress: 'reconciled', admission: 'sealed', reconciliationSequence: '0', reconciliationChain: 'c'.repeat(64),
    reconciliationHash: 'd'.repeat(64), destinationFingerprint: 'e'.repeat(64), sealedSequence: '0',
    sealedChain: 'c'.repeat(64), sealedAt: '2026-10-06T12:00:00Z', activationEpoch: null, drainHash: 'f'.repeat(64),
  }))

  await acceptsRollbackFixture(client, 'planned_item_null_observation_accepted', async () => {
    const run = await insertRun(client)
    await insertItem(client, run)
    return { state: 'planned', observedHash: null }
  })
  await rejectsCheckFixture(client, 'verified_item_null_observation_rejected', 'news_migration_items_verified_consistency_check', async () => {
    const run = await insertRun(client)
    await insertItem(client, run, { state: 'verified', observedHash: null })
  })

  await acceptsRollbackFixture(client, 'suspended_schedule_provenance_accepted', async () => {
    const run = await insertRun(client)
    await insertSchedule(client, run)
    return { state: 'suspended', actorUid: null, runBound: true }
  })
  await rejectsCheckFixture(client, 'suspended_schedule_actor_rejected', 'news_schedules_import_provenance_shape_check', async () => {
    const run = await insertRun(client)
    await insertSchedule(client, run, { actorUid: 'synthetic-actor' })
  })
  await acceptsRollbackFixture(client, 'native_schedule_null_import_binding_accepted', async () => {
    const run = { id: randomUUID(), manifest: 'b'.repeat(64) }
    await insertSchedule(client, run, { state: 'pending', actorUid: 'synthetic-native-actor' })
    return { state: 'pending', importRunId: null, actorUid: 'synthetic-native-actor' }
  })

  await acceptsRollbackFixture(client, 'legacy_history_null_metadata_basis_accepted', async () => {
    await insertLegacyRevision(client)
    return { metadataBasis: null }
  })
  await acceptsRollbackFixture(client, 'legacy_history_unknown_metadata_basis_accepted', async () => {
    await insertLegacyRevision(client, { metadataBasis: { title: 'document_snapshot', category: 'document_snapshot', publishedAt: 'unknown' } })
    return { metadataBasis: 'unknown' }
  })
  await acceptsRollbackFixture(client, 'legacy_history_published_pointer_basis_accepted', async () => {
    await insertLegacyRevision(client, { publishedAt: '2026-10-06T12:00:00.000Z', metadataBasis: { title: 'document_snapshot', category: 'document_snapshot', publishedAt: 'published_pointer' } })
    return { metadataBasis: 'published_pointer' }
  })
  await rejectsCheckFixture(client, 'legacy_history_invalid_metadata_basis_rejected', 'legacy_news_revisions_metadata_basis_check', () =>
    insertLegacyRevision(client, { metadataBasis: { title: 'invented', category: 'document_snapshot', publishedAt: 'unknown' } }))
}

async function main() {
  if (process.argv[2] === '--discover-owned-target') {
    const target = discoverOwnedDockerTarget()
    console.log(JSON.stringify(target))
    return
  }
  state = JSON.parse(await readFile(statePath, 'utf8'))
  if (!state.passwords || typeof state.passwords.postgres !== 'string' || !state.passwords.postgres ||
      typeof state.passwords.cms_migrator !== 'string' || !state.passwords.cms_migrator ||
      typeof state.passwords.cms_runtime !== 'string' || !state.passwords.cms_runtime) stop('approved_private_role_credentials_unavailable')
  const repoReal = await realpath(root)
  const baseReal = await realpath(base)
  if (baseReal === repoReal || baseReal.startsWith(`${repoReal}${path.sep}`) || repoReal.startsWith(`${baseReal}${path.sep}`)) stop('private_evidence_path_overlaps_checkout')

  authorizedTarget = discoverOwnedDockerTarget()
  report.ownedTarget = authorizedTarget
  report.status = 'guarded_preflight'

  if (process.argv[2] === '--readonly-catalog') {
    databaseName = process.argv[3]
    if (!/^cms_native_test_[a-f0-9]{12}$/u.test(databaseName || '')) stop('readonly_database_name_not_allowlisted')
    evidenceDir = path.join(base, `ownerinc-native-catalog-readonly-${randomBytes(6).toString('hex')}`)
    await mkdir(evidenceDir, { recursive: false, mode: 0o700 })
    report.database = databaseName
    report.evidenceDirectory = evidenceDir
    report.mode = 'readonly_catalog'
    report.databaseCreated = false
    report.ddlPerformed = false
    stage = 'readonly_admin_backend_verification'
    admin = await connect('postgres', state.passwords.postgres, 'postgres')
    const adminIdentity = await verifyConnectedBackend(admin, 'postgres', 'postgres')
    report.server = { clientEndpoint: { host, port }, backendIPv4: authorizedTarget.backendIPv4,
      backendPort: authorizedTarget.backendPort, systemIdentifier: adminIdentity.system_identifier, adminRole: 'postgres' }
    report.serverMajorVersion = 16
    stage = 'readonly_existing_database_catalog'
    migrator = await connect('cms_migrator', state.passwords.cms_migrator, databaseName)
    await verifyConnectedBackend(migrator, databaseName, 'cms_migrator')
    await migrator.query('BEGIN READ ONLY')
    const rows = await migrationRows(migrator)
    if (JSON.stringify(rows.map(row => row.name)) !== JSON.stringify(expectedMigrations) || rows.length !== expectedMigrations.length) {
      stop('readonly_existing_database_migration_ledger_mismatch')
    }
    report.firstMigrationLedger = rows
    await verifySchema(migrator)
    await migrator.query('ROLLBACK')
    report.status = 'pass'
    report.coverageVersion = 0
    return
  }
  if (process.argv[2] !== undefined && process.argv[2] !== '') stop('unknown_native_migration_mode')

  const suffix = randomBytes(6).toString('hex')
  databaseName = `cms_native_test_${suffix}`
  evidenceDir = path.join(base, `ownerinc-native-migrations-${suffix}`)
  await mkdir(evidenceDir, { recursive: false, mode: 0o700 })
  await mkdir(path.join(evidenceDir, 'uploads'), { recursive: false, mode: 0o700 })
  const uploadReal = await realpath(path.join(evidenceDir, 'uploads'))
  if (uploadReal === repoReal || uploadReal.startsWith(`${repoReal}${path.sep}`)) stop('native_upload_path_inside_checkout')
  report.database = databaseName
  report.evidenceDirectory = evidenceDir
  report.uploadDirectory = uploadReal
  report.status = 'preflight'

  stage = 'admin_target_verification'
  admin = await connect('postgres', state.passwords.postgres, 'postgres')
  const server = await verifyConnectedBackend(admin, 'postgres', 'postgres')
  const version = await admin.query(`SELECT current_setting('server_version_num')::integer AS version_num,
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)
  if (Math.floor(Number(version.rows[0]?.version_num) / 10000) !== 16 || version.rows[0]?.superuser !== true) {
    stop('approved_postgres_version_or_admin_mismatch')
  }
  report.server = { clientEndpoint: { host, port }, backendIPv4: authorizedTarget.backendIPv4,
    backendPort: authorizedTarget.backendPort, systemIdentifier: server.system_identifier,
    majorVersion: 16, adminRole: 'postgres' }

  const beforeRoles = await roleSnapshot(admin)
  assertMigratorRole(beforeRoles)
  const runtimeRole = beforeRoles.rows.find(role => role.rolname === 'cms_runtime')
  if (!runtimeRole || !runtimeRole.rolcanlogin || runtimeRole.rolsuper || runtimeRole.rolcreaterole) stop('existing_runtime_role_not_expected')
  const beforeDatabases = await queryDatabaseMetadata(admin)
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName])
  if (existing.rowCount) stop('target_database_already_exists_refusing_overwrite')
  report.roleBaseline = { migratorLogin: true, migratorSuperuser: false, migratorCreateRole: false,
    roleAttributesAndPasswordHash: beforeRoles.roleHash, memberships: beforeRoles.membershipHash }
  report.preexistingDatabaseCount = beforeDatabases.length

  stage = 'create_only_new_database'
  await revalidateOwnedTarget()
  // Name is generated and strictly allowlisted. No existing DB is altered.
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER cms_migrator TEMPLATE template0`)
  dbCreated = true
  report.databaseCreated = true

  stage = 'new_database_schema_and_grants'
  await applyNewDatabaseGrants()
  stage = 'verify_actual_low_privilege_migrator_login'
  await verifyMigratorLogin()

  stage = 'payload_migrate_first'
  await revalidateOwnedTarget()
  report.status = 'migrating'
  const env = migrationEnvironment()
  await runPayloadMigrate('migrate-first', env)

  stage = 'verify_first_migration_ledger'
  migrator = await connect('cms_migrator', state.passwords.cms_migrator, databaseName)
  const firstRows = await migrationRows(migrator)
  if (JSON.stringify(firstRows.map(row => row.name)) !== JSON.stringify(expectedMigrations) || firstRows.length !== 6) stop('first_migration_ledger_not_exactly_six')
  report.firstMigrationLedger = firstRows
  await verifySchema(migrator)
  await exerciseConstraints(migrator)

  stage = 'payload_migrate_repeat'
  await migrator.end()
  migrator = undefined
  await revalidateOwnedTarget()
  await runPayloadMigrate('migrate-repeat', env)
  stage = 'verify_repeat_idempotence'
  migrator = await connect('cms_migrator', state.passwords.cms_migrator, databaseName)
  const secondRows = await migrationRows(migrator)
  if (!compareRows(firstRows, secondRows) || secondRows.length !== 6) stop('repeat_migration_changed_ledger')
  report.repeatMigrationLedger = secondRows
  report.repeatAddedRows = secondRows.length - firstRows.length
  if (report.repeatAddedRows !== 0) stop('repeat_migration_added_rows')

  stage = 'verify_global_preservation'
  const afterRoles = await roleSnapshot(admin)
  const afterDatabases = await queryDatabaseMetadata(admin)
  const afterOld = afterDatabases.filter(row => row.datname !== databaseName)
  const added = afterDatabases.filter(row => !beforeDatabases.some(old => old.datname === row.datname))
  if (afterRoles.roleHash !== beforeRoles.roleHash || afterRoles.membershipHash !== beforeRoles.membershipHash) stop('global_roles_or_memberships_changed')
  if (!compareRows(beforeDatabases, afterOld) || added.length !== 1 || added[0].datname !== databaseName || added[0].owner !== 'cms_migrator') {
    stop('preexisting_database_catalog_changed_or_unexpected_database_added')
  }
  report.preservation = { allRoleAttributesAndPasswordHashesUnchanged: true, allRoleMembershipsUnchanged: true,
    allPreexistingDatabaseCatalogEntriesUnchanged: true, onlyOneNewDatabase: databaseName }
  report.status = 'pass'
  report.nativePayloadCrudOrJobAcceptance = 'NOT_RUN'
  report.protocolFinalizer = 'NOT_INSTALLED'
  report.coverageVersion = 0
}

if (directRun) {
  try {
    await main()
  } catch (error) {
    report.status = dbCreated ? 'failed_database_preserved' : 'blocked_before_database_creation'
    report.failure = { stage, code: error?.code || 'native_migration_probe_failed',
      sqlState: error?.code && /^[0-9A-Z]{5}$/u.test(error.code) ? error.code : undefined,
      diagnostic: error?.code && /^[0-9A-Z]{5}$/u.test(error.code) ? redact(error.message).slice(0, 500) : undefined }
    if (migrationOutput) report.failure.sanitizedMigrationOutput = redact(migrationOutput).slice(-12000)
    if (dbCreated) report.databasePreservedForFollowup = true
    console.error(`native-migrations: ${stage}: ${report.failure.code}`)
    if (migrationOutput) console.error(redact(migrationOutput).slice(-6000))
    process.exitCode = 1
  } finally {
    await migrator?.end().catch(() => {})
    await dbAdmin?.end().catch(() => {})
    await admin?.end().catch(() => {})
    await saveReport().catch(() => {})
    if (evidenceDir) console.log(`native-migrations evidence: ${evidenceDir}`)
  }

  if (report.status === 'pass') {
    console.log(report.mode === 'readonly_catalog'
      ? `native-migrations: READONLY CATALOG PASS database=${databaseName} tables=${report.schema.snapshotCatalog.actualTables} columns=${report.schema.snapshotCatalog.actualColumns} coverage=0`
      : `native-migrations: PASS database=${databaseName} migrations=${expectedMigrations.length} coverage=0`)
  }
}
