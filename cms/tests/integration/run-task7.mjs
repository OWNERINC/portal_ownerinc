// Local, explicit, disposable Task7 only. Never reads caller DB URLs or starts services.
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProcessResult } from './process-result.mjs'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const { Client } = createRequire(path.join(root, 'api/package.json'))('pg')
const base = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode')
const mode = process.argv[2]
if (!process.env.LOCALAPPDATA || !['--prepare-disposable-task7', '--native', '--http'].includes(mode)) throw new Error('Explicit Task7 local opt-in required')
const state = JSON.parse(await readFile(path.join(base, 'ownerinc-payload-local-validation-20261002', 'state.json'), 'utf8'))
const url = (role, database) => `postgresql://${role}:${encodeURIComponent(state.passwords[role])}@127.0.0.1:55441/${database}`
const connect = async (role, database) => { const db = new Client({ connectionString: url(role, database) }); await db.connect(); return db }
const directory = mode === '--prepare-disposable-task7' ? await mkdtemp(path.join(base, 'ownerinc-task7-')) : path.resolve(process.argv[3] || '')
if (path.dirname(directory) !== base || !path.basename(directory).startsWith('ownerinc-task7-')) throw new Error('Explicit Task7 private directory required')
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path', 'systemroot', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'comspec', 'pathext'].includes(key.toLowerCase())))
const secret = () => randomBytes(36).toString('hex')
const env = mode === '--prepare-disposable-task7' ? { ...inherited, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
  TASK7_DISPOSABLE: 'cms_task7_test', TASK7_PRIVATE_DIR: directory,
  PAYLOAD_SECRET: secret(), PAYLOAD_TO_PORTAL_SECRET: secret(), PORTAL_TO_PAYLOAD_SECRET: secret(),
  PORTAL_PUBLIC_URL: 'http://127.0.0.1:18087', PORTAL_INTERNAL_URL: 'http://127.0.0.1:18087',
  CMS_UPLOAD_DIR: path.join(directory, 'uploads'), CMS_DATABASE_URL: url('cms_runtime', 'cms_task7_test'), TASK7_PORTAL_DATABASE_URL: url('portal_api', 'portal_task7_test')
} : JSON.parse(await readFile(path.join(directory, 'env.json'), 'utf8'))
const redact = value => {
  for (const secret of [...Object.values(state.passwords), ...Object.entries(env).filter(([key]) => key.includes('SECRET')).map(([, value]) => value)]) value = value.split(secret).join('[redacted]')
  return value.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-db-url]')
}
async function run(label, args, environment = env, timeout = 180000) {
  const result = spawnSync(process.execPath, args, { cwd: path.join(root, 'cms'), env: environment, encoding: 'utf8', timeout })
  const output = redact(`${result.stdout || ''}${result.stderr || ''}`), outcome = describeProcessResult(result)
  await writeFile(path.join(directory, `${label}.log`), `${output}\n# ${outcome}\n`, { mode: 0o600 })
  console.log(`${label}: ${outcome}\n${output}`)
  if (result.status !== 0 || result.error || result.signal) throw new Error(`${label}: ${outcome}`)
}
try {
  if (mode === '--prepare-disposable-task7') {
    const admin = await connect('postgres', 'postgres')
    try {
      for (const database of ['cms_task7_test', 'portal_task7_test']) {
        if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) await admin.query(`CREATE DATABASE ${database} OWNER cms_migrator`)
        await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${database.startsWith('cms') ? 'cms_runtime' : 'portal_api'}`)
      }
    } finally { await admin.end() }
    for (const database of ['cms_task7_test', 'portal_task7_test']) {
      const db = await connect('cms_migrator', database), role = database.startsWith('cms') ? 'cms_runtime' : 'portal_api'
      try {
        if ((await db.query('SELECT current_database() AS name')).rows[0].name !== database) throw new Error('Wrong Task7 database')
        if ((await db.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].count) throw new Error('Task7 DB has active connections; refusing reset')
        await db.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION cms_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${role}`)
        await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${role}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${role}`)
        if (database === 'portal_task7_test') await db.query(`CREATE TABLE owner_news_authority(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),mode text NOT NULL,epoch integer NOT NULL);
          INSERT INTO owner_news_authority VALUES(true,'payload',1)`)
      } finally { await db.end() }
    }
    await writeFile(path.join(directory, 'env.json'), JSON.stringify(env), { mode: 0o600 })
    await run('migrate', ['node_modules/payload/bin.js', 'migrate'], { ...env, CMS_DATABASE_URL: url('cms_migrator', 'cms_task7_test') }, 120000)
  } else if (mode === '--native') await run('native', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-force-exit', 'tests/integration/task7-native.ts'], env, 210000)
  else await run('http', ['tests/integration/task7-http.mjs'], env, 165000)
  console.log(`Task7 private evidence: ${directory}`)
} catch (error) { console.error(redact(error.message)); console.error(`Task7 private evidence: ${directory}`); process.exitCode = 1 }
