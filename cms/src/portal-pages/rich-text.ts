import type { PortalPageInline, PortalPageMark, PortalPageRichNode } from './blocks'
import { array, boolean, httpsURL, invalid, keys, oneOf, record, safeRichText } from './primitives'

const INVALID_RICH_TEXT = 'invalid_portal_page_rich_text'
const MAX_RICH_TEXT_NODES = 10_000
const marks = ['bold', 'italic', 'underline', 'code'] as const

export type PortalPageRichNodeBudget = { nodes: number }

function countNode(budget: PortalPageRichNodeBudget): void {
  if (++budget.nodes > MAX_RICH_TEXT_NODES) invalid(INVALID_RICH_TEXT)
}

function normalizeInline(
  value: unknown,
  budget: PortalPageRichNodeBudget,
  depth: number,
): PortalPageInline {
  if (depth > 4) invalid(INVALID_RICH_TEXT)
  countNode(budget)
  const inline = record(value, INVALID_RICH_TEXT)
  switch (inline.type) {
    case 'text': {
      keys(inline, ['type', 'text', 'marks'], INVALID_RICH_TEXT)
      const normalizedMarks = array(inline.marks, INVALID_RICH_TEXT).map(mark => oneOf(mark, marks, INVALID_RICH_TEXT))
      if (new Set(normalizedMarks).size !== normalizedMarks.length) invalid(INVALID_RICH_TEXT)
      return { type: 'text', text: safeRichText(inline.text), marks: normalizedMarks as PortalPageMark[] }
    }
    case 'break':
      keys(inline, ['type'], INVALID_RICH_TEXT)
      return { type: 'break' }
    case 'link': {
      keys(inline, ['type', 'url', 'new_tab', 'children'], INVALID_RICH_TEXT)
      // Keep the page DTO structural and bounded; renderers must never interpolate this as HTML.
      return {
        type: 'link',
        url: httpsURL(inline.url, INVALID_RICH_TEXT),
        new_tab: boolean(inline.new_tab, INVALID_RICH_TEXT),
        children: array(inline.children).map(child => normalizeInline(child, budget, depth + 1)),
      }
    }
    default:
      invalid(INVALID_RICH_TEXT)
  }
}

/** Normalize the page-local safe rich-text DTO with a caller-shared 10,000-node budget. */
export function normalizePortalRichNodes(
  value: unknown,
  budget: PortalPageRichNodeBudget = { nodes: 0 },
): PortalPageRichNode[] {
  return array(value, INVALID_RICH_TEXT).map(value => {
    countNode(budget)
    const node = record(value, INVALID_RICH_TEXT)
    switch (node.type) {
      case 'paragraph':
        keys(node, ['type', 'children'], INVALID_RICH_TEXT)
        return { type: 'paragraph', children: array(node.children).map(child => normalizeInline(child, budget, 1)) }
      case 'heading':
        keys(node, ['type', 'level', 'children'], INVALID_RICH_TEXT)
        if (![2, 3, 4, 5, 6].includes(Number(node.level)) || typeof node.level !== 'number') invalid(INVALID_RICH_TEXT)
        return { type: 'heading', level: node.level as 2 | 3 | 4 | 5 | 6,
          children: array(node.children).map(child => normalizeInline(child, budget, 1)) }
      case 'list':
        keys(node, ['type', 'ordered', 'items'], INVALID_RICH_TEXT)
        return { type: 'list', ordered: boolean(node.ordered, INVALID_RICH_TEXT),
          items: array(node.items).map(item => {
            countNode(budget)
            return array(item).map(inline => normalizeInline(inline, budget, 1))
          }) }
      default:
        invalid(INVALID_RICH_TEXT)
    }
  })
}
