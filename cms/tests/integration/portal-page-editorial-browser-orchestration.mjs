import { expectedEditorialControlCases } from './portal-page-editorial-controls.mjs'
import {
  expectedEditorialUploadCases,
  expectedUploadDestinationPositions,
  readUploadDestinationPositions,
} from './portal-page-editorial-upload.mjs'

export { expectedUploadDestinationPositions }
export const uploadPositionAcceptanceName =
  'original image/gallery/video/PDF positions reach the upload suite unchanged'

function matchesExpectedPositions(snapshot) {
  return snapshot && Object.entries(expectedUploadDestinationPositions)
    .every(([name, expectedPath]) => snapshot[name] === expectedPath) &&
    Object.keys(snapshot).length === Object.keys(expectedUploadDestinationPositions).length
}

function samePositions(left, right) {
  return matchesExpectedPositions(left) && matchesExpectedPositions(right) &&
    Object.entries(expectedUploadDestinationPositions).every(([name]) => left[name] === right[name])
}

async function snapshot(page) {
  try { return await readUploadDestinationPositions(page) } catch { return null }
}

/** Run controls with their isolated structural editor, then gate uploads on the original page positions. */
export async function runEditorialControlAndUploadSuites({ page, structuralPage, runControls, runUploads }) {
  const before = await snapshot(page)
  const controls = await runControls(page, structuralPage)
  const after = await snapshot(page)
  const positionsVerified = samePositions(before, after)
  const positionResult = {
    name: uploadPositionAcceptanceName,
    status: positionsVerified ? 'PASS' : 'FAIL',
    detail: positionsVerified
      ? 'The isolated structural editor left all original upload positions intact and passed them to the upload suite.'
      : 'The original image/gallery/video/PDF position snapshot was missing or changed before upload acceptance.',
  }
  const uploads = positionsVerified
    ? await runUploads(page, before)
    : expectedEditorialUploadCases.map(name => ({ name, status: 'NOT_EXECUTED',
      detail: 'original_upload_destination_positions_unverified' }))
  return [...controls, positionResult, ...uploads]
}
