import type { PortalPageBlock, PortalPageInline, PortalPageRichNode } from './blocks'
import { array, invalid, record } from './primitives'
import { normalizePortalPageContent } from './validation'

const allowedLexicalTextFormat = 1 | 2 | 8 | 16

function lexicalDocument(value: unknown): Record<string, unknown> {
  let input = value
  if (typeof input === 'string') {
    try { input = JSON.parse(input) as unknown } catch { invalid('invalid_portal_page_rich_text') }
  }
  const document = record(input, 'invalid_portal_page_rich_text')
  const root = Object.hasOwn(document, 'root') ? record(document.root, 'invalid_portal_page_rich_text') : document
  if (root.type !== undefined && root.type !== 'root') invalid('invalid_portal_page_rich_text')
  return root
}

function lexicalInline(value: unknown): Record<string, unknown> {
  const node = record(value, 'invalid_portal_page_rich_text')
  if (node.type === 'text') {
    const format = node.format === undefined ? 0 : node.format
    if (typeof format !== 'number' || !Number.isSafeInteger(format) || format < 0 || (format & ~allowedLexicalTextFormat) !== 0) {
      invalid('invalid_portal_page_rich_text')
    }
    const marks = [
      ...(format & 1 ? ['bold'] : []), ...(format & 2 ? ['italic'] : []),
      ...(format & 8 ? ['underline'] : []), ...(format & 16 ? ['code'] : []),
    ]
    return { type: 'text', text: node.text, marks }
  }
  if (node.type === 'linebreak') return { type: 'break' }
  if (node.type === 'link' || node.type === 'autolink') {
    const fields = record(node.fields, 'invalid_portal_page_rich_text')
    if (fields.linkType !== undefined && fields.linkType !== 'custom') invalid('invalid_portal_page_rich_text')
    const children = array(node.children, 'invalid_portal_page_rich_text').map(lexicalInline)
    if (children.some(child => child.type === 'link')) invalid('invalid_portal_page_rich_text')
    return { type: 'link', url: fields.url, new_tab: fields.newTab === undefined ? false : fields.newTab, children }
  }
  invalid('invalid_portal_page_rich_text')
}

function lexicalBlock(value: unknown): PortalPageRichNode {
  const node = record(value, 'invalid_portal_page_rich_text')
  if (node.type === 'paragraph') {
    return { type: 'paragraph', children: array(node.children, 'invalid_portal_page_rich_text').map(lexicalInline) as PortalPageInline[] }
  }
  if (node.type === 'heading') {
    const match = /^h([2-6])$/u.exec(typeof node.tag === 'string' ? node.tag : '')
    if (!match) invalid('invalid_portal_page_rich_text')
    return { type: 'heading', level: Number(match[1]) as 2 | 3 | 4 | 5 | 6,
      children: array(node.children, 'invalid_portal_page_rich_text').map(lexicalInline) as PortalPageInline[] }
  }
  if (node.type === 'list') {
    if (node.listType !== 'number' && node.listType !== 'bullet') invalid('invalid_portal_page_rich_text')
    const items = array(node.children, 'invalid_portal_page_rich_text').map(item => {
      const listItem = record(item, 'invalid_portal_page_rich_text')
      if (listItem.type !== 'listitem') invalid('invalid_portal_page_rich_text')
      const children = array(listItem.children, 'invalid_portal_page_rich_text').map(lexicalInline)
      if (children.some(child => child.type === 'link' && (child as Record<string, unknown>).children === undefined)) {
        invalid('invalid_portal_page_rich_text')
      }
      return children as PortalPageInline[]
    })
    return { type: 'list', ordered: node.listType === 'number', items }
  }
  invalid('invalid_portal_page_rich_text')
}

function relationID(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  const relation = record(value, `invalid_portal_page_${field}`)
  if (typeof relation.id === 'string' && relation.id.length > 0) return relation.id
  invalid(`invalid_portal_page_${field}`)
}

function block(value: unknown): Record<string, unknown> {
  return record(value, 'invalid_portal_page_content')
}

function optionalLayout(source: Record<string, unknown>, target: Record<string, unknown>) {
  if (Object.hasOwn(source, 'layout') && source.layout !== null && source.layout !== '') target.layout = source.layout
}

/** Project native Payload blocks into the exact public Task 1 discriminator/field contract. */
export function projectPortalPageContent(value: unknown): PortalPageBlock[] {
  const nativeBlocks = array(value, 'invalid_portal_page_content').map(raw => {
    const source = block(raw)
    const projected: Record<string, unknown> = {}
    optionalLayout(source, projected)
    switch (source.blockType) {
      case 'heading':
        Object.assign(projected, { type: 'heading', text: source.text, level: Number(source.level) })
        break
      case 'rich_text':
        Object.assign(projected, { type: 'rich_text', nodes: array(lexicalDocument(source.content).children,
          'invalid_portal_page_rich_text').map(lexicalBlock) })
        break
      case 'image':
        Object.assign(projected, { type: 'image', asset_id: relationID(source.asset, 'media_reference'), alt: source.alt })
        if (Object.hasOwn(source, 'caption')) projected.caption = source.caption
        break
      case 'gallery':
        Object.assign(projected, { type: 'gallery', images: array(source.images).map(rawImage => {
          const image = record(rawImage)
          const result: Record<string, unknown> = { asset_id: relationID(image.asset, 'media_reference'), alt: image.alt }
          if (Object.hasOwn(image, 'caption')) result.caption = image.caption
          return result
        }) })
        break
      case 'video':
        Object.assign(projected, { type: 'video', asset_id: relationID(source.asset, 'media_reference'), title: source.title })
        break
      case 'embed':
        Object.assign(projected, { type: 'embed', provider: source.provider, url: source.url, title: source.title })
        break
      case 'pdf':
        Object.assign(projected, { type: 'pdf', asset_id: relationID(source.asset, 'media_reference'), title: source.title })
        break
      case 'callout':
        Object.assign(projected, { type: 'callout', tone: source.tone, text: source.text })
        if (Object.hasOwn(source, 'title')) projected.title = source.title
        break
      case 'link':
        Object.assign(projected, { type: 'link', label: source.label, url: source.url,
          new_tab: source.newTab ?? false, style: source.style })
        break
      case 'divider':
        projected.type = 'divider'
        break
      default:
        invalid('invalid_portal_page_content')
    }
    return projected
  })
  return normalizePortalPageContent(nativeBlocks)
}
