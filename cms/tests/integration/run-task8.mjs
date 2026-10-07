// Explicit, new Task8 database only. No reset, Docker or remote operations.
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProcessResult } from './process-result.mjs'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const { Client } = createRequire(path.join(root, 'api/package.json'))('pg')
const base = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode'), mode = process.argv[2]
if (!process.env.LOCALAPPDATA || !['--prepare-new-task8', '--browser'].includes(mode)) throw new Error('Explicit Task8 opt-in required')
const state = JSON.parse(await readFile(path.join(base, 'ownerinc-payload-local-validation-20261002', 'state.json'), 'utf8'))
const url = (role, database) => `postgresql://${role}:${encodeURIComponent(state.passwords[role])}@127.0.0.1:55441/${database}`
const directory = mode === '--prepare-new-task8' ? await mkdtemp(path.join(base, 'ownerinc-task8-')) : path.resolve(process.argv[3] || '')
if (path.dirname(directory) !== base || !path.basename(directory).startsWith('ownerinc-task8-')) throw new Error('Explicit Task8 private directory required')
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path', 'systemroot', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'comspec', 'pathext'].includes(key.toLowerCase())))
const secret = () => randomBytes(36).toString('hex')
const env = mode === '--prepare-new-task8' ? { ...inherited, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
  TASK8_DISPOSABLE: 'cms_task8_test', TASK8_PRIVATE_DIR: directory, PAYLOAD_SECRET: secret(),
  PAYLOAD_TO_PORTAL_SECRET: secret(), PORTAL_TO_PAYLOAD_SECRET: secret(),
  PORTAL_PUBLIC_URL: 'http://127.0.0.1:18088', PORTAL_INTERNAL_URL: 'http://127.0.0.1:18089',
  CMS_UPLOAD_DIR: path.join(directory, 'uploads'), CMS_DATABASE_URL: url('cms_runtime', 'cms_task8_test'),
} : JSON.parse(await readFile(path.join(directory, 'env.json'), 'utf8'))
const redact = output => {
  for (const value of [...Object.values(state.passwords), ...Object.entries(env).filter(([key]) => key.includes('SECRET')).map(([, value]) => value)]) output = output.split(value).join('[redacted]')
  return output.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-db-url]')
}
async function run(label, args, environment = env, timeout = 165000) {
  const result = spawnSync(process.execPath, args, { cwd: path.join(root, 'cms'), env: environment, encoding: 'utf8', timeout })
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`), outcome = describeProcessResult(result)
  await writeFile(path.join(directory, `${label}.log`), `${output}\n# ${outcome}\n`, { mode: 0o600 })
  console.log(`${label}: ${outcome}\n${output}`)
  if (result.status !== 0 || result.error || result.signal) throw new Error(`${label}: ${outcome}`)
}
try {
  if (mode === '--prepare-new-task8') {
    const admin = new Client({ connectionString: url('postgres', 'postgres') }); await admin.connect()
    try {
      if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', ['cms_task8_test'])).rowCount) throw new Error('Task8 database already exists; refusing to reset it')
      await admin.query('CREATE DATABASE cms_task8_test OWNER cms_migrator')
      await admin.query('REVOKE ALL ON DATABASE cms_task8_test FROM PUBLIC; GRANT CONNECT ON DATABASE cms_task8_test TO cms_runtime')
    } finally { await admin.end() }
    const db = new Client({ connectionString: url('cms_migrator', 'cms_task8_test') }); await db.connect()
    try {
      if ((await db.query('SELECT current_database() AS name')).rows[0].name !== 'cms_task8_test') throw new Error('Wrong Task8 database')
      await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO cms_runtime')
      await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO cms_runtime; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO cms_runtime')
    } finally { await db.end() }
    await writeFile(path.join(directory, 'env.json'), JSON.stringify(env), { mode: 0o600 })
    await run('migrate', ['node_modules/payload/bin.js', 'migrate'], { ...env, CMS_DATABASE_URL: url('cms_migrator', 'cms_task8_test') }, 110000)
  } else await run('browser', ['tests/integration/task8-browser.mjs'])
  console.log(`Task8 private evidence: ${directory}`)
} catch (error) { console.error(redact(error.message)); console.error(`Task8 private evidence: ${directory}`); process.exitCode = 1 }
