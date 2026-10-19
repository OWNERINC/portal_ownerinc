export type PortalPageLayout = 'content' | 'wide' | 'full' | 'left' | 'right'
export type PortalPageMark = 'bold' | 'italic' | 'underline' | 'code'

type PortalPageInlineLeaf =
  | { type: 'text'; text: string; marks: PortalPageMark[] }
  | { type: 'break' }

export type PortalPageInline = PortalPageInlineLeaf
  | { type: 'link'; url: string; new_tab: boolean; children: PortalPageInlineLeaf[] }

export type PortalPageRichNode =
  | { type: 'paragraph'; children: PortalPageInline[] }
  | { type: 'heading'; level: 2 | 3 | 4 | 5 | 6; children: PortalPageInline[] }
  | { type: 'list'; ordered: boolean; items: PortalPageInline[][] }

type WithLayout = { layout?: PortalPageLayout }

export type PortalPageGalleryImage = {
  asset_id: string
  alt: string
  caption?: string
}

export type PortalPageBlock =
  | (WithLayout & { type: 'heading'; text: string; level: 2 | 3 | 4 })
  | (WithLayout & { type: 'rich_text'; nodes: PortalPageRichNode[] })
  | (WithLayout & { type: 'image'; asset_id: string; alt: string; caption?: string })
  | (WithLayout & { type: 'gallery'; images: PortalPageGalleryImage[] })
  | (WithLayout & { type: 'video'; asset_id: string; title: string })
  | (WithLayout & { type: 'embed'; provider: 'youtube' | 'vimeo'; url: string; title: string })
  | (WithLayout & { type: 'pdf'; asset_id: string; title: string })
  | (WithLayout & { type: 'callout'; tone: 'info' | 'warning' | 'success'; title?: string; text: string })
  | (WithLayout & { type: 'link'; label: string; url: string; new_tab: boolean; style: 'primary' | 'secondary' })
  | (WithLayout & { type: 'divider' })
