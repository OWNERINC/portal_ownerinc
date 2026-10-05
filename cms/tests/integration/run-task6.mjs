// Destructive ONLY to the dedicated Task6 disposable database. No caller DB URL/default env.
import { createRequire } from 'node:module'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProcessResult } from './process-result.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const { Client } = createRequire(path.join(root, 'api/package.json'))('pg')
const base = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode')
if (!process.env.LOCALAPPDATA || process.argv.length !== 3 || process.argv[2] !== '--disposable-task6') throw new Error('Explicit Task6 local disposable opt-in required')
const state = JSON.parse(await readFile(path.join(base, 'ownerinc-payload-local-validation-20261002', 'state.json'), 'utf8'))
const directory = await mkdtemp(path.join(base, 'ownerinc-task6-'))
const url = (role, database) => `postgresql://${role}:${encodeURIComponent(state.passwords[role])}@127.0.0.1:55441/${database}`
const connect = async (role, database) => { const db = new Client({ connectionString: url(role, database) }); await db.connect(); return db }
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'comspec', 'pathext'].includes(key.toLowerCase())))
const secret = () => randomBytes(36).toString('hex')
const env = { ...inherited, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
  TASK6_DISPOSABLE: 'cms_task6_test', TASK6_PRIVATE_DIR: directory,
  PAYLOAD_SECRET: secret(), PAYLOAD_TO_PORTAL_SECRET: secret(), PORTAL_TO_PAYLOAD_SECRET: secret(),
  PORTAL_PUBLIC_URL: 'http://localhost:18086', PORTAL_INTERNAL_URL: 'http://127.0.0.1:18086',
  CMS_UPLOAD_DIR: path.join(directory, 'uploads') }
const redact = text => {
  for (const value of [...Object.values(state.passwords), ...Object.entries(env).filter(([key]) => key.includes('SECRET')).map(([, value]) => value)]) text = text.split(value).join('[redacted]')
  return text.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-db-url]')
}
async function run(label, args, role) {
  const result = spawnSync(process.execPath, args, { cwd: path.join(root, 'cms'),
    env: { ...env, CMS_DATABASE_URL: url(role, 'cms_task6_test') }, encoding: 'utf8', timeout: 180000 })
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`)
  const outcome = describeProcessResult(result)
  await writeFile(path.join(directory, `${label}.log`), `${output}\n# process outcome: ${outcome}\n`, { mode: 0o600 })
  console.log(`${label}: ${outcome}\n${output}`)
  if (result.status !== 0 || result.error || result.signal) throw new Error(`${label}: ${outcome}`)
}
try {
  const admin = await connect('postgres', 'postgres')
  try {
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = 'cms_task6_test'")).rowCount) await admin.query('CREATE DATABASE cms_task6_test OWNER cms_migrator')
    await admin.query('REVOKE ALL ON DATABASE cms_task6_test FROM PUBLIC; GRANT CONNECT ON DATABASE cms_task6_test TO cms_runtime')
  } finally { await admin.end() }
  const db = await connect('cms_migrator', 'cms_task6_test')
  try {
    if ((await db.query('SELECT current_database() AS name')).rows[0].name !== 'cms_task6_test') throw new Error('Wrong disposable database')
    const others = await db.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')
    if (others.rows[0].count) throw new Error('Task6 database has active connections; refusing reset')
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION cms_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO cms_runtime')
    await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cms_runtime')
    await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cms_runtime')
  } finally { await db.end() }
  await run('migrate', ['node_modules/payload/bin.js', 'migrate'], 'cms_migrator')
  const faults = await connect('cms_migrator', 'cms_task6_test')
  try {
    await faults.query(`CREATE FUNCTION task6_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF current_setting('owner_news.test_audit_fail', true) = 'on' THEN
        RAISE EXCEPTION 'task6_injected_audit_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER task6_audit_fault BEFORE INSERT ON news_audit FOR EACH ROW EXECUTE FUNCTION task6_audit_fault()`)
  } finally { await faults.end() }
  await run('native', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-force-exit', 'tests/integration/task6-native.ts'], 'cms_runtime')
  const after = await connect('cms_migrator', 'cms_task6_test')
  try {
    const others = await after.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')
    if (others.rows[0].count) throw new Error('Task6 native child left database connections open')
    console.log('Post-exit database check: zero leftover connections')
  } finally { await after.end() }
  console.log(`Private synthetic evidence: ${directory}`)
} catch (error) {
  console.error(`Task6 local validation failed: ${redact(error instanceof Error ? error.message : 'unknown')}`)
  console.error(`Private synthetic evidence: ${directory}`)
  process.exitCode = 1
}
