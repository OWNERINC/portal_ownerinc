import type { Block, Field } from 'payload'
import { newsEditor } from './editor'
import { legacyTextBlocks } from './legacy-blocks'
import { imageMimes, layouts, typographies, videoMimes } from './primitives'

const layout: Field = { name: 'layout', type: 'select', options: [...layouts] }
const typography: Field = { name: 'typography', type: 'select', options: [...typographies] }
const text = (name: string, maxLength: number, multiline = false): Field => multiline
  ? { name, type: 'textarea', maxLength } : { name, type: 'text', maxLength }
const media = (mimes: string[]): Field => ({ name: 'media', type: 'upload', relationTo: 'news-media', filterOptions: { mimeType: { in: mimes } } })
export const newsBlocks: Block[] = [
  { slug: 'richText', fields: [{ name: 'content', type: 'richText', editor: newsEditor }, layout, typography] },
  ...legacyTextBlocks(layout, typography),
  { slug: 'image', fields: [media(imageMimes), text('alt', 300), text('caption', 1000, true), text('credit', 300, true),
    { name: 'usage', type: 'select', options: ['cover', 'body'] }, layout] },
  { slug: 'callout', fields: [{ name: 'tone', type: 'select', options: ['info', 'warning', 'success'], defaultValue: 'info' },
    text('title', 200), text('text', 2000, true), layout, typography] },
  { slug: 'quote', fields: [text('text', 5000, true), text('attribution', 200), layout, typography] },
  { slug: 'profile', fields: [text('name', 200), text('role', 200), text('text', 5000, true), media(imageMimes), text('alt', 300), layout, typography] },
  { slug: 'divider', fields: [layout] },
  { slug: 'link', fields: [text('label', 200), text('url', 2048), { name: 'newTab', type: 'checkbox', defaultValue: false }, layout] },
  { slug: 'pdf', fields: [media(['application/pdf']), text('title', 200), { name: 'usage', type: 'select', options: ['edition', 'attachment'] }, layout] },
  { slug: 'video', fields: [media(videoMimes), text('url', 2048), text('title', 200), layout] },
]
