import {
  BoldFeature,
  FixedToolbarFeature,
  HeadingFeature,
  InlineCodeFeature,
  ItalicFeature,
  lexicalEditor,
  LinkFeature,
  OrderedListFeature,
  ParagraphFeature,
  UnderlineFeature,
  UnorderedListFeature,
} from '@payloadcms/richtext-lexical'
import type { LinkFeatureServerProps } from '@payloadcms/richtext-lexical'
import { MAX_PORTAL_PAGE_URL_LENGTH } from './primitives'

type LinkFeatureFieldsCallback = Exclude<NonNullable<LinkFeatureServerProps['fields']>, unknown[]>

export function portalPageLinkFields({ defaultFields }: Parameters<LinkFeatureFieldsCallback>[0]) {
  return defaultFields.map(field => field.name === 'url'
    ? { ...field, maxLength: MAX_PORTAL_PAGE_URL_LENGTH }
    : field)
}

/** Page-local feature allowlist aligned with Task 1's safe rich-text projection. */
export const portalPageEditor = lexicalEditor({ features: [
  ParagraphFeature(), HeadingFeature({ enabledHeadingSizes: ['h2', 'h3', 'h4', 'h5', 'h6'] }),
  BoldFeature(), ItalicFeature(), UnderlineFeature(), InlineCodeFeature(),
  OrderedListFeature(), UnorderedListFeature(),
  LinkFeature({ disableAutoLinks: true, enabledCollections: [], fields: portalPageLinkFields }), FixedToolbarFeature(),
] })
