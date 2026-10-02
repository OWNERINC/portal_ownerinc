import type { CollectionBeforeChangeHook, GlobalBeforeChangeHook } from 'payload'
import type { HomeContent, Inline, LegacyBlock, NewsEditorial, RichBlock, RichNode } from '../contracts/news'
import { countNode, lexicalToRich, normalizeRichNodes, richBudget } from './lexical-to-rich'
import { normalizeLegacyBlock, payloadToLegacyBlock, projectNativeDraftBlock, validateNativeRowMetadata } from './legacy-blocks'
import { bytes, imageMimes, invalid, keys, layouts, oneOf, plain, record, typographies, uuid, videoMimes } from './primitives'

export function normalizeEditorial(value: unknown): NewsEditorial {
  if (value === null) return null
  const e = record(value)
  keys(e, ['version', 'kind', 'summary', 'author', 'source_label', 'source_date'])
  if (e.version !== 1) invalid()
  // Legacy editorial metadata rejects line breaks before trimming, unlike block text.
  for (const name of ['author', 'source_label']) {
    if (typeof e[name] !== 'string' || /[\r\n]/u.test(e[name])) invalid()
  }
  const date = e.source_date
  if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) invalid('invalid_source_date')
  return { version: 1, kind: oneOf(e.kind, ['article', 'edition']), summary: plain(e.summary, 1000, false),
    author: plain(e.author, 200, false, false), source_label: plain(e.source_label, 200, false, false), source_date: date }
}

export function normalizeNewsContent(value: unknown): (LegacyBlock | RichBlock)[] {
  return projectContent(value, false)
}

// Incomplete native projections are solely for storage validation and budgeting.
// DTO/publication/legacy entry points never opt into this path.
function projectContent(value: unknown, nativeDraft: boolean): (LegacyBlock | RichBlock)[] {
  if (!Array.isArray(value) || value.length > 100) invalid()
  const budget = richBudget()
  const blocks = value.map(value => {
    countNode(budget)
    const b = record(value)
    if (b.blockType === 'richText' || b.type === 'rich_text') {
      const native = b.blockType === 'richText'
      keys(b, native ? ['blockType', 'id', 'blockName', 'content', 'layout', 'typography'] : ['type', 'nodes', 'layout', 'typography'])
      if (native && nativeDraft) validateNativeRowMetadata(b)
      const result: RichBlock = { type: 'rich_text', nodes: native
        ? (nativeDraft && b.content == null ? [] : lexicalToRich(b.content, budget))
        : normalizeRichNodes(b.nodes, budget) }
      if (Object.hasOwn(b, 'layout') && !(native && (b.layout == null || b.layout === ''))) result.layout = oneOf(b.layout, layouts)
      if (Object.hasOwn(b, 'typography') && !(native && (b.typography == null || b.typography === ''))) result.typography = oneOf(b.typography, typographies)
      return result
    }
    return Object.hasOwn(b, 'blockType')
      ? (nativeDraft ? projectNativeDraftBlock(b) : payloadToLegacyBlock(b)) : normalizeLegacyBlock(b)
  })
  bytes(blocks)
  return blocks
}

export function inlineText(nodes: Inline[]): string {
  return nodes.map(node => node.type === 'text' ? node.text : node.type === 'break' ? '\n' : inlineText(node.children)).join('')
}
export function richText(nodes: RichNode[]): string {
  return nodes.map(node => node.type === 'list' ? node.items.map(inlineText).join(' ') : inlineText(node.children)).join(' ')
}
function meaningfulBody(block: LegacyBlock | RichBlock): boolean {
  if (block.type === 'rich_text') return (block as RichBlock).nodes.some(node =>
    node.type !== 'heading' && Boolean(richText([node]).trim()))
  if (block.type === 'list' && 'items' in block) return (block.items as string[]).some(text => Boolean(text.trim()))
  return ['paragraph', 'quote', 'profile'].includes(String(block.type)) && 'text' in block && typeof block.text === 'string' && Boolean(block.text.trim())
}

export function normalizeNewsDocument(value: unknown, publishing = false) {
  return checkNewsDocument(value, publishing, false)
}

/** Accept safe unfinished native form fields without rewriting or returning a DTO. */
export function validateNewsDraftStorage(document: unknown): void {
  checkNewsDocument(document, false, true)
}

function checkNewsDocument(value: unknown, publishing: boolean, nativeDraft: boolean) {
  const d = record(value)
  const title = plain(d.title, 200, publishing, false)
  const category = plain(d.category, 100, false, false)
  const editorial = normalizeEditorial(d.editorial)
  const blocks = projectContent(d.body, nativeDraft)
  if (blocks.filter(b => b.type === 'image' && 'usage' in b && b.usage === 'cover').length > 1 ||
    blocks.filter(b => b.type === 'pdf' && 'usage' in b && b.usage === 'edition').length > 1) invalid('duplicate_news_usage')
  if (publishing && editorial?.kind === 'article' && (!editorial.summary || !blocks.some(meaningfulBody))) invalid('article_requires_summary_and_body')
  if (publishing && editorial?.kind === 'edition' && !blocks.some(b => b.type === 'pdf')) invalid('edition_requires_pdf')
  bytes({ blocks, editorial })
  return { title, category, editorial, blocks }
}
export function validateNewsPublication(document: unknown): void {
  normalizeNewsDocument(document, true)
}

/** Pure metadata-shape check, NOT proof of asset existence, bytes, or storage access (Task 5). */
export function validateNewsMediaShapes(blocks: unknown, media: unknown): void {
  if (!Array.isArray(media)) invalid('invalid_media_reference')
  const byID = new Map(media.map(value => { const shape = record(value); return [uuid(shape.id), shape] }))
  for (const block of normalizeNewsContent(blocks)) {
    if (!('asset_id' in block) || typeof block.asset_id !== 'string') continue
    const shape = byID.get(block.asset_id)
    const allowed = block.type === 'pdf' ? ['application/pdf'] : block.type === 'video' ? videoMimes : imageMimes
    if (!shape || typeof shape.mimeType !== 'string' || !allowed.includes(shape.mimeType) ||
      typeof shape.filesize !== 'number' || !Number.isSafeInteger(shape.filesize) || shape.filesize <= 0 ||
      shape.filesize > 50 * 1024 * 1024) invalid('invalid_media_reference')
  }
}

/** Payload data is Partial. Arrays replace; editorial is atomic JSON, including explicit null. */
export function effectiveNewsDocument(data: Record<string, unknown>, originalDoc?: Record<string, unknown>) {
  return { ...originalDoc, ...data }
}
// Server-only capability for the later importer. A JSON request cannot provide a
// symbol key; preserving imported null must not let a new native article opt out.
const legacyImport = Symbol('owner-news-legacy-import')
export const legacyNewsImportContext = Object.freeze({ [legacyImport]: true })
export const validateNewsBeforeChange: CollectionBeforeChangeHook = ({ data, originalDoc, operation, context }) => {
  const full = effectiveNewsDocument(data, originalDoc)
  if (operation === 'create' && full.editorial === null &&
    Object.getOwnPropertyDescriptor(context ?? {}, legacyImport)?.value !== true) invalid('new_article_requires_editorial')
  // Null is an imported legacy state, not an escape hatch from native publication rules.
  if (originalDoc?.editorial != null && full.editorial === null) invalid('cannot_clear_news_editorial')
  if (full._status === 'draft' && Object.getOwnPropertyDescriptor(context ?? {}, legacyImport)?.value !== true) {
    validateNewsDraftStorage(full)
  } else normalizeNewsDocument(full, full._status === 'published')
  return data
}

export function normalizeNewsHome(value: unknown, publishing = false): HomeContent {
  const d = record(value)
  const homeText = (name: string, max: number, multiline = false) => {
    const value = d[name]
    // Match the existing home contract's raw length and headline-only line breaks.
    if (typeof value !== 'string' || value.length > max || (!multiline && /[\r\n]/u.test(value))) invalid()
    return plain(value, max, publishing, multiline)
  }
  return { version: 1, eyebrow: homeText('eyebrow', 80), headline: homeText('headline', 160, true),
    summary: homeText('summary', 600) }
}
export const validateNewsHomeBeforeChange: GlobalBeforeChangeHook = ({ data, originalDoc }) => {
  const full = effectiveNewsDocument(data, originalDoc)
  normalizeNewsHome(full, full._status === 'published')
  return data
}
