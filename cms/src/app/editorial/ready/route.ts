import config from '@payload-config'
import { getPayload } from 'payload'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
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
    return Response.json({ status: 'ready' })
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503 })
  }
}
