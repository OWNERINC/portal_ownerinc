import { APIError, type AdminViewServerProps } from 'payload'
import { canWriteNews } from '../auth/access'
import { canCreateNewsArticle } from '../auth/news-area-access'
import { CreateArticle } from './CreateArticle.client'

// Public collection-view extension: server render/metadata/prefetch must not create
// documents. The native editor is used as soon as the client POST returns its UUID.
export async function CreateArticleView({ initPageResult }: AdminViewServerProps) {
  const req = initPageResult.req
  if (!canWriteNews({ req })) throw new APIError('editorial_permission_denied', 403, undefined, true)
  if (!await canCreateNewsArticle(req)) throw new APIError('cms_authority_read_only', 403, undefined, true)
  return <CreateArticle />
}
