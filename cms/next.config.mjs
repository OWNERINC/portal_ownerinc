import { withPayload } from '@payloadcms/next/withPayload'
import { PHASE_PRODUCTION_BUILD } from 'next/constants.js'
import { fileURLToPath } from 'node:url'

// Runtime contracts are shared with the Portal's root-level scripts and API.
const checkoutRoot = fileURLToPath(new URL('../', import.meta.url))

export default function nextConfig(phase) {
  if (phase === PHASE_PRODUCTION_BUILD) {
    process.env.CMS_BUILD_ONLY = 'true'
  } else if (process.env.CMS_BUILD_ONLY !== undefined || process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) {
    throw new Error('CMS_BUILD_ONLY is not allowed outside next build')
  }
  return withPayload({ poweredByHeader: false, turbopack: { root: checkoutRoot }, outputFileTracingRoot: checkoutRoot })
}
