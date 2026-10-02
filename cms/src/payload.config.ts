import { postgresAdapter } from '@payloadcms/db-postgres'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { createPortalEditors } from './collections/PortalEditors'
import { NewsArticles } from './collections/NewsArticles'
import { createNewsMedia } from './collections/NewsMedia'
import { NewsHome } from './globals/NewsHome'
import { newsEditor } from './news/editor'
import { readCmsConfigEnvironment } from './config/environment'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const environment = readCmsConfigEnvironment(process.env)
const PortalEditors = createPortalEditors(environment)

export default buildConfig({
  admin: {
    user: PortalEditors.slug,
    importMap: {
      baseDir: dirname,
      importMapFile: path.resolve(dirname, 'app/(payload)/editorial/admin/importMap.js'),
    },
  },
  routes: { admin: '/editorial/admin', api: '/editorial/api' },
  serverURL: environment.portalPublicURL,
  collections: [PortalEditors, NewsArticles, createNewsMedia(environment)],
  globals: [NewsHome],
  editor: newsEditor,
  secret: environment.payloadSecret,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  db: postgresAdapter({
    pool: { connectionString: environment.databaseURL, connectionTimeoutMillis: 5000 },
    idType: 'uuid',
    push: false,
    disableCreateDatabase: true,
    migrationDir: path.resolve(dirname, 'migrations'),
    // Reviewed migrations run only through the CLI with a migration role.
    // prodMigrations would run DDL during runtime initialization in Payload 3.90.2.
  }),
  graphQL: { disable: true },
  jobs: { autoRun: [] },
  telemetry: false,
  sharp,
})
