import type { Field } from 'payload'
import { newsBlocks } from './blocks'
import { normalizeEditorial, readEditorialFieldValue } from './validation'

const internalAccess = { create: () => false, update: () => false }
export const publicationFields: Field[] = [
  { name: 'publishedAt', label: 'Publicado em', type: 'date', admin: { readOnly: true }, access: internalAccess },
  { name: 'publicationGeneration', label: 'Geração da publicação', type: 'number', defaultValue: 0, min: 0, admin: { readOnly: true }, access: internalAccess },
  { name: 'legacyDocumentId', label: 'Documento anterior', type: 'text', index: true, admin: { readOnly: true }, access: internalAccess },
  { name: 'legacySourceId', label: 'Registro de origem anterior', type: 'text', admin: { readOnly: true }, access: internalAccess },
  { name: 'legacyRevisionId', label: 'Revisão anterior', type: 'text', admin: { readOnly: true }, access: internalAccess },
  { name: 'importedAt', label: 'Importado em', type: 'date', admin: { readOnly: true }, access: internalAccess },
]
export const newsFields: Field[] = [
  { name: 'title', label: 'Título', type: 'text', maxLength: 200, defaultValue: '' },
  { name: 'category', label: 'Categoria', type: 'text', maxLength: 100, defaultValue: '', index: true },
  // Atomic JSON preserves imported null and civil dates. A group would materialize
  // empty child fields on null; no invented metadata is permitted for legacy records.
  { name: 'editorial', label: 'Informações editoriais', type: 'json', admin: { components: { Field: '/admin/EditorialMetadata#EditorialMetadata' } }, defaultValue: {
    version: 1, kind: 'article', summary: '', author: '', source_label: '', source_date: null,
  }, validate: value => {
    try {
      // Payload's public JSONField contract validates the editor's serialized JSON.
      // Native API/local validation may already provide the parsed object.
      normalizeEditorial(readEditorialFieldValue(value))
      return true
    } catch { return 'invalid_news_editorial' }
  },
  jsonSchema: { uri: 'urn:owner-news:editorial:v1', fileMatch: ['*'], schema: {
    type: ['object', 'null'], additionalProperties: false,
    required: ['version', 'kind', 'summary', 'author', 'source_label', 'source_date'],
    properties: { version: { enum: [1] }, kind: { enum: ['article', 'edition'] },
      summary: { type: 'string', maxLength: 1000 }, author: { type: 'string', maxLength: 200 },
      source_label: { type: 'string', maxLength: 200 }, source_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
  } } },
  { name: 'body', label: 'Conteúdo', type: 'blocks', blocks: newsBlocks, maxRows: 100, defaultValue: [] },
  ...publicationFields,
]
