const EDITORIAL_PATH = '/editorial/api/portal-page-editorial'
const CREATE_PATH = '/editorial/admin/collections/portal-pages/create'
const PREVIEW_LINK = 'Abrir prévia desta versão em nova aba'
const SAVE_BUTTON = 'Salvar versão'
const PUBLISH_BUTTON = 'Publicar versão salva'
const AMBIGUOUS_REVISION = {
  document_status: 'draft',
  latest: {
    version_id: '22222222-2222-4222-8222-222222222222',
    autosave: true,
    saved_at: '2026-10-19T10:00:00.000Z',
    snapshot_hash: 'a'.repeat(64),
    editable_hash: 'b'.repeat(64),
  },
  explicit: null,
}

function assert(condition, detail) {
  if (!condition) throw new Error(detail)
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function reset(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: SAVE_BUTTON, exact: true }).waitFor({ state: 'visible' })
}

async function waitEnabled(locator, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('native_editorial_button_stayed_disabled')
}

async function saveAndWaitForPreview(page) {
  const button = page.getByRole('button', { name: SAVE_BUTTON, exact: true })
  await waitEnabled(button)
  await button.click()
  await page.getByRole('status').filter({ hasText: 'Versão salva' }).waitFor({ state: 'visible' })
  await page.getByRole('link', { name: PREVIEW_LINK, exact: true }).waitFor({ state: 'visible' })
}

async function collect(name, action) {
  try {
    await action()
    return { name, status: 'PASS', detail: 'Browser assertion passed.' }
  } catch (error) {
    return { name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Runs against a real, externally prepared Payload Portal Page editor fixture.
 * The initial page must be an existing, unchanged native document with an active
 * editorial V2 session. Happy-path saves use the real Task 1 endpoint; routes are
 * intercepted only for deterministic conflict, expiry, and race cases.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Array<{name: string; status: 'PASS'|'FAIL'; detail: string}>>}
 */
export async function runEditorialControlCases(page) {
  const initialURL = page.url()
  const origin = new URL(initialURL).origin
  const createURL = new URL(CREATE_PATH, origin).toString()
  const results = []

  results.push(await collect('explicit save exposes only a safe new-tab preview link and confirmed version metadata', async () => {
    await reset(page, initialURL)
    await saveAndWaitForPreview(page)
    const preview = page.getByRole('link', { name: PREVIEW_LINK, exact: true })
    assert(await preview.getAttribute('target') === '_blank', 'preview_target_invalid')
    assert(await preview.getAttribute('rel') === 'noopener noreferrer', 'preview_rel_invalid')
    assert(await page.getByText(/versão [0-9a-f]{8}-[0-9a-f-]{27} salva em \d{4}-/iu).count() > 0,
      'confirmed_version_uuid_or_saved_at_missing')
    assert(await page.getByRole('button', { name: PUBLISH_BUTTON, exact: true }).count() === 1,
      'editorial_publish_action_duplicated')
    assert(await page.getByRole('button', { name: /^Publicar$/iu }).count() === 0,
      'native_publish_action_would_duplicate_editorial_publication')
  }))

  results.push(await collect('new-page validation keeps the native form and focuses its first invalid field', async () => {
    await reset(page, createURL)
    await page.getByLabel('Título', { exact: true }).fill('')
    await page.getByLabel('Endereço canônico', { exact: true }).fill('')
    await page.getByRole('button', { name: SAVE_BUTTON, exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Corrija os campos inválidos' }).waitFor({ state: 'visible' })
    assert(await page.getByLabel('Título', { exact: true }).evaluate(element => element === document.activeElement),
      'first_invalid_native_field_not_focused')
    assert(await page.getByLabel('Título', { exact: true }).inputValue() === '', 'native_title_value_was_replaced')
  }))

  results.push(await collect('modified fields wait for autosave and do not send an explicit POST early', async () => {
    await reset(page, initialURL)
    let saveRequests = 0
    const saveRoute = async route => {
      saveRequests += 1
      await route.continue()
    }
    await page.route(`**${EDITORIAL_PATH}/save`, saveRoute)
    try {
      await page.getByLabel('Resumo', { exact: true }).fill(`QA ${Date.now()}`)
      await page.getByRole('status').filter({ hasText: 'Aguardando salvamento automático' }).waitFor({ state: 'visible' })
      assert(await page.getByText('Aguarde o salvamento automático para salvar uma versão.', { exact: true }).count() === 1,
        'autosave_wait_explanation_invalid')
      assert(saveRequests === 0, 'save_post_sent_while_native_form_was_modified')
      const button = page.getByRole('button', { name: SAVE_BUTTON, exact: true })
      await waitEnabled(button)
      await button.click()
      await page.getByRole('status').filter({ hasText: 'Versão salva' }).waitFor({ state: 'visible' })
      assert(saveRequests === 1, 'explicit_save_did_not_follow_autosave')
    } finally { await page.unroute(`**${EDITORIAL_PATH}/save`, saveRoute) }
  }))

  results.push(await collect('confirmation shows title, version UUID and save time without a second native publish action', async () => {
    await reset(page, initialURL)
    await saveAndWaitForPreview(page)
    await page.getByRole('button', { name: PUBLISH_BUTTON, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })
    const text = await dialog.innerText()
    assert(/versão [0-9a-f]{8}-[0-9a-f-]{27}/iu.test(text), 'confirmation_version_uuid_missing')
    assert(/salva em \d{4}-\d{2}-\d{2}T/u.test(text), 'confirmation_saved_at_missing')
    assert(await dialog.getByRole('button', { name: 'Publicar esta versão', exact: true }).count() === 1,
      'publication_confirmation_button_missing_or_duplicated')
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click()
  }))

  results.push(await collect('rapid double activation sends no duplicate explicit-save POST', async () => {
    await reset(page, initialURL)
    let saveRequests = 0
    const saveRoute = async route => {
      saveRequests += 1
      await route.continue()
    }
    await page.route(`**${EDITORIAL_PATH}/save`, saveRoute)
    try {
      const button = page.getByRole('button', { name: SAVE_BUTTON, exact: true })
      await waitEnabled(button)
      await button.dblclick()
      await page.getByRole('status').filter({ hasText: 'Versão salva' }).waitFor({ state: 'visible' })
      assert(saveRequests === 1, `duplicate_save_posts:${saveRequests}`)
    } finally { await page.unroute(`**${EDITORIAL_PATH}/save`, saveRoute) }
  }))

  results.push(await collect('a delayed revision response cannot activate confirmation after document switch', async () => {
    await reset(page, initialURL)
    await saveAndWaitForPreview(page)
    const started = deferred(), release = deferred()
    const revisionRoute = async route => {
      started.resolve()
      await release.promise
      try {
        const id = new URL(route.request().url()).searchParams.get('id')
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          ...AMBIGUOUS_REVISION, id,
        }) })
      } catch { /* Navigation intentionally abandons this response. */ }
    }
    await page.route(`**${EDITORIAL_PATH}/revision?*`, revisionRoute)
    try {
      await page.getByRole('button', { name: PUBLISH_BUTTON, exact: true }).click()
      await started.promise
      await page.goto(createURL, { waitUntil: 'domcontentloaded' })
      release.resolve()
      await page.getByRole('button', { name: SAVE_BUTTON, exact: true }).waitFor({ state: 'visible' })
      assert(await page.getByRole('dialog').count() === 0, 'stale_revision_opened_confirmation_for_new_document')
      assert(await page.getByRole('link', { name: PREVIEW_LINK, exact: true }).count() === 0,
        'stale_revision_activated_preview_after_document_switch')
    } finally {
      release.resolve()
      await page.unroute(`**${EDITORIAL_PATH}/revision?*`, revisionRoute)
    }
  }))

  results.push(await collect('a local field edit during revision GET invalidates the response before POST', async () => {
    await reset(page, initialURL)
    let saveRequests = 0
    const started = deferred(), release = deferred()
    const revisionRoute = async route => {
      started.resolve()
      await release.promise
      const id = new URL(route.request().url()).searchParams.get('id')
      try {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...AMBIGUOUS_REVISION, id }) })
      } catch { /* The local edit intentionally aborts this stale response. */ }
    }
    const saveRoute = async route => { saveRequests += 1; await route.continue() }
    await page.route(`**${EDITORIAL_PATH}/revision?*`, revisionRoute)
    await page.route(`**${EDITORIAL_PATH}/save`, saveRoute)
    try {
      await page.getByRole('button', { name: SAVE_BUTTON, exact: true }).click()
      await started.promise
      const newSummary = `changed during GET ${Date.now()}`
      await page.getByLabel('Resumo', { exact: true }).fill(newSummary)
      release.resolve()
      await page.getByRole('status').filter({ hasText: 'Aguardando salvamento automático' }).waitFor({ state: 'visible' })
      assert(saveRequests === 0, 'stale_get_response_triggered_save_post')
      assert(await page.getByLabel('Resumo', { exact: true }).inputValue() === newSummary, 'local_field_change_was_lost')
    } finally {
      release.resolve()
      await page.unroute(`**${EDITORIAL_PATH}/revision?*`, revisionRoute)
      await page.unroute(`**${EDITORIAL_PATH}/save`, saveRoute)
    }
  }))

  results.push(await collect('a delayed save response cannot confirm or replace the page after document switch', async () => {
    await reset(page, initialURL)
    const started = deferred(), release = deferred()
    const saveRoute = async route => {
      started.resolve(route.request().postDataJSON())
      await release.promise
      const body = route.request().postDataJSON()
      try {
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
          id: body.id, version_id: '44444444-4444-4444-8444-444444444444',
          saved_at: '2026-10-19T10:00:00.000Z', editable_hash: 'a'.repeat(64), document_status: 'draft',
        }) })
      } catch { /* The document navigation intentionally abandons this response. */ }
    }
    await page.route(`**${EDITORIAL_PATH}/save`, saveRoute)
    try {
      const button = page.getByRole('button', { name: SAVE_BUTTON, exact: true })
      await waitEnabled(button)
      await button.click()
      await started.promise
      await page.goto(createURL, { waitUntil: 'domcontentloaded' })
      release.resolve()
      await page.getByRole('button', { name: SAVE_BUTTON, exact: true }).waitFor({ state: 'visible' })
      assert(await page.getByRole('link', { name: PREVIEW_LINK, exact: true }).count() === 0,
        'stale_save_response_activated_preview_on_new_document')
      assert(await page.getByRole('link', { name: 'Abrir página criada no editor nativo', exact: true }).count() === 0,
        'stale_save_response_replaced_new_document')
    } finally {
      release.resolve()
      await page.unroute(`**${EDITORIAL_PATH}/save`, saveRoute)
    }
  }))

  results.push(await collect('409 conflict preserves native fields and does not retry the POST', async () => {
    await reset(page, initialURL)
    const title = page.getByLabel('Título', { exact: true })
    const summary = page.getByLabel('Resumo', { exact: true })
    const titleBefore = await title.inputValue()
    const summaryBefore = await summary.inputValue()
    let posts = 0
    const saveRoute = async route => {
      posts += 1
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
        error: 'portal_page_version_conflict', message: 'conflict',
      }) })
    }
    await page.route(`**${EDITORIAL_PATH}/save`, saveRoute)
    try {
      const button = page.getByRole('button', { name: SAVE_BUTTON, exact: true })
      await waitEnabled(button)
      await button.click()
      await page.getByRole('alert').filter({ hasText: 'A página mudou desde a conferência.' }).waitFor({ state: 'visible' })
      assert(posts === 1, `conflict_post_retried:${posts}`)
      assert(await title.inputValue() === titleBefore, 'conflict_changed_native_title')
      assert(await summary.inputValue() === summaryBefore, 'conflict_changed_native_summary')
      assert(await page.getByRole('link', { name: PREVIEW_LINK, exact: true }).count() === 0,
        'conflict_left_stale_preview_authorized')
    } finally { await page.unroute(`**${EDITORIAL_PATH}/save`, saveRoute) }
  }))

  results.push(await collect('session expiry clears confirmation and prevents publication POST', async () => {
    await reset(page, initialURL)
    await saveAndWaitForPreview(page)
    let publicationPosts = 0
    const revisionRoute = async route => await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({
      error: 'editorial_session_invalid', message: 'expired',
    }) })
    const publicationRoute = async route => { publicationPosts += 1; await route.continue() }
    await page.route(`**${EDITORIAL_PATH}/revision?*`, revisionRoute)
    await page.route(`**${EDITORIAL_PATH}/publication`, publicationRoute)
    try {
      await page.getByRole('button', { name: PUBLISH_BUTTON, exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'A sessão editorial expirou. Entre novamente.' }).waitFor({ state: 'visible' })
      assert(publicationPosts === 0, 'publication_post_sent_after_session_expiry')
      assert(await page.getByRole('link', { name: PREVIEW_LINK, exact: true }).count() === 0,
        'session_expiry_left_preview_authorized')
    } finally {
      await page.unroute(`**${EDITORIAL_PATH}/revision?*`, revisionRoute)
      await page.unroute(`**${EDITORIAL_PATH}/publication`, publicationRoute)
    }
  }))

  results.push(await collect('an unrelated native modal blocks editorial actions; lock is covered by the independent gate test', async () => {
    await reset(page, initialURL)
    await saveAndWaitForPreview(page)
    let versions = page.getByRole('button', { name: /vers(ões|ions)|histórico/iu }).first()
    if (await versions.count() === 0) versions = page.getByRole('link', { name: /vers(ões|ions)|histórico/iu }).first()
    if (await versions.count() === 0) throw new Error('native_versions_modal_fixture_missing')
    await versions.click()
    await page.getByRole('button', { name: PUBLISH_BUTTON, exact: true }).waitFor({ state: 'visible' })
    assert(await page.getByRole('button', { name: PUBLISH_BUTTON, exact: true }).isDisabled(),
      'editorial_action_not_blocked_by_native_modal')
    // PortalPages intentionally has lockDocuments:false; the lock gate is exercised
    // independently in portal-page-editorial-state.test.ts without faking Payload UI state.
  }))

  results.push(await collect('native Versions and diff navigation remain available', async () => {
    await reset(page, initialURL)
    let versions = page.getByRole('button', { name: /vers(ões|ions)|histórico/iu }).first()
    if (await versions.count() === 0) versions = page.getByRole('link', { name: /vers(ões|ions)|histórico/iu }).first()
    if (await versions.count() === 0) throw new Error('native_versions_navigation_missing')
    await versions.click()
    await page.getByText(/vers(ões|ions)/iu).first().waitFor({ state: 'visible' })
    let compare = page.getByRole('button', { name: /comparar|compare|diff/iu }).first()
    if (await compare.count() === 0) compare = page.getByRole('link', { name: /comparar|compare|diff/iu }).first()
    if (await compare.count() === 0) throw new Error('native_version_diff_action_missing')
    await compare.click()
    await page.getByText(/diferenças|changes|diff/iu).first().waitFor({ state: 'visible' })
  }))

  return results
}
