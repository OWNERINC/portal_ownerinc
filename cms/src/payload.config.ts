import { postgresAdapter } from '@payloadcms/db-postgres'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig } from 'payload'
import { pt } from '@payloadcms/translations/languages/pt'

import { createPortalEditors } from './collections/PortalEditors'
import { createNewsArticles } from './collections/NewsArticles'
import { createNewsMedia } from './collections/NewsMedia'
import { createNewsHome } from './globals/NewsHome'
import { newsEditor } from './news/editor'
import { readCmsConfigEnvironment, type CmsEnvironment } from './config/environment'
import { editorialProfileDescriptor, assertEditorialProfile } from './config/editorial-profile'
import { newsRestoreDraftEndpoints } from './endpoints/news-restore-draft'
import { isLegacyNewsImport } from './news/validation'
import { NewsSchedules } from './collections/NewsSchedules'
import { NewsAudit } from './collections/NewsAudit'
import { publishNewsSnapshot } from './jobs/publish-snapshot'
import { newsScheduleEndpoints } from './endpoints/news-schedule'
import { savedPreviewEndpoint } from './endpoints/saved-preview'
import { portalNewsEndpoints } from './endpoints/portal-news'
import { LegacyNewsRevisions } from './collections/LegacyNewsRevisions'
import { NewsMigrationRuns } from './collections/NewsMigrationRuns'
import { NewsMigrationItems } from './collections/NewsMigrationItems'
import { portalPollEndpoints } from './endpoints/portal-polls'
import { scopePayloadLockAccess } from './auth/native-admin-access'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// Only the separate trusted import process passes the server-only capability.
// Each call creates a new adapter config; a running runtime adapter is never toggled.
const defaultEnvironment = readCmsConfigEnvironment(process.env)
export const createCmsConfig = (importContext?: unknown, environment: CmsEnvironment = defaultEnvironment) => {
const PortalEditors = createPortalEditors(environment)
const manualPublication = environment.publicationMode === 'manual'
return buildConfig({
  custom: { editorialProfile: editorialProfileDescriptor(environment.editorialProfile) },
  admin: {
    avatar: 'default',
    user: PortalEditors.slug,
    dateFormat: 'dd/MM/yyyy HH:mm',
    timezones: { defaultTimezone: 'America/Sao_Paulo', supportedTimezones: [{ label: 'São Paulo', value: 'America/Sao_Paulo' }] },
    components: {
      graphics: { Logo: '/admin/Brand#Brand', Icon: '/admin/Brand#BrandIcon' },
      beforeLogin: ['/admin/PortalLogin#PortalLogin'],
      afterNavLinks: ['/admin/PortalNavigation#PortalNavigation'],
      logout: { Button: '/admin/PortalLogout#PortalLogout' },
      providers: ['/admin/SessionWatch#SessionWatch'],
      views: { dashboard: { Component: '/admin/AdminHome#AdminHome' }, polls: { Component: '/admin/PollsView#PollsView', path: '/polls', exact: true } },
    },
    importMap: {
      baseDir: dirname,
      importMapFile: path.resolve(dirname, 'app/(payload)/editorial/admin/importMap.js'),
    },
  },
  routes: { admin: '/editorial/admin', api: '/editorial/api' },
  serverURL: environment.portalPublicURL,
  collections: [PortalEditors, createNewsArticles(environment.editorialProfile), createNewsMedia(environment, importContext),
    ...(manualPublication ? [] : [NewsSchedules]), NewsAudit, LegacyNewsRevisions, NewsMigrationRuns, NewsMigrationItems],
  globals: [createNewsHome(environment.editorialProfile)],
  endpoints: [savedPreviewEndpoint, ...newsRestoreDraftEndpoints.map(endpoint => ({ ...endpoint })), ...(manualPublication ? [] : newsScheduleEndpoints), ...portalNewsEndpoints, ...portalPollEndpoints],
  i18n: { supportedLanguages: { pt }, fallbackLanguage: 'pt' },
  editor: newsEditor,
  secret: environment.payloadSecret,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  db: postgresAdapter({
    pool: { connectionString: environment.databaseURL, connectionTimeoutMillis: 5000 },
    idType: 'uuid',
    allowIDOnCreate: isLegacyNewsImport(importContext),
    push: false,
    disableCreateDatabase: true,
    migrationDir: path.resolve(dirname, 'migrations'),
    // Reviewed migrations run only through the CLI with a migration role.
    // prodMigrations would run DDL during runtime initialization in Payload 3.90.2.
  }),
  graphQL: { disable: true },
  jobs: { autoRun: [], tasks: manualPublication ? [] : [publishNewsSnapshot], deleteJobOnComplete: false, enableConcurrencyControl: true,
    access: { queue: () => false, run: () => false, cancel: () => false },
    jobsCollectionOverrides: ({ defaultJobsCollection }) => ({ ...defaultJobsCollection,
      fields: defaultJobsCollection.fields.map(field => 'name' in field && field.name === 'concurrencyKey' ? { ...field, unique: true } : field),
    }),
  },
  telemetry: false,
  upload: { limits: { fileSize: 50 * 1024 * 1024 }, abortOnLimit: true, useTempFiles: false },
  onInit: payload => { assertEditorialProfile(payload.config); scopePayloadLockAccess(payload) },
  // No Payload image transformer: even unadjusted WebP is re-encoded when sharp is
  // configured. The media validator uses sharp directly and stores ORIGINAL bytes.
})
}

export default createCmsConfig()
