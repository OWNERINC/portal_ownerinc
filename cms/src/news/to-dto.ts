import type { LegacyBlock, NewsDTO, NewsEditorial, RichBlock } from '../contracts/news'
import { invalid, record, uuid } from './primitives'
import { normalizeNewsContent, normalizeNewsDocument, richText } from './validation'

export function newsText(blocks: (LegacyBlock | RichBlock)[]): string {
  return normalizeNewsContent(blocks).flatMap(block => {
    if (block.type === 'rich_text') return richText((block as RichBlock).nodes)
    if (block.type === 'list' && 'items' in block) return block.items as string[]
    if (['heading', 'paragraph', 'quote', 'profile', 'callout'].includes(String(block.type)) && 'text' in block) return typeof block.text === 'string' ? block.text : ''
    return []
  }).join(' ').trim()
}
export function estimateNewsMinutes(blocks: Parameters<typeof newsText>[0], editorial: NewsEditorial): number | null {
  if (editorial?.kind === 'edition' || (editorial === null && blocks.some(block => block.type === 'pdf'))) return null
  const words = newsText(blocks).trim().split(/\s+/u).filter(Boolean).length
  return words ? Math.ceil(words / 200) : null
}
export function toNewsDTO(document: unknown, { preview }: { preview: boolean }): NewsDTO {
  const d = record(document)
  const { title, category, editorial, blocks } = normalizeNewsDocument(d, !preview)
  const publishedAt = d.publishedAt ?? null
  if (publishedAt !== null && (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt)))) invalid()
  return { id: uuid(d.id), title, category, published_at: publishedAt, editorial,
    content_version: 2, asset_scope: preview ? 'owner-news-preview' : 'owner-news', content_blocks: blocks,
    read_time_minutes: estimateNewsMinutes(blocks, editorial) }
}
