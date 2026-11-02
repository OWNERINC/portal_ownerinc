// Mounted ONLY by the selected editorial disposable lease. Not shipped in the CMS image.
import assert from 'node:assert/strict'
import pg from 'pg'
import { pathToFileURL } from 'node:url'
import { run as provision } from '../../scripts/provision-db'
import { runFinalizer } from '../../scripts/finalize-news-protocol'

const defaults = { client: (url: string) => new pg.Client({ connectionString: url }), provision, finalize: runFinalizer }

export async function bootstrapEditorialFixture(action: string, env: Record<string, string | undefined>, dependencies = defaults) {
assert.match(env.PAYLOAD_FUNCTIONAL_RUN_ID || '', /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u)
assert.ok(['provision', 'protocol'].includes(action))
const url = new URL((action === 'provision' ? env.CMS_DATABASE_URL : env.CMS_ADMIN_DATABASE_URL) || '')
assert.equal(url.hostname, 'cms-db'); assert.equal(url.port, '5432'); assert.equal(env.CMS_PORTAL_DATABASE_NAME, 'postgres')
assert.equal(url.protocol, 'postgresql:'); assert.equal(url.search, ''); assert.equal(url.hash, ''); assert.ok(url.password)
if (action === 'provision') {
  assert.equal(url.username, 'cms_cluster'); assert.equal(url.pathname, '/postgres')
  const cluster = dependencies.client(url.href); await cluster.connect()
  try {
    assert.equal((await cluster.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='cms_admin'")).rows[0].n, 0)
    // Empty, physically inspected fixture only. The official bootstrap requires this owner.
    await cluster.query('CREATE ROLE cms_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT')
    await cluster.query('ALTER DATABASE ownerinc_cms OWNER TO cms_admin')
  } finally { await cluster.end() }
  await dependencies.provision('--bootstrap-database', env)
  url.username = 'cms_admin'; url.password = env.CMS_POSTGRES_PASSWORD!; url.pathname = '/ownerinc_cms'
  const owner = { ...env, CMS_DATABASE_URL: url.href }
  await dependencies.provision('--provision', owner); await dependencies.provision('--bootstrap-control', owner)
} else {
  assert.equal(url.username, 'cms_admin'); assert.equal(url.pathname, '/ownerinc_cms')
  assert.deepEqual(await dependencies.finalize(env), { installed: true, ready: false, coverageVersion: 0 })
  const db = dependencies.client(url.href); await db.connect()
  try {
    await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(7194030)')
    const head = (await db.query(`SELECT sequence::text,chain_sha256,coverage_version,write_barrier,
      (SELECT count(*)::int FROM news_articles) articles,(SELECT count(*)::int FROM news_media) media,
      (SELECT count(*)::int FROM news_home) home FROM owner_news_mutation_head WHERE singleton=true FOR UPDATE`)).rows
    assert.deepEqual(head, [{ sequence: '0', chain_sha256: '0'.repeat(64), coverage_version: 0, write_barrier: 'open', articles: 0, media: 0, home: 0 }])
    await db.query('UPDATE owner_news_mutation_head SET coverage_version=1 WHERE singleton=true AND coverage_version=0')
    await db.query('COMMIT')
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { await db.end() }
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bootstrapEditorialFixture(process.argv[2], process.env)
}
