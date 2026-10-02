import type { Inline, Mark, RichNode } from '../contracts/news'
import { bytes, httpsURL, invalid, keys, record } from './primitives'

const error = 'invalid_rich_text'
export type RichBudget = { nodes: number }
export const richBudget = (): RichBudget => ({ nodes: 0 })
export function countNode(budget: RichBudget) {
  if (++budget.nodes > 10000) invalid(error)
}
const elementKeys = ['type', 'version', 'children', 'direction', 'format', 'indent', 'textFormat', 'textStyle']
const formats: [number, Mark][] = [[1, 'bold'], [2, 'italic'], [8, 'underline'], [16, 'code']]

function node(value: unknown, allowed: string[], budget: RichBudget, version = 1) {
  countNode(budget)
  const n = record(value, error)
  keys(n, allowed, error)
  if (n.version !== version) invalid(error)
  return n
}
function marks(value: unknown): Mark[] {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0 || value > 27 || (value & ~27) !== 0) invalid(error)
  return formats.filter(([bit]) => (value & bit) !== 0).map(([, mark]) => mark)
}
function element(n: Record<string, unknown>) {
  if (!Array.isArray(n.children) || (n.direction != null && n.direction !== 'ltr') ||
    (n.indent !== undefined && n.indent !== 0) ||
    (n.format !== undefined && n.format !== '' && n.format !== 0) ||
    (n.textStyle !== undefined && n.textStyle !== '')) invalid(error)
  if (n.textFormat !== undefined) marks(n.textFormat)
  return n.children
}
function inlines(values: unknown[], budget: RichBudget, depth = 1, inLink = false): Inline[] {
  if (depth > 4) invalid(error)
  return values.map(value => {
    const type = record(value, error).type
    switch (type) {
      case 'text': {
        const n = node(value, ['type', 'version', 'text', 'format', 'mode', 'style', 'detail'], budget)
        if (typeof n.text !== 'string' || (n.style !== undefined && n.style !== '') ||
          (n.mode !== undefined && n.mode !== 'normal') || (n.detail !== undefined && n.detail !== 0)) invalid(error)
        return { type: 'text', text: n.text, marks: marks(n.format ?? 0) }
      }
      case 'linebreak':
        node(value, ['type', 'version'], budget)
        return { type: 'break' }
      case 'link': {
        // Payload 3.90.2 LinkNode exports version 3 (not core Lexical's v1 URL shape).
        const n = node(value, [...elementKeys, 'fields', 'id'], budget, 3)
        if (inLink || (n.id !== undefined && typeof n.id !== 'string')) invalid(error)
        const fields = record(n.fields, error)
        keys(fields, ['url', 'newTab', 'linkType', 'doc'], error)
        if (fields.linkType !== 'custom' || fields.doc != null || typeof fields.newTab !== 'boolean') invalid(error)
        return { type: 'link', url: httpsURL(fields.url, error), new_tab: fields.newTab,
          children: inlines(element(n), budget, depth + 1, true) }
      }
      default: invalid(error)
    }
  })
}

/** Only the configured Payload Lexical dialect crosses this boundary. No HTML conversion. */
export function lexicalToRich(value: unknown, budget = richBudget()): RichNode[] {
  const document = record(value, error)
  keys(document, ['root'], error)
  const root = node(document.root, elementKeys, budget)
  if (root.type !== 'root') invalid(error)
  const result: RichNode[] = element(root).map(value => {
    const type = record(value, error).type
    switch (type) {
      case 'paragraph': {
        const n = node(value, elementKeys, budget)
        return { type: 'paragraph', children: inlines(element(n), budget) }
      }
      case 'heading': {
        const n = node(value, [...elementKeys, 'tag'], budget)
        if (typeof n.tag !== 'string' || !/^h[1-6]$/u.test(n.tag)) invalid(error)
        const level = Math.max(2, Number(n.tag.slice(1))) as 2 | 3 | 4 | 5 | 6
        return { type: 'heading', level, children: inlines(element(n), budget) }
      }
      case 'list': {
        const n = node(value, [...elementKeys, 'listType', 'start', 'tag'], budget)
        if (!['number', 'bullet'].includes(String(n.listType)) ||
          n.tag !== (n.listType === 'number' ? 'ol' : 'ul') || (n.start !== undefined && n.start !== 1)) invalid(error)
        return { type: 'list', ordered: n.listType === 'number', items: element(n).map(value => {
          const item = node(value, [...elementKeys, 'value', 'checked'], budget)
          if (item.type !== 'listitem' || item.checked != null ||
            (item.value !== undefined && (!Number.isInteger(item.value) || Number(item.value) < 1))) invalid(error)
          return inlines(element(item), budget)
        }) }
      }
      default: invalid(error)
    }
  })
  bytes(result)
  return result
}

/** Validate already-projected v2 input with the same node/depth budget. */
export function normalizeRichNodes(value: unknown, budget = richBudget()): RichNode[] {
  if (!Array.isArray(value)) invalid(error)
  function inline(value: unknown, depth = 1, inLink = false): Inline {
    if (depth > 4) invalid(error)
    countNode(budget)
    const n = record(value, error)
    switch (n.type) {
      case 'text':
        keys(n, ['type', 'text', 'marks'], error)
        if (typeof n.text !== 'string' || !Array.isArray(n.marks) || new Set(n.marks).size !== n.marks.length ||
          n.marks.some(m => !formats.some(([, mark]) => mark === m))) invalid(error)
        return { type: 'text', text: n.text, marks: n.marks as Mark[] }
      case 'break':
        keys(n, ['type'], error)
        return { type: 'break' }
      case 'link':
        keys(n, ['type', 'url', 'new_tab', 'children'], error)
        if (inLink || !Array.isArray(n.children) || typeof n.new_tab !== 'boolean') invalid(error)
        return { type: 'link', url: httpsURL(n.url, error), new_tab: n.new_tab,
          children: n.children.map(child => inline(child, depth + 1, true)) }
      default: invalid(error)
    }
  }
  return value.map(value => {
    countNode(budget)
    const n = record(value, error)
    if (n.type === 'list') {
      keys(n, ['type', 'ordered', 'items'], error)
      if (typeof n.ordered !== 'boolean' || !Array.isArray(n.items)) invalid(error)
      return { type: 'list', ordered: n.ordered, items: n.items.map(items => {
        countNode(budget)
        if (!Array.isArray(items)) invalid(error)
        return items.map(item => inline(item))
      }) }
    }
    keys(n, n.type === 'heading' ? ['type', 'level', 'children'] : ['type', 'children'], error)
    if (!Array.isArray(n.children)) invalid(error)
    const children = n.children.map(child => inline(child))
    if (n.type === 'paragraph') return { type: 'paragraph', children }
    if (n.type === 'heading' && [2, 3, 4, 5, 6].includes(Number(n.level)) && typeof n.level === 'number') {
      return { type: 'heading', level: n.level as 2 | 3 | 4 | 5 | 6, children }
    }
    invalid(error)
  })
}
