// Adapted from templates/blank at Payload v3.90.2. REST only.
import config from '@payload-config'
import '@payloadcms/next/css'
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from '@payloadcms/next/routes'
import { withEditorialBoundary } from '../../../../../auth/rest-boundary'

const guard = (handler: ReturnType<typeof REST_GET>) => async (...args: Parameters<typeof handler>) =>
  withEditorialBoundary(handler, (await config).serverURL)(...args)

export const GET = guard(REST_GET(config))
export const POST = guard(REST_POST(config))
export const DELETE = guard(REST_DELETE(config))
export const PATCH = guard(REST_PATCH(config))
export const PUT = guard(REST_PUT(config))
export const OPTIONS = guard(REST_OPTIONS(config))
