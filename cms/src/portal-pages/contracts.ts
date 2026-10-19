import type { PortalPageBlock } from './blocks'

export type PortalPageAssetScope = 'portal-pages' | 'portal-pages-preview'
export type PortalPageRevisionStatus = 'draft' | 'published'

export type PortalPageDTO = {
  id: string
  slug: string
  title: string
  summary: string
  cover: null | { asset_id: string; alt: string }
  categories: Array<{ id: string; slug: string; name: string }>
  published_at: string | null
  content_version: 1
  asset_scope: PortalPageAssetScope
  content_blocks: PortalPageBlock[]
  /** Identifies the exact saved revision returned, not a claim about the current head. */
  revision: { id: string; status: PortalPageRevisionStatus }
}

/** Later publication compares expected_version_id with the latest saved version before transition. */
export type PortalPagePublicationInput = {
  id: string
  expected_version_id: string
  operation: 'publish' | 'unpublish'
}
