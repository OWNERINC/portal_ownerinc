// Import-only entry point. Run in a separate local process, never as the web config.
import { createCmsConfig } from './payload.config'
import { legacyNewsImportContext } from './news/validation'

export default createCmsConfig(legacyNewsImportContext)
