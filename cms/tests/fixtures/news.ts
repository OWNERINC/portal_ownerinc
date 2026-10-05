import type { LegacyBlock, NewsEditorial } from '../../src/contracts/news'

export const articleID = '10000000-0000-4000-8000-000000000001'
export const imageID = '20000000-0000-4000-8000-000000000001'
export const pdfID = '30000000-0000-4000-8000-000000000001'
export const videoID = '40000000-0000-4000-8000-000000000001'
export const editorial: NonNullable<NewsEditorial> = {
  version: 1, kind: 'article', summary: 'Resumo sintético.', author: '',
  source_label: '', source_date: '2024-02-29',
}
export const textNode = (text = 'Owner News', format = 0) => ({
  type: 'text', version: 1, text, format, mode: 'normal', style: '', detail: 0,
})
export const lexical = (children: unknown[] = [textNode()]) => ({ root: {
  type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children }],
} })
export const legacyBlocks: LegacyBlock[] = [
  { type: 'heading', text: 'Título', level: 1, layout: 'wide' },
  { type: 'paragraph', text: 'Texto de corpo.', layout: 'content', typography: 'serif' },
  { type: 'list', items: ['Um', 'Dois'], ordered: true, typography: 'sans' },
  { type: 'callout', tone: 'warning', title: 'Atenção', text: 'Aviso', typography: 'sans' },
  { type: 'quote', text: 'Citação', attribution: 'Pessoa', layout: 'left', typography: 'serif' },
  { type: 'profile', name: 'Pessoa', role: 'Cargo', text: 'Perfil', asset_id: imageID, alt: 'Retrato', typography: 'sans' },
  { type: 'image', asset_id: imageID, alt: 'Paisagem', caption: 'Legenda', credit: 'Crédito', usage: 'cover', layout: 'full' },
  { type: 'divider', layout: 'wide' },
  { type: 'link', label: 'Fonte', url: 'https://example.test/fonte', new_tab: true },
  { type: 'pdf', asset_id: pdfID, title: 'Edição', usage: 'edition' },
  { type: 'video', asset_id: videoID, title: 'Vídeo', layout: 'right' },
]
export const mediaShapes = [
  { id: imageID, mimeType: 'image/png', filesize: 100 },
  { id: pdfID, mimeType: 'application/pdf', filesize: 200 },
  { id: videoID, mimeType: 'video/mp4', filesize: 300 },
]
