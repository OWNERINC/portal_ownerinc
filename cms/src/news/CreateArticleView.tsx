import { APIError, type AdminViewServerProps } from 'payload'
import { canManageNews } from '../auth/access'
import { CreateArticle } from './CreateArticle.client'

// Public collection-view extension: server render/metadata/prefetch must not create
// documents. The native editor is used as soon as the client POST returns its UUID.
export function CreateArticleView({ initPageResult }: AdminViewServerProps) {
  if (!canManageNews({ req: initPageResult.req })) throw new APIError('Forbidden', 403)
  return <CreateArticle />
}
