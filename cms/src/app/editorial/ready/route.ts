import config from '@payload-config'
import { getPayload } from 'payload'
import { readCmsEnvironment } from '../../../config/environment'
import { assertCmsDatabaseReady, assertCmsStorageReady } from '../../../config/readiness'
import { randomUUID } from 'node:crypto'

export const dynamic = 'force-dynamic'

const requestID = (request: Request): string => {
  const supplied = request.headers.get('x-request-id')
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : randomUUID()
}

const readinessLog = (requestId: string, status: 'ready' | 'unavailable', reason: string): void => {
  console.error(JSON.stringify({ service: 'cms', event: 'editorial_readiness', status, reason, requestId }))
}

export async function GET(request: Request): Promise<Response> {
  const requestId = requestID(request)
  try {
    const payload = await getPayload({ config })
    await payload.find({
      collection: 'portal-editors',
      limit: 1,
      depth: 0,
      pagination: false,
      select: { updatedAt: true },
      // Server-only readiness probe; no identity data is returned to the caller.
      overrideAccess: true,
    })
    await assertCmsDatabaseReady(payload)
    try {
      const environment = readCmsEnvironment(process.env)
      await assertCmsStorageReady(environment.uploadDir)
    } catch {
      readinessLog(requestId, 'unavailable', 'storage_unavailable')
      return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'X-Request-Id': requestId, 'Cache-Control': 'no-store' } })
    }
    readinessLog(requestId, 'ready', 'ready')
    return Response.json({ status: 'ready' }, { headers: { 'X-Request-Id': requestId, 'Cache-Control': 'no-store' } })
  } catch {
    readinessLog(requestId, 'unavailable', 'database_unavailable')
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'X-Request-Id': requestId, 'Cache-Control': 'no-store' } })
  }
}
