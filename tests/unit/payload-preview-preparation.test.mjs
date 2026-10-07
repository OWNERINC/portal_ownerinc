import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkPreparationSources,
  parseCommandLine,
  preparePreview,
  validateComposeSource,
} from '../../scripts/prepare-payload-preview.mjs'
import {
  assertLoopbackPortFree,
  createSecurityContext,
  securePath,
  validateExternalRoot,
} from '../../scripts/payload-preview/security.mjs'
import {
  composeEnvironmentKeys,
  renderFirebaseConfig,
  renderNginxConfig,
  renderComposeOverride,
  renderLaunchers,
} from '../../scripts/payload-preview/render.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const securityContext = {
  platform: 'win32',
  sid: 'S-1-5-21-1000',
  spawn: (_command, args) => {
    assert(args.includes('/inheritance:r'))
    assert(args.some(value => value.startsWith('*S-1-5-21-1000:')))
    assert(args.some(value => value.startsWith('*S-1-5-18:')))
    return { status: 0 }
  },
}

async function makeTempRoot() {
  let current = repoRoot
  let highestGitAncestor = null
  while (true) {
    try {
      await fs.lstat(path.join(current, '.git'))
      highestGitAncestor = current
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const externalParent = highestGitAncestor ? path.dirname(highestGitAncestor) : os.tmpdir()
  return fs.mkdtemp(path.join(externalParent, 'payload-preview-preparation-'))
}

async function makeUnicodeCheckout(parent) {
  const root = path.join(parent, 'checkout Criação 漢字 $ fixture')
  for (const relative of [
    'public/js/firebase-config.js',
    'public/js/auth.js',
    'nginx/nginx.conf',
    'docker-compose.yml',
    'docker-compose.payload.yml',
  ]) {
    const target = path.join(root, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(repoRoot, relative), target)
  }
  return root
}

function quotePowerShell(value) {
  return `'${value.replace(/'/gu, "''")}'`
}

function availableWindowsPowerShell51() {
  if (process.platform !== 'win32') return null
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()',
  ], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0 || !/^5\.1(?:\.|$)/u.test(String(result.stdout).trim())) return null
  return 'powershell.exe'
}

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function parseGeneratedEnv(source) {
  const values = {}
  for (const line of source.trimEnd().split('\n')) {
    const separator = line.indexOf('=')
    assert(separator > 0)
    const key = line.slice(0, separator)
    let value = line.slice(separator + 1)
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\')
    }
    values[key] = value.replace(/\$\$/gu, '$')
  }
  return values
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve)
  })
  return server.address().port
}

test('CLI exposes help, source-only check and an explicit absolute-directory interface', () => {
  const absoluteRunPath = path.resolve('preview-run')
  assert.deepEqual(parseCommandLine(['--help']), { mode: 'help' })
  assert.deepEqual(parseCommandLine(['--check']), { mode: 'check' })
  assert.deepEqual(parseCommandLine([
    'prepare', '--directory', absoluteRunPath, '--http-port', '18080', '--auth-port', '19099',
  ]), {
    mode: 'prepare', directory: absoluteRunPath, httpPort: 18080, authPort: 19099,
  })
  assert.throws(() => parseCommandLine(['prepare', '--directory', 'relative', '--http-port', '80']))
  assert.throws(() => parseCommandLine(['prepare', '--directory', absoluteRunPath, '--http-port', '18080', '--auth-port', '18080']))
  assert.throws(() => parseCommandLine(['prepare', '--directory', absoluteRunPath, '--http-port', '18080', '--http-port', '18081', '--auth-port', '19099']))
})

test('offline check validates current source contracts without invoking Docker', async () => {
  assert.deepEqual(await checkPreparationSources({ root: repoRoot }), {
    sourceContracts: true, composeMinimumVersion: '2.24.4',
  })
})

test('prepare creates isolated private artifacts without starting services or printing secrets', async t => {
  const tempRoot = await makeTempRoot()
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const unicodeCheckout = await makeUnicodeCheckout(tempRoot)
  const runParent = path.join(tempRoot, 'run-parent Criação 漢字 $')
  await fs.mkdir(runParent)
  const runDirectory = path.join(runParent, 'ownerinc-payload-preview Criação 漢字 $ test-run')
  const probed = []
  const result = await preparePreview({
    root: unicodeCheckout,
    directory: runDirectory,
    httpPort: 18080,
    authPort: 19099,
    securityContext,
    probePort: async port => probed.push(port),
    runIdFactory: () => '012345abcdef',
  })

  assert.deepEqual(probed, [18080, 19099])
  assert.equal(result.runDirectory, runDirectory)
  assert.equal(result.projectName, 'ownerinc-payload-preview-012345abcdef')
  assert.equal(result.projectId, 'demo-012345abcdef')
  assert.deepEqual(result.resourceNames.targets, ['nginx', 'cms', 'firebase-auth'])

  const envText = await fs.readFile(result.envFile, 'utf8')
  const env = parseGeneratedEnv(envText)
  assert.equal(env.PREVIEW_RUN_DIR, runDirectory.replace(/\\/gu, '/'))
  assert.ok(/^PREVIEW_RUN_DIR=".*\$\$ test-run"$/mu.test(envText), 'Compose env path escapes literal dollar signs')
  assert.equal(env.POSTGRES_DB, 'portal_test')
  assert.equal(env.FIREBASE_PROJECT_ID, result.projectId)
  assert.equal(env.FIREBASE_AUTH_EMULATOR_HOST, 'firebase-auth:9099')
  assert.equal(env.PORTAL_PUBLIC_URL, 'http://127.0.0.1:18080')
  assert.ok(env.CMS_ADMIN_DATABASE_URL === `postgresql://cms_admin:${env.CMS_POSTGRES_PASSWORD}@cms-postgres:5432/ownerinc_cms`, 'CMS admin URL has its expected isolated role')
  assert.ok(env.CMS_MIGRATION_DATABASE_URL === `postgresql://cms_migrator:${env.CMS_MIGRATOR_PASSWORD}@cms-postgres:5432/ownerinc_cms`, 'CMS migration URL has its expected isolated role')
  assert.ok(env.CMS_RUNTIME_DATABASE_URL === `postgresql://cms_runtime:${env.CMS_RUNTIME_PASSWORD}@cms-postgres:5432/ownerinc_cms`, 'CMS runtime URL has its expected isolated role')
  assert.ok(env.API_DATABASE_URL === `postgresql://portal_api:${env.PORTAL_API_DB_PASSWORD}@postgres:5432/portal_test`, 'Portal API URL has its expected isolated role')
  assert.ok(env.CRON_DATABASE_URL === `postgresql://portal_cron:${env.PORTAL_CRON_DB_PASSWORD}@postgres:5432/portal_test`, 'Portal cron URL has its expected isolated role')
  assert.equal(env.SMTP_ADDRESS, '127.0.0.1')
  assert.equal(env.SMTP_PORT, '1')
  assert.equal(env.SOLIDES_RELEASE_STAGE, 'off')
  assert.equal(env.NODE_ENV, 'development')

  const secretNames = [
    'POSTGRES_PASSWORD', 'PORTAL_API_DB_PASSWORD', 'PORTAL_CRON_DB_PASSWORD', 'CMS_POSTGRES_PASSWORD',
    'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD', 'PAYLOAD_SECRET', 'PAYLOAD_TO_PORTAL_SECRET',
    'PORTAL_TO_PAYLOAD_SECRET', 'BULK_IMPORT_WORKER_SECRET', 'SMTP_PASSWORD',
  ]
  const secrets = secretNames.map(name => env[name])
  assert(secrets.every(secret => secret.length >= 32))
  assert.equal(new Set(secrets).size, secrets.length)
  assert.ok(env.PAYLOAD_TO_PORTAL_SECRET !== env.PORTAL_TO_PAYLOAD_SECRET, 'bridge secrets must differ')

  const generatedFirebase = await fs.readFile(path.join(runDirectory, 'public', 'js', 'firebase-config.js'), 'utf8')
  assert.match(generatedFirebase, /projectId: "demo-012345abcdef"/u)
  assert.match(generatedFirebase, /connectAuthEmulator\(auth, 'http:\/\/127\.0\.0\.1:19099'/u)
  assert.match(generatedFirebase, /export const auth = initializeAuth\(app, \{ persistence: browserLocalPersistence \}\);/u)
  assert.doesNotMatch(generatedFirebase, /ownerinc-portal-interno-prod|127\.0\.0\.1:9099/u)

  const generatedNginx = await fs.readFile(path.join(runDirectory, 'nginx', 'nginx.conf'), 'utf8')
  const originalNginx = await fs.readFile(path.join(unicodeCheckout, 'nginx', 'nginx.conf'), 'utf8')
  const expectedNginx = originalNginx.replace(
    "connect-src 'self' http://127.0.0.1:9099 http://localhost:9099 https://*.googleapis.com https://*.firebaseio.com",
    "connect-src 'self' http://127.0.0.1:19099 https://*.googleapis.com https://*.firebaseio.com",
  )
  assert.equal(generatedNginx, expectedNginx)
  assert.match(generatedNginx, /connect-src 'self' http:\/\/127\.0\.0\.1:19099 https:\/\/\*\.googleapis\.com/u)
  assert.doesNotMatch(generatedNginx, /localhost:9099|127\.0\.0\.1:9099/u)

  const override = await fs.readFile(path.join(runDirectory, 'compose.preview.yml'), 'utf8')
  assert(override.includes('pg_isready -h 127.0.0.1 -U ${POSTGRES_USER:-portal_admin} -d ${POSTGRES_DB:-portal}'))
  assert.match(override, /pg_isready -h 127\.0\.0\.1 -U cms_admin -d ownerinc_cms/u)
  assert.match(override, /127\.0\.0\.1:\$\{AUTH_PORT:\?Set AUTH_PORT\}:9099/u)
  assert.match(override, /127\.0\.0\.1:\$\{HTTP_PORT:\?Set HTTP_PORT\}:80/u)
  assert.match(override, /PREVIEW_RUN_DIR[^\n]*firebase-config\.js/u)
  assert.equal((override.match(/read_only: true/gu) || []).length, 3)
  assert.match(override, /NODE_ENV: development/u)
  assert.match(override, /cms-migrate:[\s\S]*?NODE_ENV: development/u)
  assert.equal(result.resourceNames.uniqueImageTags.length, 3)
  assert.equal(new Set(result.resourceNames.uniqueImageTags).size, 3)
  assert(result.resourceNames.uniqueImageTags.every(tag => tag.includes('012345abcdef')))

  const shellLauncher = await fs.readFile(result.shellLauncher, 'utf8')
  const powershellBytes = await fs.readFile(result.powershellLauncher)
  assert.deepEqual([...powershellBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell launcher is UTF-8 with BOM')
  const powershellLauncher = powershellBytes.toString('utf8')
  assert.equal((powershellLauncher.match(/\uFEFF/gu) || []).length, 1, 'launcher has exactly one UTF-8 BOM')
  assert(shellLauncher.includes(result.envFile.replace(/\\/gu, '/')))
  assert(powershellLauncher.includes(result.envFile.replace(/\\/gu, '/')))
  assert(powershellLauncher.includes(unicodeCheckout.replace(/\\/gu, '/')), 'checkout path is preserved as Unicode')
  assert(powershellLauncher.includes(runDirectory.replace(/\\/gu, '/')), 'run path is preserved as Unicode')
  assert.match(shellLauncher, /config --quiet[\s\S]*build api cms firebase-auth[\s\S]*up -d --wait --wait-timeout 300 nginx cms firebase-auth/u)
  assert.match(powershellLauncher, /\$configArguments = @\('compose'\) \+ \$compose \+ @\('config', '--quiet'\)[\s\S]*\$buildArguments = @\('compose'\)[\s\S]*'build', 'api', 'cms', 'firebase-auth'[\s\S]*\$upArguments = @\('compose'\)[\s\S]*'up', '-d', '--wait', '--wait-timeout', '300'/u)
  assert.match(shellLauncher, /--format '\{\{\.Endpoints\.docker\.Host\}\}'/u)
  assert(powershellLauncher.includes("'--format', '{{.Endpoints.docker.Host}}'"))
  assert.doesNotMatch(shellLauncher, /index \.Endpoints|\.Endpoints "docker"/u)
  assert.doesNotMatch(powershellLauncher, /index \.Endpoints|\.Endpoints "docker"/u)
  assert.match(powershellLauncher, /function Invoke-PreviewDockerProbe[\s\S]*?\$ErrorActionPreference = 'Continue'[\s\S]*?& docker @DockerArguments 2>\$null \| ForEach-Object[\s\S]*?\$exitCode = \$LASTEXITCODE[\s\S]*?finally[\s\S]*?\$ErrorActionPreference = \$previousErrorActionPreference/u)
  assert.match(powershellLauncher, /function Invoke-PreviewDockerCommand[\s\S]*?\$ErrorActionPreference = 'Continue'[\s\S]*?& docker @DockerArguments[\s\S]*?\$script:PreviewDockerExitCode = \$LASTEXITCODE[\s\S]*?finally[\s\S]*?\$ErrorActionPreference = \$previousErrorActionPreference/u)
  assert.doesNotMatch(powershellLauncher, /& docker compose @compose (?:config|build|up)/u)
  assert.match(powershellLauncher, /\$lines\.Count -lt 2 -and \$line\.Length -le 256/u)
  assert.match(powershellLauncher, /\$versionProbe = Invoke-PreviewDockerProbe -DockerArguments @\('compose', 'version', '--short'\)/u)
  assert.match(powershellLauncher, /\$contextProbe = Invoke-PreviewDockerProbe -DockerArguments @\('context', 'show'\)/u)
  assert.match(powershellLauncher, /\$endpointProbe = Invoke-PreviewDockerProbe -DockerArguments @\('context', 'inspect', \$context, '--format',/u)
  assert.doesNotMatch(powershellLauncher, /& docker (?:compose version|context show|context inspect)[^\n]*Select-Object -First 1/u)
  assert(powershellLauncher.includes("$versionText -notmatch '^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+][0-9A-Za-z.-]+)?$'"))
  assert.match(shellLauncher, /case "\$endpoint" in unix:\/\/\*\|npipe:\/\/\*\)[\s\S]*nonlocal_docker_context/u)
  assert(powershellLauncher.includes("if ($endpoint -notmatch '^(unix|npipe)://.+$')"))
  assert(powershellLauncher.includes("Write-Output 'PREVIEW_BLOCKED nonlocal_docker_context'"))
  assert.doesNotMatch(shellLauncher, /--profile tools|bootstrap-admin|cms-worker|\bcron\b/u)
  assert.doesNotMatch(powershellLauncher, /--profile tools|bootstrap-admin|cms-worker|\bcron\b/u)
  for (const secret of secrets) {
    assert(!shellLauncher.includes(secret))
    assert(!powershellLauncher.includes(secret))
  }

  const recoveryOverride = path.join(runDirectory, 'recovery-20261007-a', 'compose.preview.recovery.yml')
  const recoveryLaunchers = renderLaunchers({
    checkoutRoot: unicodeCheckout,
    runDirectory,
    projectName: result.projectName,
    additionalComposeFiles: [recoveryOverride],
  })
  const normalizedOriginalOverride = path.join(runDirectory, 'compose.preview.yml').replace(/\\/gu, '/')
  const normalizedRecoveryOverride = recoveryOverride.replace(/\\/gu, '/')
  assert(recoveryLaunchers.shell.includes(`'-f' '${normalizedOriginalOverride}' '-f' '${normalizedRecoveryOverride}'`))
  assert(recoveryLaunchers.powershell.includes(`'-f', '${normalizedOriginalOverride}', '-f', '${normalizedRecoveryOverride}'`))
  for (const launcher of [recoveryLaunchers.shell, recoveryLaunchers.powershell]) {
    assert(launcher.includes(result.envFile.replace(/\\/gu, '/')), 'recovery launcher reuses the existing private env file')
    assert(launcher.includes(result.projectName), 'recovery launcher preserves the existing Compose project identity')
  }

  if (process.platform !== 'win32') {
    for (const filePath of [
      result.envFile, result.shellLauncher, result.powershellLauncher,
      path.join(runDirectory, 'compose.preview.yml'),
      path.join(runDirectory, 'public', 'js', 'firebase-config.js'),
      path.join(runDirectory, 'nginx', 'nginx.conf'),
    ]) assert.equal((await fs.stat(filePath)).mode & 0o077, 0)
  }

  const priorEnvText = await fs.readFile(result.envFile, 'utf8')
  await assert.rejects(preparePreview({
    root: repoRoot,
    directory: runDirectory,
    httpPort: 18080,
    authPort: 19099,
    securityContext,
    probePort: async () => assert.fail('collision check must happen before probing'),
  }), error => error.code === 'run_directory_collision')
  assert.ok(await fs.readFile(result.envFile, 'utf8') === priorEnvText, 'existing environment file remains unchanged')
})

test('Docker Compose merges preview TCP database healthchecks and CMS migration development mode', async t => {
  const environment = { ...process.env }
  for (const key of [
    ...composeEnvironmentKeys, 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES',
    'COMPOSE_DISABLE_ENV_FILE', 'DOCKER_HOST', 'DOCKER_CONTEXT',
  ]) delete environment[key]

  const version = spawnSync('docker', ['compose', 'version', '--short'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, env: environment,
  })
  if (version.error || version.status !== 0) return t.skip('Docker Compose is unavailable')
  const parsedVersion = String(version.stdout).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/u)
  if (!parsedVersion) return t.skip('Docker Compose version is unreadable')
  const [major, minor, patch] = parsedVersion.slice(1).map(Number)
  if (major < 2 || (major === 2 && minor < 24) || (major === 2 && minor === 24 && patch < 4)) {
    return t.skip('Docker Compose 2.24.4 or newer is required for merged-config validation')
  }

  const tempRoot = await makeTempRoot()
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const runDirectory = path.join(tempRoot, 'compose-merge-run')
  const result = await preparePreview({
    root: repoRoot,
    directory: runDirectory,
    httpPort: 18080,
    authPort: 19099,
    securityContext,
    probePort: async () => {},
    runIdFactory: () => 'abcdef012345',
  })
  const recoveryDirectory = path.join(runDirectory, 'recovery-regression')
  await fs.mkdir(recoveryDirectory, { mode: 0o700 })
  const recoveryOverride = path.join(recoveryDirectory, 'compose.preview.recovery.yml')
  const recoveryFile = await fs.open(recoveryOverride, 'wx', 0o600)
  try {
    await recoveryFile.writeFile(renderComposeOverride(), 'utf8')
  } finally {
    await recoveryFile.close()
  }
  const recoveryLaunchers = renderLaunchers({
    checkoutRoot: repoRoot,
    runDirectory,
    projectName: result.projectName,
    additionalComposeFiles: [recoveryOverride],
  })
  assert(recoveryLaunchers.powershell.includes(`'-f', '${path.join(runDirectory, 'compose.preview.yml').replace(/\\/gu, '/')}', '-f', '${recoveryOverride.replace(/\\/gu, '/')}'`))
  assert(recoveryLaunchers.powershell.includes(result.envFile.replace(/\\/gu, '/')))
  assert(recoveryLaunchers.powershell.includes(result.projectName))
  const configResult = spawnSync('docker', [
    'compose', '--profile', 'local',
    '--project-directory', repoRoot,
    '--env-file', result.envFile,
    '--project-name', result.projectName,
    '-f', path.join(repoRoot, 'docker-compose.yml'),
    '-f', path.join(repoRoot, 'docker-compose.payload.yml'),
    '-f', path.join(runDirectory, 'compose.preview.yml'),
    '-f', recoveryOverride,
    'config', '--format', 'json',
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: environment })
  assert.equal(configResult.error, undefined, 'read-only Compose config command completed')
  assert.equal(configResult.status, 0, 'read-only Compose config merged the generated preview inputs')

  let config
  try {
    config = JSON.parse(configResult.stdout)
  } catch {
    assert.fail('read-only Compose config returned non-JSON output')
  }
  assert.equal(config.services.postgres.environment.POSTGRES_USER, 'portal_admin')
  assert.equal(config.services.postgres.environment.POSTGRES_DB, 'portal_test')
  assert.deepEqual(config.services.postgres.healthcheck.test, [
    'CMD-SHELL', 'pg_isready -h 127.0.0.1 -U portal_admin -d portal_test',
  ])
  assert.equal(config.services['cms-postgres'].environment.POSTGRES_USER, 'cms_admin')
  assert.equal(config.services['cms-postgres'].environment.POSTGRES_DB, 'ownerinc_cms')
  assert.deepEqual(config.services['cms-postgres'].healthcheck.test, [
    'CMD-SHELL', 'pg_isready -h 127.0.0.1 -U cms_admin -d ownerinc_cms',
  ])
  assert.equal(config.services.cms.environment.NODE_ENV, 'development')
  assert.equal(config.services['cms-migrate'].environment.NODE_ENV, 'development')
  assert.equal(Object.hasOwn(config.services['cms-provision'].environment, 'NODE_ENV'), false,
    'database-only provisioning remains otherwise unchanged')
  const payloadCompose = await fs.readFile(path.join(repoRoot, 'docker-compose.payload.yml'), 'utf8')
  assert.match(payloadCompose, /x-cms-environment:[\s\S]*?NODE_ENV: production/u,
    'the base Payload overlay keeps its production default')
})

test('Windows PowerShell 5.1 parses Unicode launcher paths without invoking Docker', async t => {
  const executable = availableWindowsPowerShell51()
  if (!executable) return t.skip('Windows PowerShell 5.1 is unavailable on this host')

  const tempRoot = await makeTempRoot()
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const unicodeCheckout = await makeUnicodeCheckout(tempRoot)
  const runParent = path.join(tempRoot, 'run-parent Criação 漢字 $')
  await fs.mkdir(runParent)
  const runDirectory = path.join(runParent, 'run Criação 漢字 $ path')
  const result = await preparePreview({
    root: unicodeCheckout,
    directory: runDirectory,
    httpPort: 18080,
    authPort: 19099,
    securityContext,
    probePort: async () => {},
    runIdFactory: () => 'abcdef012345',
  })
  const captureFile = path.join(tempRoot, 'mock-docker-arguments.txt')
  const unitSeparator = String.fromCharCode(31)
  const runner = `
$global:dockerCalls = New-Object 'System.Collections.Generic.List[string]'
function docker {
  $parts = @($args | ForEach-Object { [string]$_ })
  [void]$global:dockerCalls.Add(($parts -join [char]31))
  $global:LASTEXITCODE = 0
  if ($parts.Count -ge 3 -and $parts[0] -eq 'compose' -and $parts[1] -eq 'version') { return 'v2.24.4' }
  if ($parts.Count -ge 2 -and $parts[0] -eq 'context' -and $parts[1] -eq 'show') { return 'default' }
  if ($parts.Count -ge 2 -and $parts[0] -eq 'context' -and $parts[1] -eq 'inspect') { return 'npipe://./pipe/docker_engine' }
}
& ${quotePowerShell(result.powershellLauncher)}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
[System.IO.File]::WriteAllText(${quotePowerShell(captureFile)}, [string]::Join([Environment]::NewLine, $global:dockerCalls), [System.Text.Encoding]::UTF8)
`
  const executed = spawnSync(executable, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(runner, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(executed.error, undefined, executed.error?.message)
  assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`)

  const captured = (await fs.readFile(captureFile, 'utf8')).replace(/^\uFEFF/u, '')
  const calls = captured.split(/\r?\n/u).filter(Boolean).map(call => call.split(unitSeparator))
  const composeCalls = calls.filter(([first]) => first === 'compose')
  assert.equal(composeCalls.length, 4, 'mock observes version, config, build, and up only')
  for (const args of composeCalls.slice(1)) {
    assert.equal(args[args.indexOf('--project-directory') + 1], unicodeCheckout.replace(/\\/gu, '/'))
    assert.equal(args[args.indexOf('--env-file') + 1], path.join(runDirectory, 'compose.env').replace(/\\/gu, '/'))
    assert(args.includes(path.join(unicodeCheckout, 'docker-compose.yml').replace(/\\/gu, '/')))
    assert(args.includes(path.join(unicodeCheckout, 'docker-compose.payload.yml').replace(/\\/gu, '/')))
    assert(args.includes(path.join(runDirectory, 'compose.preview.yml').replace(/\\/gu, '/')))
  }
  assert(calls.every(args => args[0] !== 'compose' || args[1] !== 'down'), 'mock never receives a stop command')
})

test('Windows PowerShell 5.1 preserves the quote-free Docker endpoint template in native argv', async t => {
  const executable = availableWindowsPowerShell51()
  if (!executable) return t.skip('Windows PowerShell 5.1 is unavailable on this host')

  const tempRoot = await makeTempRoot()
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const generatedPowerShell = renderLaunchers({ checkoutRoot: repoRoot, runDirectory: path.join(tempRoot, 'run'),
    projectName: 'ownerinc-payload-preview-012345abcdef' }).powershell
  const endpointTemplate = generatedPowerShell.match(/'--format', '([^']+)'/)?.[1]
  assert.equal(endpointTemplate, '{{.Endpoints.docker.Host}}')
  const captureFile = path.join(tempRoot, 'native-argv.json')
  const probeFile = path.join(tempRoot, 'native-argv-probe.mjs')
  await fs.writeFile(probeFile,
    "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))\n", 'utf8')
  const runner = `
& ${quotePowerShell(process.execPath)} ${quotePowerShell(probeFile)} ${quotePowerShell(captureFile)} context inspect desktop-linux --format ${quotePowerShell(endpointTemplate)}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`
  const executed = spawnSync(executable, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(runner, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(executed.error, undefined, executed.error?.message)
  assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`)
  assert.deepEqual(JSON.parse(await fs.readFile(captureFile, 'utf8')),
    ['context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'],
    'the real Node child process receives the exact argument array without PowerShell-only mock dispatch')
})

test('Windows PowerShell 5.1 drains native output, bounds capture, and preserves exit code', async t => {
  const executable = availableWindowsPowerShell51()
  if (!executable) return t.skip('Windows PowerShell 5.1 is unavailable on this host')

  const tempRoot = await makeTempRoot()
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const generatedPowerShell = renderLaunchers({ checkoutRoot: repoRoot, runDirectory: path.join(tempRoot, 'run'),
    projectName: 'ownerinc-payload-preview-012345abcdef' }).powershell
  const helperStart = generatedPowerShell.indexOf('function Invoke-PreviewDockerProbe')
  const helperEnd = generatedPowerShell.indexOf('\n$versionProbe =', helperStart)
  assert(helperStart >= 0 && helperEnd > helperStart, 'renderer exposes the expected native-probe helper in its generated launcher')
  const helper = generatedPowerShell.slice(helperStart, helperEnd)
  const nodeInvocation = `& ${quotePowerShell(process.execPath)} @DockerArguments 2>$null`
  assert(helper.includes('& docker @DockerArguments 2>$null'))
  const nodeBackedHelper = helper.replace('& docker @DockerArguments 2>$null', nodeInvocation)
  const probeFile = path.join(tempRoot, 'native-output-probe.mjs')
  const captureFile = path.join(tempRoot, 'native-output.json')
  await fs.writeFile(probeFile, [
    "process.stdout.write('v2.24.4\\n')",
    "process.stdout.write('unexpected-extra-line\\n')",
    "process.stdout.write('third-line-is-drained\\n')",
    'process.exitCode = 23',
    '',
  ].join('\n'), 'utf8')
  const runner = `
${nodeBackedHelper}
$probeResult = Invoke-PreviewDockerProbe -DockerArguments @(${quotePowerShell(probeFile)})
$report = @{ lines = @($probeResult.Lines); exitCode = $probeResult.ExitCode; overflow = $probeResult.Overflow } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText(${quotePowerShell(captureFile)}, $report, [System.Text.Encoding]::UTF8)
`
  const executed = spawnSync(executable, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(runner, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(executed.error, undefined, executed.error?.message)
  assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`)
  const reportText = (await fs.readFile(captureFile, 'utf8')).replace(/^\uFEFF/u, '')
  const report = JSON.parse(reportText)
  assert.deepEqual(report.lines, ['v2.24.4', 'unexpected-extra-line'], 'only two output lines are retained')
  assert.equal(report.overflow, true, 'additional output is drained but flagged')
  assert.equal(report.exitCode, 23, 'the nonzero native exit is read after the complete output pipeline drains')
})

test('Windows PowerShell 5.1 keeps native stderr nonfatal under all-stream launcher redirection', async t => {
  const executable = availableWindowsPowerShell51()
  if (!executable) return t.skip('Windows PowerShell 5.1 is unavailable on this host')

  const tempRoot = await makeTempRoot()
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const generatedPowerShell = renderLaunchers({ checkoutRoot: repoRoot, runDirectory: path.join(tempRoot, 'run'),
    projectName: 'ownerinc-payload-preview-012345abcdef' }).powershell
  const helperStart = generatedPowerShell.indexOf('function Invoke-PreviewDockerCommand')
  const helperEnd = generatedPowerShell.indexOf('\n$versionProbe =', helperStart)
  assert(helperStart >= 0 && helperEnd > helperStart, 'renderer exposes the native command helper')
  const helper = generatedPowerShell.slice(helperStart, helperEnd)
  const nodeInvocation = `& ${quotePowerShell(process.execPath)} @DockerArguments`
  assert(helper.includes('& docker @DockerArguments'))
  const nodeBackedHelper = helper.replace('& docker @DockerArguments', nodeInvocation)
  const probeFile = path.join(tempRoot, 'native-stderr-probe.mjs')
  const launcherFile = path.join(tempRoot, 'native-command-launcher.ps1')
  const successStatusFile = path.join(tempRoot, 'success-status.txt')
  const failureStatusFile = path.join(tempRoot, 'failure-status.txt')
  const successLogFile = path.join(tempRoot, 'success-launch.log')
  const failureLogFile = path.join(tempRoot, 'failure-launch.log')
  await fs.writeFile(probeFile, [
    'const mode = process.argv[2]',
    "process.stdout.write('native-stdout-' + mode + '\\n')",
    "process.stderr.write('native-stderr-' + mode + '\\n')",
    "process.exitCode = mode === 'failure' ? 23 : 0",
    '',
  ].join('\n'), 'utf8')
  const launcherSource = `param([string]$Mode, [string]$StatusPath)
$ErrorActionPreference = 'Stop'
${nodeBackedHelper}
$dockerArguments = @(${quotePowerShell(probeFile)}, $Mode)
Invoke-PreviewDockerCommand -DockerArguments $dockerArguments
if ($ErrorActionPreference -ne 'Stop') { [System.IO.File]::WriteAllText($StatusPath, 'preference-not-restored'); return }
[System.IO.File]::WriteAllText($StatusPath, [string]$script:PreviewDockerExitCode, [System.Text.Encoding]::UTF8)
`
  await fs.writeFile(launcherFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(launcherSource, 'utf8')]))
  const runner = `
& ${quotePowerShell(launcherFile)} success ${quotePowerShell(successStatusFile)} *> ${quotePowerShell(successLogFile)}
& ${quotePowerShell(launcherFile)} failure ${quotePowerShell(failureStatusFile)} *> ${quotePowerShell(failureLogFile)}
`
  const executed = spawnSync(executable, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(runner, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(executed.error, undefined, executed.error?.message)
  assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`)

  const readStatus = async filePath => (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/u, '').trim()
  const readRedirect = async filePath => {
    const buffer = await fs.readFile(filePath)
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8')
    return buffer.toString('utf8')
  }
  assert.equal(await readStatus(successStatusFile), '0', 'stderr from a successful native process does not abort the launcher')
  assert.equal(await readStatus(failureStatusFile), '23', 'the actual nonzero native status remains visible to the launcher')
  const successLog = await readRedirect(successLogFile)
  const failureLog = await readRedirect(failureLogFile)
  assert(successLog.includes('native-stdout-success') && successLog.includes('native-stderr-success'))
  assert(failureLog.includes('native-stdout-failure') && failureLog.includes('native-stderr-failure'))
})

test('PowerShell launcher rendering quotes Unicode checkout and run paths as literal strings', () => {
  const checkoutRoot = path.resolve('checkout Criação 漢字 $ test')
  const runDirectory = path.resolve('run Criação 漢字 $ test')
  const launcher = renderLaunchers({ checkoutRoot, runDirectory, projectName: 'ownerinc-payload-preview-012345abcdef' }).powershell
  assert(launcher.includes(quotePowerShell(checkoutRoot.replace(/\\/gu, '/'))))
  assert(launcher.includes(quotePowerShell(`${runDirectory.replace(/\\/gu, '/')}/compose.env`)))
  assert(launcher.includes(quotePowerShell(`${runDirectory.replace(/\\/gu, '/')}/compose.preview.yml`)))
})

test('occupied loopback port fails before creating the requested directory', async t => {
  const tempRoot = await makeTempRoot()
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const occupiedServer = net.createServer()
  const occupiedPort = await listen(occupiedServer)
  t.after(() => new Promise(resolve => occupiedServer.close(() => resolve())))
  let freePort = await reservePort()
  while (freePort === occupiedPort) freePort = await reservePort()
  const runDirectory = path.join(tempRoot, 'occupied-port-run')

  await assert.rejects(preparePreview({
    root: repoRoot,
    directory: runDirectory,
    httpPort: freePort,
    authPort: occupiedPort,
    securityContext,
  }), error => error.code === 'port_in_use')
  await assert.rejects(fs.lstat(runDirectory), error => error.code === 'ENOENT')
})

test('real loopback port probe rejects an already-bound port', async t => {
  const server = net.createServer()
  const port = await listen(server)
  t.after(() => new Promise(resolve => server.close(() => resolve())))
  await assert.rejects(assertLoopbackPortFree(port), error => error.code === 'port_in_use')
})

test('Windows private ACL setup requires a usable current-user SID and grants only that user plus SYSTEM', async () => {
  const calls = []
  const context = createSecurityContext({
    platform: 'win32',
    spawn: (command, args) => {
      calls.push({ command, args })
      if (command === 'whoami.exe') return { status: 0, stdout: '"DOMAIN\\preview-user","S-1-5-21-10-20-30-1001"' }
      return { status: 0 }
    },
  })
  assert.equal(context.sid, 'S-1-5-21-10-20-30-1001')
  await securePath('private-artifact', 'directory', context)
  assert.equal(calls[0].command, 'whoami.exe')
  assert.equal(calls[1].command, 'icacls.exe')
  assert(calls[1].args.includes('/inheritance:r'))
  assert(calls[1].args.includes('*S-1-5-21-10-20-30-1001:(OI)(CI)F'))
  assert(calls[1].args.includes('*S-1-5-18:(OI)(CI)F'))

  assert.throws(() => createSecurityContext({
    platform: 'win32',
    spawn: () => ({ status: 0, stdout: 'unknown identity' }),
  }), error => error.code === 'private_acl_unavailable')
  await assert.rejects(securePath('private-artifact', 'file', {
    ...context,
    spawn: () => ({ status: 1 }),
  }), error => error.code === 'private_acl_unavailable')
})

test('POSIX private permissions are explicitly set and verified', async () => {
  const recordedModes = []
  const fileSystem = {
    async chmod(_target, mode) { recordedModes.push(mode) },
    async stat() { return { mode: 0o100600 } },
  }
  const context = { platform: 'linux' }
  await securePath('private-file', 'file', context, fileSystem)
  assert.deepEqual(recordedModes, [0o600])

  await assert.rejects(securePath('loose-directory', 'directory', context, {
    async chmod(_target, mode) { recordedModes.push(mode) },
    async stat() { return { mode: 0o40777 } },
  }), error => error.code === 'private_acl_unavailable')
})

test('path guards reject repository output, symlink ancestors, and missing/relative roots', async t => {
  const tempRoot = await makeTempRoot()
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  await assert.rejects(validateExternalRoot(path.join(repoRoot, 'scripts'), repoRoot), error => error.code === 'directory_overlaps_checkout')
  await assert.rejects(validateExternalRoot('relative-preview-root', repoRoot), error => error.code === 'directory_must_be_absolute')
  await assert.rejects(validateExternalRoot(path.join(tempRoot, 'missing'), repoRoot), error => error.code === 'directory_root_unavailable')

  const external = path.join(tempRoot, 'external')
  await fs.mkdir(external)
  const fakeSymlinkFileSystem = {
    async lstat(candidate) {
      if (path.resolve(candidate) === path.resolve(external)) return { isSymbolicLink: () => true, isDirectory: () => false }
      return fs.lstat(candidate)
    },
    realpath: candidate => fs.realpath(candidate),
  }
  await assert.rejects(
    validateExternalRoot(external, repoRoot, fakeSymlinkFileSystem),
    error => error.code === 'directory_symlink_ancestor',
  )
})

test('source-contract drift fails closed instead of rewriting unexpected content', () => {
  assert.throws(() => renderFirebaseConfig('const firebaseConfig = {};', 'demo-012345abcdef', 19099), error => error.code === 'firebase_config_contract_changed')
  assert.throws(() => renderNginxConfig('connect-src self;', 19099), error => error.code === 'nginx_csp_contract_changed')
  assert.throws(() => validateComposeSource('services: {}', 'services: {}'), error => error.code === 'compose_source_contract_changed')
  assert.match(renderComposeOverride(), /ports: !override/u)
})
