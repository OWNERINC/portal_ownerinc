import React from 'react'
import { APIError, type DocumentViewServerProps } from 'payload'
import { assertNewsHistoryAccess } from '../auth/news-history-access'
import { RestoreDraft } from './RestoreDraft'
import { uuid } from '../news/primitives'

/** Public document-view extension. Version content is fetched privately by the client. */
export async function NewsVersionView({ initPageResult, routeSegments }: DocumentViewServerProps) {
  const { req, collectionConfig, globalConfig, docID } = initPageResult
  await assertNewsHistoryAccess(req)
  const target = collectionConfig?.slug === 'news-articles' ? 'news-articles' : globalConfig?.slug === 'news-home' ? 'news-home' : null
  if (!target) throw new APIError('news_version_not_found', 404)
  const documentId = target === 'news-home' ? 'news-home' : uuid(docID)
  const sourceVersionId = uuid(routeSegments.at(-1))
  return <RestoreDraft target={target} documentId={documentId} sourceVersionId={sourceVersionId} />
}
