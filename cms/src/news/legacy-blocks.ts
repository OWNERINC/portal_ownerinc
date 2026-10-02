import type { Block, Field } from 'payload'
import type { LegacyBlock } from '../contracts/news'
import { boolean, bytes, httpsURL, invalid, keys, layouts, oneOf, plain, record, typographies, uuid } from './primitives'

const typeFields: Record<string, string[]> = {
  heading: ['text', 'level'], paragraph: ['text'], list: ['items', 'ordered'],
  callout: ['tone', 'title', 'text'], quote: ['text', 'attribution'],
  profile: ['name', 'role', 'text', 'asset_id', 'alt'], image: ['asset_id', 'alt', 'caption', 'credit', 'usage'],
  divider: [], link: ['label', 'url', 'new_tab'], pdf: ['asset_id', 'title', 'usage'], video: ['asset_id', 'url', 'title'],
}
const typographyTypes = ['paragraph', 'list', 'callout', 'quote', 'profile']

/** Aligned with api/cms/blocks.js; video additionally requires exactly one source property. */
export function normalizeLegacyBlock(value: unknown): LegacyBlock {
  return normalizeBlockShape(value, false)
}

// Only the native draft-storage path may omit unfinished values. The public legacy
// normalizer and import/reading projections always require complete block shapes.
function normalizeBlockShape(value: unknown, incomplete: boolean): LegacyBlock {
  const b = record(value)
  const type = typeof b.type === 'string' ? b.type : ''
  if (!Object.hasOwn(typeFields, type)) invalid()
  keys(b, ['type', ...typeFields[type], 'layout', ...(typographyTypes.includes(type) ? ['typography'] : [])])
  const out: LegacyBlock = { type }
  const text = (name: string, max: number, multiline = false, optional = false) => {
    if ((optional || incomplete) && !Object.hasOwn(b, name)) return
    if (incomplete && typeof b[name] === 'string' && b[name].length > max) invalid()
    out[name] = plain(b[name], max, !incomplete, multiline)
  }
  const asset = () => { if (!incomplete || Object.hasOwn(b, 'asset_id')) out.asset_id = uuid(b.asset_id) }
  switch (type) {
    case 'heading':
      text('text', 200)
      out.level = b.level === undefined ? 2 : b.level
      if (!Number.isInteger(out.level) || Number(out.level) < 1 || Number(out.level) > 6) invalid()
      break
    case 'paragraph': text('text', 5000, true); break
    case 'list': {
      const items = incomplete && !Object.hasOwn(b, 'items') ? [] : b.items
      if (!Array.isArray(items) || (!incomplete && !items.length) || items.length > 100) invalid()
      out.items = items.map(item => {
        if (incomplete && item == null) return ''
        if (incomplete && typeof item === 'string' && item.length > 500) invalid()
        return plain(item, 500, !incomplete, false)
      })
      out.ordered = b.ordered === undefined ? false : boolean(b.ordered)
      break
    }
    case 'callout':
      out.tone = b.tone === undefined ? 'info' : oneOf(b.tone, ['info', 'warning', 'success'])
      text('title', 200, false, true); text('text', 2000, true)
      break
    case 'quote': text('text', 5000, true); text('attribution', 200, false, true); break
    case 'profile':
      text('name', 200); text('role', 200, false, true); text('text', 5000, true, true)
      if (Object.hasOwn(b, 'asset_id')) { out.asset_id = uuid(b.asset_id); text('alt', 300) }
      else if (incomplete) text('alt', 300, false, true)
      else if (Object.hasOwn(b, 'alt')) invalid()
      break
    case 'image':
      asset(); text('alt', 300)
      text('caption', 1000, true, true); text('credit', 300, true, true)
      if (Object.hasOwn(b, 'usage')) out.usage = oneOf(b.usage, ['cover', 'body'])
      break
    case 'divider': break
    case 'link':
      text('label', 200)
      if (!incomplete || Object.hasOwn(b, 'url')) out.url = httpsURL(b.url)
      out.new_tab = b.new_tab === undefined ? false : boolean(b.new_tab)
      break
    case 'pdf':
      asset(); text('title', 200)
      if (Object.hasOwn(b, 'usage')) out.usage = oneOf(b.usage, ['edition', 'attachment'])
      break
    case 'video':
      if ((Object.hasOwn(b, 'asset_id') && Object.hasOwn(b, 'url')) ||
        (!incomplete && !Object.hasOwn(b, 'asset_id') && !Object.hasOwn(b, 'url'))) invalid()
      if (Object.hasOwn(b, 'asset_id')) out.asset_id = uuid(b.asset_id)
      else if (Object.hasOwn(b, 'url')) out.url = httpsURL(b.url)
      text('title', 200, false, true)
      break
    default: invalid()
  }
  if (Object.hasOwn(b, 'layout')) out.layout = oneOf(b.layout, layouts)
  if (Object.hasOwn(b, 'typography')) out.typography = oneOf(b.typography, typographies)
  return out
}

/** Import to real native Blocks, never opaque legacy JSON or flattened Lexical. */
export function legacyToPayloadBlocks(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 100) invalid()
  const normalized = value.map(normalizeLegacyBlock)
  // The cap belongs to the reading boundary, not the expanded native list rows.
  // normalizeNewsDocument also counts editorial metadata in the aggregate limit.
  bytes(normalized)
  return normalized.map(({ type, asset_id, new_tab, items, ...rest }) => {
    return { blockType: type, ...rest,
      ...(asset_id === undefined ? {} : { media: asset_id }),
      ...(new_tab === undefined ? {} : { newTab: new_tab }),
      ...(items === undefined ? {} : { items: (items as string[]).map(text => ({ text })) }),
    }
  })
}

// Native optional fields serialize as null/empty after DB/UI hydration. Only declared
// optional fields are omitted here; the legacy JSON boundary remains strictly validated.
const optionalFields: Record<string, string[]> = {
  heading: [], paragraph: [], list: [], callout: ['title'], quote: ['attribution'],
  profile: ['role', 'text', 'media', 'alt'], image: ['caption', 'credit', 'usage'],
  divider: [], link: [], pdf: ['usage'], video: ['media', 'url', 'title'],
}
export function payloadToLegacyBlock(value: unknown): LegacyBlock {
  return normalizeBlockShape(payloadBlockData(value, false), false)
}

/** Validation/budget projection only: never persist this incomplete boundary shape. */
export function projectNativeDraftBlock(value: unknown): LegacyBlock {
  return normalizeBlockShape(payloadBlockData(value, true), true)
}

export function validateNativeRowMetadata(row: Record<string, unknown>) {
  for (const name of ['id', 'blockName']) {
    const value = row[name]
    if (value == null) continue
    if (typeof value !== 'string' || value.length > 200) invalid()
    plain(value, 200, false, false)
  }
}

function payloadBlockData(value: unknown, incomplete: boolean): LegacyBlock {
  const b = record(value)
  const type = typeof b.blockType === 'string' ? b.blockType : ''
  if (!Object.hasOwn(typeFields, type)) invalid()
  const fieldNames = typeFields[type].map(key => key === 'asset_id' ? 'media' : key === 'new_tab' ? 'newTab' : key)
  keys(b, ['blockType', 'id', 'blockName', ...fieldNames, 'layout', ...(typographyTypes.includes(type) ? ['typography'] : [])])
  if (incomplete) validateNativeRowMetadata(b)
  const out: LegacyBlock = { type }
  for (const name of [...fieldNames, 'layout', ...(typographyTypes.includes(type) ? ['typography'] : [])]) {
    if (!Object.hasOwn(b, name)) continue
    const value = b[name]
    if ([...optionalFields[type], 'layout', 'typography'].includes(name) && (value == null || value === '')) continue
    if (incomplete && (value == null || (value === '' && ['media', 'url', 'level', 'tone', 'ordered', 'newTab'].includes(name)))) continue
    if (name === 'media') out.asset_id = uuid(typeof value === 'object' && value !== null ? record(value).id : value)
    else if (name === 'newTab') out.new_tab = value
    else if (name === 'items') {
      if (!Array.isArray(value)) invalid()
      out.items = value.map(value => {
        const row = record(value)
        keys(row, ['id', 'text'])
        if (incomplete) validateNativeRowMetadata(row)
        return row.text
      })
    } else out[name] = value
  }
  return out
}

export function legacyTextBlocks(layout: Field, typography: Field): Block[] {
  return [
    { slug: 'heading', labels: { singular: 'Legacy heading', plural: 'Legacy headings' }, fields: [
      { name: 'text', type: 'text', maxLength: 200 }, { name: 'level', type: 'number', min: 1, max: 6, defaultValue: 2 }, layout,
    ] },
    { slug: 'paragraph', labels: { singular: 'Legacy paragraph', plural: 'Legacy paragraphs' }, fields: [
      { name: 'text', type: 'textarea', maxLength: 5000 }, layout, typography,
    ] },
    { slug: 'list', labels: { singular: 'Legacy list', plural: 'Legacy lists' }, fields: [
      { name: 'items', type: 'array', maxRows: 100, fields: [{ name: 'text', type: 'text', maxLength: 500 }] },
      { name: 'ordered', type: 'checkbox', defaultValue: false }, layout, typography,
    ] },
  ]
}
