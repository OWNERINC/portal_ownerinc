const UPLOAD_BASE = '/editorial/api/portal-page-uploads'
const MEDIA_BASE = '/editorial/api/portal-page-media'
const CHUNK_BYTES = 5 * 1024 * 1024
const MEDIA = [
  { name: 'cover', path: 'cover', kind: 'image', fieldLabel: 'Capa', labelIndex: 0,
    fileName: 'cover.png', mimeType: 'image/png', id: '11111111-1111-4111-8111-111111111111' },
  { name: 'image.asset', path: 'body.0.asset', kind: 'image', fieldLabel: 'Arquivo de imagem', labelIndex: 0,
    fileName: 'inline.png', mimeType: 'image/png', id: '22222222-2222-4222-8222-222222222222' },
  { name: 'gallery.images[0].asset', path: 'body.1.images.0.asset', kind: 'image', fieldLabel: 'Arquivo de imagem', labelIndex: 1,
    fileName: 'gallery.png', mimeType: 'image/png', id: '33333333-3333-4333-8333-333333333333' },
  { name: 'video.asset', path: 'body.2.asset', kind: 'video', fieldLabel: 'Arquivo de vídeo', labelIndex: 0,
    fileName: 'lesson.mp4', mimeType: 'video/mp4', id: '44444444-4444-4444-8444-444444444444' },
  { name: 'pdf.asset', path: 'body.3.asset', kind: 'pdf', fieldLabel: 'Arquivo PDF', labelIndex: 0,
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
  const native = page.getByLabel(destination.fieldLabel, { exact: true }).nth(destination.labelIndex)
  await native.waitFor({ state: 'visible' })
  const wrapper = page.locator('.portal-page-media-field').filter({ has: native }).first()
  await wrapper.waitFor({ state: 'visible' })
  return { native, wrapper }
}

async function visibleNativeValue(wrapper, path) {
  const hiddenInputs = wrapper.locator('input[type="hidden"]')
  const count = await hiddenInputs.count()
  for (let index = 0; index < count; index += 1) {
    const input = hiddenInputs.nth(index)
    const name = await input.getAttribute('name')
    const value = await input.inputValue().catch(() => '')
    if (name === path || value) return value
  }
  return wrapper.innerText()
}

async function assertNativeID(wrapper, path, id) {
  const hiddenInputs = wrapper.locator('input[type="hidden"]')
  const count = await hiddenInputs.count()
  for (let index = 0; index < count; index += 1) {
    const input = hiddenInputs.nth(index)
    const name = await input.getAttribute('name')
    const value = await input.inputValue().catch(() => '')
    if ((name === path || name?.endsWith(path.split('.').at(-1))) && value === id) return
    if (value === id) return
  }
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
  let chunks = 0
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
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: uploadID, cancelled: true }) })
      return
    }
    await route.continue()
  })
  return {
    uploadID, bytes, chunkStarted, allowComplete, origin,
    get chunks() { return chunks }, get collectionReads() { return collectionReads },
    async cleanup() { for (const [pattern, handler] of routes) await page.unroute(pattern, handler) },
  }
}

async function reset(page, initialURL) {
  await page.goto(initialURL, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Enviar novo arquivo', exact: true }).first().waitFor({ state: 'visible' })
}

async function uploadThroughSelection(page, initialURL, destination) {
  await reset(page, initialURL)
  const fixture = await installUploadRoutes(page, destination, { waitForComplete: true })
  const { wrapper } = await relationshipWrapper(page, destination)
  const initialValue = await visibleNativeValue(wrapper, destination.path)
  try {
    await wrapper.getByRole('button', { name: 'Enviar novo arquivo', exact: true }).click()
    const fileInput = page.getByLabel('Escolha um arquivo', { exact: true })
    await fileInput.focus()
    await fileInput.setInputFiles(validFile(destination))
    await fixture.chunkStarted.promise
    await page.getByRole('status').filter({ hasText: 'Validando arquivo…' }).waitFor({ state: 'visible' })
    const progress = page.getByRole('progressbar', { name: 'Blocos confirmados do envio' })
    assert(Number(await progress.getAttribute('aria-valuenow')) === fixture.bytes,
      `${destination.name}: chunk progress did not reach the acknowledged 100% boundary`)
    assert(await visibleNativeValue(wrapper, destination.path) === initialValue,
      `${destination.name}: relationship changed before complete and explicit selection`)
    assert(fixture.chunks === 1, `${destination.name}: expected one sequential chunk`)
    fixture.allowComplete.resolve()
    await page.getByRole('button', { name: 'Usar este arquivo', exact: true }).waitFor({ state: 'visible' })
    assert(fixture.collectionReads === 1, `${destination.name}: authenticated collection reread was not performed`)
    assert(await visibleNativeValue(wrapper, destination.path) === initialValue,
      `${destination.name}: collection refresh changed the native relationship without explicit selection`)
    assert(await fileInput.evaluate(element => element === document.activeElement),
      `${destination.name}: refreshing only the relationship selector moved focus away from the file input`)
    await page.getByRole('button', { name: 'Usar este arquivo', exact: true }).click()
    await assertNativeID(wrapper, destination.path, fixture.uploadID)
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
 * The fixture must contain cover, image block, gallery with at least two rows, video and PDF in that order.
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
      await wrapper.getByRole('button', { name: 'Enviar novo arquivo', exact: true }).click()
      await page.getByLabel('Escolha um arquivo', { exact: true }).setInputFiles(validFile(destination))
      await fixture.chunkStarted.promise
      await page.getByRole('status').filter({ hasText: 'Arquivo pronto para selecionar' }).waitFor({ state: 'visible' })
      await page.getByRole('button', { name: 'Fechar painel', exact: true }).click()
      assert(await visibleNativeValue(wrapper, destination.path) === before, 'close_without_selection_changed_native_value')
    } finally { fixture.allowComplete.resolve(); await fixture.cleanup() }
  }))

  results.push(await collect('wrong MIME or failed collection reread keeps selection disabled', async () => {
    for (const read of [{ readMimeType: 'video/mp4' }, { readStatus: 503 }]) {
      const destination = MEDIA[0]
      await reset(page, initialURL)
      const fixture = await installUploadRoutes(page, destination, read)
      try {
        const { wrapper } = await relationshipWrapper(page, destination)
        await wrapper.getByRole('button', { name: 'Enviar novo arquivo', exact: true }).click()
        await page.getByLabel('Escolha um arquivo', { exact: true }).setInputFiles(validFile(destination))
        await fixture.chunkStarted.promise
        await page.getByRole('alert').filter({ hasText: /mídia concluída não pôde ser confirmada/iu }).waitFor({ state: 'visible' })
        assert(await page.getByRole('button', { name: 'Usar este arquivo', exact: true }).count() === 0,
          'wrong_mime_or_failed_collection_response_enabled_selection')
      } finally { fixture.allowComplete.resolve(); await fixture.cleanup() }
    }
  }))

  results.push(await collect('removing or reordering a native gallery row invalidates the captured destination', async () => {
    const destination = MEDIA[2]
    await reset(page, initialURL)
    const fixture = await installUploadRoutes(page, destination, { waitForComplete: true })
    try {
      const { native, wrapper } = await relationshipWrapper(page, destination)
      await wrapper.getByRole('button', { name: 'Enviar novo arquivo', exact: true }).click()
      await page.getByLabel('Escolha um arquivo', { exact: true }).setInputFiles(validFile(destination))
      await fixture.chunkStarted.promise
      const galleryRow = native.locator('xpath=ancestor::*[contains(@class,"array-field__row") or contains(@class,"array-row")]').first()
      const remove = galleryRow.getByRole('button', { name: /remover|remove|delete|excluir/iu }).first()
      const move = galleryRow.getByRole('button', { name: /mover|move|reordenar|reorder/iu }).first()
      if (await remove.count()) await remove.click()
      else if (await move.count()) await move.click()
      else throw new Error('native_gallery_remove_or_reorder_control_missing')
      fixture.allowComplete.resolve()
      await page.getByRole('alert').filter({ hasText: /destino mudou|seleção.*desativada/iu }).waitFor({ state: 'visible' })
      const useFile = page.getByRole('button', { name: 'Usar este arquivo', exact: true })
      assert(await useFile.count() === 0 || await useFile.isDisabled(), 'gallery_reorder_or_removal_kept_selection_enabled')
    } finally { fixture.allowComplete.resolve(); await fixture.cleanup() }
  }))

  results.push(await collect('document navigation during upload never selects into the new document', async () => {
    const destination = MEDIA[3]
    await reset(page, initialURL)
    const fixture = await installUploadRoutes(page, destination, { waitForComplete: true })
    try {
      await page.getByRole('button', { name: 'Enviar novo arquivo', exact: true }).nth(3).click()
      await page.getByLabel('Escolha um arquivo', { exact: true }).setInputFiles(validFile(destination))
      await fixture.chunkStarted.promise
      const nextDocument = new URL('/editorial/admin/collections/portal-pages/create', fixture.origin).toString()
      await page.goto(nextDocument, { waitUntil: 'domcontentloaded' })
      fixture.allowComplete.resolve()
      await page.getByRole('button', { name: 'Salvar versão', exact: true }).waitFor({ state: 'visible' })
      assert(await page.getByRole('button', { name: 'Usar este arquivo', exact: true }).count() === 0,
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
    const altInput = page.getByLabel('Texto alternativo', { exact: true }).first()
    const altBefore = await altInput.inputValue().catch(() => '')
    const altRequired = await altInput.getAttribute('aria-required') ?? await altInput.getAttribute('required')
    const videoTitle = page.getByLabel('Título do vídeo', { exact: true })
    const titleBefore = await videoTitle.inputValue().catch(() => '')
    const titleRequired = await videoTitle.getAttribute('aria-required') ?? await videoTitle.getAttribute('required')
    const result = await uploadThroughSelection(page, initialURL, destination)
    await assertNativeID(wrapper, destination.path, result.id)
    assert(altRequired === 'true' || altRequired === '', 'native_alt_text_is_no_longer_required')
    assert(await altInput.inputValue().catch(() => '') === altBefore,
      'upload_overwrote_native_alt_text')
    assert(titleRequired === 'true' || titleRequired === '', 'native_video_title_is_no_longer_required')
    assert(await page.getByLabel('Título do vídeo', { exact: true }).inputValue().catch(() => '') === titleBefore,
      'upload_overwrote_native_title')
    if (await publish.count()) assert(await publish.isDisabled(), 'uploaded_relationship_did_not_invalidate_Task_2_confirmation')
    assert(await page.locator('.portal-page-media-field').count() >= 5, 'remount_only_selector_preserves_the_native_wrapper_and_focus')
  }))

  return results
}
