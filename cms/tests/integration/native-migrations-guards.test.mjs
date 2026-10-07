import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertOwnedBackendIdentity,
  authorizeOwnedDockerContainer,
  compareNativeSnapshotCatalog,
} from './native-migrations.mjs'

const targetInput = () => ({
  contextName: 'desktop-linux',
  contextEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine',
  dockerHostOverride: undefined,
  dockerContextOverride: undefined,
  container: {
    Name: '/ownerinc-payload-local-postgres-1',
    State: { Running: true },
    Config: {
      Image: 'postgres:16-alpine',
      Labels: { 'com.docker.compose.project': 'ownerinc-payload-local', 'com.docker.compose.service': 'postgres' },
    },
    NetworkSettings: { Networks: { 'ownerinc-payload-local_default': { IPAddress: '172.21.0.2' } } },
    HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55441' }] } },
  },
})

const validSnapshot = () => ({
  tables: {
    'public.native_runs': {
      name: 'native_runs',
      columns: {
        id: { name: 'id', type: 'uuid', notNull: true },
        counter: { name: 'counter', type: 'varchar', notNull: false },
        state: { name: 'state', type: 'enum_native_runs_state', notNull: true },
        labels: { name: 'labels', type: 'varchar[]', notNull: true },
        created_at: { name: 'created_at', type: 'timestamp(3) with time zone', notNull: true },
      },
      indexes: {},
    },
    'public.payload_migrations': {
      name: 'payload_migrations',
      columns: { id: { name: 'id', type: 'serial', notNull: true } },
      indexes: {},
    },
  },
})

const validCatalog = () => ({
  tables: [{ tablename: 'native_runs' }, { tablename: 'payload_migrations' }],
  columns: [
    { table_name: 'native_runs', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
    { table_name: 'native_runs', column_name: 'counter', data_type: 'character varying', udt_name: 'varchar', is_nullable: 'YES' },
    { table_name: 'native_runs', column_name: 'state', data_type: 'USER-DEFINED', udt_name: 'enum_native_runs_state', is_nullable: 'NO' },
    { table_name: 'native_runs', column_name: 'labels', data_type: 'ARRAY', udt_name: '_varchar', is_nullable: 'NO' },
    { table_name: 'native_runs', column_name: 'created_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', datetime_precision: '3', is_nullable: 'NO' },
    { table_name: 'payload_migrations', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO' },
  ],
})

function target() { return authorizeOwnedDockerContainer(targetInput()) }

test('owned Docker guard binds the exact local context, Compose service, network backend and loopback port', () => {
  assert.deepEqual(target(), {
    contextName: 'desktop-linux', contextEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine',
    container: 'ownerinc-payload-local-postgres-1', composeProject: 'ownerinc-payload-local', composeService: 'postgres',
    clientHost: '127.0.0.1', clientPort: 55441, backendIPv4: '172.21.0.2', backendPort: 5432,
  })
})

test('owned Docker guard rejects remote overrides and wrong context/container identity', () => {
  for (const change of [
    input => { input.dockerHostOverride = 'tcp://remote:2376' },
    input => { input.dockerContextOverride = 'remote' },
    input => { input.contextName = 'remote' },
    input => { input.contextEndpoint = 'tcp://remote:2376' },
    input => { input.container.Name = '/unrelated-postgres' },
    input => { input.container.Config.Labels['com.docker.compose.project'] = 'other-project' },
    input => { input.container.Config.Labels['com.docker.compose.service'] = 'other-service' },
    input => { input.container.State.Running = false },
    input => { input.container.Config.Image = 'postgres:15-alpine' },
  ]) {
    const input = targetInput()
    change(input)
    assert.throws(() => authorizeOwnedDockerContainer(input), /owned_docker_|owned_postgres_container_/u)
  }
})

test('owned Docker guard rejects ambiguous networks and any port binding beyond exact loopback mapping', () => {
  const multipleNetworks = targetInput()
  multipleNetworks.container.NetworkSettings.Networks.other = { IPAddress: '172.22.0.2' }
  assert.throws(() => authorizeOwnedDockerContainer(multipleNetworks), /owned_postgres_container_network_ambiguous/u)

  for (const binding of [
    [{ HostIp: '0.0.0.0', HostPort: '55441' }],
    [{ HostIp: '127.0.0.1', HostPort: '5432' }],
    [{ HostIp: '127.0.0.1', HostPort: '55441' }, { HostIp: '127.0.0.1', HostPort: '55442' }],
  ]) {
    const input = targetInput()
    input.container.HostConfig.PortBindings['5432/tcp'] = binding
    assert.throws(() => authorizeOwnedDockerContainer(input), /owned_postgres_loopback_binding_mismatch/u)
  }
})

test('backend guard requires inspected container IPv4, backend port 5432, and stable PostgreSQL system identifier', () => {
  const authorized = target()
  const id = '7654321098765432109'
  assert.equal(assertOwnedBackendIdentity(authorized, {
    server_address: '172.21.0.2/32', server_port: 5432, system_identifier: id,
  }), id)
  assert.throws(() => assertOwnedBackendIdentity(authorized, {
    server_address: '172.21.0.9', server_port: 5432, system_identifier: id,
  }), /owned_postgres_backend_identity_mismatch/u)
  assert.throws(() => assertOwnedBackendIdentity(authorized, {
    server_address: '172.21.0.2', server_port: 55441, system_identifier: id,
  }), /owned_postgres_backend_identity_mismatch/u)
  assert.throws(() => assertOwnedBackendIdentity(authorized, {
    server_address: '172.21.0.2', server_port: 5432, system_identifier: '9876543210987654321',
  }, id), /owned_postgres_backend_identity_mismatch/u)
})

test('snapshot catalog comparator matches all tables and columns including enums, arrays, serial aliases, and nullability', () => {
  const comparison = compareNativeSnapshotCatalog(validSnapshot(), validCatalog())
  assert.equal(comparison.matches, true)
  assert.deepEqual({ tables: comparison.actualTables, columns: comparison.actualColumns }, { tables: 2, columns: 6 })
})

test('snapshot catalog comparator detects missing and unexpected tables and columns', () => {
  const snapshot = validSnapshot()
  const catalog = validCatalog()
  catalog.tables.push({ tablename: 'unexpected_table' })
  catalog.columns.push({ table_name: 'native_runs', column_name: 'unexpected_column', data_type: 'text', udt_name: 'text', is_nullable: 'YES' })
  catalog.tables = catalog.tables.filter(table => table.tablename !== 'payload_migrations')
  catalog.columns = catalog.columns.filter(column => column.table_name !== 'payload_migrations')
  const result = compareNativeSnapshotCatalog(snapshot, catalog)
  assert.equal(result.matches, false)
  assert.deepEqual(result.mismatches.missingTables, ['payload_migrations'])
  assert.deepEqual(result.mismatches.unexpectedTables, ['unexpected_table'])
  assert.ok(result.mismatches.missingColumns.includes('payload_migrations.id'))
  assert.deepEqual(result.mismatches.unexpectedColumns, ['native_runs.unexpected_column'])
})

test('snapshot catalog comparator detects type and nullability mismatches', () => {
  const catalog = validCatalog()
  const counter = catalog.columns.find(column => column.column_name === 'counter')
  counter.data_type = 'text'
  counter.udt_name = 'text'
  counter.is_nullable = 'NO'
  const result = compareNativeSnapshotCatalog(validSnapshot(), catalog)
  assert.equal(result.matches, false)
  assert.deepEqual(result.mismatches.typeMismatches, [{ column: 'native_runs.counter', expected: 'varchar', actual: 'text', udt: 'text' }])
  assert.deepEqual(result.mismatches.nullabilityMismatches, [{ column: 'native_runs.counter', expectedNotNull: false, actual: 'NO' }])
})
