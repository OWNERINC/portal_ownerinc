import assert from 'node:assert/strict'
import test from 'node:test'
import type { Payload, PayloadRequest } from 'payload'
import { PgDialect } from 'drizzle-orm/pg-core'
import { canManagePortalPages, portalPageEditorAccess } from '../../src/auth/portal-pages-access'
import { PortalPageCategories } from '../../src/collections/PortalPageCategories'
import { PortalPageMedia, portalPageMediaReadAccess } from '../../src/collections/PortalPageMedia'
import { PortalPages } from '../../src/collections/PortalPages'
import { assertReferenceStoreCoverage } from '../../src/media/references'
import {
  assertPortalPageCategoryOrphan,
  assertPortalPageMediaOrphan,
  assertPortalPageMediaReferences,
  collectPortalPageCategoryIds,
  collectPortalPageMediaIds,
  isPortalPageMediaLifecycleMutation,
  isPortalPagePublication,
  isPortalPageMediaMutation,
  projectPortalPageContent,
  withPortalPageMediaMutation,
  withPortalPageMediaLifecycleMutation,
  withExpectedPortalPageVersion,
  lockPortalPageUpload,
  portalPageUploadAdvisoryKey,
} from '../../src/portal-pages/persistence'
import {
  createPortalPageStorageKey,
  normalizePortalPageCategory,
  validatePortalPageMediaMetadata,
  validatePortalPageSlugChange,
  validatePortalPageStatusTransition,
} from '../../src/portal-pages/validation'

const pageID = '018f47a2-7b3c-7a11-8a2c-1234567890ab'
const versionID = '018f47a2-7b3c-7a11-8a2c-1234567890ac'
const pageMediaID = '018f47a2-7b3c-7a11-8a2c-1234567890ad'
const categoryID = '018f47a2-7b3c-7a11-8a2c-1234567890ae'
const newsMediaID = '018f47a2-7b3c-7a11-8a2c-1234567890af'

async function createTestCmsConfig() {
  const previousBuildOnly = process.env.CMS_BUILD_ONLY
  const previousNextPhase = process.env.NEXT_PHASE
  process.env.CMS_BUILD_ONLY = 'true'
  process.env.NEXT_PHASE = 'phase-production-build'
  try { return (await import('../../src/payload.config')).createCmsConfig() }
  finally {
    if (previousBuildOnly === undefined) delete process.env.CMS_BUILD_ONLY
    else process.env.CMS_BUILD_ONLY = previousBuildOnly
    if (previousNextPhase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = previousNextPhase
  }
}

const manager = {
  id: 'portal-editor-1', collection: 'portal-editors', portalUid: 'staff-1',
  portalActor: { uid: 'staff-1', canManageNews: true },
}
const adminManager = {
  id: 'portal-editor-2', collection: 'portal-editors', portalUid: 'staff-2',
  adminActor: { version: 2, uid: 'staff-2', email: 'staff@example.test', name: null,
    capabilities: { manageKnowledge: true, manageAcademy: false, manageBenefits: false, manageReminders: false } },
}

async function configPayload() {
  const config = await createTestCmsConfig()
  return {
    config,
    collections: Object.fromEntries(config.collections.map(collection => [collection.slug, { config: collection }])),
  }
}

async function payloadFixture(options: {
  drafts?: Record<string, unknown>[]
  current?: Record<string, unknown>[]
  versions?: Record<string, unknown>[]
  media?: Record<string, unknown>[]
  latestVersion?: Record<string, unknown>
  mainPage?: { slug: string; status: 'draft' | 'published' } | null
} = {}) {
  const { config, collections } = await configPayload()
  const calls: string[] = []
  const executeResults: unknown[] = []
  let mainPage = options.mainPage === undefined ? { slug: 'draft-slug', status: 'draft' as const } : options.mainPage
  const queryText = (query: unknown) => {
    if (!query || typeof query !== 'object' || !Array.isArray((query as { queryChunks?: unknown }).queryChunks)) return ''
    return ((query as { queryChunks: unknown[] }).queryChunks).map(chunk => {
      if (typeof chunk === 'string') return chunk
      if (!chunk || typeof chunk !== 'object') return ''
      const value = (chunk as { value?: unknown }).value
      return Array.isArray(value) ? value.join('') : ''
    }).join('')
  }
  const session = { execute: async (query: unknown) => {
    const text = queryText(query)
    calls.push(`sql:${JSON.stringify(query)}`)
    if (text.includes('SELECT slug, _status FROM portal_pages')) {
      calls.push('main-page-state-read')
      return { rows: mainPage ? [{ slug: mainPage.slug, _status: mainPage.status }] : [] }
    }
    return executeResults.shift() || { rows: [] }
  } }
  const payload = {
    config,
    collections,
    db: {
      sessions: { live: { db: session } },
      beginTransaction: async () => { calls.push('begin'); return 'owned' },
      commitTransaction: async () => { calls.push('commit') },
      rollbackTransaction: async () => { calls.push('rollback') },
    },
    find: async ({ collection, draft }: { collection: string; draft?: boolean }) => {
      calls.push(`find:${collection}:${String(draft)}`)
      if (collection !== 'portal-pages') return { docs: [], hasNextPage: false }
      return { docs: draft ? options.drafts || [] : options.current || [], hasNextPage: false }
    },
    findVersions: async ({ collection }: { collection: string }) => {
      calls.push(`versions:${collection}`)
      return { docs: options.latestVersion ? [options.latestVersion] : options.versions || [], hasNextPage: false }
    },
    findByID: async ({ collection, id }: { collection: string; id: string }) => {
      calls.push(`findByID:${collection}:${id}`)
      if (collection === 'portal-page-media') return options.media?.find(row => row.id === id) || null
      if (collection === 'portal-pages') return { id, _status: 'draft' }
      if (collection === 'portal-page-categories') return { id, name: 'Produto', slug: 'produto' }
      return null
    },
  } as unknown as Payload
  const req = { payload, transactionID: 'live', context: {}, user: manager } as unknown as PayloadRequest
  return { payload, req, calls, session, executeResults, config, collections,
    setMainPage: (page: { slug: string; status: 'draft' | 'published' } | null) => { mainPage = page } }
}

function mediaRecord(id: string, mimeType: string, state: 'uploading' | 'complete' = 'complete') {
  return {
    id, originalName: 'arquivo', storageKey: createPortalPageStorageKey(mimeType), mimeType, filesize: 100,
    sha256: state === 'complete' ? 'a'.repeat(64) : null, state, uploadedBy: 'staff-1',
    completedAt: state === 'complete' ? '2026-10-19T10:20:30.000Z' : null,
  }
}

test('page editorial access accepts only verified portal editors with existing capability semantics in every News mode', async () => {
  for (const authorityMode of ['legacy', 'frozen', 'payload', 'payload_frozen']) {
    const req = { user: manager, context: { authorityMode } } as unknown as PayloadRequest
    assert.equal(canManagePortalPages({ req }), true, authorityMode)
    assert.equal(await portalPageEditorAccess({ req } as never), true, authorityMode)
    const v2Req = { user: adminManager, context: { authorityMode } } as unknown as PayloadRequest
    assert.equal(canManagePortalPages({ req: v2Req }), true, `V2 manageKnowledge in ${authorityMode}`)
  }
  for (const user of [null, { ...manager, collection: 'users' }, { ...manager, portalUid: 'other' },
    { ...manager, portalActor: { uid: 'staff-1', canManageNews: false } },
    { ...adminManager, adminActor: { ...adminManager.adminActor, capabilities: { ...adminManager.adminActor.capabilities, manageKnowledge: false } } }]) {
    assert.equal(canManagePortalPages({ req: { user } as unknown as PayloadRequest }), false)
  }
})

test('three page collections are registered, editor-scoped, non-locking and use unlimited autosaved drafts', async () => {
  const config = await createTestCmsConfig()
  const pages = ['portal-pages', 'portal-page-categories', 'portal-page-media']
  for (const slug of pages) {
    const collection = config.collections.find(entry => entry.slug === slug)
    assert.ok(collection, `${slug} is registered`)
    assert.equal(collection.lockDocuments, false)
    assert.equal(typeof collection.access?.read, 'function')
    assert.equal(typeof collection.access?.admin, 'function')
  }
  const versions = PortalPages.versions as Exclude<NonNullable<typeof PortalPages.versions>, boolean>
  const drafts = versions.drafts as Record<string, unknown>
  assert.equal(versions.maxPerDoc, 0)
  assert.equal((drafts.autosave as Record<string, unknown>).interval, 2000)
  assert.equal(drafts.schedulePublish, false)
  assert.equal(PortalPages.access?.readVersions, portalPageEditorAccess)
  assert.equal(PortalPageMedia.access?.create?.({ req: { user: manager } as never } as never), false)
  assert.equal(PortalPageMedia.access?.update?.({ req: { user: manager } as never } as never), false)
  assert.equal(PortalPageMedia.access?.delete?.({ req: { user: manager } as never } as never), false)
  assert.deepEqual(await portalPageMediaReadAccess({ req: { user: manager } as never } as never), { state: { equals: 'complete' } })

  const categories = PortalPageCategories.fields
  const categoryName = categories.find(field => 'name' in field && field.name === 'name')! as unknown as Record<string, unknown>
  const categorySlug = categories.find(field => 'name' in field && field.name === 'slug')! as unknown as Record<string, unknown>
  const categoryDescription = categories.find(field => 'name' in field && field.name === 'description')! as unknown as Record<string, unknown>
  assert.equal(categoryName.required, true)
  assert.equal(categoryName.maxLength, 100)
  assert.equal(categorySlug.required, true)
  assert.equal(categorySlug.unique, true)
  assert.equal(categorySlug.index, true)
  assert.equal(categorySlug.maxLength, 160)
  assert.equal(categoryDescription.maxLength, 1000)

  const pageFields = PortalPages.fields as unknown as Record<string, unknown>[]
  const body = pageFields.find(field => field.name === 'body')!
  assert.equal(body.maxRows, 100)
  const blocks = body.blocks as Record<string, unknown>[]
  assert.deepEqual(blocks.map(block => block.slug), [
    'heading', 'rich_text', 'image', 'gallery', 'video', 'embed', 'pdf', 'callout', 'link', 'divider',
  ])
  assert.ok(blocks.every(block => {
    const labels = block.labels as Record<string, unknown>
    return typeof labels.singular === 'string' && typeof labels.plural === 'string'
  }), 'native editor blocks have Portuguese labels')
  const imageBlock = blocks.find(block => block.slug === 'image')!
  const imageAlt = (imageBlock.fields as Record<string, unknown>[]).find(field => field.name === 'alt')!
  assert.equal(imageAlt.required, true)
  const cover = pageFields.find(field => field.name === 'cover')!
  assert.equal(cover.relationTo, 'portal-page-media')
  assert.equal(Boolean(PortalPageMedia.upload), false, 'page media is metadata-only, not a native Payload upload collection')
  for (const name of ['publishedAt', 'createdBy', 'updatedBy']) {
    const field = pageFields.find(candidate => candidate.name === name)!
    assert.equal((field.admin as Record<string, unknown>).readOnly, true)
    assert.equal((field.access as Record<string, (args: never) => unknown>).create({ req: { user: manager } } as never), false)
    assert.equal((field.access as Record<string, (args: never) => unknown>).update({ req: { user: manager } } as never), false)
  }
})

test('Payload native create tolerates an undefined publishedAt placeholder but rejects client timestamps', async () => {
  const f = await payloadFixture()
  const beforeChange = PortalPages.hooks?.beforeChange?.[0]
  assert.ok(beforeChange)
  const input = { title: 'Guia inicial', slug: 'guia-inicial', summary: '', cover: null,
    coverAlt: null, categories: [], body: [], _status: 'draft', publishedAt: undefined }
  const args = { data: input, operation: 'create', originalDoc: {}, req: f.req }
  const normalized = await beforeChange(args as never)
  assert.equal((normalized as Record<string, unknown>).publishedAt, null)

  await assert.rejects(beforeChange({ ...args,
    data: { ...input, publishedAt: '2026-10-20T10:00:00.000Z' },
  } as never), { status: 403 })
})

test('Payload blocks project exactly the Task 1 public shapes and reject malformed rich text/media rows', () => {
  const projected = projectPortalPageContent([
    { blockType: 'heading', text: '  Título  ', level: 2 },
    { blockType: 'image', asset: pageMediaID, alt: 'Descrição', caption: 'Legenda' },
    { blockType: 'gallery', images: [{ asset: pageMediaID, alt: 'Imagem 1' }, { asset: newsMediaID, alt: 'Imagem 2' }] },
    { blockType: 'video', asset: pageMediaID, title: 'Vídeo' },
    { blockType: 'pdf', asset: pageMediaID, title: 'Manual' },
    { blockType: 'rich_text', content: { root: { type: 'root', children: [{ type: 'paragraph', children: [
      { type: 'text', text: 'Texto ', format: 1 },
      { type: 'link', fields: { linkType: 'custom', url: 'https://example.test', newTab: true }, children: [
        { type: 'text', text: 'externo', format: 0 },
      ] },
    ] }] } } },
    { blockType: 'embed', provider: 'youtube', url: 'https://youtube.com/watch?v=dQw4w9WgXcQ', title: 'Tutorial' },
    { blockType: 'callout', tone: 'info', text: 'Aviso' },
    { blockType: 'link', label: 'Acessar', url: 'https://example.test', newTab: true, style: 'primary' },
    { blockType: 'divider' },
  ])
  assert.deepEqual(projected.map(block => block.type), [
    'heading', 'image', 'gallery', 'video', 'pdf', 'rich_text', 'embed', 'callout', 'link', 'divider',
  ])
  assert.deepEqual(projected[1], { type: 'image', asset_id: pageMediaID, alt: 'Descrição', caption: 'Legenda' })
  assert.deepEqual(projected[2], { type: 'gallery', images: [
    { asset_id: pageMediaID, alt: 'Imagem 1' }, { asset_id: newsMediaID, alt: 'Imagem 2' },
  ] })
  assert.deepEqual(projected[5], { type: 'rich_text', nodes: [{ type: 'paragraph', children: [
    { type: 'text', text: 'Texto ', marks: ['bold'] },
    { type: 'link', url: 'https://example.test/', new_tab: true, children: [{ type: 'text', text: 'externo', marks: [] }] },
  ] }] })
  assert.throws(() => projectPortalPageContent([{ blockType: 'html', html: '<b>unsafe</b>' }]))
  assert.throws(() => projectPortalPageContent(Array.from({ length: 101 }, () => ({ blockType: 'divider' }))))
  assert.throws(() => projectPortalPageContent([{ blockType: 'gallery', images: [{ asset: pageMediaID, alt: 'Somente uma' }] }]))
  assert.throws(() => projectPortalPageContent([{ blockType: 'rich_text', content: { root: { children: [
    { type: 'paragraph', children: [{ type: 'text', text: '<script>', format: 0 }] },
  ] } } }]))
})

test('persisted native page blocks omit nullish optional captions, callout titles, and layouts before normalization', () => {
  const persisted = projectPortalPageContent([
    { blockType: 'image', asset: pageMediaID, alt: 'Imagem', caption: null, layout: null },
    { blockType: 'gallery', images: [
      { asset: pageMediaID, alt: 'Imagem 1', caption: null },
      { asset: pageMediaID, alt: 'Imagem 2', caption: 'Legenda' },
    ], layout: null },
    { blockType: 'callout', tone: 'info', text: 'Aviso', title: null, layout: null },
  ])
  assert.deepEqual(persisted, [
    { type: 'image', asset_id: pageMediaID, alt: 'Imagem' },
    { type: 'gallery', images: [
      { asset_id: pageMediaID, alt: 'Imagem 1' }, { asset_id: pageMediaID, alt: 'Imagem 2', caption: 'Legenda' },
    ] },
    { type: 'callout', tone: 'info', text: 'Aviso' },
  ])
})

test('category name and canonical slug use page-local normalization and bounds', () => {
  assert.deepEqual(normalizePortalPageCategory({ name: '  Crème Brûlée  ', slug: '  Equipe Produto / 2026 ', description: '  Conteúdo  ' }), {
    name: 'Crème Brûlée', slug: 'equipe-produto-2026', description: 'Conteúdo',
  })
  assert.throws(() => normalizePortalPageCategory({ name: 'x'.repeat(101), slug: 'valid' }))
  assert.throws(() => normalizePortalPageCategory({ name: 'válida', slug: 'x'.repeat(201) }))
  assert.throws(() => normalizePortalPageCategory({ name: 'válida', slug: '東京' }))
  assert.throws(() => normalizePortalPageCategory({ name: 'válida', slug: 'valid', description: 'x'.repeat(1001) }))
})

test('media metadata enforces random canonical keys, hash, positive integer size, MIME caps and completion state', () => {
  const metadata = {
    originalName: ' Manual.PDF ', storageKey: createPortalPageStorageKey('application/pdf'), mimeType: 'application/pdf', filesize: 100,
    sha256: 'a'.repeat(64), state: 'complete', uploadedBy: 'staff-1', completedAt: '2026-10-19T10:20:30.000Z',
  }
  assert.deepEqual(validatePortalPageMediaMetadata(metadata), { ...metadata, originalName: 'Manual.PDF' })
  const uploading = { ...metadata, sha256: null, state: 'uploading', completedAt: null }
  assert.deepEqual(validatePortalPageMediaMetadata(uploading), { ...uploading, originalName: 'Manual.PDF' })
  const hashAbsentWhileUploading = { ...uploading }
  delete (hashAbsentWhileUploading as Partial<typeof uploading>).sha256
  assert.equal(validatePortalPageMediaMetadata(hashAbsentWhileUploading).sha256, null)
  for (const invalid of [
    { ...metadata, storageKey: '../secret.pdf' }, { ...metadata, storageKey: `${pageMediaID}.png` },
    { ...metadata, sha256: 'A'.repeat(64) }, { ...metadata, filesize: 0 }, { ...metadata, filesize: 1.5 },
    { ...metadata, mimeType: 'video/quicktime', storageKey: `${pageMediaID}.mov` },
    { ...metadata, filesize: 100 * 1024 * 1024 + 1 }, { ...metadata, state: 'complete', completedAt: null },
    { ...metadata, state: 'complete', sha256: null },
    { ...metadata, state: 'uploading', completedAt: '2026-10-19T10:20:30.000Z' },
  ]) assert.throws(() => validatePortalPageMediaMetadata(invalid))
  assert.throws(() => validatePortalPageMediaMetadata({ ...metadata, mimeType: 'image/png', storageKey: createPortalPageStorageKey('image/png'), filesize: 15 * 1024 * 1024 + 1 }))
  assert.throws(() => validatePortalPageMediaMetadata({ ...metadata, mimeType: 'video/mp4', storageKey: createPortalPageStorageKey('video/mp4'), filesize: 500 * 1024 * 1024 + 1 }))
  const generatedKeys = new Set(Array.from({ length: 5 }, () => createPortalPageStorageKey('image/jpeg')))
  assert.equal(generatedKeys.size, 5)
  assert.ok([...generatedKeys].every(key => /^[0-9a-f-]{36}\.jpg$/u.test(key)))
})

test('page media mutations fail closed outside the trusted scoped helper and server-own key/uploader identity', async () => {
  const f = await payloadFixture()
  const beforeOperation = PortalPageMedia.hooks?.beforeOperation?.[0]
  assert.ok(beforeOperation)
  await assert.rejects((beforeOperation as (args: unknown) => Promise<unknown>)(
    { operation: 'create', args: { data: {} }, req: f.req },
  ), /portal_page_media_server_only/)
  assert.equal(PortalPageMedia.access?.create?.({ req: f.req } as never), false)
  assert.equal(isPortalPageMediaMutation(f.req), false)

  const beforeChange = PortalPageMedia.hooks?.beforeChange?.[0]
  assert.ok(beforeChange)
  const attackerKey = `${pageMediaID}.pdf`
  const result = await withPortalPageMediaMutation(f.req, 'trusted-uploader', 'create', async req => {
    assert.equal(isPortalPageMediaMutation(req, 'create'), true)
    const { id: _id, ...metadata } = mediaRecord(pageMediaID, 'application/pdf', 'uploading')
    return (beforeChange as (args: unknown) => unknown)({
      operation: 'create', req, originalDoc: undefined,
      data: { ...metadata, storageKey: attackerKey, uploadedBy: 'attacker' },
    }) as Record<string, unknown>
  })
  assert.notEqual(result.storageKey, attackerKey)
  assert.match(String(result.storageKey), /^[0-9a-f-]{36}\.pdf$/u)
  assert.equal(result.uploadedBy, 'trusted-uploader')
  assert.equal(result.sha256, null, 'new uploads remain incomplete until byte verification')
  assert.equal(isPortalPageMediaMutation(f.req), false)
})

test('trusted media completion validates explicit metadata from a persisted Payload document', async () => {
  const f = await payloadFixture()
  const beforeChange = PortalPageMedia.hooks?.beforeChange?.[0]
  assert.ok(beforeChange)
  const persisted = {
    ...mediaRecord(pageMediaID, 'application/pdf', 'uploading'),
    createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:00.000Z',
  }
  const completedAt = '2026-10-19T10:30:00.000Z'
  const data: Record<string, unknown> = { state: 'complete', sha256: 'b'.repeat(64), completedAt }
  const result = await withPortalPageMediaMutation(f.req, 'staff-1', 'update', async req =>
    (beforeChange as (args: unknown) => unknown)({ operation: 'update', req, originalDoc: persisted, data }) as Record<string, unknown>)

  assert.equal(result.state, 'complete')
  assert.equal(result.completedAt, completedAt)
  assert.equal(result.sha256, 'b'.repeat(64))
  assert.equal(result.storageKey, persisted.storageKey)
  assert.equal(result.uploadedBy, 'staff-1')
  assert.equal('id' in data, false)
  assert.equal('createdAt' in data, false)
  assert.equal('updatedAt' in data, false)
  assert.throws(() => validatePortalPageMediaMetadata({ ...persisted, state: 'uploading', completedAt: null }))
})

test('internal lifecycle recovery can complete another actor media row without changing its owner', async () => {
  const f = await payloadFixture()
  const beforeChange = PortalPageMedia.hooks?.beforeChange?.[0]
  assert.ok(beforeChange)
  const persisted = {
    ...mediaRecord(pageMediaID, 'application/pdf', 'uploading'), uploadedBy: 'other-editor',
  }
  const data: Record<string, unknown> = { state: 'complete', sha256: 'c'.repeat(64), completedAt: '2026-10-19T10:30:00.000Z' }
  const result = await withPortalPageMediaLifecycleMutation(f.req, 'recovery-worker', async req => {
    assert.equal(isPortalPageMediaLifecycleMutation(req), true)
    assert.equal(isPortalPageMediaMutation(req, 'update'), true)
    return (beforeChange as (args: unknown) => unknown)({ operation: 'update', req, originalDoc: persisted, data }) as Record<string, unknown>
  })
  assert.equal(result.state, 'complete')
  assert.equal(result.uploadedBy, 'other-editor')
  assert.equal(data.uploadedBy, 'other-editor')
  assert.equal(isPortalPageMediaLifecycleMutation(f.req), false)
})

test('published slug uses canonical main state and remains blocked through drafts/publish until controlled unpublication', async () => {
  assert.doesNotThrow(() => validatePortalPageSlugChange('same-slug', 'same-slug', 'published'))
  assert.throws(() => validatePortalPageSlugChange('new-slug', 'same-slug', 'published'), /portal_page_slug_immutable/)
  assert.doesNotThrow(() => validatePortalPageSlugChange('new-slug', 'same-slug', 'draft'))
  assert.throws(() => validatePortalPageStatusTransition('published', 'draft', false), /portal_page_publication_context_required/)
  assert.throws(() => validatePortalPageStatusTransition('draft', 'published', false), /portal_page_publication_context_required/)
  assert.doesNotThrow(() => validatePortalPageStatusTransition('published', 'draft', true))
  assert.doesNotThrow(() => validatePortalPageStatusTransition('draft', 'published', true))
  const f = await payloadFixture({
    latestVersion: { id: versionID, parent: pageID, latest: true, autosave: false, version: { _status: 'draft', slug: 'publicado' } },
    mainPage: { slug: 'publicado', status: 'published' },
  })
  const beforeOperation = PortalPages.hooks?.beforeOperation?.[0]
  const beforeChange = PortalPages.hooks?.beforeChange?.[0]
  assert.ok(beforeOperation); assert.ok(beforeChange)
  const draft = { id: pageID, _status: 'draft', slug: 'publicado', publishedAt: '2026-10-19T10:00:00.000Z', body: [] }
  const save = async (req: PayloadRequest, originalDoc: Record<string, unknown>, data: Record<string, unknown>, draftSave: boolean) => {
    await (beforeOperation as (args: unknown) => Promise<unknown>)({
      operation: 'update', args: { id: pageID, data, draft: draftSave }, req,
    })
    const result = await (beforeChange as (args: unknown) => Promise<unknown>)({ data, originalDoc, operation: 'update', req })
    return { ...(result as Record<string, unknown>), id: pageID } as Record<string, unknown>
  }
  const savedDraft = await save(f.req, draft, {
    _status: 'draft', title: 'Rascunho', slug: 'publicado', summary: '', body: [],
  }, true)
  assert.equal(savedDraft.slug, 'publicado')

  await assert.rejects(save(f.req, savedDraft, {
    _status: 'draft', title: 'Rascunho editado', slug: 'novo-endereco', summary: '', body: [],
  }, true), /portal_page_slug_immutable/)

  const publicationInput = { id: pageID, expected_version_id: versionID, operation: 'publish' as const }
  await assert.rejects(withExpectedPortalPageVersion(f.req, publicationInput, async req => save(req, savedDraft, {
    _status: 'published', title: 'Rascunho editado', slug: 'novo-endereco', summary: '', body: [],
  }, false)), /portal_page_slug_immutable/)

  const unpublishInput = { ...publicationInput, operation: 'unpublish' as const }
  const unpublished = await withExpectedPortalPageVersion(f.req, unpublishInput, async req => save(req, savedDraft, {
    _status: 'draft', title: 'Rascunho', slug: 'publicado', summary: '', body: [],
  }, false))
  assert.equal(unpublished._status, 'draft')
  assert.equal(unpublished.publishedAt, null)
  f.setMainPage({ slug: 'publicado', status: 'draft' })
  const renamed = await save(f.req, unpublished, {
    _status: 'draft', title: 'Rascunho', slug: 'novo-endereco', summary: '', body: [],
  }, true)
  assert.equal(renamed.slug, 'novo-endereco')
  assert.ok(f.calls.includes('main-page-state-read'))
  assert.equal(f.calls.filter(call => call === `findByID:portal-pages:${pageID}`).length, 2,
    'only expected-version helper reads the document through Payload; canonical hook state is SQL-read under the row lock')

  const untrusted = await payloadFixture()
  const untrustedBeforeChange = PortalPages.hooks?.beforeChange?.[0]
  assert.ok(untrustedBeforeChange)
  await assert.rejects((untrustedBeforeChange as (args: unknown) => Promise<unknown>)({
    data: { _status: 'published', title: 'Página', slug: 'pagina', summary: '', body: [] },
    originalDoc: { id: pageID, _status: 'draft', slug: 'pagina' }, operation: 'update', req: untrusted.req,
  }), /portal_page_publication_context_required/)
})

test('native REST status changes and historical restores still require the page publication helper', async () => {
  const f = await payloadFixture({ mainPage: { slug: 'pagina', status: 'published' } })
  const beforeOperation = PortalPages.hooks?.beforeOperation?.[0]
  const beforeChange = PortalPages.hooks?.beforeChange?.[0]
  assert.ok(beforeOperation); assert.ok(beforeChange)
  await assert.rejects((beforeOperation as (args: unknown) => Promise<unknown>)({
    operation: 'update', args: { id: pageID, data: { _status: 'published' }, draft: false }, req: f.req,
  }), /portal_page_publication_context_required/)
  await assert.rejects((beforeChange as (args: unknown) => Promise<unknown>)({
    operation: 'update', data: { _status: 'draft', title: 'Página', slug: 'pagina', summary: '', body: [] },
    originalDoc: { id: pageID, _status: 'published', slug: 'pagina' }, req: f.req,
  }), /portal_page_publication_context_required/)
  await assert.rejects((beforeOperation as (args: unknown) => Promise<unknown>)({
    operation: 'restoreVersion', args: { id: pageID, version: versionID, draft: true }, req: f.req,
  }), /portal_page_restore_requires_publication_helper/)
})

test('media validation locks and rejects incomplete or wrong-shape MIME references before publication', async () => {
  for (const asset of [
    mediaRecord(pageMediaID, 'image/png', 'uploading'),
    mediaRecord(pageMediaID, 'application/pdf'),
  ]) {
    const f = await payloadFixture({ media: [asset] })
    await assert.rejects(assertPortalPageMediaReferences(f.payload, {
      cover: null, body: [{ type: 'image', asset_id: pageMediaID, alt: 'Descrição' }],
    }, f.req), /invalid_portal_page_media_reference/)
    assert.ok(f.calls.some(call => call.startsWith('sql:')), 'media checks must be under the shared DB transaction')
  }
  const good = await payloadFixture({ media: [mediaRecord(pageMediaID, 'image/webp')] })
  await assert.doesNotReject(assertPortalPageMediaReferences(good.payload, {
    cover: { asset_id: pageMediaID, alt: 'Capa' }, body: [{ type: 'gallery', images: [
      { asset_id: pageMediaID, alt: 'Imagem 1' }, { asset_id: pageMediaID, alt: 'Imagem 2' },
    ] }],
  }, good.req))
})

test('duplicate media IDs are validated independently for each image, gallery, video, and PDF usage', async () => {
  const imageUsedAsVideo = await payloadFixture({ media: [mediaRecord(pageMediaID, 'image/png')] })
  await assert.rejects(assertPortalPageMediaReferences(imageUsedAsVideo.payload, {
    cover: { asset_id: pageMediaID, alt: 'Capa' },
    body: [{ type: 'video', asset_id: pageMediaID, title: 'Vídeo' }],
  }, imageUsedAsVideo.req), /invalid_portal_page_media_reference/)

  const pdfUsedAsGalleryImage = await payloadFixture({ media: [mediaRecord(pageMediaID, 'application/pdf')] })
  await assert.rejects(assertPortalPageMediaReferences(pdfUsedAsGalleryImage.payload, {
    cover: null,
    body: [
      { type: 'gallery', images: [{ asset_id: pageMediaID, alt: 'Imagem 1' }, { asset_id: pageMediaID, alt: 'Imagem 2' }] },
      { type: 'pdf', asset_id: pageMediaID, title: 'Documento' },
    ],
  }, pdfUsedAsGalleryImage.req), /invalid_portal_page_media_reference/)
})

test('reference collectors include cover, image, gallery, video, PDF, category relations and nested saved draft shapes', () => {
  const doc = {
    cover: pageMediaID,
    categories: [categoryID],
    body: [
      { blockType: 'image', asset: newsMediaID },
      { blockType: 'gallery', images: [{ asset: pageMediaID }, { asset: { id: '018f47a2-7b3c-7a11-8a2c-1234567890b0' } }] },
      { blockType: 'video', asset: '018f47a2-7b3c-7a11-8a2c-1234567890b1' },
      { blockType: 'pdf', asset: '018f47a2-7b3c-7a11-8a2c-1234567890b2' },
    ],
  }
  assert.deepEqual([...collectPortalPageMediaIds(doc)].sort(), [
    pageMediaID, newsMediaID, '018f47a2-7b3c-7a11-8a2c-1234567890b0',
    '018f47a2-7b3c-7a11-8a2c-1234567890b1', '018f47a2-7b3c-7a11-8a2c-1234567890b2',
  ].sort())
  assert.deepEqual([...collectPortalPageCategoryIds(doc)], [categoryID])
})

test('category and media deletion protection scans current drafts and retained Payload Versions under the shared lock', async () => {
  const pageDraft = { cover: pageMediaID, categories: [categoryID], body: [{ blockType: 'video', asset: pageMediaID }] }
  const f = await payloadFixture({ drafts: [pageDraft] })
  await assert.rejects(assertPortalPageMediaOrphan(f.payload, pageMediaID, f.req), /portal_page_media_is_referenced/)
  assert.ok(f.calls.includes('find:portal-pages:true'))
  assert.ok(f.calls.indexOf('find:portal-pages:true') > f.calls.findIndex(call => call.includes('pg_advisory_xact_lock')),
    'reference scans run after the global advisory transaction lock')

  const retained = await payloadFixture({ versions: [{ id: versionID, version: {
    cover: null, categories: [categoryID], body: [{ blockType: 'gallery', images: [{ asset: pageMediaID }, { asset: newsMediaID }] }],
  } }] })
  await assert.rejects(assertPortalPageMediaOrphan(retained.payload, pageMediaID, retained.req), /portal_page_media_is_referenced/)
  await assert.rejects(assertPortalPageCategoryOrphan(retained.payload, categoryID, retained.req), /portal_page_category_is_referenced/)
  assert.ok(retained.calls.includes('versions:portal-pages'))

  const free = await payloadFixture()
  await assert.doesNotReject(assertPortalPageMediaOrphan(free.payload, pageMediaID, free.req))
  await assert.doesNotReject(assertPortalPageCategoryOrphan(free.payload, categoryID, free.req))
})

test('server-only expected-version helper requires exact latest saved version and scopes controlled transitions', async () => {
  const f = await payloadFixture({ latestVersion: { id: versionID, parent: pageID, latest: true, autosave: false, version: { _status: 'draft' } } })
  const input = { id: pageID, expected_version_id: versionID, operation: 'publish' as const }
  let returnedID = ''
  await withExpectedPortalPageVersion(f.req, input, async (req, version) => {
    assert.equal(isPortalPagePublication(req), true)
    returnedID = String(version.id)
    return version
  })
  assert.equal(returnedID, versionID)
  assert.ok(f.calls.some(call => call.includes('FOR UPDATE')))
  const stale = await payloadFixture({ latestVersion: { id: '018f47a2-7b3c-7a11-8a2c-1234567890b3', parent: pageID } })
  await assert.rejects(withExpectedPortalPageVersion(stale.req, input, async () => true), /portal_page_version_conflict/)
  assert.equal(isPortalPagePublication(f.req), false, 'publication scope is removed after the callback')
})

test('expected-version helper rejects reused autosave Versions and any newer revision but accepts an explicit save', async () => {
  const input = { id: pageID, expected_version_id: versionID, operation: 'publish' as const }
  const autosave = { id: versionID, parent: pageID, latest: true, autosave: true, version: { _status: 'draft', title: 'auto 1' } }
  const f = await payloadFixture({ latestVersion: autosave })
  let callbackCalled = false
  await assert.rejects(withExpectedPortalPageVersion(f.req, input, async () => { callbackCalled = true; return true }), /portal_page_version_conflict/)
  assert.equal(callbackCalled, false)

  autosave.version = { _status: 'draft', title: 'auto 2' }
  assert.equal(autosave.id, input.expected_version_id, 'Payload reuses the latest autosave Version identity')
  await assert.rejects(withExpectedPortalPageVersion(f.req, input, async () => { callbackCalled = true; return true }), /portal_page_version_conflict/)
  assert.equal(callbackCalled, false, 'an updated autosave with the same ID is still mutable and cannot be published')

  const stale = await payloadFixture({ latestVersion: {
    id: '018f47a2-7b3c-7a11-8a2c-1234567890b3', parent: pageID, latest: true, autosave: true,
    version: { _status: 'draft', title: 'newer autosave' },
  } })
  await assert.rejects(withExpectedPortalPageVersion(stale.req, input, async () => true), /portal_page_version_conflict/)
  const newerSave = await payloadFixture({ latestVersion: {
    id: '018f47a2-7b3c-7a11-8a2c-1234567890b4', parent: pageID, latest: true, autosave: false,
    version: { _status: 'draft', title: 'newer explicit save' },
  } })
  await assert.rejects(withExpectedPortalPageVersion(newerSave.req, input, async () => true), /portal_page_version_conflict/)
  const missingSaveKind = await payloadFixture({ latestVersion: {
    id: versionID, parent: pageID, latest: true, version: { _status: 'draft', title: 'unknown save kind' },
  } })
  await assert.rejects(withExpectedPortalPageVersion(missingSaveKind.req, input, async () => true), /portal_page_version_conflict/)

  const explicit = await payloadFixture({ latestVersion: {
    id: versionID, parent: pageID, latest: true, autosave: false, version: { _status: 'draft', title: 'saved' },
  } })
  let explicitSaveAccepted = false
  await withExpectedPortalPageVersion(explicit.req, input, async (_req, version) => {
    explicitSaveAccepted = version.id === versionID && version.autosave === false
    return true
  })
  assert.equal(explicitSaveAccepted, true)
})

test('upload advisory keys are stable UUID-derived int32 pairs and the production lock helper binds them', async () => {
  const upper = pageMediaID.toUpperCase()
  const key = portalPageUploadAdvisoryKey(pageMediaID)
  assert.deepEqual(portalPageUploadAdvisoryKey(upper), key, 'UUID spelling is canonicalized before hashing')
  assert.deepEqual(portalPageUploadAdvisoryKey(pageMediaID), key, 'key derivation is stable')
  assert.notDeepEqual(key, portalPageUploadAdvisoryKey(versionID), 'different UUIDs map to different sample keys')
  assert.equal(key.length, 2)
  assert.ok(key.every(part => Number.isInteger(part) && part >= -2_147_483_648 && part <= 2_147_483_647))
  assert.throws(() => portalPageUploadAdvisoryKey('../not-a-uuid'), /invalid_portal_page_content/)

  const statements: unknown[] = []
  const payload = { db: { sessions: { live: { db: { execute: async (statement: unknown) => {
    statements.push(statement)
    return { rows: [] }
  } } } } } } as unknown as Payload
  const req = { payload, transactionID: 'live' } as PayloadRequest
  await lockPortalPageUpload(payload, req, pageMediaID)

  assert.equal(statements.length, 1, 'the production helper executes one transaction-scoped upload lock')
  const compiled = new PgDialect().sqlToQuery(statements[0] as never)
  assert.match(compiled.sql, /^SELECT pg_advisory_xact_lock\(\$1, \$2\)$/u)
  assert.deepEqual(compiled.params, key, 'both key components are SQL parameters, not interpolated SQL text')
})

test('News media reference inventory structurally verifies page collection relationship targets', async () => {
  const valid = await payloadFixture()
  assert.doesNotThrow(() => assertReferenceStoreCoverage(valid.payload))
  const unsafe = await payloadFixture()
  unsafe.collections['portal-pages'].config.fields.push({ name: 'newsAsset', type: 'relationship', relationTo: 'news-media' } as never)
  assert.throws(() => assertReferenceStoreCoverage(unsafe.payload), /media_reference_store_not_covered/)
  const unsafeBlock = await payloadFixture()
  const blocks = unsafeBlock.collections['portal-pages'].config.fields.find(field => 'name' in field && field.name === 'body') as { blocks: Array<{ slug: string; fields: unknown[] }> }
  blocks.blocks[0]!.fields.push({ name: 'newsAsset', type: 'upload', relationTo: 'news-media' })
  assert.throws(() => assertReferenceStoreCoverage(unsafeBlock.payload), /media_reference_store_not_covered/)
})
