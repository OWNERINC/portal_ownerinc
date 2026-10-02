import {
  BoldFeature, createServerFeature, FixedToolbarFeature, HeadingFeature, InlineCodeFeature,
  ItalicFeature, lexicalEditor, LinkFeature, OrderedListFeature, ParagraphFeature,
  UnderlineFeature, UnorderedListFeature,
} from '@payloadcms/richtext-lexical'

export const FlatListsFeature = createServerFeature({
  key: 'newsFlatLists',
  feature: { ClientFeature: '/news/FlatLists.client#FlatListsFeatureClient' },
})
export const newsEditor = lexicalEditor({ features: [
  ParagraphFeature(), HeadingFeature({ enabledHeadingSizes: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] }),
  BoldFeature(), ItalicFeature(), UnderlineFeature(), InlineCodeFeature(),
  OrderedListFeature(), UnorderedListFeature(),
  LinkFeature({ disableAutoLinks: true, enabledCollections: [] }),
  FlatListsFeature(), FixedToolbarFeature(),
] })
