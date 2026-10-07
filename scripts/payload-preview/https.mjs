import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fail } from './errors.mjs'
import {
  assertLoopbackPortFree,
  assertValidPort,
  createSecureDirectory,
  createSecureSubdirectory,
  createSecurityContext,
  validateExternalRoot,
  writeSecureFile,
} from './security.mjs'
import {
  renderFirebaseConfig,
  renderLaunchers,
  renderNginxConfig,
  validateFirebaseAuthContract,
} from './render.mjs'

const projectPattern = /^ownerinc-payload-preview-[a-f0-9]{8,24}$/u
const projectIdPattern = /^demo-[a-f0-9]{8,24}$/u
const outputNamePattern = /^recovery-https-[A-Za-z0-9_-]{1,48}$/u
const emulatorPaths = [
  '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
  '/identitytoolkit.googleapis.com/v1/accounts:lookup',
  '/securetoken.googleapis.com/v1/token',
]
const relevantEnvironmentKeys = new Set([
  'COMPOSE_PROJECT_NAME', 'PREVIEW_RUN_DIR', 'FIREBASE_PROJECT_ID', 'HTTP_PORT', 'AUTH_PORT',
])
const maximumInputBytes = 128 * 1024

function countOccurrences(source, needle) {
  return source.split(needle).length - 1
}

function assertAbsolutePath(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail(code)
  return path.resolve(value)
}

function decodeEnvironmentValue(raw) {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) fail('run_environment_invalid')
    const inner = raw.slice(1, -1)
    let value = ''
    for (let index = 0; index < inner.length; index += 1) {
      const character = inner[index]
      if (character === '\\') {
        const escaped = inner[index + 1]
        if (escaped !== '\\' && escaped !== '"') fail('run_environment_invalid')
        value += escaped
        index += 1
      } else {
        value += character
      }
    }
    return value.replace(/\$\$/gu, '$')
  }
  if (/\s|[\\"']/u.test(raw)) fail('run_environment_invalid')
  return raw.replace(/\$\$/gu, '$')
}

export function parseRunEnvironment(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > maximumInputBytes) {
    fail('run_environment_invalid')
  }
  const values = Object.create(null)
  for (const line of source.split(/\r?\n/u)) readEnvironmentLine(values, line)
  return validatedRunEnvironment(values)
}

function readEnvironmentLine(values, line) {
  if (!line) return
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/u)
  if (!match) fail('run_environment_invalid')
  const key = match[1]
  if (!relevantEnvironmentKeys.has(key)) return
  if (Object.hasOwn(values, key)) fail('run_environment_invalid')
  const raw = line.slice(key.length + 1)
  values[key] = decodeEnvironmentValue(raw)
}

function validatedRunEnvironment(values) {
  for (const key of relevantEnvironmentKeys) {
    if (!Object.hasOwn(values, key)) fail('run_environment_identity_missing')
  }
  if (!projectPattern.test(values.COMPOSE_PROJECT_NAME)
    || !projectIdPattern.test(values.FIREBASE_PROJECT_ID)
    || !/^\d{1,5}$/u.test(values.HTTP_PORT)
    || !/^\d{1,5}$/u.test(values.AUTH_PORT)) {
    fail('run_environment_identity_invalid')
  }
  const httpPort = Number(values.HTTP_PORT)
  const authPort = Number(values.AUTH_PORT)
  assertValidPort(httpPort, 'http')
  assertValidPort(authPort, 'auth')
  return { ...values, HTTP_PORT: httpPort, AUTH_PORT: authPort }
}

function normalizePathIdentity(value) {
  const resolved = path.resolve(value).replace(/[\\/]+/gu, path.sep)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function validateRunIdentity({ environment, runDirectory, projectName }) {
  if (!projectPattern.test(projectName) || environment.COMPOSE_PROJECT_NAME !== projectName) {
    fail('run_project_identity_mismatch')
  }
  if (normalizePathIdentity(environment.PREVIEW_RUN_DIR) !== normalizePathIdentity(runDirectory)) {
    fail('run_directory_identity_mismatch')
  }
  return {
    projectName,
    projectId: environment.FIREBASE_PROJECT_ID,
    httpPort: environment.HTTP_PORT,
    authPort: environment.AUTH_PORT,
  }
}

export function renderHttpsFirebaseConfig(source, { projectId, authPort, httpsPort }) {
  assertValidPort(authPort, 'auth')
  assertValidPort(httpsPort, 'https')
  if (!projectIdPattern.test(projectId)) fail('firebase_config_contract_changed')
  const projectIdProperty = new RegExp(`\\bprojectId\\s*:\\s*(['"])${projectId}\\1\\s*,?`, 'gu')
  if ([...source.matchAll(projectIdProperty)].length !== 1) fail('firebase_config_contract_changed')

  const emulatorCall = /connectAuthEmulator\(auth,\s*(['"])http:\/\/127\.0\.0\.1:(\d+)\1,\s*\{\s*disableWarnings:\s*true\s*\}\s*\);/gu
  const calls = [...source.matchAll(emulatorCall)]
  if (calls.length !== 1 || Number(calls[0][2]) !== authPort) fail('firebase_config_contract_changed')
  const origin = `https://127.0.0.1:${httpsPort}`
  const output = source.replace(emulatorCall, `connectAuthEmulator(auth, '${origin}', { disableWarnings: true });`)
  if (countOccurrences(output, `connectAuthEmulator(auth, '${origin}'`) !== 1
    || /connectAuthEmulator\(auth,\s*['"]http:/u.test(output)) {
    fail('firebase_config_contract_changed')
  }
  return output
}

function renderAuthLocations() {
  return emulatorPaths.map(endpoint => `    location = ${endpoint} {
        limit_except POST { deny all; }
        limit_req zone=api burst=10 nodelay;
        proxy_pass $auth_emulator;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port "";
    }
`).join('')
}

export function renderHttpsNginxConfig(source, { authPort, httpsPort }) {
  assertValidPort(authPort, 'auth')
  assertValidPort(httpsPort, 'https')
  const authCsp = `connect-src 'self' http://127.0.0.1:${authPort} https://*.googleapis.com https://*.firebaseio.com`
  if (countOccurrences(source, authCsp) !== 1 || countOccurrences(source, 'connect-src ') !== 1) {
    fail('nginx_csp_contract_changed')
  }

  const listen = '    listen 80;\n'
  const forwardedProto = `map $http_x_forwarded_proto $forwarded_proto {
    default $http_x_forwarded_proto;
    "" $scheme;
}`
  const cmsUpstream = '    set $cms_upstream http://cms:3001;\n'
  const hsts = '    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'
  if (countOccurrences(source, listen) !== 1
    || countOccurrences(source, forwardedProto) !== 1
    || countOccurrences(source, cmsUpstream) !== 1
    || countOccurrences(source, hsts) !== 1) {
    fail('nginx_tls_contract_changed')
  }

  let output = source.replace(authCsp,
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com")
  output = output.replace(listen, `    listen 443 ssl;\n    ssl_certificate /run/ownerinc-preview-tls/tls.crt;\n    ssl_certificate_key /run/ownerinc-preview-tls/tls.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n`)
  output = output.replace(forwardedProto, `map $scheme $forwarded_proto {
    default $scheme;
}`)
  output = output.replace(cmsUpstream, `${cmsUpstream}    set $auth_emulator http://firebase-auth:9099;\n`)
  output = output.replace(hsts,
    '    add_header Strict-Transport-Security "max-age=0" always;')
  const serverAnchor = '    set $auth_emulator http://firebase-auth:9099;\n'
  output = output.replace(serverAnchor, `${serverAnchor}${renderAuthLocations()}`)

  if (countOccurrences(output, 'listen 443 ssl;') !== 1
    || output.includes('listen 80;')
    || output.includes(`http://127.0.0.1:${authPort}`)
    || output.includes('http://localhost:9099')
    || countOccurrences(output, 'location = /identitytoolkit.googleapis.com/v1/accounts:signInWithPassword') !== 1
    || countOccurrences(output, 'location = /identitytoolkit.googleapis.com/v1/accounts:lookup') !== 1
    || countOccurrences(output, 'location = /securetoken.googleapis.com/v1/token') !== 1) {
    fail('nginx_tls_contract_changed')
  }
  return output
}

export function renderHttpsComposeOverride({ httpsPort, outputName }) {
  assertValidPort(httpsPort, 'https')
  if (!outputNamePattern.test(outputName)) fail('output_directory_name_invalid')
  const origin = `https://127.0.0.1:${httpsPort}`
  const source = `\${PREVIEW_RUN_DIR:?Set PREVIEW_RUN_DIR}/${outputName}`
  return `name: \${COMPOSE_PROJECT_NAME:?Set COMPOSE_PROJECT_NAME}
services:
  api:
    environment:
      PORTAL_PUBLIC_URL: ${JSON.stringify(origin)}
      CORS_ORIGINS: ${JSON.stringify(origin)}
  cms:
    environment:
      NODE_ENV: production
      PORTAL_PUBLIC_URL: ${JSON.stringify(origin)}
  cms-migrate:
    environment:
      NODE_ENV: production
      PORTAL_PUBLIC_URL: ${JSON.stringify(origin)}
  firebase-auth:
    ports: !override []
  nginx:
    ports: !override
      - "127.0.0.1:${httpsPort}:443"
    volumes: !override
      - type: bind
        source: ./public
        target: /usr/share/nginx/html
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ${source}/public/js/firebase-config.js
        target: /usr/share/nginx/html/js/firebase-config.js
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ${source}/nginx.https.conf
        target: /etc/nginx/conf.d/default.conf
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ${source}/tls/tls.crt
        target: /run/ownerinc-preview-tls/tls.crt
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ${source}/tls/tls.key
        target: /run/ownerinc-preview-tls/tls.key
        read_only: true
        bind:
          create_host_path: false
`
}

export function renderHttpsLaunchers({ checkoutRoot, runDirectory, projectName, overrideFile, baseOverride }) {
  const rendered = renderLaunchers({
    checkoutRoot,
    runDirectory,
    projectName,
    additionalComposeFiles: [...(baseOverride ? [baseOverride] : []), overrideFile],
  })
  const shellBuild = 'compose build api cms firebase-auth\n'
  const shellUp = 'compose up -d --wait --wait-timeout 300 nginx cms firebase-auth\n'
  const powershellBuild = `$buildArguments = @('compose') + $compose + @('build', 'api', 'cms', 'firebase-auth')
Invoke-PreviewDockerCommand -DockerArguments $buildArguments
if ($script:PreviewDockerExitCode -ne 0) { exit $script:PreviewDockerExitCode }
`
  const powershellUp = `$upArguments = @('compose') + $compose + @('up', '-d', '--wait', '--wait-timeout', '300', 'nginx', 'cms', 'firebase-auth')`
  if (countOccurrences(rendered.shell, shellBuild) !== 1
    || countOccurrences(rendered.shell, shellUp) !== 1
    || countOccurrences(rendered.powershell, powershellBuild) !== 1
    || countOccurrences(rendered.powershell, powershellUp) !== 1) {
    fail('preview_launcher_contract_changed')
  }
  const shell = rendered.shell
    .replace(shellBuild, '')
    .replace(shellUp, 'compose up --no-build -d --wait --wait-timeout 300 nginx cms firebase-auth\n')
  const powershell = rendered.powershell
    .replace(powershellBuild, '')
    .replace(powershellUp,
      `$upArguments = @('compose') + $compose + @('up', '--no-build', '-d', '--wait', '--wait-timeout', '300', 'nginx', 'cms', 'firebase-auth')`)
  if (/\bcompose build\b|@\('build'/u.test(shell)
    || /\$buildArguments|@\('build'/u.test(powershell)
    || !shell.includes('compose up --no-build -d')
    || !powershell.includes("@('up', '--no-build', '-d'")) {
    fail('preview_launcher_contract_changed')
  }
  return { shell, powershell }
}

function parseCertificateDates(certificate) {
  const validFrom = new Date(certificate.validFrom).getTime()
  const validTo = new Date(certificate.validTo).getTime()
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) fail('tls_certificate_invalid')
  const now = Date.now()
  if (validFrom > now || validTo <= now || validTo <= validFrom) fail('tls_certificate_not_current')
}

export function validateTlsPair(certificatePem, privateKeyPem, {
  certificateFactory = value => new X509Certificate(value),
} = {}) {
  if (typeof certificatePem !== 'string' || typeof privateKeyPem !== 'string'
    || Buffer.byteLength(certificatePem, 'utf8') > maximumInputBytes
    || Buffer.byteLength(privateKeyPem, 'utf8') > maximumInputBytes) {
    fail('tls_certificate_invalid')
  }

  let certificate
  let privateKeyObject
  try {
    certificate = certificateFactory(certificatePem)
    privateKeyObject = createPrivateKey(privateKeyPem)
  } catch { fail('tls_certificate_invalid') }
  parseCertificateDates(certificate)
  try {
    if (certificate.subject !== certificate.issuer
      || typeof certificate.verify !== 'function'
      || !certificate.verify(certificate.publicKey)) {
      fail('tls_certificate_not_self_signed')
    }
    if (typeof certificate.checkIP !== 'function' || !certificate.checkIP('127.0.0.1')
      || typeof certificate.checkHost !== 'function' || !certificate.checkHost('localhost')) {
      fail('tls_certificate_san_invalid')
    }
  } catch (error) {
    if (error?.code) throw error
    fail('tls_certificate_invalid')
  }
  try {
    const certificateKey = certificate.publicKey.export({ type: 'spki', format: 'der' })
    const privateKey = createPublicKey(privateKeyObject).export({ type: 'spki', format: 'der' })
    if (!certificateKey.equals(privateKey)) fail('tls_key_mismatch')
  } catch (error) {
    if (error?.code) throw error
    fail('tls_certificate_invalid')
  }
  return true
}

async function assertNewTarget(target, fileSystem) {
  try {
    await fileSystem.lstat(target)
    fail('output_directory_collision')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function readPrivateRunFile(runDirectory, relativePath, fileSystem) {
  const filePath = path.join(runDirectory, relativePath)
  const relativeDirectory = path.relative(runDirectory, path.dirname(filePath))
  if (path.isAbsolute(relativeDirectory) || relativeDirectory === '..'
    || relativeDirectory.startsWith(`..${path.sep}`)) fail('run_artifact_invalid')
  let current = runDirectory
  for (const part of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let directoryStat
    try { directoryStat = await fileSystem.lstat(current) } catch { fail('run_artifact_unavailable') }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('run_artifact_invalid')
  }
  let stat
  try { stat = await fileSystem.lstat(filePath) } catch { fail('run_artifact_unavailable') }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumInputBytes) fail('run_artifact_invalid')
  try { return await fileSystem.readFile(filePath, 'utf8') } catch { fail('run_artifact_unavailable') }
}

async function readRunEnvironment(runDirectory, fileSystem) {
  const filePath = path.join(runDirectory, 'compose.env')
  const relativeDirectory = path.relative(runDirectory, path.dirname(filePath))
  if (relativeDirectory !== '') fail('run_artifact_invalid')
  let stat
  try { stat = await fileSystem.lstat(filePath) } catch { fail('run_artifact_unavailable') }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumInputBytes) fail('run_artifact_invalid')
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fail('run_environment_permissions_invalid')

  const values = Object.create(null)
  let totalBytes = 0
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      totalBytes += Buffer.byteLength(line, 'utf8') + 1
      if (totalBytes > maximumInputBytes) fail('run_environment_invalid')
      readEnvironmentLine(values, line)
    }
  } catch (error) {
    if (error?.name === 'PreviewPreparationError') throw error
    fail('run_artifact_unavailable')
  } finally {
    reader.close()
    input.destroy()
  }
  return validatedRunEnvironment(values)
}

async function readTlsInput(filePath, { fileSystem, checkoutRoot }) {
  const absolute = assertAbsolutePath(filePath, 'tls_path_must_be_absolute')
  await validateExternalRoot(path.dirname(absolute), checkoutRoot, fileSystem)
  let stat
  try { stat = await fileSystem.lstat(absolute) } catch { fail('tls_input_unavailable') }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > maximumInputBytes) {
    fail('tls_input_invalid')
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fail('tls_input_permissions_invalid')
  try { return await fileSystem.readFile(absolute, 'utf8') } catch { fail('tls_input_unavailable') }
}

export async function checkHttpsPreparationSources({ root, fileSystem = fs } = {}) {
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
  if (!baseCompose.includes('name: ${COMPOSE_PROJECT_NAME:-ownerinc-portal}')
    || !baseCompose.includes('profiles: ["local"]')
    || !baseCompose.includes('\n  postgres:')
    || !baseCompose.includes('\n  firebase-auth:')
    || !baseCompose.includes('\n  nginx:')
    || !baseCompose.includes('postgres_data:/var/lib/postgresql/data')
    || !payloadCompose.includes('cms-postgres:')
    || !payloadCompose.includes('\n  cms-migrate:')
    || !payloadCompose.includes('\n  cms:')
    || !payloadCompose.includes('cms_uploads_data:/var/lib/ownerinc-cms/media')) {
    fail('compose_source_contract_changed')
  }
  const projectId = 'demo-012345abcdef'
  const authPort = 19099
  renderHttpsFirebaseConfig(renderFirebaseConfig(firebaseConfig, projectId, authPort), {
    projectId, authPort, httpsPort: 19443,
  })
  renderHttpsNginxConfig(renderNginxConfig(nginxConfig, authPort), { authPort, httpsPort: 19443 })
  renderHttpsComposeOverride({ httpsPort: 19443, outputName: 'recovery-https-source-check' })
  return { sourceContracts: true, composeMinimumVersion: '2.24.4' }
}

export async function prepareHttpsRecovery({
  root,
  runDirectory,
  outputDirectory,
  projectName,
  httpsPort,
  certificate,
  privateKey,
  baseOverride,
  fileSystem = fs,
  probePort = assertLoopbackPortFree,
  securityContext = createSecurityContext(),
  certificateFactory,
} = {}) {
  const canonicalRunDirectory = await validateExternalRoot(
    assertAbsolutePath(runDirectory, 'run_directory_must_be_absolute'), root, fileSystem,
  )
  const requestedOutput = assertAbsolutePath(outputDirectory, 'output_directory_must_be_absolute')
  const outputName = path.basename(requestedOutput)
  if (!outputNamePattern.test(outputName)
    || normalizePathIdentity(path.dirname(requestedOutput)) !== normalizePathIdentity(canonicalRunDirectory)) {
    fail('output_directory_must_be_new_run_child')
  }
  if (!projectPattern.test(projectName)) fail('run_project_identity_invalid')
  assertValidPort(httpsPort, 'https')
  await assertNewTarget(requestedOutput, fileSystem)

  const environment = await readRunEnvironment(canonicalRunDirectory, fileSystem)
  const identity = validateRunIdentity({
    environment,
    runDirectory: canonicalRunDirectory,
    projectName,
  })
  if (httpsPort === identity.httpPort || httpsPort === identity.authPort) fail('ports_must_differ')
  const [firebaseConfig, nginxConfig] = await Promise.all([
    readPrivateRunFile(canonicalRunDirectory, 'public/js/firebase-config.js', fileSystem),
    readPrivateRunFile(canonicalRunDirectory, 'nginx/nginx.conf', fileSystem),
  ])
  await readPrivateRunFile(canonicalRunDirectory, 'compose.preview.yml', fileSystem)
  let canonicalBaseOverride
  if (baseOverride !== undefined) {
    const requestedBaseOverride = assertAbsolutePath(baseOverride, 'base_override_must_be_absolute')
    const relativeBaseOverride = path.relative(canonicalRunDirectory, requestedBaseOverride)
    if (path.isAbsolute(relativeBaseOverride) || relativeBaseOverride === '..'
      || relativeBaseOverride.startsWith(`..${path.sep}`)
      || !/\.(?:yml|yaml)$/iu.test(relativeBaseOverride)
      || normalizePathIdentity(requestedBaseOverride)
        === normalizePathIdentity(path.join(canonicalRunDirectory, 'compose.preview.yml'))) {
      fail('base_override_must_be_run_child')
    }
    await readPrivateRunFile(canonicalRunDirectory, relativeBaseOverride, fileSystem)
    canonicalBaseOverride = requestedBaseOverride
  }
  const tlsCertificate = await readTlsInput(certificate, { fileSystem, checkoutRoot: root })
  const tlsPrivateKey = await readTlsInput(privateKey, { fileSystem, checkoutRoot: root })
  const tlsOptions = certificateFactory ? { certificateFactory } : undefined
  validateTlsPair(tlsCertificate, tlsPrivateKey, tlsOptions)

  const httpsFirebaseConfig = renderHttpsFirebaseConfig(firebaseConfig, {
    projectId: identity.projectId,
    authPort: identity.authPort,
    httpsPort,
  })
  const httpsNginxConfig = renderHttpsNginxConfig(nginxConfig, {
    authPort: identity.authPort,
    httpsPort,
  })
  const override = renderHttpsComposeOverride({ httpsPort, outputName })
  const overrideFile = path.join(requestedOutput, 'compose.preview.https.yml')
  const launchers = renderHttpsLaunchers({
    checkoutRoot: root,
    runDirectory: canonicalRunDirectory,
    projectName,
    overrideFile,
    baseOverride: canonicalBaseOverride,
  })

  await probePort(httpsPort)
  const outputRoot = await createSecureDirectory(
    canonicalRunDirectory, outputName, securityContext, fileSystem,
  )
  const publicDirectory = await createSecureSubdirectory(outputRoot, 'public', securityContext, fileSystem)
  const publicJsDirectory = await createSecureSubdirectory(publicDirectory, 'js', securityContext, fileSystem)
  const tlsDirectory = await createSecureSubdirectory(outputRoot, 'tls', securityContext, fileSystem)
  const artifacts = [
    [path.join(outputRoot, 'compose.preview.https.yml'), override],
    [path.join(outputRoot, 'nginx.https.conf'), httpsNginxConfig],
    [path.join(publicJsDirectory, 'firebase-config.js'), httpsFirebaseConfig],
    [path.join(tlsDirectory, 'tls.crt'), tlsCertificate],
    [path.join(tlsDirectory, 'tls.key'), tlsPrivateKey],
    [path.join(outputRoot, 'launch-https.sh'), launchers.shell],
    [path.join(outputRoot, 'launch-https.ps1'), launchers.powershell, { utf8Bom: true }],
  ]
  for (const [filePath, contents, options] of artifacts) {
    await writeSecureFile(filePath, contents, securityContext, fileSystem, options)
  }

  return {
    runDirectory: canonicalRunDirectory,
    outputDirectory: outputRoot,
    projectName: identity.projectName,
    projectId: identity.projectId,
    httpsPort,
    origin: `https://127.0.0.1:${httpsPort}`,
    shellLauncher: path.join(outputRoot, 'launch-https.sh'),
    powershellLauncher: path.join(outputRoot, 'launch-https.ps1'),
    certificateFile: path.join(tlsDirectory, 'tls.crt'),
    privateKeyFile: path.join(tlsDirectory, 'tls.key'),
  }
}
