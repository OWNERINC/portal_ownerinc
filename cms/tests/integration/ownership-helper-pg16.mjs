import assert from 'node:assert/strict'
import pg from 'pg'
import {
  clusterOwnershipHelperSQL,
  clusterOwnershipHelperVerificationSQL,
} from '../../scripts/provision-db.ts'

const connectionString = process.env.CMS_OWNERSHIP_HELPER_TEST_DATABASE_URL
if (process.env.CMS_OWNERSHIP_HELPER_TEST_DISPOSABLE !== 'true' || !connectionString) {
  throw new Error('Explicit disposable PostgreSQL 16 fixture required')
}

const client = new pg.Client({ connectionString, application_name: 'cms-ownership-helper-pg16-test' })
try {
  await client.connect()
  const identity = await client.query('SELECT current_database() AS database, version() AS version')
  assert.equal(identity.rows[0]?.database, 'portal_test')
  assert.match(identity.rows[0]?.version ?? '', /^PostgreSQL 16\./u)
  await client.query('BEGIN')
  await client.query(`DO $roles$
  DECLARE role_name text;
  BEGIN
    FOREACH role_name IN ARRAY ARRAY['cms_admin','cms_observer','cms_control','cms_controller','cms_migrator','cms_runtime'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      END IF;
    END LOOP;
  END
  $roles$;`)
  await client.query(clusterOwnershipHelperSQL)
  const contract = await client.query(clusterOwnershipHelperVerificationSQL)
  assert.equal(contract.rows[0]?.safe, true)
  const execution = await client.query('SELECT * FROM cms_cluster_guard.verify_cms_ownership_contract()')
  assert.equal(typeof execution.rows[0]?.safe, 'boolean')
  await client.query('ROLLBACK')
  console.log('CMS ownership helper installed and executed on disposable PostgreSQL 16')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  await client.end().catch(() => {})
}
