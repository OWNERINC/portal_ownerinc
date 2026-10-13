import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkHttpsPreparationSources,
  parseRunEnvironment,
  prepareHttpsRecovery,
  renderHttpsComposeOverride,
  renderHttpsFirebaseConfig,
  renderHttpsLaunchers,
  renderHttpsNginxConfig,
  validateRunIdentity,
  validateTlsPair,
} from '../../scripts/payload-preview/https.mjs'
import { parseCommandLine } from '../../scripts/prepare-payload-preview-https.mjs'
import { preparePreview } from '../../scripts/prepare-payload-preview.mjs'
import { composeEnvironmentKeys } from '../../scripts/payload-preview/render.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateAcl = {
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
  return fs.mkdtemp(path.join(externalParent, 'payload-preview-https-'))
}

async function makeCheckout(tempRoot) {
  const checkout = path.join(tempRoot, 'checkout fixture')
  for (const relative of [
    'public/js/firebase-config.js', 'public/js/auth.js', 'nginx/nginx.conf',
    'docker-compose.yml', 'docker-compose.payload.yml',
  ]) {
    const destination = path.join(checkout, relative)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(path.join(repoRoot, relative), destination)
  }
  return checkout
}

function makeCertificatePolicyFixture() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' })
  // An injected policy fixture, not a real X509 certificate or static key.
  const certificatePem = 'synthetic-test-only-certificate'
  const certificate = {
    subject: 'CN=127.0.0.1',
    issuer: 'CN=127.0.0.1',
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validTo: new Date(Date.now() + 60_000).toISOString(),
    publicKey: pair.publicKey,
    verify: key => key === pair.publicKey,
    checkIP: value => value === '127.0.0.1' ? value : undefined,
    checkHost: value => value === 'localhost' ? value : undefined,
  }
  return { certificatePem, privateKey, publicKeyPem, certificate, certificateFactory: () => certificate }
}

async function makeRunFixture(t, { projectName = 'ownerinc-payload-preview-012345abcdef' } = {}) {
  const tempRoot = await makeTempRoot()
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const checkout = await makeCheckout(tempRoot)
  const runParent = path.join(tempRoot, 'run-parent')
  await fs.mkdir(runParent)
  const runDirectory = path.join(runParent, 'existing-private-run')
  const result = await preparePreview({
    root: checkout,
    directory: runDirectory,
    httpPort: 18080,
    authPort: 19099,
    securityContext: privateAcl,
    probePort: async () => {},
    runIdFactory: () => projectName.slice('ownerinc-payload-preview-'.length),
  })
  const tlsInputDirectory = path.join(runDirectory, 'tls-input')
  await fs.mkdir(tlsInputDirectory, { mode: 0o700 })
  const fixture = makeCertificatePolicyFixture()
  const certificatePath = path.join(tlsInputDirectory, 'localhost.crt')
  const privateKeyPath = path.join(tlsInputDirectory, 'localhost.key')
  const publicKeyPath = path.join(tlsInputDirectory, 'localhost.pub')
  await fs.writeFile(certificatePath, fixture.certificatePem, { mode: 0o600 })
  await fs.writeFile(privateKeyPath, fixture.privateKey, { mode: 0o600 })
  await fs.writeFile(publicKeyPath, fixture.publicKeyPem, { mode: 0o600 })
  return {
    tempRoot,
    checkout,
    runDirectory,
    projectName: result.projectName,
    certificatePath,
    privateKeyPath,
    publicKeyPath,
    ...fixture,
  }
}

function recoveryArgs(fixture, outputName = 'recovery-https-test-a') {
  return {
    root: fixture.checkout,
    runDirectory: fixture.runDirectory,
    outputDirectory: path.join(fixture.runDirectory, outputName),
    projectName: fixture.projectName,
    httpsPort: 19443,
    certificate: fixture.certificatePath,
    privateKey: fixture.privateKeyPath,
    securityContext: privateAcl,
    probePort: async () => {},
    certificateFactory: fixture.certificateFactory,
  }
}

test('CLI requires explicit existing-run identity and private TLS inputs', () => {
  assert.deepEqual(parseCommandLine(['--help']), { mode: 'help' })
  assert.deepEqual(parseCommandLine(['--check']), { mode: 'check' })
  const options = [
    'prepare', '--run-directory', path.resolve('private-run'),
    '--output-directory', path.resolve('private-run/recovery-https-test-a'),
    '--project', 'ownerinc-payload-preview-012345abcdef', '--https-port', '19443',
    '--certificate', path.resolve('localhost.crt'), '--private-key', path.resolve('localhost.key'),
  ]
  assert.deepEqual(parseCommandLine(options), {
    mode: 'prepare',
    runDirectory: path.resolve('private-run'),
    outputDirectory: path.resolve('private-run/recovery-https-test-a'),
    projectName: 'ownerinc-payload-preview-012345abcdef',
    httpsPort: 19443,
    certificate: path.resolve('localhost.crt'),
    privateKey: path.resolve('localhost.key'),
  })
  const withBase = parseCommandLine([...options, '--base-override', path.resolve('private-run/compose.runtime-fix.yml')])
  assert.equal(withBase.baseOverride, path.resolve('private-run/compose.runtime-fix.yml'))
  assert.throws(() => parseCommandLine(options.slice(0, -2)))
  assert.throws(() => parseCommandLine([...options, '--base-override', 'relative.yml']))
  assert.throws(() => parseCommandLine([...options, '--project', 'ownerinc-payload-preview-012345abcdef']))
  assert.throws(() => parseCommandLine(options.map((value, index) => index === 6 ? 'not-a-project' : value)))
})

test('run metadata parsing retains only required identity values and rejects ambiguous identity', () => {
  const source = [
    'COMPOSE_PROJECT_NAME=ownerinc-payload-preview-012345abcdef',
    'POSTGRES_PASSWORD=x',
    'PREVIEW_RUN_DIR="C:/Users/Public/preview $$ run"',
    'FIREBASE_PROJECT_ID=demo-012345abcdef',
    'HTTP_PORT=18080',
    'AUTH_PORT=19099',
  ].join('\n')
  const parsed = parseRunEnvironment(source)
  assert.deepEqual(Object.keys(parsed).sort(), [
    'AUTH_PORT', 'COMPOSE_PROJECT_NAME', 'FIREBASE_PROJECT_ID', 'HTTP_PORT', 'PREVIEW_RUN_DIR',
  ])
  assert.equal(parsed.PREVIEW_RUN_DIR, 'C:/Users/Public/preview $ run')
  assert.equal(parsed.AUTH_PORT, 19099)
  assert.equal(parsed.HTTP_PORT, 18080)
  assert.doesNotMatch(JSON.stringify(parsed), /POSTGRES_PASSWORD/u)

  assert.throws(() => parseRunEnvironment(`${source}\nCOMPOSE_PROJECT_NAME=ownerinc-payload-preview-abcdef012345`),
    error => error.code === 'run_environment_invalid')
  assert.throws(() => validateRunIdentity({
    environment: parsed,
    runDirectory: 'C:/Users/Public/preview $ run',
    projectName: 'ownerinc-payload-preview-abcdef012345',
  }), error => error.code === 'run_project_identity_mismatch')
  assert.throws(() => validateRunIdentity({
    environment: parsed,
    runDirectory: 'C:/Users/Public/another-run',
    projectName: parsed.COMPOSE_PROJECT_NAME,
  }), error => error.code === 'run_directory_identity_mismatch')
})

test('HTTPS browser auth is same-origin and its TLS Nginx proxy exposes only the required Firebase SDK calls', async t => {
  const fixture = await makeRunFixture(t)
  const baseFirebase = await fs.readFile(path.join(fixture.runDirectory, 'public/js/firebase-config.js'), 'utf8')
  const secureFirebase = renderHttpsFirebaseConfig(baseFirebase, {
    projectId: 'demo-012345abcdef', authPort: 19099, httpsPort: 19443,
  })
  assert.match(secureFirebase, /connectAuthEmulator\(auth, 'https:\/\/127\.0\.0\.1:19443'/u)
  assert.doesNotMatch(secureFirebase, /http:\/\/127\.0\.0\.1:19099|ownerinc-portal-interno-prod/u)
  assert.throws(() => renderHttpsFirebaseConfig(baseFirebase, {
    projectId: 'demo-abcdef012345', authPort: 19099, httpsPort: 19443,
  }), error => error.code === 'firebase_config_contract_changed')

  const baseNginx = await fs.readFile(path.join(fixture.runDirectory, 'nginx/nginx.conf'), 'utf8')
  const secureNginx = renderHttpsNginxConfig(baseNginx, { authPort: 19099, httpsPort: 19443 })
  assert.match(secureNginx, /listen 443 ssl;/u)
  assert.match(secureNginx, /ssl_certificate_key \/run\/ownerinc-preview-tls\/tls\.key;/u)
  assert.match(secureNginx, /map \$scheme \$forwarded_proto/u)
  assert.match(secureNginx, /Strict-Transport-Security "max-age=0"/u)
  assert.match(secureNginx, /connect-src 'self' https:\/\/\*\.googleapis\.com/u)
  assert.doesNotMatch(secureNginx, /listen 80;|http:\/\/127\.0\.0\.1:19099|localhost:9099/u)
  assert.equal((secureNginx.match(/location = \/(?:identitytoolkit|securetoken)\.googleapis\.com\//gu) || []).length, 3)
  assert.equal((secureNginx.match(/limit_except POST \{ deny all; \}/gu) || []).length, 3)
  assert.equal((secureNginx.match(/proxy_pass \$auth_emulator;/gu) || []).length, 3)
  assert.doesNotMatch(secureNginx, /location \^~ \/identitytoolkit\.googleapis\.com/u)
})

test('HTTPS override disables direct HTTP/Auth publication and keeps production CMS origin and read-only TLS mounts', () => {
  const override = renderHttpsComposeOverride({ httpsPort: 19443, outputName: 'recovery-https-test-a' })
  assert.match(override, /api:[\s\S]*?PORTAL_PUBLIC_URL: "https:\/\/127\.0\.0\.1:19443"[\s\S]*?CORS_ORIGINS: "https:\/\/127\.0\.0\.1:19443"/u)
  assert.match(override, /CORS_ORIGINS: "https:\/\/127\.0\.0\.1:19443"/u)
  assert.match(override, /cms:[\s\S]*?NODE_ENV: production[\s\S]*?PORTAL_PUBLIC_URL: "https:\/\/127\.0\.0\.1:19443"/u)
  assert.match(override, /cms-migrate:[\s\S]*?NODE_ENV: production[\s\S]*?PORTAL_PUBLIC_URL: "https:\/\/127\.0\.0\.1:19443"/u)
  assert.match(override, /firebase-auth:\n    ports: !override \[\]/u)
  assert.match(override, /127\.0\.0\.1:19443:443/u)
  assert.doesNotMatch(override, /127\.0\.0\.1:\$\{HTTP_PORT|127\.0\.0\.1:\$\{AUTH_PORT/u)
  assert.equal((override.match(/read_only: true/gu) || []).length, 5)
  assert.equal((override.match(/target: \/usr\/share\/nginx\/html\/js\/firebase-config\.js/gu) || []).length, 1)
  assert.match(override, /tls\/tls\.key[\s\S]*?read_only: true/u)
})

test('HTTPS launchers keep original Compose identity and use existing images without rebuilding', () => {
  const checkoutRoot = path.resolve('checkout fixture')
  const runDirectory = path.resolve('existing private run')
  const overrideFile = path.join(runDirectory, 'recovery-https-test-a', 'compose.preview.https.yml')
  const launchers = renderHttpsLaunchers({
    checkoutRoot, runDirectory, projectName: 'ownerinc-payload-preview-012345abcdef', overrideFile,
  })
  const originalOverride = `${runDirectory.replace(/\\/gu, '/')}/compose.preview.yml`
  const additionalOverride = overrideFile.replace(/\\/gu, '/')
  for (const launcher of [launchers.shell, launchers.powershell]) {
    assert(launcher.includes(originalOverride))
    assert(launcher.includes(additionalOverride))
    assert(launcher.includes('ownerinc-payload-preview-012345abcdef'))
    assert(launcher.includes(`${runDirectory.replace(/\\/gu, '/')}/compose.env`))
    assert.doesNotMatch(launcher, /docker compose[^\n]* down|cms-worker|bootstrap-admin|--profile tools/u)
  }
  assert.match(launchers.shell, /config --quiet[\s\S]*up --no-build -d --wait/u)
  assert.doesNotMatch(launchers.shell, /compose build/u)
  assert.match(launchers.powershell, /config', '--quiet'[\s\S]*'up', '--no-build', '-d'/u)
  assert.doesNotMatch(launchers.powershell, /\$buildArguments|@\('build'/u)

  const baseOverride = path.join(runDirectory, 'recovery-runtime-fix', 'compose.preview.runtime-fix.yml')
  const withBase = renderHttpsLaunchers({
    checkoutRoot, runDirectory, projectName: 'ownerinc-payload-preview-012345abcdef', overrideFile, baseOverride,
  })
  const normalizedBase = baseOverride.replace(/\\/gu, '/')
  for (const launcher of [withBase.shell, withBase.powershell]) {
    assert(launcher.indexOf(originalOverride) < launcher.indexOf(normalizedBase))
    assert(launcher.indexOf(normalizedBase) < launcher.indexOf(additionalOverride))
  }
})

test('TLS policy fixture exercises real private-key parsing and rejects a public PEM', () => {
  const fixture = makeCertificatePolicyFixture()
  assert.equal(validateTlsPair(fixture.certificatePem, fixture.privateKey, {
    certificateFactory: fixture.certificateFactory,
  }), true)
  assert.throws(() => validateTlsPair(fixture.certificatePem, fixture.publicKeyPem, {
    certificateFactory: fixture.certificateFactory,
  }), error => error.code === 'tls_certificate_invalid', 'a public key must not be accepted as the TLS private key')

  const noLoopbackSan = { ...fixture.certificate, checkIP: () => undefined }
  assert.throws(() => validateTlsPair(fixture.certificatePem, fixture.privateKey, {
    certificateFactory: () => noLoopbackSan,
  }), error => error.code === 'tls_certificate_san_invalid')
  const expired = { ...fixture.certificate, validTo: new Date(Date.now() - 1).toISOString() }
  assert.throws(() => validateTlsPair(fixture.certificatePem, fixture.privateKey, {
    certificateFactory: () => expired,
  }), error => error.code === 'tls_certificate_not_current')
  const notSelfSigned = { ...fixture.certificate, issuer: 'CN=other' }
  assert.throws(() => validateTlsPair(fixture.certificatePem, fixture.privateKey, {
    certificateFactory: () => notSelfSigned,
  }), error => error.code === 'tls_certificate_not_self_signed')
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  assert.throws(() => validateTlsPair(fixture.certificatePem, otherKey, {
    certificateFactory: fixture.certificateFactory,
  }), error => error.code === 'tls_key_mismatch')
  assert.throws(() => validateTlsPair('not a certificate', fixture.privateKey),
    error => error.code === 'tls_certificate_invalid')
})

test('prepare writes exclusive private TLS recovery artifacts and leaves the run env, config, and images untouched', async t => {
  const fixture = await makeRunFixture(t)
  const envPath = path.join(fixture.runDirectory, 'compose.env')
  const originalEnv = await fs.readFile(envPath, 'utf8')
  const originalFirebase = await fs.readFile(path.join(fixture.runDirectory, 'public/js/firebase-config.js'), 'utf8')
  const originalNginx = await fs.readFile(path.join(fixture.runDirectory, 'nginx/nginx.conf'), 'utf8')
  const result = await prepareHttpsRecovery(recoveryArgs(fixture))

  assert.equal(result.projectName, fixture.projectName)
  assert.equal(result.origin, 'https://127.0.0.1:19443')
  assert.equal(await fs.readFile(envPath, 'utf8'), originalEnv)
  assert.equal(await fs.readFile(path.join(fixture.runDirectory, 'public/js/firebase-config.js'), 'utf8'), originalFirebase)
  assert.equal(await fs.readFile(path.join(fixture.runDirectory, 'nginx/nginx.conf'), 'utf8'), originalNginx)
  assert.equal(await fs.readFile(path.join(result.outputDirectory, 'tls/tls.key'), 'utf8'), fixture.privateKey)

  const generatedOverride = await fs.readFile(path.join(result.outputDirectory, 'compose.preview.https.yml'), 'utf8')
  const generatedNginx = await fs.readFile(path.join(result.outputDirectory, 'nginx.https.conf'), 'utf8')
  const generatedFirebase = await fs.readFile(path.join(result.outputDirectory, 'public/js/firebase-config.js'), 'utf8')
  assert.match(generatedOverride, /recovery-https-test-a\/tls\/tls\.key/u)
  assert.match(generatedOverride, /ports: !override \[\]/u)
  assert.match(generatedNginx, /listen 443 ssl;/u)
  assert.match(generatedFirebase, /https:\/\/127\.0\.0\.1:19443/u)
  assert.doesNotMatch(generatedFirebase, /ownerinc-portal-interno-prod/u)

  const shell = await fs.readFile(result.shellLauncher, 'utf8')
  const powershell = await fs.readFile(result.powershellLauncher, 'utf8')
  assert.match(shell, /up --no-build/u)
  assert(!`${shell}${powershell}`.includes(fixture.privateKey), 'launchers do not contain the TLS private key')
  if (process.platform !== 'win32') {
    for (const filePath of [
      path.join(result.outputDirectory, 'compose.preview.https.yml'),
      path.join(result.outputDirectory, 'nginx.https.conf'),
      path.join(result.outputDirectory, 'tls/tls.key'),
      result.shellLauncher,
      result.powershellLauncher,
    ]) assert.equal((await fs.stat(filePath)).mode & 0o077, 0)
  }

  await assert.rejects(prepareHttpsRecovery(recoveryArgs(fixture)),
    error => error.code === 'output_directory_collision')
})

test('prepare refuses mismatched projects, outside output paths, and occupied TLS ports before creating output', async t => {
  const fixture = await makeRunFixture(t)
  const valid = recoveryArgs(fixture, 'recovery-https-negative-a')
  let probes = 0
  const mismatch = { ...valid, projectName: 'ownerinc-payload-preview-abcdef012345', probePort: async () => { probes += 1 } }
  await assert.rejects(prepareHttpsRecovery(mismatch), error => error.code === 'run_project_identity_mismatch')
  assert.equal(probes, 0)
  await assert.rejects(prepareHttpsRecovery({ ...valid, outputDirectory: path.join(fixture.tempRoot, 'outside') }),
    error => error.code === 'output_directory_must_be_new_run_child')
  await assert.rejects(prepareHttpsRecovery({ ...valid, baseOverride: path.join(fixture.tempRoot, 'runtime-fix.yml') }),
    error => error.code === 'base_override_must_be_run_child')
  await assert.rejects(prepareHttpsRecovery({
    ...valid,
    probePort: async () => { throw Object.assign(new Error('in use'), { code: 'port_in_use' }) },
  }), error => error.code === 'port_in_use')
  await assert.rejects(fs.lstat(valid.outputDirectory), error => error.code === 'ENOENT')

  const publicKeyOutput = path.join(fixture.runDirectory, 'recovery-https-public-key-rejected')
  await assert.rejects(prepareHttpsRecovery({
    ...recoveryArgs(fixture, 'recovery-https-public-key-rejected'),
    privateKey: fixture.publicKeyPath,
  }), error => error.code === 'tls_certificate_invalid')
  await assert.rejects(fs.lstat(publicKeyOutput), error => error.code === 'ENOENT')
})

test('HTTPS source check validates checkout contracts without inspecting any private run', async () => {
  assert.deepEqual(await checkHttpsPreparationSources({ root: repoRoot }), {
    sourceContracts: true,
    composeMinimumVersion: '2.24.4',
  })
})

test('read-only Compose config merges the synthetic HTTPS recovery override when Docker Compose is available', async t => {
  const environment = { ...process.env }
  for (const key of [
    ...composeEnvironmentKeys, 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES',
    'COMPOSE_DISABLE_ENV_FILE', 'DOCKER_HOST', 'DOCKER_CONTEXT',
  ]) delete environment[key]
  const version = spawnSync('docker', ['compose', 'version', '--short'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, env: environment,
  })
  if (version.error || version.status !== 0) return t.skip('Docker Compose is unavailable')

  const fixture = await makeRunFixture(t)
  const result = await prepareHttpsRecovery(recoveryArgs(fixture))
  const configuration = spawnSync('docker', [
    'compose', '--profile', 'local',
    '--project-directory', fixture.checkout,
    '--env-file', path.join(fixture.runDirectory, 'compose.env'),
    '--project-name', fixture.projectName,
    '-f', path.join(fixture.checkout, 'docker-compose.yml'),
    '-f', path.join(fixture.checkout, 'docker-compose.payload.yml'),
    '-f', path.join(fixture.runDirectory, 'compose.preview.yml'),
    '-f', path.join(result.outputDirectory, 'compose.preview.https.yml'),
    'config', '--format', 'json',
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: environment })
  assert.equal(configuration.error, undefined)
  assert.equal(configuration.status, 0)
  const merged = JSON.parse(configuration.stdout)
  assert.equal(merged.services.api.environment.PORTAL_PUBLIC_URL, result.origin)
  assert.equal(merged.services.api.environment.CORS_ORIGINS, result.origin)
  assert.equal(merged.services.cms.environment.NODE_ENV, 'production')
  assert.equal(merged.services['cms-migrate'].environment.NODE_ENV, 'production')
  assert.deepEqual(merged.services.nginx.ports.map(({ host_ip, published, target }) => ({ host_ip, published, target })), [
    { host_ip: '127.0.0.1', published: '19443', target: 443 },
  ])
  assert.equal(merged.services['firebase-auth'].ports?.length || 0, 0)
  assert(merged.services.nginx.volumes.every(volume => volume.read_only))
})
