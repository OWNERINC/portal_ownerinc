#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorCode, fail } from './payload-preview/errors.mjs'
import {
  assertLoopbackPortFree,
  assertValidPort,
  createSecureDirectory,
  createSecureSubdirectory,
  createSecurityContext,
  validateExternalRoot,
  writeSecureFile,
} from './payload-preview/security.mjs'
import {
  composeEnvironmentKeys,
  displayPath,
  renderComposeEnv,
  renderComposeOverride,
  renderFirebaseConfig,
  renderLaunchers,
  renderNginxConfig,
  validateFirebaseAuthContract,
} from './payload-preview/render.mjs'

const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helpText = `Prepare-only local Payload preview harness

Usage:
  node scripts/prepare-payload-preview.mjs --help
  node scripts/prepare-payload-preview.mjs --check
  node scripts/prepare-payload-preview.mjs prepare --directory <new-absolute-run-directory> --http-port <free-port> --auth-port <different-free-port>

The directory must be new, outside this checkout and any Git repository, and
have an existing parent. The command writes private per-run configuration only;
it does not invoke Docker, launch services, run migrations, or read .env files.
Compose launch requires Docker Compose 2.24.4 or newer.
`

export function parseCommandLine(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { mode: 'help' }
  if (args.length === 1 && args[0] === '--check') return { mode: 'check' }
  if (args[0] !== 'prepare') fail('usage')

  const options = new Map()
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index]
    if (!['--directory', '--http-port', '--auth-port'].includes(name) || options.has(name)) fail('usage')
    const value = args[index + 1]
    if (!value || value.startsWith('--')) fail('usage')
    options.set(name, value)
    index += 1
  }

  if (options.size !== 3) fail('usage')
  const directory = options.get('--directory')
  const rawHttpPort = options.get('--http-port')
  const rawAuthPort = options.get('--auth-port')
  if (!path.isAbsolute(directory)) fail('directory_must_be_absolute')
  if (!/^\d{1,5}$/u.test(rawHttpPort) || !/^\d{1,5}$/u.test(rawAuthPort)) fail('usage')
  const httpPort = assertValidPort(Number(rawHttpPort), 'http')
  const authPort = assertValidPort(Number(rawAuthPort), 'auth')
  if (httpPort === authPort) fail('ports_must_differ')
  return {
    mode: 'prepare',
    directory,
    httpPort,
    authPort,
  }
}

function servicesFrom(source) {
  const lines = source.split(/\r?\n/u)
  const servicesIndex = lines.findIndex(line => line === 'services:')
  if (servicesIndex < 0) fail('compose_source_contract_changed')
  const serviceStarts = []
  let servicesEnd = lines.length
  for (let index = servicesIndex + 1; index < lines.length; index += 1) {
    if (lines[index] && !/^\s/u.test(lines[index]) && !/^#/u.test(lines[index])) {
      servicesEnd = index
      break
    }
    const match = lines[index].match(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/u)
    if (match) serviceStarts.push({ name: match[1], index })
  }
  if (!serviceStarts.length) fail('compose_source_contract_changed')
  return new Map(serviceStarts.map((service, index) => {
    const end = serviceStarts[index + 1]?.index ?? servicesEnd
    return [service.name, lines.slice(service.index, end).join('\n')]
  }))
}

export function validateComposeSource(base, payload) {
  if (!base.includes('name: ${COMPOSE_PROJECT_NAME:-ownerinc-portal}')
    || !base.includes('postgres_data:/var/lib/postgresql/data')
    || !base.includes('uploads_data:/app/uploads')
    || !base.includes('profiles: ["local"]')
    || !payload.includes('cms-postgres:')
    || !payload.includes('POSTGRES_DB: ownerinc_cms')
    || !payload.includes('cms_postgres_data:/var/lib/postgresql/data')
    || !payload.includes('cms_uploads_data:/var/lib/ownerinc-cms/media')) {
    fail('compose_source_contract_changed')
  }

  const interpolationKeys = [base, payload]
    .flatMap(source => [...source.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu)].map(match => match[1]))
  if (interpolationKeys.some(key => !composeEnvironmentKeys.includes(key))) fail('compose_env_contract_changed')

  const baseServices = servicesFrom(base)
  const payloadServices = servicesFrom(payload)
  for (const [services, allowedPublishedServices] of [
    [baseServices, new Set(['firebase-auth', 'nginx'])],
    [payloadServices, new Set()],
  ]) {
    for (const [name, block] of services) {
      if (/^    ports:/mu.test(block) && !allowedPublishedServices.has(name)) {
        fail('unexpected_host_port_mapping')
      }
    }
  }
  if (!baseServices.has('postgres') || !baseServices.has('nginx') || !baseServices.has('firebase-auth')
    || !payloadServices.has('cms-postgres') || !payloadServices.has('cms')) fail('compose_source_contract_changed')
}

async function readSources(root, fileSystem) {
  let firebaseConfig
  let authModule
  let nginxConfig
  let baseCompose
  let payloadCompose
  try {
    [firebaseConfig, authModule, nginxConfig, baseCompose, payloadCompose] = await Promise.all([
      fileSystem.readFile(path.join(root, 'public', 'js', 'firebase-config.js'), 'utf8'),
      fileSystem.readFile(path.join(root, 'public', 'js', 'auth.js'), 'utf8'),
      fileSystem.readFile(path.join(root, 'nginx', 'nginx.conf'), 'utf8'),
      fileSystem.readFile(path.join(root, 'docker-compose.yml'), 'utf8'),
      fileSystem.readFile(path.join(root, 'docker-compose.payload.yml'), 'utf8'),
    ])
  } catch { fail('source_contract_unavailable') }

  validateFirebaseAuthContract(firebaseConfig, authModule)
  validateComposeSource(baseCompose, payloadCompose)
  return { firebaseConfig, nginxConfig }
}

async function ensureTargetDoesNotExist(target, fileSystem) {
  let exists = false
  try {
    await fileSystem.lstat(target)
    exists = true
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('run_directory_target_unavailable')
  }
  if (exists) fail('run_directory_collision')
}

function randomSecret() {
  return randomBytes(32).toString('hex')
}

function databaseURL(username, password, database) {
  return `postgresql://${username}:${encodeURIComponent(password)}@postgres:5432/${database}`
}

function cmsDatabaseURL(username, password) {
  return `postgresql://${username}:${encodeURIComponent(password)}@cms-postgres:5432/ownerinc_cms`
}

function makeEnvironment({ projectName, runId, projectId, runDirectory, httpPort, authPort }) {
  const portalAdminPassword = randomSecret()
  const apiPassword = randomSecret()
  const cronPassword = randomSecret()
  const cmsAdminPassword = randomSecret()
  const cmsMigratorPassword = randomSecret()
  const cmsRuntimePassword = randomSecret()
  const env = {
    COMPOSE_PROJECT_NAME: projectName,
    POSTGRES_DB: 'portal_test',
    POSTGRES_USER: 'portal_admin',
    POSTGRES_PASSWORD: portalAdminPassword,
    API_IMAGE: `local/ownerinc-payload-preview-api:${runId}`,
    CRON_IMAGE: `local/ownerinc-payload-preview-cron:${runId}`,
    CMS_IMAGE: `local/ownerinc-payload-preview-cms:${runId}`,
    PREVIEW_FIREBASE_IMAGE: `local/ownerinc-payload-preview-firebase-auth:${runId}`,
    NODE_ENV: 'development',
    MIGRATION_DATABASE_URL: databaseURL('portal_admin', portalAdminPassword, 'portal_test'),
    PORTAL_API_DB_PASSWORD: apiPassword,
    PORTAL_CRON_DB_PASSWORD: cronPassword,
    API_DATABASE_URL: databaseURL('portal_api', apiPassword, 'portal_test'),
    CRON_DATABASE_URL: databaseURL('portal_cron', cronPassword, 'portal_test'),
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_CLIENT_EMAIL: '',
    FIREBASE_PRIVATE_KEY: '',
    FIREBASE_AUTH_EMULATOR_HOST: 'firebase-auth:9099',
    CORS_ORIGINS: `http://127.0.0.1:${httpPort}`,
    SMTP_ADDRESS: '127.0.0.1',
    SMTP_PORT: '1',
    SMTP_USERNAME: `preview-${runId}@example.invalid`,
    SMTP_PASSWORD: randomSecret(),
    SMTP_AUTHENTICATION: 'login',
    SMTP_DOMAIN: 'example.invalid',
    SMTP_ENABLE_STARTTLS_AUTO: 'false',
    SMTP_OPENSSL_VERIFY_MODE: 'peer',
    MAILER_SENDER_EMAIL: `Payload preview <preview-${runId}@example.invalid>`,
    SOLIDES_RELEASE_STAGE: 'off',
    SOLIDES_TOKEN: '',
    SOLIDES_EMPLOYER_BASE_URL: '',
    SOLIDES_PUNCH_BASE_URL: '',
    SOLIDES_REPORT_BASE_URL: '',
    SOLIDES_REQUEST_TIMEOUT_MS: '12000',
    SOLIDES_PILOT_UIDS: '',
    BULK_IMPORT_WORKER_SECRET: randomSecret(),
    BIND_ADDRESS: '127.0.0.1',
    HTTP_PORT: String(httpPort),
    PORTAL_PUBLIC_URL: `http://127.0.0.1:${httpPort}`,
    MAX_PENDING_REGISTRATIONS_PER_HOUR: '100',
    OPERATIONAL_ALERT_EMAIL: '',
    TZ: 'America/Sao_Paulo',
    NOTIFICATION_RETENTION_DAYS: '730',
    AUDIT_RETENTION_DAYS: '1825',
    PENDING_REGISTRATION_RETENTION_DAYS: '730',
    UPLOAD_DIR: '/app/uploads',
    AUTOCARD_MEDIA_ORPHAN_DAYS: '7',
    CMS_ASSET_ORPHAN_RETENTION_DAYS: '30',
    BULK_IMPORT_API_URL: 'http://api:3000',
    CRON_BOOTSTRAP_ONLY: 'false',
    CMS_RUNTIME_DATABASE_URL: cmsDatabaseURL('cms_runtime', cmsRuntimePassword),
    PAYLOAD_SECRET: randomSecret(),
    PAYLOAD_TO_PORTAL_SECRET: randomSecret(),
    PORTAL_TO_PAYLOAD_SECRET: randomSecret(),
    CMS_POSTGRES_PASSWORD: cmsAdminPassword,
    CMS_ADMIN_DATABASE_URL: cmsDatabaseURL('cms_admin', cmsAdminPassword),
    CMS_MIGRATOR_PASSWORD: cmsMigratorPassword,
    CMS_RUNTIME_PASSWORD: cmsRuntimePassword,
    CMS_MIGRATION_DATABASE_URL: cmsDatabaseURL('cms_migrator', cmsMigratorPassword),
    AUTH_PORT: String(authPort),
    PREVIEW_RUN_DIR: path.resolve(runDirectory).replace(/\\/gu, '/'),
  }

  for (const key of Object.keys(env)) {
    if (!composeEnvironmentKeys.includes(key)) fail('env_render_failed')
  }
  return env
}

export async function checkPreparationSources({ root = checkoutRoot, fileSystem = fs } = {}) {
  const sources = await readSources(root, fileSystem)
  renderFirebaseConfig(sources.firebaseConfig, 'demo-012345abcdef', 19234)
  renderNginxConfig(sources.nginxConfig, 19234)
  renderComposeOverride()
  return { sourceContracts: true, composeMinimumVersion: '2.24.4' }
}

export async function preparePreview({
  root = checkoutRoot,
  directory,
  httpPort,
  authPort,
  fileSystem = fs,
  probePort = assertLoopbackPortFree,
  securityContext = createSecurityContext(),
  runIdFactory = () => randomUUID().replaceAll('-', '').slice(0, 12),
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) fail('directory_must_be_absolute')
  assertValidPort(httpPort, 'http')
  assertValidPort(authPort, 'auth')
  if (httpPort === authPort) fail('ports_must_differ')

  const requestedDirectory = path.resolve(directory)
  const parentPath = path.dirname(requestedDirectory)
  const canonicalParent = await validateExternalRoot(parentPath, root, fileSystem)
  const target = path.join(canonicalParent, path.basename(requestedDirectory))
  await ensureTargetDoesNotExist(target, fileSystem)
  const sources = await readSources(root, fileSystem)

  await probePort(httpPort)
  await probePort(authPort)

  const runId = runIdFactory()
  if (!/^[a-f0-9]{8,24}$/u.test(runId)) fail('run_id_invalid')
  const projectName = `ownerinc-payload-preview-${runId}`
  const projectId = `demo-${runId}`
  const firebaseOutput = renderFirebaseConfig(sources.firebaseConfig, projectId, authPort)
  const nginxOutput = renderNginxConfig(sources.nginxConfig, authPort)

  const runDirectory = await createSecureDirectory(canonicalParent, path.basename(target), securityContext, fileSystem)
  const publicConfigDirectory = await createSecureSubdirectory(runDirectory, 'public', securityContext, fileSystem)
  const publicJsDirectory = await createSecureSubdirectory(publicConfigDirectory, 'js', securityContext, fileSystem)
  const nginxDirectory = await createSecureSubdirectory(runDirectory, 'nginx', securityContext, fileSystem)

  const env = makeEnvironment({ projectName, runId, projectId, runDirectory, httpPort, authPort })
  const launchers = renderLaunchers({ checkoutRoot: root, runDirectory, projectName })
  const artifacts = [
    [path.join(runDirectory, 'compose.env'), renderComposeEnv(env)],
    [path.join(runDirectory, 'compose.preview.yml'), renderComposeOverride()],
    [path.join(publicJsDirectory, 'firebase-config.js'), firebaseOutput],
    [path.join(nginxDirectory, 'nginx.conf'), nginxOutput],
    [path.join(runDirectory, 'launch.sh'), launchers.shell],
    [path.join(runDirectory, 'launch.ps1'), launchers.powershell, { utf8Bom: true }],
  ]
  for (const [filePath, contents, options] of artifacts) {
    await writeSecureFile(filePath, contents, securityContext, fileSystem, options)
  }

  return {
    runDirectory,
    projectName,
    projectId,
    httpPort,
    authPort,
    envFile: path.join(runDirectory, 'compose.env'),
    shellLauncher: path.join(runDirectory, 'launch.sh'),
    powershellLauncher: path.join(runDirectory, 'launch.ps1'),
    resourceNames: {
      portalDatabase: 'portal_test',
      cmsDatabase: 'ownerinc_cms',
      databaseServices: ['postgres', 'cms-postgres'],
      projectScopedVolumes: ['postgres_data', 'uploads_data', 'cms_postgres_data', 'cms_uploads_data']
        .map(name => `${projectName}_${name}`),
      projectNetwork: `${projectName}_default`,
      uniqueImageTags: [env.API_IMAGE, env.CMS_IMAGE, env.PREVIEW_FIREBASE_IMAGE],
      targets: ['nginx', 'cms', 'firebase-auth'],
    },
  }
}

function printPreparedSummary(result) {
  const quotePowerShell = value => `'${value.replace(/'/gu, "''")}'`
  process.stdout.write(`Prepared private Payload preview artifacts. No services were launched.\n`)
  process.stdout.write(`Run directory: ${displayPath(result.runDirectory)}\n`)
  process.stdout.write(`Compose project: ${result.projectName}\n`)
  process.stdout.write(`Synthetic Firebase project: ${result.projectId}\n`)
  process.stdout.write(`Loopback ports: HTTP ${result.httpPort}, Auth Emulator ${result.authPort}\n`)
  process.stdout.write(`Databases: Portal ${result.resourceNames.portalDatabase}; CMS ${result.resourceNames.cmsDatabase}\n`)
  process.stdout.write(`Database services: ${result.resourceNames.databaseServices.join(', ')} (not host-published)\n`)
  process.stdout.write(`Project-scoped named volumes: ${result.resourceNames.projectScopedVolumes.join(', ')}\n`)
  process.stdout.write(`Project network: ${result.resourceNames.projectNetwork}\n`)
  process.stdout.write(`Unique image tags: ${result.resourceNames.uniqueImageTags.join(', ')}\n`)
  process.stdout.write(`Compose env file (contains generated secrets; private): ${displayPath(result.envFile)}\n`)
  process.stdout.write(`POSIX launch: sh '${displayPath(result.shellLauncher).replace(/'/gu, `'\\''`)}'\n`)
  process.stdout.write(`PowerShell launch: & ${quotePowerShell(result.powershellLauncher)}\n`)
  process.stdout.write(`Later target services: ${result.resourceNames.targets.join(', ')} (normal dependencies include the isolated databases and migrations)\n`)
  process.stdout.write('Generated launchers require local Docker Compose 2.24.4+ and confirm a local Docker context before any build/start.\n')
}

async function main(args) {
  let command
  try { command = parseCommandLine(args) } catch (error) {
    process.stderr.write(`PREVIEW_PREPARE_BLOCKED ${errorCode(error)}\n`)
    process.stderr.write('Run with --help for usage.\n')
    process.exitCode = 2
    return
  }

  if (command.mode === 'help') {
    process.stdout.write(helpText)
    return
  }

  try {
    if (command.mode === 'check') {
      const result = await checkPreparationSources()
      process.stdout.write(`Offline source contracts OK. Compose ${result.composeMinimumVersion}+ required to launch; no Docker or services were used.\n`)
      return
    }

    const result = await preparePreview({ root: checkoutRoot, ...command })
    printPreparedSummary(result)
  } catch (error) {
    process.stderr.write(`PREVIEW_PREPARE_BLOCKED ${errorCode(error)}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
