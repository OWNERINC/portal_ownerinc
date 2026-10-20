const UPLOAD_BASE = '/editorial/api/portal-page-uploads'
const MEDIA_BASE = '/editorial/api/portal-page-media'
const CHUNK_BYTES = 5 * 1024 * 1024
const MEDIA = [
  { name: 'cover', path: 'cover', kind: 'image', fieldLabel: 'Capa',
    fileName: 'cover.png', mimeType: 'image/png', id: '11111111-1111-4111-8111-111111111111' },
  { name: 'image.asset', path: 'body.0.asset', kind: 'image', fieldLabel: 'Arquivo de imagem',
    fileName: 'inline.png', mimeType: 'image/png', id: '22222222-2222-4222-8222-222222222222' },
  { name: 'gallery.images[0].asset', path: 'body.1.images.0.asset', fieldLabel: 'Arquivo de imagem',
    galleryPath: 'body.1.images', kind: 'image',
    fileName: 'gallery.png', mimeType: 'image/png', id: '33333333-3333-4333-8333-333333333333' },
  { name: 'video.asset', path: 'body.2.asset', kind: 'video', fieldLabel: 'Arquivo de vídeo',
    fileName: 'lesson.mp4', mimeType: 'video/mp4', id: '44444444-4444-4444-8444-444444444444' },
  { name: 'pdf.asset', path: 'body.3.asset', kind: 'pdf', fieldLabel: 'Arquivo PDF',
    fileName: 'handbook.pdf', mimeType: 'application/pdf', id: '55555555-5555-4555-8555-555555555555' },
]

function assert(condition, detail) {
  if (!condition) throw new Error(detail)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function collect(name, action) {
  try {
    await action()
    return { name, status: 'PASS', detail: 'Browser assertion passed.' }
  } catch (error) {
    return { name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) }
  }
}

async function relationshipWrapper(page, destination) {
  const wrapper = page.locator(`.portal-page-media-field[data-portal-page-media-path="${destination.path}"]`)
  await wrapper.waitFor({ state: 'visible' })
  const native = wrapper.getByLabel(destination.fieldLabel, { exact: true })
  await native.waitFor({ state: 'visible' })
  return { native, wrapper }
}

/** Payload's public Modal markup exposes each Drawer as a dialog named by its exact slug. */
async function activeUploadDialog(page) {
  const dialogs = page.getByRole('dialog', { name: /^portal-page-upload-/u })
  await dialogs.waitFor({ state: 'visible' })
  assert(await dialogs.count() === 1, 'expected_exactly_one_visible_Portal_Page_upload_dialog')
  return dialogs
}

async function openUploadDialog(page, wrapper) {
  const existingDialogs = page.getByRole('dialog', { name: /^portal-page-upload-/u })
  assert(await existingDialogs.count() === 0, 'an_upload_dialog_was_already_active_before_opening_the_field_destination')
  await wrapper.getByRole('button', { name: 'Enviar novo arquivo', exact: true }).click()
  return activeUploadDialog(page)
}

async function assertDialogClosed(dialog, detail) {
  await dialog.waitFor({ state: 'hidden' })
  assert(await dialog.count() === 0, detail)
}

async function visibleNativeValue(wrapper, path) {
  const value = await wrapper.locator('input[type="hidden"]').evaluateAll((inputs, fieldPath) => {
    const matching = inputs.find(input => input.getAttribute('name') === fieldPath) || inputs.find(input => input.value)
    return matching?.value || ''
  }, path)
  if (value) return value
  return wrapper.innerText()
}

async function assertNativeID(wrapper, path, id) {
  const matches = await wrapper.locator('input[type="hidden"]').evaluateAll((inputs, expected) =>
    inputs.some(input => (input.getAttribute('name') === expected.path || input.value) && input.value === expected.id), { path, id })
  if (matches) return
  assert((await wrapper.innerText()).includes(id), 'native_relationship_value_does_not_match_returned_media_id')
}

function validFile(destination) {
  return { name: destination.fileName, mimeType: destination.mimeType, buffer: Buffer.from([0x50, 0x4f, 0x52, 0x54]) }
}

async function installUploadRoutes(page, destination, options = {}) {
  const origin = new URL(page.url()).origin
  const uploadID = options.uploadID || destination.id
  const bytes = options.bytes || 4
  const chunkStarted = deferred()
  const allowComplete = deferred()
  const deleteStarted = deferred()
  const deleteSettled = deferred()
  let chunks = 0
  let deletes = 0
  let collectionReads = 0
  const routes = []
  const register = async (pattern, handler) => {
    await page.route(pattern, handler)
    routes.push([pattern, handler])
  }
  await register(`**${UPLOAD_BASE}/init`, async route => {
    const body = route.request().postDataJSON()
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
      id: uploadID, token: 'A'.repeat(43), chunkSize: CHUNK_BYTES, chunkCount: Math.ceil(body.bytes / CHUNK_BYTES),
      bytes: body.bytes, mimeType: body.mimeType,
    }) })
  })
  await register(`**${UPLOAD_BASE}/${uploadID}/chunks/*`, async route => {
    chunks += 1
    chunkStarted.resolve()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: uploadID, index: chunks - 1, received: true, duplicate: false, sha256: 'a'.repeat(64),
    }) })
  })
  await register(`**${UPLOAD_BASE}/${uploadID}/complete`, async route => {
    if (options.waitForComplete) await allowComplete.promise
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: uploadID, state: 'complete', mimeType: destination.mimeType, bytes, sha256: 'a'.repeat(64),
      completedAt: '2026-10-19T10:00:00.000Z',
    }) })
  })
  await register(`**${MEDIA_BASE}/${uploadID}?depth=0`, async route => {
    collectionReads += 1
    await route.fulfill({ status: options.readStatus || 200, contentType: 'application/json', body: JSON.stringify({
      id: uploadID, state: options.readState || 'complete', mimeType: options.readMimeType || destination.mimeType,
      filesize: bytes, sha256: 'a'.repeat(64), completedAt: '2026-10-19T10:00:00.000Z',
      // Making the rendered relationship option equal its ID lets the native select also expose the ID visibly.
      originalName: uploadID,
    }) })
  })
  await register(`**${UPLOAD_BASE}/${uploadID}`, async route => {
    if (route.request().method() === 'DELETE') {
      deletes += 1
      deleteStarted.resolve()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: uploadID, cancelled: true }) })
      deleteSettled.resolve()
      return
    }
    await route.continue()
  })
  return {
    uploadID, bytes, chunkStarted, allowComplete, deleteStarted, deleteSettled, origin,
    get chunks() { return chunks }, get deletes() { return deletes }, get collectionReads() { return collectionReads },
    async cleanup() { for (const [pattern, handler] of routes) await page.unroute(pattern, handler) },
  }
}

async function reset(page, initialURL) {
  await page.goto(initialURL, { waitUntil: 'domcontentloaded' })
  const { wrapper } = await relationshipWrapper(page, MEDIA[0])
  await wrapper.getByRole('button', { name: 'Enviar novo arquivo', exact: true }).waitFor({ state: 'visible' })
}

async function uploadThroughSelection(page, initialURL, destination, { reloadPage = true } = {}) {
  if (reloadPage) await reset(page, initialURL)
  const fixture = await installUploadRoutes(page, destination, { waitForComplete: true })
  const { wrapper } = await relationshipWrapper(page, destination)
  const initialValue = await visibleNativeValue(wrapper, destination.path)
  try {
    const dialog = await openUploadDialog(page, wrapper)
    const fileInput = dialog.getByLabel('Escolha um arquivo', { exact: true })
    await fileInput.focus()
    await fileInput.setInputFiles(validFile(destination))
    await fixture.chunkStarted.promise
    await dialog.getByRole('status').filter({ hasText: 'Validando arquivo…' }).waitFor({ state: 'visible' })
    const progress = dialog.getByRole('progressbar', { name: 'Blocos confirmados do envio' })
    assert(Number(await progress.getAttribute('aria-valuenow')) === fixture.bytes,
      `${destination.name}: chunk progress did not reach the acknowledged 100% boundary`)
    assert(await visibleNativeValue(wrapper, destination.path) === initialValue,
      `${destination.name}: relationship changed before complete and explicit selection`)
    assert(fixture.chunks === 1, `${destination.name}: expected one sequential chunk`)
    fixture.allowComplete.resolve()
    await dialog.getByRole('button', { name: 'Usar este arquivo', exact: true }).waitFor({ state: 'visible' })
    assert(fixture.collectionReads === 1, `${destination.name}: authenticated collection reread was not performed`)
    assert(await visibleNativeValue(wrapper, destination.path) === initialValue,
      `${destination.name}: collection refresh changed the native relationship without explicit selection`)
    assert(await fileInput.evaluate(element => element === document.activeElement),
      `${destination.name}: refreshing only the relationship selector moved focus away from the file input`)
    await dialog.getByRole('button', { name: 'Usar este arquivo', exact: true }).click()
    await assertNativeID(wrapper, destination.path, fixture.uploadID)
    await assertDialogClosed(dialog, `${destination.name}: upload dialog remained open after explicit selection`)
    assert(await wrapper.getByRole('button', { name: 'Enviar novo arquivo', exact: true })
      .evaluate(element => element === document.activeElement),
    `${destination.name}: native Drawer did not return focus to the field-local upload control`)
    return { initialValue, id: fixture.uploadID }
  } finally {
    fixture.allowComplete.resolve()
    await fixture.cleanup()
  }
}

/**
 * Runs only after Task 4 registers the field and provides a real authorized native editor fixture.
 * The fixture must expose all five wrappers by data-portal-page-media-path and contain a gallery with at least two rows.
 * Task 4 must expose window.__portalPageUploadFixture.galleryRowIDs(path) and
 * mutateGalleryRows({ path, operation, targetRowID, otherRowID }) for controlled Payload form-state transitions compatible with the Drawer focus trap.
 * Routes intercept only upload/read responses; the relationships, native form values and focus remain real.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Array<{name: string; status: 'PASS'|'FAIL'; detail: string}>>}
 */
export async function runEditorialUploadCases(page) {
  const initialURL = page.url()
  const results = []

  for (const destination of MEDIA) {
    results.push(await collect(`${destination.name}: chunks complete, collection reread, then explicit native selection`, async () => {
      await uploadThroughSelection(page, initialURL, destination)
    }))
  }

  results.push(await collect('close without selection leaves the native relationship value unchanged', async () => {
    const destination = MEDIA[0]
    await reset(page, initialURL)
    const fixture = await installUploadRoutes(page, destination)
    const { wrapper } = await relationshipWrapper(page, destination)
    const before = await visibleNativeValue(wrapper, destination.path)
    try {
      const dialog = await openUploadDialog(page, wrapper)
      await dialog.getByLabel('Escolha um arquivo', { exact: true }).setInputFiles(validFile(destination))
      await fixture.chunkStarted.promise
      await dialog.getByRole('status').filter({ hasText: 'Arquivo pronto para selecionar' }).waitFor({ state: 'visible' })
      await dialog.getByRole('button', { name: 'Fechar painel', exact: true }).click()
      await assertDialogClosed(dialog, 'idle upload dialog did not close')
      assert(await visibleNativeValue(wrapper, destination.path) === before, 'close_without_selection_changed_native_value')

      const reopenedDialog = await openUploadDialog(page, wrapper)
      await reopenedDialog.getByRole('button', { name: 'Fechar painel', exact: true }).click()
      await assertDialogClosed(reopenedDialog, 'reopened upload dialog did not close')
    } finally { fixture.allowComplete.resolve(); await fixture.cleanup() }
  }))

  results.push(await collect('wrong MIME or failed collection reread keeps selection disabled', async () => {
    for (const read of [{ readMimeType: 'video/mp4' }, { readStatus: 503 }]) {
      const destination = MEDIA[0]
      await reset(page, initialURL)
      const fixture = await installUploadRoutes(page, destination, read)
      try {
        const { wrapper } = await relationshipWrapper(page, destination)
        const dialog = await openUploadDialog(page, wrapper)
        await dialog.getByLabel('Escolha um arquivo', { exact: true }).setInputFiles(validFile(destination))
        await fixture.chunkStarted.promise
        await dialog.getByRole('alert').filter({ hasText: /mídia concluída não pôde ser confirmada/iu }).waitFor({ state: 'visible' })
        assert(await dialog.getByRole('button', { name: 'Usar este arquivo', exact: true }).count() === 0,
          'wrong_mime_or_failed_collection_response_enabled_selection')
        assert(await activeUploadDialog(page).then(active => active.count()) === 1,
          'failed_collection_reread_closed_or_duplicated_the_active_upload_dialog')
      } finally { fixture.allowComplete.resolve(); await fixture.cleanup() }
    }
  }))

  for (const operation of ['reorder', 'remove']) results.push(await collect(`${operation} gallery row invalidates the captured destination`, async () => {
    const destination = MEDIA[2]
    await reset(page, initialURL)
    const fixture = await installUploadRoutes(page, destination, { waitForComplete: true })
    try {
      const { wrapper } = await relationshipWrapper(page, destination)
      const beforeIDs = await page.evaluate(path => window.__portalPageUploadFixture?.galleryRowIDs(path), destination.galleryPath)
      assert(Array.isArray(beforeIDs) && beforeIDs.length >= 2, 'Task_4_gallery_fixture_must_expose_two_native_row_IDs')
      const dialog = await openUploadDialog(page, wrapper)
      await dialog.getByLabel('Escolha um arquivo', { exact: true }).setInputFiles(validFile(destination))
      await fixture.chunkStarted.promise
      await dialog.getByRole('status').filter({ hasText: 'Validando arquivo…' }).waitFor({ state: 'visible' })
      await page.keyboard.press('Escape')
      const closeConfirmation = dialog.getByRole('alertdialog', { name: 'Cancelar envio?' })
      await closeConfirmation.waitFor({ state: 'visible' })
      if (operation === 'remove') {
        await closeConfirmation.getByRole('button', { name: 'Continuar envio', exact: true }).click()
      }
      const mutation = await page.evaluate(async request => {
        const fixture = window.__portalPageUploadFixture
        if (!fixture?.mutateGalleryRows || !fixture.galleryRowIDs) throw new Error('Task_4_controlled_gallery_fixture_missing')
        const currentIDs = await fixture.galleryRowIDs(request.path)
        const changed = await fixture.mutateGalleryRows({ path: request.path, operation: request.operation,
          targetRowID: request.targetRowID, otherRowID: request.otherRowID })
        const nextIDs = await fixture.galleryRowIDs(request.path)
        return { currentIDs, nextIDs, changed }
      }, { path: destination.galleryPath, operation, targetRowID: beforeIDs[0], otherRowID: beforeIDs[1] })
      assert(JSON.stringify(mutation.currentIDs) === JSON.stringify(beforeIDs), 'gallery_rows_changed_before_the_upload_destination_was_captured')
      assert(Array.isArray(mutation.nextIDs) && JSON.stringify(mutation.nextIDs) !== JSON.stringify(mutation.currentIDs),
        `${operation}_did_not_change_native_gallery_row_order_or_membership`)
      if (operation === 'reorder') {
        assert(mutation.nextIDs.length === mutation.currentIDs.length &&
          mutation.nextIDs[0] === mutation.currentIDs[1] && mutation.nextIDs[1] === mutation.currentIDs[0],
        'gallery_reorder_did_not_deterministically_swap_the_captured_row_with_its_neighbor')
      } else {
        assert(mutation.nextIDs.length === mutation.currentIDs.length - 1 && !mutation.nextIDs.includes(beforeIDs[0]),
          'gallery_removal_did_not_remove_the_captured_row_ID')
      }
      assert(mutation.changed === true, 'Task_4_fixture_did_not_confirm_the_controlled_form_state_transition')
      if (operation === 'reorder') {
        await closeConfirmation.getByRole('button', { name: 'Continuar envio', exact: true }).click()
        await dialog.getByLabel('Escolha um arquivo', { exact: true }).waitFor({ state: 'visible' })
        assert(await activeUploadDialog(page).then(active => active.count()) === 1,
          'reorder_confirmation_did_not_resolve_to_one_reopened_upload_dialog')
      }
      fixture.allowComplete.resolve()
      if (operation === 'reorder') {
        await dialog.getByRole('alert').filter({ hasText: /destino mudou|seleção.*desativada/iu }).waitFor({ state: 'visible' })
        assert(await dialog.getByRole('button', { name: 'Usar este arquivo', exact: true }).count() === 0,
          'reorder_kept_selection_available_after_native_row_ID_mutation')
      } else {
        await fixture.deleteStarted.promise
        await fixture.deleteSettled.promise
        await assertDialogClosed(dialog, 'removed gallery row left its upload dialog open')
        const remainingDestination = page.locator(`.portal-page-media-field[data-portal-page-media-path="${destination.path}"]`)
        await remainingDestination.waitFor({ state: 'visible' })
        assert(fixture.deletes === 1, 'removed_destination_did_not_dispose_and_cancel_its_private_upload_session')
        assert(await visibleNativeValue(remainingDestination, destination.path) !== fixture.uploadID,
          'removed_destination_upload_ID_was_written_to_the_remaining_native_row')
        const reopenedDialog = await openUploadDialog(page, remainingDestination)
        await reopenedDialog.getByLabel('Escolha um arquivo', { exact: true }).waitFor({ state: 'visible' })
        assert(await reopenedDialog.getByRole('button', { name: 'Usar este arquivo', exact: true }).count() === 0,
          'reopening_the_remaining_gallery_field_restored_the_removed_upload_selection')
        await reopenedDialog.getByRole('button', { name: 'Fechar painel', exact: true }).click()
        await assertDialogClosed(reopenedDialog, 'remaining gallery upload dialog did not close after reopen')
      }
    } finally { fixture.allowComplete.resolve(); await fixture.cleanup() }
  }))

  results.push(await collect('document navigation during upload never selects into the new document', async () => {
    const destination = MEDIA[3]
    await reset(page, initialURL)
    const fixture = await installUploadRoutes(page, destination, { waitForComplete: true })
    try {
      const { wrapper } = await relationshipWrapper(page, destination)
      const dialog = await openUploadDialog(page, wrapper)
      await dialog.getByLabel('Escolha um arquivo', { exact: true }).setInputFiles(validFile(destination))
      await fixture.chunkStarted.promise
      const nextDocument = new URL('/editorial/admin/collections/portal-pages/create', fixture.origin).toString()
      await page.goto(nextDocument, { waitUntil: 'domcontentloaded' })
      fixture.allowComplete.resolve()
      await assertDialogClosed(dialog, 'document navigation left the previous upload dialog active')
      await page.getByRole('button', { name: 'Salvar versão', exact: true }).waitFor({ state: 'visible' })
      assert(await dialog.getByRole('button', { name: 'Usar este arquivo', exact: true }).count() === 0,
        'old_upload_selected_into_new_document')
    } finally { fixture.allowComplete.resolve(); await fixture.cleanup() }
  }))

  results.push(await collect('native focus, alt/title values and Task 2 confirmation are preserved or invalidated correctly', async () => {
    const destination = MEDIA[1]
    await reset(page, initialURL)
    await page.getByRole('button', { name: 'Salvar versão', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Versão salva' }).waitFor({ state: 'visible' })
    await page.getByRole('link', { name: 'Abrir prévia desta versão em nova aba', exact: true }).waitFor({ state: 'visible' })
    const publish = page.getByRole('button', { name: 'Publicar versão salva', exact: true })
    assert(await publish.isEnabled(), 'Task_2_confirmation_not_ready_before_relationship_change')
    const { wrapper } = await relationshipWrapper(page, destination)
    const altInput = page.locator('input[name="body.0.alt"]')
    const altBefore = await altInput.inputValue().catch(() => '')
    const altRequired = await altInput.getAttribute('aria-required') ?? await altInput.getAttribute('required')
    const videoTitle = page.locator('input[name="body.2.title"]')
    const titleBefore = await videoTitle.inputValue().catch(() => '')
    const titleRequired = await videoTitle.getAttribute('aria-required') ?? await videoTitle.getAttribute('required')
    const result = await uploadThroughSelection(page, initialURL, destination, { reloadPage: false })
    await assertNativeID(wrapper, destination.path, result.id)
    assert(altRequired === 'true' || altRequired === '', 'native_alt_text_is_no_longer_required')
    assert(await altInput.inputValue().catch(() => '') === altBefore,
      'upload_overwrote_native_alt_text')
    assert(titleRequired === 'true' || titleRequired === '', 'native_video_title_is_no_longer_required')
    assert(await page.locator('input[name="body.2.title"]').inputValue().catch(() => '') === titleBefore,
      'upload_overwrote_native_title')
    if (await publish.count()) assert(await publish.isDisabled(), 'uploaded_relationship_did_not_invalidate_Task_2_confirmation')
    assert(await page.locator('.portal-page-media-field').count() >= 5, 'remount_only_selector_preserves_the_native_wrapper_and_focus')
  }))

  return results
}
