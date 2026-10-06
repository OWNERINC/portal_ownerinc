// Only new Task9 databases on the already-authorized loopback PostgreSQL.
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProcessResult } from './process-result.mjs'
const root = fileURLToPath(new URL('../../../', import.meta.url)), base = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode'), mode = process.argv[2]
if (!process.env.LOCALAPPDATA || !['--prepare-new-task9', '--browser', '--http'].includes(mode)) throw new Error('Explicit Task9 opt-in required')
const { Client } = createRequire(path.join(root, 'api/package.json'))('pg')
const state = JSON.parse(await readFile(path.join(base, 'ownerinc-payload-local-validation-20261002', 'state.json'), 'utf8'))
const url = (role, db) => `postgresql://${role}:${encodeURIComponent(state.passwords[role])}@127.0.0.1:55441/${db}`
const directory = mode === '--prepare-new-task9' ? await mkdtemp(path.join(base, 'ownerinc-task9-')) : path.resolve(process.argv[3] || '')
if (path.dirname(directory) !== base || !path.basename(directory).startsWith('ownerinc-task9-')) throw new Error('Explicit Task9 private directory required')
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path', 'systemroot', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'comspec', 'pathext'].includes(key.toLowerCase())))
const secret = () => randomBytes(36).toString('hex')
const env = mode === '--prepare-new-task9' ? { ...inherited, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', TASK9_PRIVATE_DIR: directory,
  PAYLOAD_SECRET: secret(), PAYLOAD_TO_PORTAL_SECRET: secret(), PORTAL_TO_PAYLOAD_SECRET: secret(),
  PORTAL_PUBLIC_URL: 'http://127.0.0.1:19091', PORTAL_INTERNAL_URL: 'http://127.0.0.1:19091',
  CMS_UPLOAD_DIR: path.join(directory, 'uploads'), CMS_DATABASE_URL: url('cms_runtime', 'cms_task9_test'), TASK9_PORTAL_DATABASE_URL: url('portal_api', 'portal_task9_test'),
} : JSON.parse(await readFile(path.join(directory, 'env.json'), 'utf8'))
const redact = value => {
  for (const secret of [...Object.values(state.passwords), ...Object.entries(env).filter(([key]) => key.includes('SECRET')).map(([, value]) => value)]) value = value.split(secret).join('[redacted]')
  return value.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-db-url]')
}
async function run(label, args, environment = env, timeout = 160000) {
  const result = spawnSync(process.execPath, args, { cwd: path.join(root, 'cms'), env: environment, encoding: 'utf8', timeout })
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`), outcome = describeProcessResult(result)
  await writeFile(path.join(directory, `${label}.log`), `${output}\n# ${outcome}\n`, { mode: 0o600 })
  console.log(`${label}: ${outcome}\n${output}`)
  if (result.status !== 0 || result.error || result.signal) throw new Error(`${label}: ${outcome}`)
}
try {
  if (mode === '--prepare-new-task9') {
    const admin = new Client({ connectionString: url('postgres', 'postgres') }); await admin.connect()
    try {
      for (const database of ['cms_task9_test', 'portal_task9_test']) if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) throw new Error('Task9 database exists; refusing any reset')
      for (const database of ['cms_task9_test', 'portal_task9_test']) {
        await admin.query(`CREATE DATABASE ${database} OWNER cms_migrator`)
        await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${database.startsWith('cms') ? 'cms_runtime' : 'portal_api'}`)
      }
    } finally { await admin.end() }
    await writeFile(path.join(directory, 'env.json'), JSON.stringify(env), { mode: 0o600 })
    for (const database of ['cms_task9_test', 'portal_task9_test']) {
      const db = new Client({ connectionString: url('cms_migrator', database) }); await db.connect()
      try {
        const role = database.startsWith('cms') ? 'cms_runtime' : 'portal_api'
        await db.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${role}`)
        await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${role}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${role}`)
        if (database === 'portal_task9_test') {
          for (const file of (await readdir(path.join(root, 'api/db/migrations'))).filter(file => file.endsWith('.sql')).sort()) await db.query(await readFile(path.join(root, 'api/db/migrations', file), 'utf8'))
          await db.query(`INSERT INTO users(uid,email,name,role,permissions) VALUES ('task9-editor','task9@example.invalid','Task9 Editor','admin','{"manageKnowledge":true}'); UPDATE owner_news_authority SET mode='payload'`)
        }
      } finally { await db.end() }
    }
    await run('migrate', ['node_modules/payload/bin.js', 'migrate'], { ...env, CMS_DATABASE_URL: url('cms_migrator', 'cms_task9_test') }, 110000)
  } else await run(mode.slice(2), ['tests/integration/task9-browser.mjs', mode], env, mode === '--http' ? 210000 : 165000)
  console.log(`Task9 private evidence: ${directory}`)
} catch (error) { console.error(redact(error.message)); console.error(`Task9 private evidence: ${directory}`); process.exitCode = 1 }
