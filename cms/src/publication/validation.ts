import { beforeChangeTraverseFields, ValidationError, type PayloadRequest, type ValidationFieldError } from 'payload'
import type { NewsSnapshot } from './document'
import type { PublicationTarget } from './transaction'

const authoredFields = (target: PublicationTarget) => target === 'news-articles'
  ? ['title', 'category', 'editorial', 'body'] : ['eyebrow', 'headline', 'summary']

/** Validate the raw snapshot with the same sanitized field validators as native
 * publication (including nested blocks), not a second table of trimmed limits.
 * Public field traversal does not own/kill transactions. Its transformed clone is
 * discarded; persisted snapshots remain byte-for-byte authored content.
 */
export async function validateNativeSnapshot(req: PayloadRequest, target: PublicationTarget, snapshot: NewsSnapshot) {
  const collection = target === 'news-articles' ? req.payload.collections[target].config : null
  const global = target === 'news-home' ? req.payload.globals.config.find(config => config.slug === target)! : null
  const fields = (collection || global)!.fields.filter(field => 'name' in field && authoredFields(target).includes(field.name))
  const data = structuredClone({ ...snapshot, _status: 'published' }), errors: ValidationFieldError[] = []
  await beforeChangeTraverseFields({ collection, global, fields, context: req.context, data, doc: {}, docWithLocales: {},
    errors, mergeLocaleActions: [], operation: 'update', overrideAccess: true, req, skipValidation: false,
    fieldLabelPath: '', parentIndexPath: '', parentPath: '', parentSchemaPath: '', parentIsLocalized: false,
    siblingData: data, siblingDoc: {}, siblingDocWithLocales: {} })
  if (errors.length) throw new ValidationError({ collection: collection?.slug, global: global?.slug, errors, req }, req.t)
}

/** DB uniqueness errors are also ValidationError in the pinned adapter. Never
 * misclassify those (tableName), audit failures, or generic API/operational errors.
 */
export function isNativeContentValidation(error: unknown, target: PublicationTarget): error is ValidationError {
  if (!(error instanceof ValidationError)) return false
  const { collection, global, errors } = error.data
  return (target === 'news-articles' ? collection === target : global === target) && errors.length > 0 &&
    errors.every(field => !('tableName' in field) && typeof field.path === 'string' && authoredFields(target).includes(field.path.split('.')[0]))
}
