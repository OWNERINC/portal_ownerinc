import type { EditorialBrowserCase } from './portal-page-editorial-controls.mjs'

export type UploadPositionSnapshot = Readonly<{
  image: string | null
  gallery: string | null
  video: string | null
  pdf: string | null
}>

export const expectedUploadDestinationPositions: Readonly<{
  image: string
  gallery: string
  video: string
  pdf: string
}>
export const uploadPositionAcceptanceName: string
export function runEditorialControlAndUploadSuites(input: {
  page: unknown
  structuralPage: unknown
  runControls: (page: unknown, structuralPage: unknown) => Promise<EditorialBrowserCase[]>
  runUploads: (page: unknown, positions: UploadPositionSnapshot) => Promise<EditorialBrowserCase[]>
}): Promise<EditorialBrowserCase[]>
