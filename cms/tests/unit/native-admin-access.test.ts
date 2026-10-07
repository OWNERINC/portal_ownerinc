import assert from 'node:assert/strict'
import test from 'node:test'
import { getAccessResults, type Access, type Payload, type PayloadRequest } from 'payload'
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
import { createNativeNewsLockAccess, LOCKED_DOCUMENTS_SLUG, scopePayloadLockAccess } from '../../src/auth/native-admin-access.js'

const adminActor = {
  version: 2 as const,
  uid: 'benefits-admin',
  email: 'benefits@example.test',
  name: 'Benefits admin',
  capabilities: { manageKnowledge: false, manageAcademy: false, manageBenefits: true, manageReminders: false },
}
const genericUser = { id: 'projection-benefits', collection: 'portal-editors', portalUid: adminActor.uid, adminActor }
const request = (user: unknown, payload: unknown = {}) => ({ user, payload } as unknown as PayloadRequest)

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

test('Payload 3.90.2 generated lock collection is request-scoped without disabling native News locks', async () => {
  const { payload, locked } = testConfig()
  const lockConfig = locked as unknown as {
    slug: string; lockDocuments: boolean; fields: Array<{ name: string; relationTo?: string[] }>
    access: Record<'create' | 'read' | 'update' | 'delete', Access>
  }
  let newsReadChecks = 0
  const access = createNativeNewsLockAccess(async () => { newsReadChecks++; return true })
  scopePayloadLockAccess(payload, access)

  assert.equal(lockConfig.slug, LOCKED_DOCUMENTS_SLUG)
  assert.equal(lockConfig.lockDocuments, false, 'only the internal lock collection is non-lockable')
  assert.deepEqual(lockConfig.fields.find(field => field.name === 'user')?.relationTo, ['portal-editors'])
  const read = lockConfig.access.read
  const create = lockConfig.access.create
  const update = lockConfig.access.update
  const remove = lockConfig.access.delete
  const allowedNewsActor = { ...genericUser, portalActor: { uid: adminActor.uid, email: adminActor.email, name: null, canManageNews: true } }
  const allowedRequest = request(allowedNewsActor, payload)
  for (const operation of [read, create, update, remove]) assert.equal(await operation({ req: allowedRequest }), true)
  assert.equal(newsReadChecks, 4)

  newsReadChecks = 0
  for (const operation of [read, create, update, remove]) assert.equal(await operation({ req: request(genericUser, payload) }), false)
  assert.equal(newsReadChecks, 0, 'a general Benefits identity cannot query News lock metadata')
  const knowledgeOnlyAdmin = { ...genericUser, portalUid: 'news-manager', adminActor: { ...adminActor, uid: 'news-manager',
    capabilities: { ...adminActor.capabilities, manageKnowledge: true } } }
  assert.equal(await read({ req: request(knowledgeOnlyAdmin, payload) }), false,
    'a v2-only identity never receives lock user/editor metadata even when it can read News')
})

test('getAccessResults keeps a Benefits-only v2 actor out of News, versions, history, media and lock records', async () => {
  const { payload, locked, preferences, portalEditors } = testConfig()
  scopePayloadLockAccess(payload, createNativeNewsLockAccess(async () => true))
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
  assert.equal(hasPermission(permissions.collections?.[locked.slug], 'read'), false, 'locked global/document editor identity')

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
