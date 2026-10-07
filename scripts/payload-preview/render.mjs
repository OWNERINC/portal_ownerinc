import path from 'node:path'
import { fail } from './errors.mjs'

const BASE_AUTH_ORIGINS = "http://127.0.0.1:9099 http://localhost:9099"

export const composeEnvironmentKeys = [
  'COMPOSE_PROJECT_NAME', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'API_IMAGE', 'NODE_ENV',
  'MIGRATION_DATABASE_URL', 'PORTAL_API_DB_PASSWORD', 'PORTAL_CRON_DB_PASSWORD', 'API_DATABASE_URL',
  'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_AUTH_EMULATOR_HOST', 'CORS_ORIGINS',
  'SMTP_ADDRESS', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_AUTHENTICATION', 'SMTP_DOMAIN',
  'SMTP_ENABLE_STARTTLS_AUTO', 'SMTP_OPENSSL_VERIFY_MODE', 'MAILER_SENDER_EMAIL',
  'SOLIDES_RELEASE_STAGE', 'SOLIDES_TOKEN', 'SOLIDES_EMPLOYER_BASE_URL', 'SOLIDES_PUNCH_BASE_URL',
  'SOLIDES_REPORT_BASE_URL', 'SOLIDES_REQUEST_TIMEOUT_MS', 'SOLIDES_PILOT_UIDS', 'BULK_IMPORT_WORKER_SECRET',
  'BIND_ADDRESS', 'HTTP_PORT', 'CRON_IMAGE', 'CRON_DATABASE_URL', 'OPERATIONAL_ALERT_EMAIL', 'TZ',
  'MAX_PENDING_REGISTRATIONS_PER_HOUR', 'NOTIFICATION_RETENTION_DAYS', 'AUDIT_RETENTION_DAYS', 'PENDING_REGISTRATION_RETENTION_DAYS',
  'UPLOAD_DIR', 'AUTOCARD_MEDIA_ORPHAN_DAYS', 'CMS_ASSET_ORPHAN_RETENTION_DAYS', 'BULK_IMPORT_API_URL',
  'CRON_BOOTSTRAP_ONLY', 'CMS_IMAGE', 'CMS_RUNTIME_DATABASE_URL', 'PAYLOAD_SECRET', 'PORTAL_PUBLIC_URL',
  'PAYLOAD_TO_PORTAL_SECRET', 'PORTAL_TO_PAYLOAD_SECRET', 'CMS_POSTGRES_PASSWORD', 'CMS_ADMIN_DATABASE_URL',
  'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD', 'CMS_MIGRATION_DATABASE_URL', 'PREVIEW_FIREBASE_IMAGE',
  'AUTH_PORT', 'PREVIEW_RUN_DIR',
]

function countOccurrences(source, needle) {
  return source.split(needle).length - 1
}

function updateConfigProperty(block, name, value) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const property = new RegExp(`^(\\s*${escapedName}\\s*:\\s*)(['\"])([^'\"]*)\\2(\\s*,?\\s*)$`, 'mu')
  if (countOccurrences(block, `${name}:`) !== 1 || !property.test(block)) fail('firebase_config_contract_changed')
  return block.replace(property, (_match, prefix, quote, _value, suffix) => `${prefix}${quote}${value}${quote}${suffix}`)
}

export function renderFirebaseConfig(source, projectId, authPort) {
  if (!/^demo-[a-f0-9]{8,24}$/u.test(projectId) || !Number.isInteger(authPort) || authPort < 1024 || authPort > 65535) {
    fail('firebase_config_contract_changed')
  }
  const blocks = source.match(/const firebaseConfig = \{[\s\S]*?\n\};/gu) || []
  if (blocks.length !== 1) fail('firebase_config_contract_changed')

  let block = blocks[0]
  const values = {
    apiKey: 'fake-api-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: `${projectId}.firebasestorage.app`,
    messagingSenderId: '000000000000',
    appId: `1:000000000000:web:${projectId.slice(-16)}`,
  }
  for (const [name, value] of Object.entries(values)) block = updateConfigProperty(block, name, value)

  if (countOccurrences(source, "'http://127.0.0.1:9099'") !== 1
    || !source.includes("export const auth = initializeAuth(app, { persistence: browserLocalPersistence });")) {
    fail('firebase_config_contract_changed')
  }

  const output = source.replace(blocks[0], block).replace(
    "'http://127.0.0.1:9099'",
    `'http://127.0.0.1:${authPort}'`,
  )
  if (output.includes('ownerinc-portal-interno-prod') || countOccurrences(output, `http://127.0.0.1:${authPort}`) !== 1) {
    fail('firebase_config_contract_changed')
  }
  return output
}

export function validateFirebaseAuthContract(firebaseConfigSource, authSource) {
  const moduleImport = authSource.match(/import\s+\{\s*auth\s*\}\s+from\s+(['"])\.\/firebase-config\.js\1\s*;/u)
  const configAuthSdk = firebaseConfigSource.match(/from\s+(['"])(https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-auth\.js)\1/u)?.[2]
  const authModuleSdk = authSource.match(/from\s+(['"])(https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-auth\.js)\1/u)?.[2]
  const appSdk = firebaseConfigSource.match(/from\s+(['"])(https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-app\.js)\1/u)?.[2]
  if (!moduleImport || !configAuthSdk || configAuthSdk !== authModuleSdk || !appSdk
    || !firebaseConfigSource.includes('export const auth = initializeAuth(')) {
    fail('firebase_auth_contract_changed')
  }
}

export function renderNginxConfig(source, authPort) {
  if (!Number.isInteger(authPort) || authPort < 1024 || authPort > 65535) fail('nginx_csp_contract_changed')
  const directive = `connect-src 'self' ${BASE_AUTH_ORIGINS} https://*.googleapis.com https://*.firebaseio.com`
  if (countOccurrences(source, directive) !== 1 || countOccurrences(source, 'connect-src ') !== 1) {
    fail('nginx_csp_contract_changed')
  }
  return source.replace(directive,
    `connect-src 'self' http://127.0.0.1:${authPort} https://*.googleapis.com https://*.firebaseio.com`)
}

function envLine(name, value) {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof value !== 'string' || /[\r\n\0]/u.test(value)) {
    fail('env_render_failed')
  }
  const escaped = value.replace(/\$/gu, () => '$$')
  const encoded = /[\s#"'\\]/u.test(value)
    ? `"${escaped.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
    : escaped
  return `${name}=${encoded}`
}

export function renderComposeEnv(values) {
  return `${Object.entries(values).map(([name, value]) => envLine(name, value)).join('\n')}\n`
}

export function renderComposeOverride() {
  return `name: \${COMPOSE_PROJECT_NAME:?Set COMPOSE_PROJECT_NAME}
services:
  firebase-auth:
    image: \${PREVIEW_FIREBASE_IMAGE:?Set PREVIEW_FIREBASE_IMAGE}
    command:
      - firebase
      - emulators:start
      - --only
      - auth
      - --project
      - \${FIREBASE_PROJECT_ID:?Set FIREBASE_PROJECT_ID}
    environment:
      GCLOUD_PROJECT: \${FIREBASE_PROJECT_ID:?Set FIREBASE_PROJECT_ID}
      FIREBASE_PROJECT: \${FIREBASE_PROJECT_ID:?Set FIREBASE_PROJECT_ID}
    ports: !override
      - "127.0.0.1:\${AUTH_PORT:?Set AUTH_PORT}:9099"
  nginx:
    ports: !override
      - "127.0.0.1:\${HTTP_PORT:?Set HTTP_PORT}:80"
    volumes: !override
      - type: bind
        source: ./public
        target: /usr/share/nginx/html
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: \${PREVIEW_RUN_DIR:?Set PREVIEW_RUN_DIR}/public/js/firebase-config.js
        target: /usr/share/nginx/html/js/firebase-config.js
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: \${PREVIEW_RUN_DIR:?Set PREVIEW_RUN_DIR}/nginx/nginx.conf
        target: /etc/nginx/conf.d/default.conf
        read_only: true
        bind:
          create_host_path: false
  cms:
    environment:
      NODE_ENV: development
`
}

function shellQuote(value) {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

function powershellQuote(value) {
  return `'${value.replace(/'/gu, "''")}'`
}

function composeArguments({ checkoutRoot, runDirectory, projectName }) {
  const normalized = value => path.resolve(value).replace(/\\/gu, '/')
  return [
    '--profile', 'local',
    '--project-directory', normalized(checkoutRoot),
    '--env-file', `${normalized(runDirectory)}/compose.env`,
    '--project-name', projectName,
    '-f', normalized(path.join(checkoutRoot, 'docker-compose.yml')),
    '-f', normalized(path.join(checkoutRoot, 'docker-compose.payload.yml')),
    '-f', `${normalized(runDirectory)}/compose.preview.yml`,
  ]
}

function localComposeGuardShell() {
  return `version=\$(docker compose version --short 2>/dev/null) || { echo 'PREVIEW_BLOCKED compose_unavailable' >&2; exit 2; }
version=\${version#v}
major=\${version%%.*}; remainder=\${version#*.}; minor=\${remainder%%.*}; patch=\${remainder#*.}; patch=\${patch%%[!0-9]*}
case \${major}:\${minor}:\${patch} in *[!0-9:]*|::*|:*|*:) echo 'PREVIEW_BLOCKED compose_version_unreadable' >&2; exit 2 ;; esac
if [ \"$major\" -lt 2 ] || { [ \"$major\" -eq 2 ] && [ \"$minor\" -lt 24 ]; } || { [ \"$major\" -eq 2 ] && [ \"$minor\" -eq 24 ] && [ \"$patch\" -lt 4 ]; }; then
  echo 'PREVIEW_BLOCKED compose_2_24_4_required' >&2; exit 2
fi
context=\$(docker context show 2>/dev/null) || { echo 'PREVIEW_BLOCKED local_docker_context_required' >&2; exit 2; }
endpoint=\$(docker context inspect \"$context\" --format '{{(index .Endpoints \"docker\").Host}}' 2>/dev/null) || { echo 'PREVIEW_BLOCKED local_docker_context_required' >&2; exit 2; }
case \"$endpoint\" in unix://*|npipe://*) ;; *) echo 'PREVIEW_BLOCKED nonlocal_docker_context' >&2; exit 2 ;; esac
`
}

function localComposeGuardPowerShell() {
  return `$versionText = (& docker compose version --short 2>$null | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or "$versionText" -notmatch '^v?(\\d+)\\.(\\d+)\\.(\\d+)') { Write-Output 'PREVIEW_BLOCKED compose_version_unreadable'; exit 2 }
$composeVersion = [version]("$($Matches[1]).$($Matches[2]).$($Matches[3])")
if ($composeVersion -lt [version]'2.24.4') { Write-Output 'PREVIEW_BLOCKED compose_2_24_4_required'; exit 2 }
$context = (& docker context show 2>$null | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or -not $context) { Write-Output 'PREVIEW_BLOCKED local_docker_context_required'; exit 2 }
$endpoint = (& docker context inspect $context --format '{{(index .Endpoints "docker").Host}}' 2>$null | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or -not $endpoint -or -not ($endpoint.StartsWith('unix://') -or $endpoint.StartsWith('npipe://'))) { Write-Output 'PREVIEW_BLOCKED nonlocal_docker_context'; exit 2 }
`
}

export function renderLaunchers({ checkoutRoot, runDirectory, projectName }) {
  const args = composeArguments({ checkoutRoot, runDirectory, projectName })
  const shellArgs = args.map(shellQuote).join(' ')
  const powershellArgs = args.map(powershellQuote).join(', ')
  const envKeys = [
    ...composeEnvironmentKeys, 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES',
    'COMPOSE_DISABLE_ENV_FILE', 'DOCKER_HOST', 'DOCKER_CONTEXT',
  ]
  const unsetShell = `unset ${envKeys.join(' ')}\n`
  const unsetPowerShell = `$environmentNames = @(${envKeys.map(powershellQuote).join(', ')})\nforeach ($name in $environmentNames) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }\n`

  const shell = `#!/bin/sh
set -eu
${unsetShell}${localComposeGuardShell()}
compose() { docker compose ${shellArgs} "$@"; }
compose config --quiet
compose build api cms firebase-auth
compose up -d --wait --wait-timeout 300 nginx cms firebase-auth
`

  const powershell = `$ErrorActionPreference = 'Stop'
${unsetPowerShell}${localComposeGuardPowerShell()}
$compose = @(${powershellArgs})
& docker compose @compose config --quiet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& docker compose @compose build api cms firebase-auth
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& docker compose @compose up -d --wait --wait-timeout 300 nginx cms firebase-auth
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`

  return { shell, powershell }
}

export function displayPath(filePath) {
  return path.resolve(filePath).replace(/\\/gu, '/')
}
