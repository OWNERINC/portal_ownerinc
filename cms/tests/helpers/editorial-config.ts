import { readCmsConfigEnvironment } from '../../src/config/environment'
import type { EditorialProfile } from '../../src/config/editorial-profile'

/** Sanitization only. Never initializes Payload, connects or listens. */
export async function editorialConfig(profile: EditorialProfile = 'held-v1') {
  const previous = { build: process.env.CMS_BUILD_ONLY, phase: process.env.NEXT_PHASE }
  try {
    process.env.CMS_BUILD_ONLY = 'true'; process.env.NEXT_PHASE = 'phase-production-build'
    const { createCmsConfig } = await import('../../src/payload.config')
    return await createCmsConfig(undefined, { ...readCmsConfigEnvironment(process.env), editorialProfile: profile })
  } finally {
    if (previous.build === undefined) delete process.env.CMS_BUILD_ONLY
    else process.env.CMS_BUILD_ONLY = previous.build
    if (previous.phase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = previous.phase
  }
}
