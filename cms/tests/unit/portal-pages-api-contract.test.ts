import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { projectPortalPageContent } from '../../src/portal-pages/projection.js'

const require = createRequire(import.meta.url)
const { readPortalPageResult } = require('../../../api/portal-pages/payload-dto.js') as {
  readPortalPageResult: (action: string, value: unknown, input: { slug: string }) => unknown
}

const pageID = '018f47a2-7b3c-7a11-8a2c-1234567890ab'
const revisionID = '018f47a2-7b3c-7a11-8a2c-1234567890ac'
const assetA = '018f47a2-7b3c-7a11-8a2c-1234567890ad'
const assetB = '018f47a2-7b3c-7a11-8a2c-1234567890ae'
const categoryID = '018f47a2-7b3c-7a11-8a2c-1234567890af'
const layouts = ['content', 'wide', 'full', 'left', 'right'] as const

function nativeBlock(type: string, layout: string): Record<string, unknown> {
  const base = { layout }
  switch (type) {
    case 'heading': return { ...base, blockType: type, text: 'Heading', level: 2 }
    case 'rich_text': return { ...base, blockType: type, content: { root: { type: 'root', children: [
      { type: 'paragraph', children: [{ type: 'text', text: 'Body', format: 1 }] },
    ] } } }
    case 'image': return { ...base, blockType: type, asset: assetA, alt: 'Image alt', caption: 'Optional image caption' }
    case 'gallery': return { ...base, blockType: type, images: [
      { asset: assetA, alt: 'First alt', caption: 'First optional caption' },
      { asset: assetB, alt: 'Second alt', caption: 'Second optional caption' },
    ] }
    case 'video': return { ...base, blockType: type, asset: assetA, title: 'Video title' }
    case 'embed': return { ...base, blockType: type, provider: 'youtube', url: 'https://www.youtube.com/embed/ABCDEFGHIJK', title: 'Embed title' }
    case 'pdf': return { ...base, blockType: type, asset: assetA, title: 'PDF title' }
    case 'callout': return { ...base, blockType: type, tone: 'info', title: 'Optional callout title', text: 'Callout body' }
    case 'link': return { ...base, blockType: type, label: 'Link label', url: 'https://example.test/policy', newTab: true, style: 'primary' }
    case 'divider': return { ...base, blockType: type }
    default: throw new Error(`Unknown contract fixture block: ${type}`)
  }
}

function dto(contentBlocks: unknown[]) {
  return {
    id: pageID, slug: 'contract-round-trip', title: 'Contract round trip', summary: '',
    cover: { asset_id: assetA, alt: 'Cover alt' },
    categories: [{ id: categoryID, slug: 'people-policies', name: 'People policies' }],
    published_at: null, content_version: 1, asset_scope: 'portal-pages', content_blocks: contentBlocks,
    revision: { id: revisionID, status: 'published' },
  }
}

test('real CMS projection round-trips every block/layout/optional field through the strict API DTO validator', () => {
  const types = ['heading', 'rich_text', 'image', 'gallery', 'video', 'embed', 'pdf', 'callout', 'link', 'divider']
  const projected = projectPortalPageContent(types.flatMap(type => layouts.map(layout => nativeBlock(type, layout))))
  assert.equal(projected.length, types.length * layouts.length)
  assert.deepEqual(new Set(projected.map(block => block.type)), new Set(types))
  assert.deepEqual(new Set(projected.map(block => block.layout)), new Set(layouts))

  const value = dto(projected)
  const validated = readPortalPageResult('detail', value, { slug: 'contract-round-trip' }) as typeof value
  assert.deepEqual(validated, value)
  assert.deepEqual(validated.cover, { asset_id: assetA, alt: 'Cover alt' })
  assert.deepEqual(validated.categories, [{ id: categoryID, slug: 'people-policies', name: 'People policies' }])
  assert.ok(projected.filter(block => block.type === 'image').every(block => block.caption === 'Optional image caption'))
  assert.ok(projected.filter(block => block.type === 'gallery').every(block =>
    block.images.every(image => image.caption?.includes('optional caption'))))
  assert.ok(projected.filter(block => block.type === 'callout').every(block => block.title === 'Optional callout title'))

  const nativeWithoutOptionals = ['image', 'gallery', 'callout'].map(type => {
    const block = nativeBlock(type, 'content')
    delete block.caption
    delete block.title
    if (type === 'gallery') {
      for (const image of block.images as Record<string, unknown>[]) delete image.caption
    }
    return block
  })
  const omittedOptionals = projectPortalPageContent(nativeWithoutOptionals)
  assert.doesNotThrow(() => readPortalPageResult('detail', dto(omittedOptionals), { slug: 'contract-round-trip' }),
    'image/gallery captions and callout title remain optional in the exact API contract')
})

test('API DTO rejects unknown keys at block, gallery image, cover and category boundaries', () => {
  const projected = projectPortalPageContent(['image', 'gallery', 'callout'].map(type => nativeBlock(type,
    'content')))
  const value = dto(projected)
  const assertRejected = (candidate: unknown) => assert.throws(() =>
    readPortalPageResult('detail', candidate, { slug: 'contract-round-trip' }))

  assertRejected({ ...value, content_blocks: [{ ...projected[0], unknown: true }] })
  const gallery = projected.find(block => block.type === 'gallery')!
  assertRejected({ ...value, content_blocks: [{ ...gallery, images: [{ ...gallery.images[0], unknown: true }, gallery.images[1]] }] })
  assertRejected({ ...value, cover: { ...value.cover!, unknown: true } })
  assertRejected({ ...value, categories: [{ ...value.categories[0], description: 'not part of the DTO' }] })
})
