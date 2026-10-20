import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUploadClient, claimPortalPageUpload, releasePortalPageUpload } from '../../src/admin/portal-pages/upload-client'
import { isPortalPageMediaEditable, resolveUploadDrawerClose,
  shouldRetainUploadActivityAfterRunFailure } from '../../src/admin/portal-pages/upload-panel-state'
import type { UploadProgress } from '../../src/admin/portal-pages/upload-client'

const uploadID = '11111111-1111-4111-8111-111111111111'
const token = 'A'.repeat(43)
const chunkBytes = 5 * 1024 * 1024

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function virtualImage(): File {
  return { name: 'photo.png', type: 'image/png', size: 3,
    slice: () => new Blob([new Uint8Array(3)], { type: 'image/png' }) } as unknown as File
}

test('native Payload close and Escape synchronize idle and completed/ready panels without a reopen loop', () => {
  for (const scenario of [
    { name: 'idle', active: false, hasSession: false },
    { name: 'completed/ready', active: false, hasSession: false },
  ]) {
    let previousOpen = true
    let isOpen = false
    let panelClosed = false
    const closeAction = resolveUploadDrawerClose(previousOpen, isOpen, scenario.active, scenario.hasSession)
    assert.equal(closeAction, 'close-panel', scenario.name)
    if (closeAction === 'close-panel') panelClosed = true
    previousOpen = isOpen

    isOpen = true
    assert.equal(resolveUploadDrawerClose(previousOpen, isOpen, false, false), 'no-change', `${scenario.name} immediate reopen`)
    assert.equal(panelClosed, true, `${scenario.name} native close must synchronize the field wrapper`)
  }

  assert.equal(resolveUploadDrawerClose(true, false, true, false), 'confirm-and-reopen', 'active upload close requires confirmation')
  assert.equal(resolveUploadDrawerClose(true, false, false, true), 'confirm-and-reopen', 'resumable session close requires confirmation')
  assert.equal(resolveUploadDrawerClose(false, true, true, true), 'no-change', 'programmatic reopen must not repeat confirmation')
  assert.equal(resolveUploadDrawerClose(false, false, false, false), 'no-change', 'initial closed render is not a close event')
})

test('media operations follow current Payload disabled, readonly, lock, and processing state', () => {
  const editable = { fieldDisabled: false, readOnly: false, formDisabled: false, locked: false,
    processing: false, backgroundProcessing: false, initializing: false, documentInitializing: false }
  assert.equal(isPortalPageMediaEditable(editable), true)

  for (const key of Object.keys(editable) as Array<keyof typeof editable>) {
    assert.equal(isPortalPageMediaEditable({ ...editable, [key]: true }), false, key)
  }

  let current = editable
  assert.equal(isPortalPageMediaEditable(current), true)
  current = { ...current, locked: true }
  assert.equal(isPortalPageMediaEditable(current), false, 'state becoming locked blocks the next event handler')

  let valueSet = false
  if (isPortalPageMediaEditable(current)) valueSet = true
  assert.equal(valueSet, false, 'a state transition to blocked must never call setValue')
})

test('aborted upload continuation retains active ownership and unload protection until deferred DELETE settles', async () => {
  const owner = {}, competingOwner = {}, form = {}
  assert.equal(claimPortalPageUpload('page-cancel', form, owner), true)
  let active = true
  let status: 'uploading' | 'idle' | 'failed' = 'uploading'
  let chunkStarted!: () => void
  let deleteStarted!: () => void
  let releaseDelete!: (response: Response) => void
  const chunkReady = new Promise<void>(resolve => { chunkStarted = resolve })
  const deleteReady = new Promise<void>(resolve => { deleteStarted = resolve })
  const pendingDelete = new Promise<Response>(resolve => { releaseDelete = resolve })
  const progress: UploadProgress[] = []
  const client = createUploadClient({
    fetch: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/init')) return json({ id: uploadID, token, chunkSize: chunkBytes,
        chunkCount: 1, bytes: 3, mimeType: 'image/png' }, 201)
      if (url.includes('/chunks/')) return new Promise<Response>((_resolve, reject) => {
        chunkStarted()
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      if (init?.method === 'DELETE') {
        deleteStarted()
        return pendingDelete
      }
      throw new Error(`unexpected route: ${url}`)
    },
    sleep: async () => {}, random: () => 0.5,
    onProgress: next => {
      progress.push(next)
      if (['preparing', 'uploading', 'validating', 'cancelling'].includes(next.phase)) active = true
      if (next.phase === 'cancelled' || next.phase === 'ready') active = false
    },
  })
  let cancelIntent = false
  const running = client.start(virtualImage(), 'image').catch(() => {
    if (!shouldRetainUploadActivityAfterRunFailure(cancelIntent)) {
      active = false
      status = 'failed'
      releasePortalPageUpload('page-cancel', form, owner)
    }
  })
  await chunkReady
  cancelIntent = true
  const cancellation = client.cancel()
  await deleteReady
  await running

  assert.equal(active, true, 'aborted run completion must not remove the beforeunload guard')
  assert.equal(status, 'uploading', 'aborted run completion must not publish idle/failed while DELETE is pending')
  assert.equal(claimPortalPageUpload('page-cancel', form, competingOwner), false,
    'another panel cannot acquire the document during cancellation')
  assert.equal(progress.at(-1)?.phase, 'cancelling')

  releaseDelete(json({ id: uploadID, cancelled: true }))
  assert.equal(await cancellation, 'cancelled')
  active = false
  status = 'idle'
  assert.equal(releasePortalPageUpload('page-cancel', form, owner), true)
  assert.equal(status, 'idle')
  assert.equal(claimPortalPageUpload('page-cancel', form, competingOwner), true,
    'the document becomes available only after the owned cancellation settles')
  releasePortalPageUpload('page-cancel', form, competingOwner)
})

test('idle-session cancellation cannot take a document lease held by another panel', () => {
  const owner = {}, other = {}, form = {}
  assert.equal(claimPortalPageUpload('page-idle-cancel', form, owner), true)
  assert.equal(claimPortalPageUpload('page-idle-cancel', form, other), false)
  assert.equal(releasePortalPageUpload('page-idle-cancel', form, other), false)
  assert.equal(releasePortalPageUpload('page-idle-cancel', form, owner), true)
})
