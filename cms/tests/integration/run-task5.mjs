// Explicitly destructive only to cms_task5_test on the approved disposable instance.
// Reads credentials privately; never loads a default .env or uses a caller-supplied DB URL.
import { createRequire } from 'node:module'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(path.join(root, 'api/package.json'))
const { Client } = require('pg')
const base = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode')
if (!process.env.LOCALAPPDATA || process.argv[2] !== '--disposable-task5') throw new Error('Explicit local disposable opt-in required')
const statePath = path.join(base, 'ownerinc-payload-local-validation-20261002', 'state.json')
const state = JSON.parse(await readFile(statePath, 'utf8'))
const directory = await mkdtemp(path.join(base, 'ownerinc-task5-'))
const url = (role, database) => `postgresql://${role}:${encodeURIComponent(state.passwords[role])}@127.0.0.1:55441/${database}`
const connect = async (role, database) => { const db = new Client({ connectionString: url(role, database) }); await db.connect(); return db }
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'comspec', 'pathext'].includes(key.toLowerCase())))
const secret = () => randomBytes(36).toString('hex')
const env = { ...inherited, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
  TASK5_DISPOSABLE: 'cms_task5_test', TASK5_PRIVATE_DIR: directory,
  PAYLOAD_SECRET: secret(), PAYLOAD_TO_PORTAL_SECRET: secret(), PORTAL_TO_PAYLOAD_SECRET: secret(),
  PORTAL_PUBLIC_URL: 'http://localhost:18085', PORTAL_INTERNAL_URL: 'http://127.0.0.1:18085',
  CMS_UPLOAD_DIR: path.join(directory, 'uploads') }
const redact = text => {
  for (const value of [...Object.values(state.passwords), ...Object.entries(env).filter(([key]) => key.includes('SECRET')).map(([, value]) => value)]) text = text.split(value).join('[redacted]')
  return text.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-db-url]')
}
async function run(label, args, role) {
  const result = spawnSync(process.execPath, args, { cwd: path.join(root, 'cms'),
    env: { ...env, CMS_DATABASE_URL: url(role, 'cms_task5_test') }, encoding: 'utf8', timeout: 180000 })
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`)
  await writeFile(path.join(directory, `${label}.log`), output, { mode: 0o600 })
  console.log(`${label}: exit ${result.status ?? 'spawn-error'}`)
  console.log(output)
  if (result.status !== 0) throw new Error(`${label} failed`)
}
try {
  const admin = await connect('postgres', 'postgres')
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'cms_task5_test'")
    if (!exists.rowCount) await admin.query('CREATE DATABASE cms_task5_test OWNER cms_migrator')
    await admin.query('REVOKE ALL ON DATABASE cms_task5_test FROM PUBLIC; GRANT CONNECT ON DATABASE cms_task5_test TO cms_runtime')
  } finally { await admin.end() }
  const db = await connect('cms_migrator', 'cms_task5_test')
  try {
    if ((await db.query('SELECT current_database() AS name')).rows[0].name !== 'cms_task5_test') throw new Error('Wrong disposable database')
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION cms_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO cms_runtime')
    await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cms_runtime')
    await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cms_runtime')
  } finally { await db.end() }
  await run('migrate', ['node_modules/payload/bin.js', 'migrate'], 'cms_migrator')
  await run('native', ['--import', 'tsx', '--test', 'tests/integration/task5-native.ts'], 'cms_runtime')
  console.log(`Private synthetic evidence: ${directory}`)
} catch (error) {
  console.error(`Task5 local validation failed: ${redact(error instanceof Error ? error.message : 'unknown')}`)
  console.error(`Private synthetic evidence: ${directory}`)
  process.exitCode = 1
}
