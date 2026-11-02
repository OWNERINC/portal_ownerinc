// Adapted from templates/blank at Payload v3.90.2. REST only.
import config from '@payload-config'
import '@payloadcms/next/css'
import { formatAdminURL } from 'payload/shared'
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from '@payloadcms/next/routes'
import { withEditorialBoundary } from '../../../../../auth/rest-boundary'

const guard = (handler: ReturnType<typeof REST_GET>) => async (request: Request, args: Parameters<typeof handler>[1]) => {
  const resolvedConfig = await config, params = await args.params
  // Match @payloadcms/next 3.90.2: Next has decoded each catchall segment;
  // the adapter re-encodes them for dispatch while retaining the raw req.url.
  const path = formatAdminURL({ apiRoute: resolvedConfig.routes.api,
    path: params?.slug ? `/${params.slug.map(segment => encodeURIComponent(segment)).join('/')}` : undefined })
  return withEditorialBoundary(handler, resolvedConfig.serverURL, path)(request, args)
}

export const GET = guard(REST_GET(config))
export const POST = guard(REST_POST(config))
export const DELETE = guard(REST_DELETE(config))
export const PATCH = guard(REST_PATCH(config))
export const PUT = guard(REST_PUT(config))
export const OPTIONS = guard(REST_OPTIONS(config))
