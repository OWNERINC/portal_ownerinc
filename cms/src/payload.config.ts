import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { createPortalEditors } from './collections/PortalEditors'
import { readCmsConfigEnvironment } from './config/environment'
import { migrations } from './migrations'

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
  collections: [PortalEditors],
  editor: lexicalEditor(),
  secret: environment.payloadSecret,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  db: postgresAdapter({
    pool: { connectionString: environment.databaseURL, connectionTimeoutMillis: 5000 },
    idType: 'uuid',
    push: false,
    disableCreateDatabase: true,
    migrationDir: path.resolve(dirname, 'migrations'),
    prodMigrations: migrations,
  }),
  graphQL: { disable: true },
  jobs: { autoRun: [] },
  telemetry: false,
  sharp,
})
