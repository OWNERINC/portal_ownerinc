import path from 'node:path'

type Environment = Record<string, string | undefined>

export type CmsEnvironment = {
  databaseURL: string
  payloadSecret: string
  portalPublicURL: string
  portalInternalURL: string
  payloadToPortalSecret: string
  portalToPayloadSecret: string
  uploadDir: string
}

function invalid(name: string): never {
  // Do not attach the parser's error/cause: it may contain a credential or URL.
  throw new Error(`Invalid or missing CMS environment variable: ${name}`)
}

function required(env: Environment, name: string): string {
  const value = env[name]
  if (!value || !value.trim()) invalid(name)
  return value
}

function url(env: Environment, name: string): URL {
  const value = required(env, name)
  try {
    if (value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) invalid(name)
    // WHATWG URL accepts malformed percent escapes that the PostgreSQL driver rejects.
    decodeURI(value)
    return new URL(value)
  } catch {
    invalid(name)
  }
}

function httpURL(env: Environment, name: string, originOnly = false): string {
  const parsed = url(env, name)
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname ||
    parsed.username || parsed.password || parsed.href.includes('?') || parsed.href.includes('#') ||
    (originOnly && parsed.pathname !== '/')) invalid(name)
  return originOnly ? parsed.origin : parsed.href.replace(/\/+$/u, '')
}

function secret(env: Environment, name: string): string {
  const value = required(env, name)
  if (value.trim().length < 32) invalid(name)
  return value
}

// The pre-dispatch Origin boundary needs only this setting, never DB or service credentials.
export function readPortalPublicURL(env: Environment): string {
  return httpURL(env, 'PORTAL_PUBLIC_URL', true)
}

export function readCmsEnvironment(env: Environment): CmsEnvironment {
  const database = url(env, 'CMS_DATABASE_URL')
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname ||
    database.pathname.length <= 1 || database.href.includes('#')) invalid('CMS_DATABASE_URL')

  const payloadSecret = secret(env, 'PAYLOAD_SECRET')
  const portalPublicURL = readPortalPublicURL(env)
  const portalInternalURL = httpURL(env, 'PORTAL_INTERNAL_URL')
  const payloadToPortalSecret = secret(env, 'PAYLOAD_TO_PORTAL_SECRET')
  const portalToPayloadSecret = secret(env, 'PORTAL_TO_PAYLOAD_SECRET')
  if (payloadToPortalSecret === portalToPayloadSecret) invalid('PORTAL_TO_PAYLOAD_SECRET')
  const uploadDir = required(env, 'CMS_UPLOAD_DIR')
  if (!path.isAbsolute(uploadDir) || uploadDir.includes('\0')) invalid('CMS_UPLOAD_DIR')

  return {
    databaseURL: database.href,
    payloadSecret,
    portalPublicURL,
    portalInternalURL,
    payloadToPortalSecret,
    portalToPayloadSecret,
    uploadDir: path.normalize(uploadDir),
  }
}

export function readCmsConfigEnvironment(env: Environment): CmsEnvironment {
  if (env.CMS_BUILD_ONLY !== undefined) {
    if (env.CMS_BUILD_ONLY !== 'true' || env.NEXT_PHASE !== 'phase-production-build') {
      invalid('CMS_BUILD_ONLY')
    }
    // Explicit non-routable build inputs; never fall back to operational credentials.
    // These configure the adapter only. Dynamic routes must not initialize Payload at build.
    return readCmsEnvironment({
      CMS_DATABASE_URL: 'postgresql://cms-build.invalid/editorial_build_only',
      PAYLOAD_SECRET: 'build-only-payload-not-a-runtime-secret',
      PORTAL_PUBLIC_URL: 'https://portal-build.invalid',
      PORTAL_INTERNAL_URL: 'https://portal-internal-build.invalid',
      PAYLOAD_TO_PORTAL_SECRET: 'build-only-payload-to-portal-not-a-runtime-secret',
      PORTAL_TO_PAYLOAD_SECRET: 'build-only-portal-to-payload-not-a-runtime-secret',
      CMS_UPLOAD_DIR: path.resolve('build-only-no-uploads'),
    })
  }
  return readCmsEnvironment(env)
}
