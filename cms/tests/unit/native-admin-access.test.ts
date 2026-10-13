import assert from 'node:assert/strict'
import test from 'node:test'
import { getAccessResults, type Access, type Payload, type PayloadRequest, type Where } from 'payload'
import { getGlobalData } from '../../node_modules/@payloadcms/ui/dist/utilities/getGlobalData.js'
import { findOperation } from '../../node_modules/payload/dist/collections/operations/find.js'
import { getLockedDocumentsCollection } from '../../node_modules/payload/dist/locked-documents/config.js'
import { getPreferencesCollection } from '../../node_modules/payload/dist/preferences/config.js'
import { NewsArticles } from '../../src/collections/NewsArticles.js'
import { NewsAudit } from '../../src/collections/NewsAudit.js'
import { createNewsMedia } from '../../src/collections/NewsMedia.js'
import { NewsSchedules } from '../../src/collections/NewsSchedules.js'
import { LegacyNewsRevisions } from '../../src/collections/LegacyNewsRevisions.js'
import { NewsMigrationRuns } from '../../src/collections/NewsMigrationRuns.js'
import { NewsMigrationItems } from '../../src/collections/NewsMigrationItems.js'
import { NewsHome } from '../../src/globals/NewsHome.js'
import { createPortalEditors } from '../../src/collections/PortalEditors.js'
import type { CmsEnvironment } from '../../src/config/environment.js'
import { createNewsAreaAccess } from '../../src/auth/news-area-access.js'
import { canManageNews, canWriteNews } from '../../src/auth/access.js'
import { createNativeNewsLockAccess, createNativeNewsLockReadAccess, LOCKED_DOCUMENTS_SLUG, scopePayloadLockAccess } from '../../src/auth/native-admin-access.js'

const adminActor = {
  version: 2 as const,
  uid: 'benefits-admin',
  email: 'benefits@example.test',
  name: 'Benefits admin',
  capabilities: { manageKnowledge: false, manageAcademy: false, manageBenefits: true, manageReminders: false },
}
const genericUser = { id: 'projection-benefits', collection: 'portal-editors', portalUid: adminActor.uid, adminActor }
const request = (user: unknown, payload: unknown = {}) => ({ user, payload } as unknown as PayloadRequest)
const noLockRowsWhere: Where = { and: [
  { id: { equals: '00000000-0000-0000-0000-000000000001' } },
  { id: { equals: '00000000-0000-0000-0000-000000000002' } },
] }

function equalIds(where: unknown, output: string[] = []): string[] {
  if (!where || typeof where !== 'object') return output
  const clauses = where as Record<string, unknown>
  if (Array.isArray(clauses.and)) for (const clause of clauses.and) equalIds(clause, output)
  if (Array.isArray(clauses.or)) for (const clause of clauses.or) equalIds(clause, output)
  const id = clauses.id
  if (id && typeof id === 'object' && typeof (id as Record<string, unknown>).equals === 'string') {
    output.push((id as Record<string, string>).equals)
  }
  return output
}

function testConfig() {
  const environment: CmsEnvironment = {
    databaseURL: 'postgresql://cms.example.test/payload_test', payloadSecret: 'synthetic-payload-secret',
    portalPublicURL: 'https://portal.example.test', portalInternalURL: 'http://portal-api:3000',
    payloadToPortalSecret: 'synthetic-payload-to-portal-secret', portalToPayloadSecret: 'synthetic-portal-to-payload-secret',
    uploadDir: 'unused-test-upload-dir',
  }
  const client = {
    resolvePortalEditor: async () => ({ actor: { uid: 'test', email: 'test@example.test', name: null, canManageNews: true }, expiresAt: '2030-01-01T00:00:00.000Z' }),
    resolvePortalAdmin: async () => ({ actor: adminActor, expiresAt: '2030-01-01T00:00:00.000Z' }),
    revokePortalEditor: async () => {},
  }
  const portalEditors = createPortalEditors(environment, client as never)
  const collections = [portalEditors, NewsArticles, createNewsMedia({ uploadDir: 'unused-test-upload-dir' }),
    NewsSchedules, NewsAudit, LegacyNewsRevisions, NewsMigrationRuns, NewsMigrationItems]
  const locked = getLockedDocumentsCollection({ collections, globals: [NewsHome] } as never)!
  const preferences = getPreferencesCollection({ collections } as never)
  const allCollections = [...collections, locked, preferences]
  const config = { admin: { user: 'portal-editors' }, collections: allCollections, globals: [NewsHome] }
  const payload = {
    config,
    blocks: {},
    collections: Object.fromEntries(allCollections.map(collection => [collection.slug, { config: collection }])),
  } as unknown as Payload
  return { payload, locked, preferences, portalEditors }
}

test('Payload 3.90.2 generated lock collection filters denied reads without weakening lock mutations', async () => {
  const { payload, locked } = testConfig()
  const lockConfig = locked as unknown as {
    slug: string; lockDocuments: boolean; fields: Array<{ name: string; relationTo?: string[] }>
    access: Record<'create' | 'read' | 'update' | 'delete', Access>
  }
  let newsReadChecks = 0
  const readNews = async () => { newsReadChecks++; return true }
  const mutationAccess = createNativeNewsLockAccess(readNews)
  const readAccess = createNativeNewsLockReadAccess(readNews)
  scopePayloadLockAccess(payload, mutationAccess, readAccess)

  assert.equal(lockConfig.slug, LOCKED_DOCUMENTS_SLUG)
  assert.equal(lockConfig.lockDocuments, false, 'only the internal lock collection is non-lockable')
  assert.deepEqual(lockConfig.fields.find(field => field.name === 'user')?.relationTo, ['portal-editors'])
  const read = lockConfig.access.read
  const create = lockConfig.access.create
  const update = lockConfig.access.update
  const remove = lockConfig.access.delete
  const allowedNewsActor = { ...genericUser, portalActor: { uid: adminActor.uid, email: adminActor.email, name: null, canManageNews: true } }
  const allowedRequest = request(allowedNewsActor, payload)
  assert.equal(await read({ req: allowedRequest }), true)
  for (const operation of [create, update, remove]) assert.equal(await operation({ req: allowedRequest }), true)
  assert.equal(newsReadChecks, 4)

  newsReadChecks = 0
  assert.deepEqual(await read({ req: request(genericUser, payload) }), noLockRowsWhere,
    'a non-News Portal actor receives a filter that cannot match any lock row')
  for (const operation of [create, update, remove]) assert.equal(await operation({ req: request(genericUser, payload) }), false)
  assert.equal(newsReadChecks, 0, 'a general Benefits identity cannot query News lock metadata')
  const knowledgeOnlyAdmin = { ...genericUser, portalUid: 'news-manager', adminActor: { ...adminActor, uid: 'news-manager',
    capabilities: { ...adminActor.capabilities, manageKnowledge: true } } }
  assert.deepEqual(await read({ req: request(knowledgeOnlyAdmin, payload) }), noLockRowsWhere,
    'manageKnowledge alone never receives lock user/editor metadata without the strict News actor')

  const legacyNewsActor = { ...allowedNewsActor, portalUid: 'legacy-news', portalActor: {
    uid: 'legacy-news', email: 'news@example.test', name: null, canManageNews: true,
  } }
  assert.deepEqual(await createNativeNewsLockReadAccess(async () => false)({ req: request(legacyNewsActor, payload) }), noLockRowsWhere,
    'the strict News actor still gets no native locks while authority is legacy')
  assert.equal(await createNativeNewsLockReadAccess(async () => true)({ req: request(legacyNewsActor, payload) }), true,
    'a strict News actor retains native lock reads under current Payload authority')
})

test('getAccessResults keeps a Benefits-only v2 actor out of News and confines lock reads to an empty scope', async () => {
  const { payload, locked, preferences, portalEditors } = testConfig()
  scopePayloadLockAccess(payload, createNativeNewsLockAccess(async () => true), createNativeNewsLockReadAccess(async () => true))
  const req = request(genericUser, payload)
  const permissionResults = await getAccessResults({ req })
  const permissions = permissionResults as unknown as {
    canAccessAdmin?: boolean
    collections?: Record<string, Record<string, unknown>>
    globals?: Record<string, Record<string, unknown>>
  }

  assert.equal(permissions.canAccessAdmin, true)
  assert.deepEqual((permissions.collections?.['portal-editors']?.read as { where?: unknown } | undefined)?.where,
    { id: { equals: genericUser.id } }, 'v2 actors can read only their own projected identity')
  assert.deepEqual(portalEditors.fields.map(field => 'name' in field ? field.name : null), ['portalUid', 'email', 'displayName'],
    'general-admin capabilities are request metadata, not identity fields')
  const meHook = portalEditors.hooks?.me?.[0] as unknown as (args: { args: { req: PayloadRequest }; user: Record<string, unknown> }) => { user: Record<string, unknown> }
  const meResult = meHook({ args: { req }, user: { id: genericUser.id, collection: 'portal-editors', portalUid: genericUser.portalUid } })
  assert.deepEqual(meResult.user.adminActor, adminActor, 'navigation receives the actor freshly resolved for this /me request')
  const hasPermission = (permissionsFor: Record<string, unknown> | undefined, operation: string) => {
    const result = permissionsFor?.[operation]
    return result === true || Boolean(result && typeof result === 'object' && (result as { permission?: unknown }).permission === true)
  }
  for (const slug of ['news-articles', 'news-media', 'news-schedules', 'news-audit', 'legacy-news-revisions', 'news-migration-runs', 'news-migration-items']) {
    assert.equal(hasPermission(permissions.collections?.[slug], 'read'), false, `${slug} read`)
  }
  assert.equal(hasPermission(permissions.collections?.['news-articles'], 'readVersions'), false, 'draft/history Versions')
  assert.equal(hasPermission(permissions.globals?.['news-home'], 'read'), false)
  const lockRead = permissions.collections?.[locked.slug]?.read as { permission?: unknown; where?: unknown } | undefined
  assert.equal(lockRead?.permission, true, 'the UI can issue its required read, but only under a restrictive result filter')
  assert.deepEqual(lockRead?.where, noLockRowsWhere, 'the v2 lock permission cannot match any row or expose an editor projection')

  const preferenceConfig = preferences as unknown as {
    slug: string
    access: { read: (args: { req: PayloadRequest }) => unknown }
    fields: Array<{ name?: string; hooks?: { beforeValidate?: Array<(args: { req: PayloadRequest; value?: unknown }) => unknown> } }>
  }
  const ownPreferenceCondition = preferenceConfig.access.read({ req })
  const permissionWhere = (permissions.collections?.[preferenceConfig.slug]?.read as { where?: unknown } | undefined)?.where
  assert.deepEqual(permissionWhere, ownPreferenceCondition)
  assert.deepEqual(ownPreferenceCondition, { and: [
    { 'user.value': { equals: genericUser.id } },
    { 'user.relationTo': { equals: genericUser.collection } },
  ] })
  const preferenceUserField = preferenceConfig.fields.find(field => field.name === 'user')
  const setOwner = preferenceUserField?.hooks?.beforeValidate?.[0]
  assert.ok(setOwner)
  const forcedOwner = setOwner({ req, value: { relationTo: 'other', value: 'other-user' } })
  assert.deepEqual(forcedOwner, { relationTo: genericUser.collection, value: genericUser.id })
})

test('pinned Payload 3.90.2 DashboardView global-lock query completes with no lock metadata for a v2-only actor', async () => {
  const { payload, locked } = testConfig()
  const lockConfig = locked as unknown as Record<string, unknown> & {
    fields: Array<Record<string, unknown>>
    access: Record<'create' | 'read' | 'update' | 'delete', Access>
  }
  Object.assign(lockConfig, {
    flattenedFields: [
      { name: 'id', type: 'text' },
      ...lockConfig.fields,
      { name: 'updatedAt', type: 'date' },
    ],
    forceSelect: [],
    defaultSort: 'id',
    joins: {},
    polymorphicJoins: [],
    hooks: {},
  })

  const v2OnlyUser = { ...genericUser, portalUid: 'knowledge-only', adminActor: {
    ...adminActor,
    uid: 'knowledge-only',
    capabilities: { ...adminActor.capabilities, manageKnowledge: true },
  } }
  const req = request(v2OnlyUser, payload) as PayloadRequest & Record<string, unknown>
  Object.assign(req, { context: {}, query: {}, locale: 'en', fallbackLocale: null, payloadAPI: 'REST', t: (key: string) => key })

  const storedLock = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    globalSlug: 'news-home',
    updatedAt: '2026-10-07T12:00:00.000Z',
    user: { relationTo: 'portal-editors', value: 'private-editor-projection' },
  }
  let dashboardFindArgs: Record<string, unknown> | undefined
  let adapterWhere: unknown
  let adapterRows: unknown[] = []
  const db = {
    find: async (args: { where: unknown }) => {
      adapterWhere = args.where
      const ids = equalIds(args.where)
      // Model the adapter's conjunctive equality semantics against a lock row
      // that would otherwise expose both News lock state and editor identity.
      adapterRows = ids.length > 0 && ids.every(id => id === storedLock.id) ? [storedLock] : []
      return {
        docs: adapterRows,
        hasNextPage: false,
        hasPrevPage: false,
        limit: 0,
        nextPage: null,
        page: 1,
        pagingCounter: 1,
        prevPage: null,
        totalDocs: adapterRows.length,
        totalPages: 1,
      }
    },
  }
  Object.assign(payload, {
    db,
    find: async (args: Record<string, unknown>) => {
      dashboardFindArgs = args
      const slug = args.collection as string
      return findOperation({
        ...args,
        collection: payload.collections[slug as keyof typeof payload.collections],
      } as never)
    },
  })
  Object.assign(req, { payload })
  scopePayloadLockAccess(payload, createNativeNewsLockAccess(async () => false), createNativeNewsLockReadAccess(async () => false))

  const dashboardGlobals = await getGlobalData(req)

  assert.ok(dashboardFindArgs, 'the pinned DashboardView helper must issue its built-in lock query')
  assert.equal(dashboardFindArgs.collection, LOCKED_DOCUMENTS_SLUG)
  assert.equal(dashboardFindArgs.overrideAccess, false)
  assert.equal(dashboardFindArgs.pagination, false)
  assert.deepEqual(dashboardFindArgs.where, { globalSlug: { exists: true } })
  assert.deepEqual(dashboardFindArgs.select, { globalSlug: true, updatedAt: true, user: true })
  assert.deepEqual(adapterWhere, { and: [
    { globalSlug: { exists: true } },
    noLockRowsWhere,
  ] }, 'Payload findOperation must preserve the Dashboard filter and enforce the empty-result access scope')
  assert.deepEqual(equalIds(adapterWhere).sort(), [
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
  ], 'Payload findOperation must AND the empty-result access filter with the Dashboard global filter')
  assert.deepEqual(adapterRows, [], 'the matching News lock row and user projection do not reach the dashboard')
  assert.deepEqual(dashboardGlobals, [{ slug: 'news-home', data: {
    _isLocked: false, _lastEditedAt: null, _userEditing: null,
  }, lockDuration: 300 }])
})

test('manageKnowledge native reads still resolve current News authority and do not grant News writes', async () => {
  let mode = 'legacy', authorityCalls = 0
  const area = createNewsAreaAccess(() => ({ getAuthority: async () => { authorityCalls++; return { mode, epoch: authorityCalls } } }))
  const knowledgeActor = { ...adminActor, capabilities: { ...adminActor.capabilities, manageKnowledge: true } }
  const user = { ...genericUser, adminActor: knowledgeActor }
  const req = request(user)

  assert.equal(canManageNews({ req }), true)
  assert.equal(canWriteNews({ req }), false)
  assert.equal(await area.canRead(req), false, 'legacy mode is not a native News read grant')
  mode = 'payload'
  assert.equal(await area.canRead(req), false, 'the exact request may share its already-resolved authority')
  assert.equal(await area.canRead(request(user)), true, 'a later request re-resolves current authority')
  assert.equal(authorityCalls, 2)
})
