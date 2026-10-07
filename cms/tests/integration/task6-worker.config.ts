// Test-only: normal public configuration; suppress dev background type generation.
import configPromise from '../../src/payload.config'
if (process.env.TASK6_DISPOSABLE !== 'cms_task6_test') throw new Error('Task6 worker fixture only')
const config = await configPromise
config.typescript.autoGenerate = false
export default config
