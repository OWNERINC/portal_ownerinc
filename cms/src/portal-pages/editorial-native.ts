import type { PortalPage } from '../payload-types'
import { projectPortalPageContent } from './projection'
import type { NativeEditable } from './editorial-contracts'
import { MAX_PORTAL_PAGE_CONTENT_BYTES, array, invalid, keys, plainText, record, uuid } from './primitives'
import { normalizeSlug } from './validation'

const EDITABLE_KEYS = ['title', 'slug', 'summary', 'cover', 'coverAlt', 'categories', 'body'] as const
const commonBlockKeys = ['id', 'blockName', 'blockType', 'layout'] as const
const blockKeys: Readonly<Record<string, readonly string[]>> = {
  heading: [...commonBlockKeys, 'text', 'level'],
  rich_text: [...commonBlockKeys, 'content'],
  image: [...commonBlockKeys, 'asset', 'alt', 'caption'],
  gallery: [...commonBlockKeys, 'images'],
  video: [...commonBlockKeys, 'asset', 'title'],
  embed: [...commonBlockKeys, 'provider', 'url', 'title'],
  pdf: [...commonBlockKeys, 'asset', 'title'],
  callout: [...commonBlockKeys, 'tone', 'title', 'text'],
  link: [...commonBlockKeys, 'label', 'url', 'newTab', 'style'],
  divider: [...commonBlockKeys],
}

function optionalText(value: unknown, max: number, multiline = false): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const text = plainText(value, { max, multiline })
  return text === '' ? undefined : text
}

function relationID(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const raw = typeof value === 'string' ? value : record(value).id
  return uuid(raw)
}

function optionalNativeID(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return nativeRowID(value)
}

/** Payload 3.90.2's baseIDField uses bson-objectid.toHexString() for native rows. */
function nativeRowID(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{24}$/u.test(value)) invalid('invalid_portal_page_content')
  return value
}

function optionalLayout(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string') invalid('invalid_portal_page_content')
  return { layout: value }
}

function nativeBlock(value: unknown): Record<string, unknown> {
  const source = record(value, 'invalid_portal_page_content')
  if (typeof source.blockType !== 'string' || !Object.hasOwn(blockKeys, source.blockType)) {
    invalid('invalid_portal_page_content')
  }
  keys(source, blockKeys[source.blockType], 'invalid_portal_page_content')
  const metadata: Record<string, unknown> = {}
  const id = optionalNativeID(source.id)
  if (id) metadata.id = id
  if (source.blockName !== undefined && source.blockName !== null) {
    if (typeof source.blockName !== 'string' || Array.from(source.blockName).length > 255 || /[\p{Cc}]/u.test(source.blockName)) {
      invalid('invalid_portal_page_content')
    }
    metadata.blockName = source.blockName
  }
  const layout = optionalLayout(source.layout)

  switch (source.blockType) {
    case 'heading': {
      const level = source.level === undefined || source.level === null || source.level === '' ? '2' : String(source.level)
      const result = { ...metadata, blockType: 'heading', text: plainText(source.text, { min: 1, max: 200 }),
        level, ...layout }
      return result
    }
    case 'rich_text': {
      if (source.content === undefined || source.content === null) invalid('invalid_portal_page_rich_text')
      const result = { ...metadata, blockType: 'rich_text', content: source.content, ...layout }
      return result
    }
    case 'image': {
      const asset = relationID(source.asset)
      const caption = optionalText(source.caption, 1000, true)
      return { ...metadata, blockType: 'image', ...(asset ? { asset } : {}),
        alt: plainText(source.alt, { min: 1, max: 300 }), ...(caption === undefined ? {} : { caption }), ...layout }
    }
    case 'gallery': {
      const images = array(source.images, 'invalid_portal_page_content').map(rawImage => {
        const image = record(rawImage, 'invalid_portal_page_content')
        keys(image, ['id', 'asset', 'alt', 'caption'], 'invalid_portal_page_content')
        const rowID = optionalNativeID(image.id)
        const asset = relationID(image.asset)
        const caption = optionalText(image.caption, 1000, true)
        return { ...(rowID ? { id: rowID } : {}), ...(asset ? { asset } : {}),
          alt: plainText(image.alt, { min: 1, max: 300 }), ...(caption === undefined ? {} : { caption }) }
      })
      return { ...metadata, blockType: 'gallery', images, ...layout }
    }
    case 'video':
    case 'pdf': {
      const asset = relationID(source.asset)
      return { ...metadata, blockType: source.blockType, ...(asset ? { asset } : {}),
        title: plainText(source.title, { min: 1, max: 200 }), ...layout }
    }
    case 'embed':
      return { ...metadata, blockType: 'embed', provider: source.provider, url: source.url,
        title: plainText(source.title, { min: 1, max: 200 }), ...layout }
    case 'callout': {
      const tone = source.tone === undefined || source.tone === null || source.tone === '' ? 'info' : source.tone
      const title = optionalText(source.title, 200)
      return { ...metadata, blockType: 'callout', tone, ...(title === undefined ? {} : { title }),
        text: plainText(source.text, { min: 1, max: 2000, multiline: true }), ...layout }
    }
    case 'link':
      return { ...metadata, blockType: 'link', label: plainText(source.label, { min: 1, max: 200 }),
        url: source.url, newTab: source.newTab === undefined || source.newTab === null ? false : source.newTab,
        style: source.style === undefined || source.style === null || source.style === '' ? 'primary' : source.style, ...layout }
    case 'divider':
      return { ...metadata, blockType: 'divider', ...layout }
    default:
      invalid('invalid_portal_page_content')
  }
}

function normalizeEditable(raw: unknown): NativeEditable {
  const source = record(raw, 'invalid_portal_page_content')
  const title = plainText(source.title, { min: 1, max: 200, code: 'invalid_portal_page_title' })
  const slug = normalizeSlug(source.slug)
  const summary = source.summary === undefined || source.summary === null
    ? '' : plainText(source.summary, { max: 1000, multiline: true, code: 'invalid_portal_page_summary' })
  const cover = relationID(source.cover)
  const coverAltValue = source.coverAlt === undefined || source.coverAlt === null
    ? null : plainText(source.coverAlt, { max: 300, code: 'invalid_portal_page_cover_alt' })
  const coverAlt = cover === null || coverAltValue === '' ? null : coverAltValue
  if (cover !== null && !coverAlt) invalid('invalid_portal_page_cover_alt')
  const categories = source.categories === undefined || source.categories === null ? []
    : array(source.categories, 'invalid_portal_page_category_reference').map(value => {
      const id = relationID(value)
      if (!id) invalid('invalid_portal_page_category_reference')
      return id
    })
  const bodySource = source.body === undefined || source.body === null ? []
    : array(source.body, 'invalid_portal_page_content')
  const body = bodySource.map(nativeBlock) as unknown as NonNullable<PortalPage['body']>
  // The public projection is the single source of truth for block/schema validity and its byte budget.
  const projection = projectPortalPageContent(body)
  if (new TextEncoder().encode(JSON.stringify(projection)).byteLength > MAX_PORTAL_PAGE_CONTENT_BYTES) {
    invalid('portal_page_content_too_large')
  }
  return { title, slug, summary, cover, coverAlt, categories, body }
}

/** Select only editable values from trusted form/version documents, excluding server metadata. */
export function extractNativeEditable(raw: unknown): NativeEditable {
  return normalizeEditable(raw)
}

/** Strict browser ingress: callers may submit only the exact seven native editable fields. */
export function validateNativeEditable(raw: unknown): NativeEditable {
  const source = record(raw, 'invalid_portal_page_content')
  keys(source, EDITABLE_KEYS, 'invalid_portal_page_content')
  if (!Object.hasOwn(source, 'title') || !Object.hasOwn(source, 'slug')) invalid('invalid_portal_page_content')
  return normalizeEditable(source)
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, stableValue(item)]),
  )
  return value
}

export function canonicalNativeEditable(raw: unknown): string {
  return JSON.stringify(stableValue(extractNativeEditable(raw)))
}

/**
 * Canonical persisted content for a first-save comparison. Ignore a Payload row ID
 * only where the corresponding submitted native block/gallery row omitted it.
 */
export function canonicalCreationEditable(submittedRaw: unknown, persistedRaw: unknown): string {
  const submitted = extractNativeEditable(submittedRaw)
  const persisted = extractNativeEditable(persistedRaw)
  const submittedBody = submitted.body as unknown as Array<Record<string, unknown>>
  const persistedBody = persisted.body as unknown as Array<Record<string, unknown>>
  const body = persistedBody.map((rawBlock, index) => {
    const block = { ...rawBlock }
    const submittedBlock = submittedBody[index]
    if (submittedBlock && !Object.hasOwn(submittedBlock, 'id')) delete block.id
    if (block.blockType === 'gallery' && submittedBlock?.blockType === 'gallery' &&
      Array.isArray(block.images) && Array.isArray(submittedBlock.images)) {
      const images = block.images as Array<Record<string, unknown>>
      const submittedImages = submittedBlock.images as Array<Record<string, unknown>>
      block.images = images.map((rawImage, imageIndex) => {
        const image = { ...rawImage }
        const submittedImage = submittedImages[imageIndex]
        if (submittedImage && !Object.hasOwn(submittedImage, 'id')) delete image.id
        return image
      })
    }
    return block
  })
  return canonicalNativeEditable({ ...persisted, body })
}

export async function creationEquivalenceHash(submittedRaw: unknown, persistedRaw: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCreationEditable(submittedRaw, persistedRaw))
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function editableHash(raw: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalNativeEditable(raw))
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
