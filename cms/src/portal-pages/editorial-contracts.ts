import type { PortalPagePublicationInput, PortalPageRevisionStatus } from './contracts'
import type { PortalPage } from '../payload-types'

export type NativeEditable = {
  title: string
  slug: string
  summary: string
  cover: string | null
  coverAlt: string | null
  categories: string[]
  body: NonNullable<PortalPage['body']>
}

export type SaveInput =
  | { id: string; expected_latest_version_id: string; expected_snapshot_hash: string }
  | { id: null; data: NativeEditable }

export type RevisionResult = {
  id: string
  document_status: PortalPageRevisionStatus
  latest: null | {
    version_id: string
    autosave: boolean
    saved_at: string
    snapshot_hash: string
    editable_hash: string
  }
  explicit: null | { version_id: string; saved_at: string; is_latest: boolean }
}

export type SaveResult = {
  id: string
  version_id: string
  saved_at: string
  editable_hash: string
  document_status: PortalPageRevisionStatus
}

export type PublicationResult = {
  id: string
  operation: PortalPagePublicationInput['operation']
  source_version_id: string
  resulting_version_id: string
  document_status: PortalPageRevisionStatus
  published_at: string | null
}

export type EditorialErrorBody = {
  error: string
  message: string
  fields?: Array<{ path: string; message: string }>
}

export const EDITORIAL_BASE = '/editorial/api/portal-page-editorial'
export const EXISTING_JSON_BYTES = 16 * 1024
export const CREATE_JSON_BYTES = 8 * 1024 * 1024
export const PROJECTED_CONTENT_BYTES = 5 * 1024 * 1024
export const EDITORIAL_HEADERS = {
  'Cache-Control': 'private,no-store',
  'X-Content-Type-Options': 'nosniff',
}
