// Focused browser acceptance for Task9's native atomic editorial JSON field.
// Runs against dedicated existing Task9 DBs; only creates a synthetic document.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { captureTask9Screenshot, captureWithTemporaryDOMMask, readSanitizedEditorialNavigation, runTask9Operation, safeBrowserPath, safeEditorialDestination, safeEventMessage } from './task9-browser-observability.mjs'
export async function checkNativeMetadata({ context, origin, directory, signal, registerCleanup }) {
  const require = createRequire(path.join(process.cwd(), 'api/package.json'))
  const { Pool } = require('pg')
  const cms = new Pool({ connectionString: process.env.CMS_DATABASE_URL })
  const unregisterCleanup = registerCleanup?.(() => cms.end()) || (() => {})
  const guardedCMS = createGuardedPool(cms, signal)
  const page = await context.newPage()
  const runId = `T9META-${Date.now()}`
  let documentId = ''
  const errors = []
  const browserEvents = { console: [], requestFailed: [], responses: [], pageErrors: [], windowErrors: [] }
  let storageDiagnostic = null
  let fixtureSetupDiagnostic = null
  const writeArtifact = (target, content, options) => runTask9Operation(signal, 'writeFile', () => writeFile(target, content, options))
  page.on('pageerror', error => {
    errors.push(error.name)
    browserEvents.pageErrors.push({ name: sanitize(error.name), message: safeEventMessage(error.message) })
  })
  page.on('console', message => browserEvents.console.push({ type: message.type(), text: safeEventMessage(message.text()) }))
  page.on('requestfailed', request => browserEvents.requestFailed.push({ method: request.method(), path: safeRequestPath(request.url()), error: safeEventMessage(request.failure()?.errorText || '') }))
  page.on('response', response => {
    const responseURL = new URL(response.url())
    const pathname = responseURL.pathname
    if (responseURL.origin === origin && (pathname.startsWith('/editorial/') || pathname.startsWith('/api/'))) browserEvents.responses.push({
      method: response.request().method(), path: safeRequestPath(response.url()), status: response.status(),
      autosave: responseURL.searchParams.get('autosave') === 'true',
    })
    else if (responseURL.origin === origin && pathname.startsWith('/_next/static/')) browserEvents.responses.push({
      method: response.request().method(), path: safeRequestPath(response.url()), status: response.status(),
    })
  })
  try {
    assertRunActive(signal)
    // Passive diagnostics only: retain bounded error names/messages, without stacks,
    // request bodies, DOM values, or preventing normal browser error handling.
    await page.addInitScript(() => {
      const entries = []
      Object.defineProperty(window, '__task9R8ClientErrors', { value: entries, configurable: false })
      const push = (type, value) => {
        if (entries.length >= 30) return
        const error = value instanceof Error ? value : null
        const objectMessage = value && typeof value === 'object' && 'message' in value ? value.message : ''
        entries.push({
          type,
          name: error?.name || (type === 'window.error' ? 'ErrorEvent' : 'UnhandledRejection'),
          message: String(error?.message || objectMessage || (typeof value === 'string' ? value : '')).slice(0, 800),
        })
      }
      window.addEventListener('error', event => push('window.error', event.error || event.message), true)
      window.addEventListener('unhandledrejection', event => push('unhandledrejection', event.reason), true)
    })
    // Legacy editorial=null UI remains PENDING the authorized native import fixture.
    // This independent subset starts from the existing valid incomplete draft builder.
    const initialEditorial = { version: 1, kind: 'article', summary: '', author: '', source_label: '', source_date: null }
    const createResponse = await page.request.post(`${origin}/editorial/api/news-articles?draft=true&depth=0`, {
      data: { _status: 'draft', editorial: initialEditorial },
      headers: { 'Content-Type': 'application/json', Origin: origin, Referer: `${origin}/editorial/admin` },
    })
    const createBody = await createResponse.json().catch(() => null)
    const created = createBody && typeof createBody === 'object' ? (createBody.doc || createBody) : null
    const candidateID = created && typeof created === 'object' && typeof created.id === 'string' && /^[0-9a-f-]{36}$/iu.test(created.id) ? created.id : ''
    const createErrors = Array.isArray(createBody?.errors) ? createBody.errors.map(error => ({
      name: sanitize(error?.name || ''), message: safeEventMessage(error?.message || ''),
      field: typeof error?.data?.path === 'string' ? sanitize(error.data.path) : '',
    })) : []
    fixtureSetupDiagnostic = { method: 'POST', path: '/editorial/api/news-articles?draft=true&depth=0', status: createResponse.status(),
      createdDocumentId: candidateID ? '[synthetic-id]' : null, selectedErrors: createErrors }
    if (!createResponse.ok() || !candidateID) {
      const fixturePath = path.join(directory, `native-metadata-${runId}-fixture-rejected.json`)
      await writeArtifact(fixturePath, JSON.stringify({ scenarioId: runId, classification: 'DIAGNOSTIC — valid incomplete native draft creation failed',
        create: fixtureSetupDiagnostic, legacyNullUI: 'PENDING authorized importer fixture', noArticleUIOpened: true }, null, 2), { mode: 0o600 })
      console.error(JSON.stringify({ fixtureRejected: true, status: createResponse.status(), errorCount: createErrors.length, evidence: path.basename(fixturePath) }))
      throw new Error(`Payload native incomplete-draft API failed (HTTP ${createResponse.status()})`)
    }
    documentId = candidateID
    const state = await guardedCMS.query(`SELECT a.editorial AS base_editorial, a._status AS base_status,
      v.id AS latest_version_id, v.version_editorial AS latest_editorial,
      v.version__status AS latest_status, v.latest AS is_latest, v.autosave AS is_autosave
      FROM news_articles a LEFT JOIN _news_articles_v v ON v.parent_id=a.id AND v.latest=true
      WHERE a.id=$1 ORDER BY v.updated_at DESC LIMIT 1`, [documentId])
    const draftResponse = await page.request.get(`${origin}/editorial/api/news-articles/${documentId}?draft=true&depth=0`)
    let draftDocument = null
    if (draftResponse.ok()) {
      const payload = await draftResponse.json().catch(() => null)
      const candidate = payload && typeof payload === 'object' ? (payload.doc || payload) : null
      if (candidate && typeof candidate === 'object' && candidate.id === documentId) {
        draftDocument = { id: candidate.id, status: candidate._status ?? null,
          hasEditorial: Object.hasOwn(candidate, 'editorial'), editorial: candidate.editorial ?? null }
      }
    }
    storageDiagnostic = { baseAndLatest: state.rows.map(row => ({ ...row })), draftAPI: {
      path: `/editorial/api/news-articles/${documentId}`, status: draftResponse.status(),
      document: draftDocument,
    } }
    fixtureSetupDiagnostic = { ...fixtureSetupDiagnostic, readback: storageDiagnostic }
    const coherentDraft = state.rowCount === 1 && state.rows[0].base_status === 'draft'
      && isDeepStrictEqual(state.rows[0].base_editorial, initialEditorial)
      && state.rows[0].latest_version_id && state.rows[0].latest_status === 'draft' && state.rows[0].is_latest === true
      && isDeepStrictEqual(state.rows[0].latest_editorial, initialEditorial)
      && draftResponse.ok() && draftDocument?.id === documentId
      && draftDocument.status === 'draft' && draftDocument.hasEditorial
      && isDeepStrictEqual(draftDocument.editorial, initialEditorial)
    if (!coherentDraft) {
      const fixturePath = path.join(directory, `native-metadata-${runId}-fixture-incoherent.json`)
      await writeArtifact(fixturePath, JSON.stringify({ scenarioId: runId, classification: 'DIAGNOSTIC — valid incomplete draft did not match draft API/base/latest',
        create: fixtureSetupDiagnostic, noArticleUIOpened: true, noSQLMutation: true }, null, 2), { mode: 0o600 })
      console.error(JSON.stringify({ fixtureIncoherent: true, status: draftResponse.status(), evidence: fixturePath }))
      throw new Error('Native incomplete draft did not match selected draft API and SQL base/latest; UI scenario not started')
    }
    await writeArtifact(path.join(directory, `native-metadata-${runId}-fixture-ready.json`), JSON.stringify({ scenarioId: runId,
      classification: 'Valid native draft fixture preparation only — not UI round-trip acceptance', create: fixtureSetupDiagnostic,
      persistedShape: initialEditorial, draftAPI: storageDiagnostic.draftAPI.document,
      storage: storageDiagnostic.baseAndLatest[0], legacyNullUI: 'PENDING authorized importer fixture',
      verifiedBeforeOpeningEditor: true }, null, 2), { mode: 0o600 })
    await page.goto(`${origin}/editorial/admin/collections/news-articles/${documentId}`)
    await page.waitForSelector('fieldset legend:text("Informações editoriais")', { timeout: 20000 })
    await page.getByLabel('Resumo', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Adicionar informações editoriais' }).count(), 0,
      'valid non-null drafts do not exercise the pending legacy-null initialization path')
    assert.equal(await page.getByLabel('Resumo', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('Autoria', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('Fonte', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('Data da fonte (AAAA-MM-DD)', { exact: true }).inputValue(), '')
    const kind = page.getByRole('combobox', { name: 'Tipo de publicação', exact: true })
    assert.equal(await kind.inputValue(), 'article')
    const kindOptions = await kind.locator('option').evaluateAll(options => options.map(option => ({
      value: option.value, label: option.textContent?.trim() || '',
    })))
    assert.deepEqual(kindOptions, [
      { value: 'article', label: 'Matéria' },
      { value: 'edition', label: 'Edição em PDF' },
    ])
    const sourceDate = page.getByLabel('Data da fonte (AAAA-MM-DD)', { exact: true })
    assert.equal(await sourceDate.getAttribute('type'), 'text', 'Payload TextInput accepts the exact civil-date text for server validation')
    const initialDateA11y = await inspectSourceDateA11y(sourceDate)
    assert.equal(initialDateA11y.labelTargetsInput, true)
    assert.notEqual(initialDateA11y.ariaInvalid, 'true', 'initial valid empty date must not be marked invalid')
    assert.equal(initialDateA11y.describedBy.length, 1, 'initial valid date references help only')
    assert.deepEqual(initialDateA11y.resolved.map(item => item.id), initialDateA11y.describedBy)
    assert.equal(initialDateA11y.resolved[0].visible, true)
    assert.equal(initialDateA11y.errorExists, false)
    assert.equal(initialDateA11y.duplicateIDs.length, 0)

    await page.getByLabel('Resumo', { exact: true }).fill('Resumo sintético de teste.')
    await kind.focus()
    await kind.press('ArrowDown')
    await kind.press('Enter')
    assert.equal(await kind.inputValue(), 'edition', 'native keyboard selection changes the controlled publication kind')

    // Empty author/source and null civil date are valid optional draft metadata.
    const optionalSave = await saveAndAck(page, origin, documentId)
    const expectedOptionalDraft = { version: 1, kind: 'edition', summary: 'Resumo sintético de teste.', author: '', source_label: '', source_date: null }
    assert.deepEqual(await readLatestEditorial(cms, documentId), expectedOptionalDraft)
    const optionalAPI = await readDraftDocument(page, origin, documentId)
    assert.equal(optionalAPI.status, 200)
    assert.equal(optionalAPI.document.status, 'draft')
    assert.deepEqual(optionalAPI.document.editorial, expectedOptionalDraft)

    await sourceDate.fill('2024-02-30')
    await sourceDate.blur()
    const invalidSaveResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.origin === origin && url.pathname === `/editorial/api/news-articles/${documentId}`
        && response.request().method() === 'PATCH' && url.searchParams.get('draft') === 'true'
        && url.searchParams.get('autosave') !== 'true'
    }, { timeout: 20000 })
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
    const invalidSaveResponse = await invalidSaveResponsePromise
    assert.equal(invalidSaveResponse.status(), 400, 'invalid civil date must remain rejected by Payload validation')
    const invalidResponseBody = await invalidSaveResponse.json().catch(() => null)
    assert.ok(invalidResponseBody?.errors?.some(error => error?.message === 'invalid_source_date'),
      'the 400 must carry the civil-date validation code, not an unrelated request error')
    await page.getByRole('alert').filter({ hasText: 'Data inválida. Informe uma data real no formato AAAA-MM-DD.' }).waitFor()
    assert.equal(await sourceDate.inputValue(), '2024-02-30', 'invalid civil date remains visible for correction')
    const invalidDateA11y = await inspectSourceDateA11y(sourceDate)
    assert.equal(invalidDateA11y.labelTargetsInput, true)
    assert.equal(invalidDateA11y.ariaInvalid, 'true', 'invalid input must expose aria-invalid=true')
    assert.equal(invalidDateA11y.describedBy.length, 2, 'invalid input references both help and error')
    assert.equal(invalidDateA11y.resolved.length, 2, 'all describedby references resolve inside the metadata fieldset')
    assert.deepEqual(invalidDateA11y.resolved.map(item => item.id), invalidDateA11y.describedBy)
    assert.ok(invalidDateA11y.resolved.every(item => item.visible))
    assert.equal(invalidDateA11y.errorExists, true)
    assert.deepEqual(invalidDateA11y.duplicateIDs, [], 'metadata fieldset IDs must be unique')
    const inlineError = invalidDateA11y.resolved.find(item => item.id === invalidDateA11y.errorId)
    assert.equal(inlineError?.role, 'alert')
    assert.equal(inlineError?.text, 'Data inválida. Informe uma data real no formato AAAA-MM-DD.')
    assert.deepEqual(await readLatestEditorial(cms, documentId), expectedOptionalDraft,
      'invalid civil date must not replace the last acknowledged draft')
    const afterInvalidAPI = await readDraftDocument(page, origin, documentId)
    assert.equal(afterInvalidAPI.status, 200)
    assert.equal(afterInvalidAPI.document?.status, 'draft')
    assert.deepEqual(afterInvalidAPI.document?.editorial, expectedOptionalDraft)

    await sourceDate.fill('2024-02-29')
    await sourceDate.blur()
    const correctedDateA11y = await inspectSourceDateA11y(sourceDate)
    assert.equal(correctedDateA11y.labelTargetsInput, true)
    assert.notEqual(correctedDateA11y.ariaInvalid, 'true', 'valid correction must clear aria-invalid')
    assert.equal(correctedDateA11y.describedBy.length, 1, 'valid correction must remove the error association')
    assert.deepEqual(correctedDateA11y.resolved.map(item => item.id), correctedDateA11y.describedBy)
    assert.ok(correctedDateA11y.resolved.every(item => item.visible))
    assert.equal(correctedDateA11y.errorExists, false, 'corrected date must remove the stale error node')
    assert.deepEqual(correctedDateA11y.duplicateIDs, [])
    const saved = await saveAndAck(page, origin, documentId)
    assert.ok(saved.status >= 200 && saved.status < 300)
    await waitFor(async () => {
      const value = await readLatestEditorial(cms, documentId)
      return value?.summary === 'Resumo sintético de teste.' && value?.kind === 'edition' && value?.source_date === '2024-02-29' ? value : null
    })
    const savedDraftAPI = await readDraftDocument(page, origin, documentId)
    assert.equal(savedDraftAPI.status, 200)
    assert.equal(savedDraftAPI.document.status, 'draft', 'Save Draft must not publish the synthetic document')
    const expectedValue = { version: 1, kind: 'edition', summary: 'Resumo sintético de teste.', author: '', source_label: '', source_date: '2024-02-29' }
    assert.deepEqual(savedDraftAPI.document.editorial, expectedValue)
    const savedStorage = await readEditorialStorage(cms, documentId)
    assert.equal(savedStorage.base_status, 'draft')
    assert.equal(savedStorage.latest_status, 'draft')
    assert.deepEqual(savedStorage.latest_editorial, savedDraftAPI.document.editorial)
    await page.reload()
    await page.getByLabel('Resumo', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Resumo', { exact: true }).inputValue(), 'Resumo sintético de teste.')
    assert.equal(await page.getByLabel('Autoria', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('Fonte', { exact: true }).inputValue(), '')
    assert.equal(await page.getByLabel('Data da fonte (AAAA-MM-DD)', { exact: true }).inputValue(), '2024-02-29')
    const dbValue = await readLatestEditorial(cms, documentId)
    assert.deepEqual(dbValue, expectedValue)
    const afterReloadAPI = await readDraftDocument(page, origin, documentId)
    assert.equal(afterReloadAPI.status, 200)
    assert.equal(afterReloadAPI.document.status, 'draft')
    assert.deepEqual(afterReloadAPI.document.editorial, expectedValue)
    const afterReloadStorage = await readEditorialStorage(cms, documentId)
    assert.equal(afterReloadStorage.base_status, 'draft')
    assert.equal(afterReloadStorage.latest_status, 'draft')
    assert.deepEqual(afterReloadStorage.latest_editorial, expectedValue)
    const actualFields = {
      kind: await page.getByRole('combobox', { name: 'Tipo de publicação', exact: true }).inputValue(),
      summary: await page.getByLabel('Resumo', { exact: true }).inputValue(),
      author: await page.getByLabel('Autoria', { exact: true }).inputValue(),
      source: await page.getByLabel('Fonte', { exact: true }).inputValue(),
      civilDate: await page.getByLabel('Data da fonte (AAAA-MM-DD)', { exact: true }).inputValue(),
    }
    assert.deepEqual(actualFields, { kind: 'edition', summary: expectedValue.summary, author: expectedValue.author, source: expectedValue.source_label, civilDate: expectedValue.source_date })
    const evidencePath = path.join(directory, `native-metadata-${runId}.json`)
    const uiPath = path.join(directory, `native-metadata-${runId}.png`)
    const ownedMetadataFieldset = page.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'Informações editoriais' }) })
    assert.equal(await ownedMetadataFieldset.count(), 1, 'capture only the synthetic editorial metadata fieldset')
    await captureTask9Screenshot(signal, options => ownedMetadataFieldset.screenshot(options), uiPath)
    const links = await page.locator('.portal-navigation a').evaluateAll(anchors => anchors.map(anchor => ({ label: anchor.textContent?.trim(), href: new URL(anchor.href).pathname })))
    assert.ok(links.some(link => link.label === 'Voltar à central editorial' && link.href === '/cms.html'))
    assert.ok(links.some(link => link.label === 'Ler Owner News' && link.href === '/announcements.html'))
    await page.locator('.portal-navigation a').filter({ hasText: 'Voltar à central editorial' }).click()
    await page.waitForURL(`${origin}/cms.html`)
    assert.equal((await page.request.get(`${origin}/cms.html`)).status(), 200)
    await page.goto(`${origin}/editorial/admin/collections/news-articles/${documentId}`)
    await page.locator('.portal-navigation a').filter({ hasText: 'Ler Owner News' }).click()
    await page.waitForURL(`${origin}/announcements.html`)
    assert.equal((await page.request.get(`${origin}/announcements.html`)).status(), 200)
    const serverActionPOSTs = browserEvents.responses.filter(response => response.method === 'POST'
      && response.path === '/editorial/admin/collections/news-articles/[id]')
    assert.ok(serverActionPOSTs.length > 0, 'capture actual Payload form-state Server Action POSTs')
    const failedServerActions = serverActionPOSTs.filter(response => response.status >= 400)
    assert.deepEqual(failedServerActions, [], 'Server Action 4xx includes Next Origin rejection; captured POSTs must not be rejected')
    assert.deepEqual(errors, [])
    const clientErrors = await readClientErrors()
    browserEvents.windowErrors = clientErrors
    assert.deepEqual(clientErrors, [], 'window.error/unhandledrejection diagnostics remain empty')
    await writeArtifact(evidencePath, JSON.stringify({ scenarioId: runId, documentId: '[synthetic-id]', legacyNullUI: 'PENDING authorized importer fixture',
      incompleteDraft: { nativeAPICreated: true, value: initialEditorial }, optionalDraftSave: optionalSave,
      invalidDateRejected: { input: '2024-02-30', status: invalidSaveResponse.status(), errorCode: 'invalid_source_date',
        inlineMessage: 'Data inválida. Informe uma data real no formato AAAA-MM-DD.',
        accessibility: { initial: initialDateA11y, invalid: invalidDateA11y, corrected: correctedDateA11y } },
      reloadFields: actualFields, persistedJSON: dbValue,
      draftAPI: afterReloadAPI.document, storage: afterReloadStorage, serverActionPOSTs,
      pageErrors: errors.map(message => sanitize(message).slice(0, 120)), windowErrors: clientErrors,
      browserEvents: sanitizeObject(browserEvents),
      saveAcknowledgement: saved, runtime: 'Next+PostgreSQL real; Firebase SDK/provider+hosting doubles' }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ scenarioId: runId, documentId: '[synthetic-id]', legacyNullUI: 'PENDING authorized importer fixture',
      optionalDraftSaved: true, invalidRejected: { status: invalidSaveResponse.status(), code: 'invalid_source_date', inlineMessageVisible: true },
      validSaveAcknowledged: true, reloadRoundTrip: true, cmsDestination: '/cms.html', readerDestination: '/announcements.html',
       screenshot: uiPath, evidence: evidencePath, actualFields, persistedJSON: dbValue,
      serverActionPOSTs, failedServerActions: failedServerActions.length, pageErrors: errors.length, windowErrors: clientErrors.length }))
    console.log(JSON.stringify({ scenarioId: runId, explicitDestinationsRendered: true, cmsStatus: 200, readerStatus: 200 }))
  } catch (error) {
    if (signal?.aborted) throw error
    // Capture the failing tab before finally closes it. Keep only synthetic document
    // fields, visible text, local paths and redacted diagnostics; never headers/body.
    const evidenceBase = path.join(directory, `native-metadata-${runId}-failure`)
    const screenshotPath = `${evidenceBase}.png`
    const jsonPath = `${evidenceBase}.json`
    const currentURL = page.url()
    const rawPageState = await page.evaluate(() => {
      const allowedHeadings = new Set(['Owner News', 'Sessão editorial', 'Coleções', 'Globais', 'Painel de Controle'])
      const allowedStatuses = new Set([
        'Data inválida. Informe uma data real no formato AAAA-MM-DD.', 'invalid_source_date',
        'Confira as informações editoriais.', 'Rascunho salvo.', 'Salvando…', 'Salvando...',
      ])
      const safeStatus = value => allowedStatuses.has(value) ? value : value ? '[unlisted status]' : ''
      const metadataFieldset = [...document.querySelectorAll('fieldset')].find(fieldset =>
        fieldset.querySelector('legend')?.textContent?.trim() === 'Informações editoriais')
      return {
        headingCount: document.querySelectorAll('h1, h2').length,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(alert => safeStatus(alert.textContent?.trim() || '')),
        toasts: [...document.querySelectorAll('[data-sonner-toast]')].map(toast => ({
          text: safeStatus(toast.textContent?.trim() || ''), type: toast.getAttribute('data-type'),
          visible: toast.getAttribute('data-visible'),
        })),
        liveRegions: [...document.querySelectorAll('[aria-live]')].map(region => ({
          role: region.getAttribute('role'), live: region.getAttribute('aria-live'),
          text: safeStatus(region.textContent?.trim() || ''),
        })).filter(region => region.text),
        nav: [...document.querySelectorAll('.portal-navigation a')].map(anchor => ({ label: anchor.textContent?.trim() || '', href: anchor.href })),
        formStructure: (() => {
          const allowedNames = new Set(['editorial', 'editorial-kind', 'editorial-summary', 'editorial-author', 'editorial-source-label', 'editorial-source-date'])
          const controls = [...document.querySelectorAll('input, textarea, select')].filter(control => allowedNames.has(control.getAttribute('name') || ''))
          const saveDraftButtons = [...document.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'Salvar rascunho')
          const forms = [...document.querySelectorAll('form')]
          return {
            formCount: forms.length,
            forms: forms.map(form => ({ ariaBusy: form.getAttribute('aria-busy'), disabledFieldsetCount: form.querySelectorAll('fieldset:disabled').length })),
            metadataFieldsetPresent: Boolean(metadataFieldset),
            metadataFieldsetDisabled: metadataFieldset?.matches(':disabled') ?? null,
            metadataFieldsetHidden: metadataFieldset ? metadataFieldset.hidden : null,
            ownedControls: controls.map(control => ({
              name: control.getAttribute('name'), tag: control.tagName.toLowerCase(), type: control.getAttribute('type'),
              disabled: control.matches(':disabled'), readOnly: 'readOnly' in control ? control.readOnly : null,
              ariaInvalid: control.getAttribute('aria-invalid'), ariaDescribedBy: control.getAttribute('aria-describedby'),
              labels: [...(control.labels || [])].map(label => label.textContent?.trim() || ''),
            })),
            saveDraftButtons: saveDraftButtons.map(button => ({ disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled') })),
          }
        })(),
      }
    }).catch(captureError => ({ captureError: sanitize(captureError.message), headingCount: 0, alerts: [], toasts: [], liveRegions: [], nav: [], formStructure: null }))
    const pageState = {
      ...rawPageState,
      nav: (rawPageState.nav || []).map(link => ({
        label: ['Voltar à central editorial', 'Ler Owner News', 'Sair do editorial'].includes(link.label) ? link.label : '[unlisted-link]',
        path: safeEditorialDestination(link.href, [origin]),
      })),
    }
    const windowErrors = await readClientErrors()
    browserEvents.windowErrors = windowErrors
    const evidence = {
      scenarioId: runId,
      documentId,
      failure: `${sanitize(error instanceof Error ? error.name : 'Error')}: ${safeEventMessage(error instanceof Error ? error.message : String(error))}`,
      fixtureSetup: sanitizeObject(fixtureSetupDiagnostic),
      storageDiagnostic: sanitizeObject(storageDiagnostic),
      page: { url: currentURL === 'about:blank' ? 'about:blank' : safePath(currentURL), title: safeTitle(await page.title().catch(() => '')), ...sanitizeObject(pageState) },
      pageErrors: errors.map(message => sanitize(message).slice(0, 120)),
      windowErrors,
      browserEvents: sanitizeObject(browserEvents),
    }
    if (currentURL !== 'about:blank') {
      try {
        await captureWithTemporaryDOMMask({
          page,
          signal,
          prepare: () => {
            const headings = new Set(['Owner News', 'Sessão editorial', 'Coleções', 'Globais', 'Painel de Controle'])
            const statuses = new Set(['Data inválida. Informe uma data real no formato AAAA-MM-DD.', 'invalid_source_date',
              'Confira as informações editoriais.', 'Rascunho salvo.', 'Salvando…', 'Salvando...'])
            const originals = []
            const mark = (element, attribute, value) => {
              originals.push([element, attribute, element.getAttribute(attribute)])
              element.setAttribute(attribute, value)
            }
            const fieldset = [...document.querySelectorAll('fieldset')].find(item => item.querySelector('legend')?.textContent?.trim() === 'Informações editoriais')
            if (fieldset) mark(fieldset, 'data-task9-observable', 'allow')
            for (const heading of document.querySelectorAll('h1,h2')) if (headings.has(heading.textContent?.trim() || '')) mark(heading, 'data-task9-observable', 'allow')
            for (const node of document.querySelectorAll('#editorial-entry-status,[role="status"],[role="alert"],.portal-session-status p,[data-sonner-toast]')) {
              if (statuses.has(node.textContent?.trim() || '')) mark(node, 'data-task9-observable', 'allow')
            }
            for (const anchor of document.querySelectorAll('.portal-navigation a')) {
              if (['Voltar à central editorial', 'Ler Owner News', 'Sair do editorial'].includes(anchor.textContent?.trim() || '')) mark(anchor, 'data-task9-observable', 'allow')
            }
            Object.defineProperty(window, '__task9MetadataMaskOriginals', { configurable: true, value: originals })
          },
          capture: () => captureTask9Screenshot(signal, options => page.screenshot(options), screenshotPath,
            { fullPage: true, timeout: 5000 }),
          restore: () => {
            for (const [element, attribute, previous] of window.__task9MetadataMaskOriginals || []) {
              if (previous === null) element.removeAttribute(attribute)
              else element.setAttribute(attribute, previous)
            }
            delete window.__task9MetadataMaskOriginals
          },
        })
      } catch (captureError) { evidence.screenshotError = sanitize(captureError.message) }
    } else evidence.screenshotError = 'Article UI was not opened; API fixture failed before browser scenario.'
    await writeArtifact(jsonPath, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    console.error(JSON.stringify({ failureCapture: jsonPath, screenshot: evidence.screenshotError ? null : screenshotPath, pageURL: evidence.page.url }))
    throw error
  } finally {
    if (!signal?.aborted) {
      try { await page.close() } finally { unregisterCleanup(); await cms.end() }
    }
  }

  async function saveAndAck(target, appOrigin, id) {
    const responsePromise = target.waitForResponse(response => {
      const url = new URL(response.url())
      // Payload's autosave is the same PATCH route with autosave=true; exclude
      // it so only the explicit document-save response can satisfy this ACK.
      return url.origin === appOrigin && url.pathname === `/editorial/api/news-articles/${id}`
        && response.request().method() === 'PATCH' && url.searchParams.get('draft') === 'true'
        && url.searchParams.get('autosave') !== 'true'
    }, { timeout: 20000 })
    const saveButton = target.getByRole('button', { name: 'Salvar rascunho', exact: true })
    assert.equal(await saveButton.isDisabled(), false, 'explicit Save Draft must be enabled for the modified draft')
    await saveButton.click()
    const response = await responsePromise
    assert.ok(response.status() >= 200 && response.status() < 300, `save ACK status ${response.status()}`)
    return { status: response.status(), method: response.request().method(), path: safeRequestPath(response.url()),
      documentId: '[synthetic-id]', autosave: new URL(response.url()).searchParams.get('autosave') === 'true', explicitSaveDraft: true }
  }
  async function readEditorial(_pool, id) {
    return (await guardedCMS.query('SELECT editorial FROM news_articles WHERE id=$1', [id])).rows[0]
  }
  async function readLatestEditorial(pool, id) {
    const result = await guardedCMS.query('SELECT version_editorial FROM _news_articles_v WHERE parent_id=$1 AND latest=true ORDER BY updated_at DESC LIMIT 1', [id])
    return result.rows[0]?.version_editorial ?? null
  }
  async function readEditorialStorage(pool, id) {
    const result = await guardedCMS.query(`SELECT a.editorial AS base_editorial, a._status AS base_status,
      v.id AS latest_version_id, v.version_editorial AS latest_editorial,
      v.version__status AS latest_status, v.latest AS is_latest, v.autosave AS is_autosave
      FROM news_articles a LEFT JOIN _news_articles_v v ON v.parent_id=a.id AND v.latest=true
      WHERE a.id=$1 ORDER BY v.updated_at DESC LIMIT 1`, [id])
    return result.rows[0] || null
  }
  async function readDraftDocument(target, appOrigin, id) {
    const response = await target.request.get(`${appOrigin}/editorial/api/news-articles/${id}?draft=true&depth=0`)
    const payload = response.ok() ? await response.json().catch(() => null) : null
    const document = payload && typeof payload === 'object' ? (payload.doc || payload) : null
    return { status: response.status(), path: safeRequestPath(`${appOrigin}/editorial/api/news-articles/${id}`), document: document && document.id === id
      ? { id: '[synthetic-id]', status: document._status ?? null, editorial: Object.hasOwn(document, 'editorial') ? document.editorial : undefined }
      : null }
  }
  async function inspectSourceDateA11y(locator) {
    return locator.evaluate(input => {
      const fieldset = input.closest('fieldset')
      const ids = [...(fieldset || document).querySelectorAll('[id]')].map(element => element.id)
      const describedBy = (input.getAttribute('aria-describedby') || '').split(/\s+/u).filter(Boolean)
      return {
        inputId: input.id,
        labelTargetsInput: [...(fieldset || document).querySelectorAll('label')].some(label => label.htmlFor === input.id),
        ariaInvalid: input.getAttribute('aria-invalid'),
        describedBy,
        errorId: `${input.id}-error`,
        errorExists: [...(fieldset || document).querySelectorAll('[id]')].some(element => element.id === `${input.id}-error`),
        resolved: describedBy.map(id => {
          const element = [...(fieldset || document).querySelectorAll('[id]')].find(candidate => candidate.id === id)
          return element ? {
            id, text: element.textContent?.trim() || '', role: element.getAttribute('role'),
            visible: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
          } : { id, text: '', role: null, visible: false }
        }),
        duplicateIDs: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
      }
    })
  }
  async function waitFor(operation) {
    const until = Date.now() + 15000
    while (Date.now() < until) { const value = await operation(); if (value) return value; await delay(200) }
    throw new Error('synthetic metadata draft did not persist before timeout')
  }

  function safePath(value) {
    return safeBrowserPath(value, [origin])
  }
  function safeRequestPath(value) {
    return safeBrowserPath(value, [origin])
  }
  function safeTitle(value) {
    const allowed = new Set(['Editando - News Article - Payload', 'Coleções', 'Collections - Payload', 'Sessão editorial'])
    return allowed.has(value) ? value : '[unlisted-title]'
  }
  async function readClientErrors() {
    const entries = await page.evaluate(() => Array.isArray(window.__task9R8ClientErrors) ? window.__task9R8ClientErrors : []).catch(() => [])
    const safeEntries = sanitizeObject(entries).slice(0, 30).map(entry => ({
      type: String(entry.type || '').slice(0, 40), name: String(entry.name || '').slice(0, 100),
      message: safeEventMessage(entry.message),
    }))
    return safeEntries
  }
  function assertRunActive(runSignal) {
    if (!runSignal?.aborted) return
    throw runSignal.reason instanceof Error ? runSignal.reason : new Error('Task9 metadata run aborted')
  }
  function createGuardedPool(pool, runSignal) {
    return new Proxy(pool, { get(target, property) {
      const member = Reflect.get(target, property, target)
      if (property !== 'query' || typeof member !== 'function') return member
      return (...args) => runTask9Operation(runSignal, 'query', () => Reflect.apply(member, target, args))
    } })
  }
  function sanitize(value) {
    let text = String(value ?? '')
    for (const [key, secret] of Object.entries(process.env)) {
      if (secret && (/(secret|token|cookie|database_url|password|credential)/iu.test(key) || /postgres(?:ql)?:\/\//iu.test(secret))) text = text.split(secret).join('[redacted]')
    }
    return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, '[redacted-db-url]')
      .replace(/\bhttps?:\/\/[^/?#\s]+([^\s?#]*)(?:[?#][^\s]*)?/giu, '[url]$1')
      .replace(/(authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
      .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/giu, '[synthetic-id]')
  }
  function sanitizeObject(value) {
    if (typeof value === 'string') return sanitize(value)
    if (Array.isArray(value)) return value.map(sanitizeObject)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeObject(entry)]))
    return value
  }
}
