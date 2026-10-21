import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { NewsArticles } from '../../src/collections/NewsArticles'
import { PortalPages } from '../../src/collections/PortalPages'
import { portalPageLinkFields } from '../../src/portal-pages/editor'
import { portalPageBlocks } from '../../src/portal-pages/native-blocks'

const importMapURL = new URL('../../src/app/(payload)/editorial/admin/importMap.js', import.meta.url)
const requiredTextComponent = '/admin/portal-pages/PortalPageRequiredTextField#PortalPageRequiredTextField'
const requiredTextareaComponent = '/admin/portal-pages/PortalPageRequiredTextareaField#PortalPageRequiredTextareaField'
const mediaFieldComponent = '/admin/portal-pages/PortalPageMediaField#PortalPageMediaField'
const emptyControlComponent = '/admin/portal-pages/EmptyPortalPageControl#EmptyPortalPageControl'
const controlsComponent = '/admin/portal-pages/PortalPageEditorialControls#PortalPageEditorialControls'

function fieldsOf(fields: Array<Record<string, unknown>>, path = ''): Array<{ path: string; field: Record<string, unknown> }> {
  return fields.flatMap(field => {
    const current = path ? `${path}.${String(field.name)}` : String(field.name)
    const nested = Array.isArray(field.fields) ? fieldsOf(field.fields as Array<Record<string, unknown>>, current) : []
    return [{ path: current, field }, ...nested]
  })
}

function componentPath(field: Record<string, unknown>): unknown {
  const admin = field.admin as { components?: { Field?: unknown } } | undefined
  return admin?.components?.Field
}

test('PortalPages retains native autosave and registers only dedicated editorial controls', () => {
  assert.deepEqual(PortalPages.versions, {
    maxPerDoc: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false },
  })
  const components = PortalPages.admin?.components?.edit
  assert.deepEqual(components?.beforeDocumentControls, [controlsComponent])
  assert.equal(components?.PublishButton, emptyControlComponent)
  assert.equal(components?.UnpublishButton, emptyControlComponent)
  assert.equal(components?.PreviewButton, emptyControlComponent)
  assert.equal(PortalPages.admin?.useAsTitle, 'title')
  assert.deepEqual(PortalPages.admin?.defaultColumns, ['title', 'slug', '_status', 'publishedAt'])
  assert.equal(JSON.stringify(PortalPages).includes('SaveDraftButton'), false)
})

test('cover and all four native media destinations use typed Task 3 wrappers and preserve relationship guards', () => {
  const pageFields = fieldsOf(PortalPages.fields as unknown as Array<Record<string, unknown>>)
  const blockFields = portalPageBlocks.flatMap(block => fieldsOf(block.fields as unknown as Array<Record<string, unknown>>, `body.${block.slug}`))
  const all = [...pageFields, ...blockFields]
  const media = [
    ['cover', 'image'],
    ['body.image.asset', 'image'],
    ['body.gallery.images.asset', 'image'],
    ['body.video.asset', 'video'],
    ['body.pdf.asset', 'pdf'],
  ] as const
  for (const [path, kind] of media) {
    const field = all.find(item => item.path === path)?.field
    assert.ok(field, `Missing native media relationship ${path}`)
    const relation = (field!.admin as { components?: { Field?: unknown } } | undefined)?.components?.Field as
      { path?: string; exportName?: string; clientProps?: Record<string, unknown> } | undefined
    assert.deepEqual(relation, {
      path: '/admin/portal-pages/PortalPageMediaField', exportName: 'PortalPageMediaField', clientProps: { kind },
    })
    assert.equal((field!.admin as { allowCreate?: boolean }).allowCreate, false)
    assert.equal((field!.admin as { allowEdit?: boolean }).allowEdit, false)
    assert.deepEqual(field!.filterOptions, {
      state: { equals: 'complete' },
      mimeType: { in: kind === 'image' ? ['image/jpeg', 'image/png', 'image/webp']
        : kind === 'video' ? ['video/mp4', 'video/webm'] : ['application/pdf'] },
    })
  }
  const gallery = all.find(item => item.path === 'body.gallery.images')?.field
  assert.equal(gallery?.minRows, 2)
  assert.equal(gallery?.maxRows, 20)
})

test('single-line required fields use the text wrapper and the required callout textarea uses the native textarea wrapper', () => {
  const pageFields = fieldsOf(PortalPages.fields as unknown as Array<Record<string, unknown>>)
  const blockFields = portalPageBlocks.flatMap(block => fieldsOf(block.fields as unknown as Array<Record<string, unknown>>, `body.${block.slug}`))
  const all = [...pageFields, ...blockFields]
  for (const path of ['title', 'slug', 'body.heading.text', 'body.image.alt', 'body.gallery.images.alt',
    'body.video.title', 'body.embed.url', 'body.embed.title', 'body.pdf.title', 'body.link.label', 'body.link.url']) {
    const field = all.find(item => item.path === path)?.field
    assert.ok(field, `Missing required editor field ${path}`)
    assert.equal(field!.required, true, `${path} should remain required`)
    assert.equal(componentPath(field!), requiredTextComponent, `${path} must register its native input with editorial-focus-state`)
  }
  const calloutText = all.find(item => item.path === 'body.callout.text')?.field
  assert.ok(calloutText, 'Missing required editor field body.callout.text')
  assert.equal(calloutText!.type, 'textarea')
  assert.equal(calloutText!.required, true)
  assert.equal(calloutText!.maxLength, 2000)
  assert.equal(componentPath(calloutText!), requiredTextareaComponent)
})

test('all Payload URL authoring controls expose the shared 2048-character limit', () => {
  const blockFields = portalPageBlocks.flatMap(block => fieldsOf(block.fields as unknown as Array<Record<string, unknown>>, `body.${block.slug}`))
  for (const path of ['body.embed.url', 'body.link.url']) {
    assert.equal(blockFields.find(item => item.path === path)?.field.maxLength, 2048, path)
  }

  const defaults = [{ name: 'text', type: 'text' }, { name: 'url', type: 'text' }, { name: 'newTab', type: 'checkbox' }]
  const fields = portalPageLinkFields({ defaultFields: defaults as never }) as Array<Record<string, unknown>>
  assert.equal(fields.find(field => field.name === 'url')?.maxLength, 2048)
  assert.equal(fields.find(field => field.name === 'text')?.maxLength, undefined)
  assert.equal(fields.find(field => field.name === 'newTab')?.maxLength, undefined)
})

test('News configuration and generated import map entries remain intact', async () => {
  assert.equal(NewsArticles.slug, 'news-articles')
  assert.deepEqual(NewsArticles.admin?.components?.edit?.beforeDocumentControls,
    ['/admin/SavedPreview#SavedPreview', '/admin/ScheduleRevision#ScheduleRevision', '/admin/LegacyHistory#LegacyHistory'])
  const importMap = await readFile(fileURLToPath(importMapURL), 'utf8')
  for (const key of [
    '/admin/SavedPreview#SavedPreview', '/admin/ScheduleRevision#ScheduleRevision', '/admin/LegacyHistory#LegacyHistory',
    '/news/CreateArticleView#CreateArticleView', '/admin/EditorialMetadata#EditorialMetadata',
    controlsComponent, emptyControlComponent, mediaFieldComponent,
    '/admin/portal-pages/PortalPageRequiredTextField#PortalPageRequiredTextField',
    requiredTextareaComponent,
  ]) assert.ok(importMap.includes(key), `Generated import map lost ${key}`)
  assert.match(importMap, /@payloadcms\/richtext-lexical\/client#BoldFeatureClient/u)
  assert.match(importMap, /\/news\/FlatLists\.client#FlatListsFeatureClient/u)
})
