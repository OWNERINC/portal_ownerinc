import type {
  PortalPageBlock,
  PortalPageGalleryImage,
  PortalPageLayout,
} from './blocks'
import type { PortalPageDTO, PortalPagePublicationInput } from './contracts'
import { normalizePortalRichNodes, type PortalPageRichNodeBudget } from './rich-text'
import {
  array,
  boolean,
  httpsURL,
  invalid,
  keys,
  MAX_PORTAL_PAGE_CONTENT_BYTES,
  oneOf,
  plainText,
  PORTAL_PAGE_LAYOUTS,
  record,
  utf8Bytes,
  uuid,
} from './primitives'

const INVALID_SLUG = 'invalid_portal_page_slug'
const INVALID_DTO = 'invalid_portal_page_dto'
const INVALID_PUBLICATION = 'invalid_portal_page_publication'
const contentKeys = ['type', 'layout'] as const

export function normalizeSlug(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length > 200) invalid(INVALID_SLUG)
  const source = plainText(value, { min: 1, max: 200, code: INVALID_SLUG })
  const slug = source.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (slug.length < 1 || slug.length > 160 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) invalid(INVALID_SLUG)
  return slug
}

function layout(value: Record<string, unknown>): PortalPageLayout | undefined {
  return Object.hasOwn(value, 'layout') ? oneOf(value.layout, PORTAL_PAGE_LAYOUTS) : undefined
}

function withLayout<T extends { type: PortalPageBlock['type'] }>(block: T, value: PortalPageLayout | undefined): T | (T & { layout: PortalPageLayout }) {
  return value === undefined ? block : { ...block, layout: value }
}

function normalizeEmbedURL(
  provider: 'youtube' | 'vimeo',
  value: unknown,
  allowCanonicalVimeo: boolean,
): string {
  const code = 'invalid_portal_page_embed'
  if (typeof value !== 'string') invalid(code)
  const raw = value.trim()
  if (/[\p{Cc}\s\\]/u.test(raw)) invalid(code)
  const source = /^https:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/iu.exec(raw)
  if (!source || raw.includes('#')) invalid(code)
  const authority = source[1]
  const rawPath = source[2] || '/'
  const query = source[3]
  if (authority.includes('@') || authority.includes(':')) invalid(code)

  let parsed: URL
  try { parsed = new URL(raw) } catch { invalid(code) }
  const hostname = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== rawPath) invalid(code)

  if (provider === 'youtube') {
    if (query === undefined) {
      if (hostname === 'youtu.be') {
        const match = /^\/([A-Za-z0-9_-]{11})$/u.exec(rawPath)
        if (match) return `https://www.youtube.com/embed/${match[1]}`
      } else if (hostname === 'youtube.com' || hostname === 'www.youtube.com') {
        const pathID = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/u.exec(rawPath)
        if (pathID) return `https://www.youtube.com/embed/${pathID[1]}`
      }
    } else if ((hostname === 'youtube.com' || hostname === 'www.youtube.com') && rawPath === '/watch') {
      const match = /^v=([A-Za-z0-9_-]{11})$/u.exec(query)
      if (match && parsed.searchParams.size === 1 && parsed.searchParams.get('v') === match[1]) {
        return `https://www.youtube.com/embed/${match[1]}`
      }
    }
    invalid(code)
  }

  // The player host is accepted only when validating our own normalized public DTO projection.
  if (allowCanonicalVimeo && hostname === 'player.vimeo.com' && query === undefined && rawPath === parsed.pathname) {
    const canonical = /^\/video\/([1-9][0-9]*)$/u.exec(rawPath)
    if (canonical) return `https://player.vimeo.com/video/${canonical[1]}`
  }
  if ((hostname === 'vimeo.com' || hostname === 'www.vimeo.com') && query === undefined) {
    const match = /^\/([1-9][0-9]*)$/u.exec(rawPath)
    if (match) return `https://player.vimeo.com/video/${match[1]}`
  }
  invalid(code)
}

function normalizeGalleryImage(value: unknown): PortalPageGalleryImage {
  const image = record(value)
  keys(image, ['asset_id', 'alt', 'caption'])
  const result: PortalPageGalleryImage = { asset_id: uuid(image.asset_id),
    alt: plainText(image.alt, { min: 1, max: 300 }) }
  if (Object.hasOwn(image, 'caption')) result.caption = plainText(image.caption, { max: 1000, multiline: true })
  return result
}

function normalizeBlock(value: unknown, budget: PortalPageRichNodeBudget, allowCanonicalVimeo: boolean): PortalPageBlock {
  const block = record(value)
  const type = block.type
  const blockLayout = layout(block)
  switch (type) {
    case 'heading': {
      keys(block, [...contentKeys, 'text', 'level'])
      if (!Number.isInteger(block.level) || ![2, 3, 4].includes(Number(block.level))) invalid()
      return withLayout({ type, text: plainText(block.text, { min: 1, max: 200 }),
        level: block.level as 2 | 3 | 4 }, blockLayout)
    }
    case 'rich_text': {
      keys(block, [...contentKeys, 'nodes'])
      return withLayout({ type, nodes: normalizePortalRichNodes(block.nodes, budget) }, blockLayout)
    }
    case 'image': {
      keys(block, [...contentKeys, 'asset_id', 'alt', 'caption'])
      const result: Extract<PortalPageBlock, { type: 'image' }> = { type, asset_id: uuid(block.asset_id),
        alt: plainText(block.alt, { min: 1, max: 300 }) }
      if (Object.hasOwn(block, 'caption')) result.caption = plainText(block.caption, { max: 1000, multiline: true })
      return withLayout(result, blockLayout)
    }
    case 'gallery': {
      keys(block, [...contentKeys, 'images'])
      const images = array(block.images)
      if (images.length < 2 || images.length > 20) invalid()
      return withLayout({ type, images: images.map(normalizeGalleryImage) }, blockLayout)
    }
    case 'video':
    case 'pdf': {
      keys(block, [...contentKeys, 'asset_id', 'title'])
      return withLayout({ type, asset_id: uuid(block.asset_id), title: plainText(block.title, { min: 1, max: 200 }) }, blockLayout)
    }
    case 'embed': {
      keys(block, [...contentKeys, 'provider', 'url', 'title'])
      const provider = oneOf(block.provider, ['youtube', 'vimeo'] as const)
      return withLayout({ type, provider, url: normalizeEmbedURL(provider, block.url, allowCanonicalVimeo),
        title: plainText(block.title, { min: 1, max: 200 }) }, blockLayout)
    }
    case 'callout': {
      keys(block, [...contentKeys, 'tone', 'title', 'text'])
      const result: Extract<PortalPageBlock, { type: 'callout' }> = { type,
        tone: oneOf(block.tone, ['info', 'warning', 'success'] as const),
        text: plainText(block.text, { min: 1, max: 2000, multiline: true }) }
      if (Object.hasOwn(block, 'title')) result.title = plainText(block.title, { max: 200 })
      return withLayout(result, blockLayout)
    }
    case 'link': {
      keys(block, [...contentKeys, 'label', 'url', 'new_tab', 'style'])
      return withLayout({ type, label: plainText(block.label, { min: 1, max: 200 }),
        url: httpsURL(block.url), new_tab: boolean(block.new_tab),
        style: oneOf(block.style, ['primary', 'secondary'] as const) }, blockLayout)
    }
    case 'divider':
      keys(block, contentKeys)
      return withLayout({ type }, blockLayout)
    default:
      invalid()
  }
}

function normalizeContent(value: unknown, allowCanonicalVimeo = false): PortalPageBlock[] {
  const source = array(value)
  if (source.length > 100) invalid()
  const budget: PortalPageRichNodeBudget = { nodes: 0 }
  const blocks = source.map(block => normalizeBlock(block, budget, allowCanonicalVimeo))
  if (utf8Bytes(blocks) > MAX_PORTAL_PAGE_CONTENT_BYTES) invalid('portal_page_content_too_large')
  return blocks
}

/** Public content-block DTO normalization. Native Payload storage is projected in Task 2. */
export function normalizePortalPageContent(value: unknown): PortalPageBlock[] {
  return normalizeContent(value)
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') invalid(INVALID_DTO)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (!match) invalid(INVALID_DTO)
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6])
  const offset = match[8]
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
    hour > 23 || minute > 59 || second > 59 || (offset !== 'Z' &&
      (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))) invalid(INVALID_DTO)
  const time = Date.parse(value)
  if (!Number.isFinite(time)) invalid(INVALID_DTO)
  return new Date(time).toISOString()
}

function normalizeCategory(value: unknown): PortalPageDTO['categories'][number] {
  const category = record(value, INVALID_DTO)
  keys(category, ['id', 'slug', 'name'], INVALID_DTO)
  return { id: uuid(category.id, INVALID_DTO), slug: normalizeSlug(category.slug),
    name: plainText(category.name, { min: 1, code: INVALID_DTO }) }
}

/** Strict public projection; this intentionally does not consume native Payload documents. */
export function validatePortalPageDTO(value: unknown): PortalPageDTO {
  const page = record(value, INVALID_DTO)
  keys(page, ['id', 'slug', 'title', 'summary', 'cover', 'categories', 'published_at',
    'content_version', 'asset_scope', 'content_blocks', 'revision'], INVALID_DTO)
  const categories = array(page.categories, INVALID_DTO)
  if (page.content_version !== 1 || categories.length > 20) invalid(INVALID_DTO)

  let cover: PortalPageDTO['cover'] = null
  if (page.cover !== null) {
    const source = record(page.cover, INVALID_DTO)
    keys(source, ['asset_id', 'alt'], INVALID_DTO)
    cover = { asset_id: uuid(source.asset_id, INVALID_DTO), alt: plainText(source.alt, { min: 1, max: 300, code: INVALID_DTO }) }
  }

  const assetScope = oneOf(page.asset_scope, ['portal-pages', 'portal-pages-preview'] as const, INVALID_DTO)
  const revisionValue = record(page.revision, INVALID_DTO)
  keys(revisionValue, ['id', 'status'], INVALID_DTO)
  const status = assetScope === 'portal-pages'
    ? oneOf(revisionValue.status, ['published'] as const, INVALID_DTO)
    : oneOf(revisionValue.status, ['draft', 'published'] as const, INVALID_DTO)

  return {
    id: uuid(page.id, INVALID_DTO),
    slug: normalizeSlug(page.slug),
    title: plainText(page.title, { min: 1, max: 200, code: INVALID_DTO }),
    summary: plainText(page.summary, { max: 1000, multiline: true, code: INVALID_DTO }),
    cover,
    categories: categories.map(normalizeCategory),
    published_at: normalizeTimestamp(page.published_at),
    content_version: 1,
    asset_scope: assetScope,
    content_blocks: normalizeContent(page.content_blocks, true),
    revision: { id: uuid(revisionValue.id, INVALID_DTO), status },
  }
}

export function validatePortalPagePublicationInput(value: unknown): PortalPagePublicationInput {
  const input = record(value, INVALID_PUBLICATION)
  keys(input, ['id', 'expected_version_id', 'operation'], INVALID_PUBLICATION)
  return {
    id: uuid(input.id, INVALID_PUBLICATION),
    expected_version_id: uuid(input.expected_version_id, INVALID_PUBLICATION),
    operation: oneOf(input.operation, ['publish', 'unpublish'] as const, INVALID_PUBLICATION),
  }
}
