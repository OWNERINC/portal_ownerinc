import type { Block, Field } from 'payload'
import { PORTAL_PAGE_IMAGE_MIMES, PORTAL_PAGE_MEDIA_MIMES } from './primitives'
import { portalPageEditor } from './editor'

const layout: Field = {
  name: 'layout', label: 'Largura do conteúdo', type: 'select',
  options: [
    { label: 'Conteúdo', value: 'content' }, { label: 'Amplo', value: 'wide' },
    { label: 'Tela inteira', value: 'full' }, { label: 'Alinhar à esquerda', value: 'left' },
    { label: 'Alinhar à direita', value: 'right' },
  ],
}
const text = (name: string, label: string, maxLength?: number, required = true): Field => ({
  name, label, type: 'text', required, ...(maxLength === undefined ? {} : { maxLength }),
})
const textarea = (name: string, label: string, maxLength: number, required = false): Field => ({
  name, label, type: 'textarea', required, maxLength,
})
const pageMedia = (label: string, mimes: readonly string[] = PORTAL_PAGE_MEDIA_MIMES): Field => ({
  name: 'asset', label, type: 'relationship', relationTo: 'portal-page-media',
  filterOptions: { state: { equals: 'complete' }, mimeType: { in: [...mimes] } },
  admin: { allowCreate: false, allowEdit: false },
})

export const portalPageBlocks: Block[] = [
  {
    slug: 'heading', labels: { singular: 'Título de seção', plural: 'Títulos de seção' },
    fields: [text('text', 'Título', 200), {
      name: 'level', label: 'Nível do título', type: 'select', required: true, defaultValue: '2',
      options: [{ label: 'Nível 2', value: '2' }, { label: 'Nível 3', value: '3' }, { label: 'Nível 4', value: '4' }],
    }, layout],
  },
  {
    slug: 'rich_text', labels: { singular: 'Texto rico', plural: 'Textos ricos' },
    fields: [{ name: 'content', label: 'Conteúdo', type: 'richText', editor: portalPageEditor }, layout],
  },
  {
    slug: 'image', labels: { singular: 'Imagem', plural: 'Imagens' },
    fields: [pageMedia('Arquivo de imagem', PORTAL_PAGE_IMAGE_MIMES), text('alt', 'Texto alternativo', 300),
      textarea('caption', 'Legenda', 1000), layout],
  },
  {
    slug: 'gallery', labels: { singular: 'Galeria', plural: 'Galerias' },
    fields: [{
      name: 'images', label: 'Imagens', type: 'array', minRows: 2, maxRows: 20,
      fields: [pageMedia('Arquivo de imagem', PORTAL_PAGE_IMAGE_MIMES), text('alt', 'Texto alternativo', 300),
        textarea('caption', 'Legenda', 1000)],
    }, layout],
  },
  {
    slug: 'video', labels: { singular: 'Vídeo', plural: 'Vídeos' },
    fields: [pageMedia('Arquivo de vídeo', ['video/mp4', 'video/webm']), text('title', 'Título do vídeo', 200), layout],
  },
  {
    slug: 'embed', labels: { singular: 'Vídeo incorporado', plural: 'Vídeos incorporados' },
    fields: [{ name: 'provider', label: 'Provedor', type: 'select', required: true,
      options: [{ label: 'YouTube', value: 'youtube' }, { label: 'Vimeo', value: 'vimeo' }] },
    text('url', 'Endereço do vídeo'), text('title', 'Título acessível', 200), layout],
  },
  {
    slug: 'pdf', labels: { singular: 'Documento PDF', plural: 'Documentos PDF' },
    fields: [pageMedia('Arquivo PDF', ['application/pdf']), text('title', 'Título do documento', 200), layout],
  },
  {
    slug: 'callout', labels: { singular: 'Aviso', plural: 'Avisos' },
    fields: [{ name: 'tone', label: 'Tipo do aviso', type: 'select', required: true, defaultValue: 'info',
      options: [{ label: 'Informação', value: 'info' }, { label: 'Atenção', value: 'warning' }, { label: 'Sucesso', value: 'success' }] },
    text('title', 'Título', 200, false), textarea('text', 'Texto do aviso', 2000, true), layout],
  },
  {
    slug: 'link', labels: { singular: 'Link', plural: 'Links' },
    fields: [text('label', 'Texto do link', 200), text('url', 'Endereço do link'),
      { name: 'newTab', label: 'Abrir em nova aba', type: 'checkbox', defaultValue: false },
      { name: 'style', label: 'Estilo', type: 'select', required: true, defaultValue: 'primary',
        options: [{ label: 'Principal', value: 'primary' }, { label: 'Secundário', value: 'secondary' }] }, layout],
  },
  {
    slug: 'divider', labels: { singular: 'Divisor', plural: 'Divisores' }, fields: [layout],
  },
]
