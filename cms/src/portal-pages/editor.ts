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

/** Page-local feature allowlist aligned with Task 1's safe rich-text projection. */
export const portalPageEditor = lexicalEditor({ features: [
  ParagraphFeature(), HeadingFeature({ enabledHeadingSizes: ['h2', 'h3', 'h4', 'h5', 'h6'] }),
  BoldFeature(), ItalicFeature(), UnderlineFeature(), InlineCodeFeature(),
  OrderedListFeature(), UnorderedListFeature(),
  LinkFeature({ disableAutoLinks: true, enabledCollections: [] }), FixedToolbarFeature(),
] })
