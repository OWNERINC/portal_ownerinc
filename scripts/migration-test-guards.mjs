const migrationClusterIdPattern = /^\d{8,30}$/;

export function requireDisposableMigrationEnvironment() {
  if (process.env.NODE_ENV === 'production') throw new Error('Migration integration test cannot run with NODE_ENV=production');
  if (process.env.MIGRATION_TEST_DISPOSABLE !== 'true') throw new Error('MIGRATION_TEST_DISPOSABLE=true is required');
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
  const clusterId = process.env.MIGRATION_TEST_CLUSTER_ID;
  if (!clusterId) throw new Error('MIGRATION_TEST_CLUSTER_ID is required');
  if (!migrationClusterIdPattern.test(clusterId)) {
    throw new Error('MIGRATION_TEST_CLUSTER_ID must be the PostgreSQL system identifier');
  }
  return clusterId;
}

export async function assertApprovedMigrationCluster(client, expectedClusterId = process.env.MIGRATION_TEST_CLUSTER_ID) {
  const { rows: [row] } = await client.query(`
    SELECT current_database() AS database_name,
      system_identifier::text AS cluster_id
    FROM pg_control_system()`);
  if (row?.cluster_id !== expectedClusterId) {
    throw new Error(
      `Migration test database is not on the approved disposable cluster; expected marker ${expectedClusterId || 'unset'}, observed ${row?.cluster_id || 'unset'}`,
    );
  }
  return row;
}

export function assertEmptyMigrationDatabase(objects) {
  if (objects.length > 0) {
    throw new Error('Migration setup requires an empty disposable database; no database objects are dropped');
  }
}
