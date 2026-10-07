// Actual browser history traversals, not synthetic popstate events or link clicks.
// Reuses the strictly isolated Task9 server/database/session harness.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { captureTask9Screenshot, runTask9Operation } from './task9-browser-observability.mjs'

// The Chromium browser toolbar's history command (not a synthetic DOM event).
// This also proves cancellation keeps the actual browser history index intact.
async function traverse(context, page, direction, transport) {
  if (transport === 'history-api') {
    // A real user gesture, like a control calling Next router.back/forward.
    await page.evaluate(direction => {
      document.getElementById('task9-history-trigger')?.remove()
      const button = document.createElement('button'); button.id = 'task9-history-trigger'; button.textContent = 'Task9 history traversal'
      button.onclick = () => window.history[direction](); document.body.append(button)
    }, direction)
    return page.getByRole('button', { name: 'Task9 history traversal', exact: true }).click()
  }
  const driver = await context.newCDPSession(page)
  try {
    const { currentIndex, entries } = await driver.send('Page.getNavigationHistory')
    const target = entries[currentIndex + (direction === 'back' ? -1 : 1)]
    assert.ok(target, `browser must have a ${direction} entry`)
    await driver.send('Page.navigateToHistoryEntry', { entryId: target.id })
  } finally { await driver.detach() }
}

export async function checkPollHistory({ context, origin, directory, signal }) {
  const results = [], runId = Date.now()
  for (const transport of ['toolbar', 'history-api']) for (const direction of ['back', 'forward']) for (const mode of ['dirty', 'pending', 'clean']) {
    const page = await context.newPage(), dialogs = [], pageErrors = []
    let acceptDiscard = false
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('dialog', async dialog => { dialogs.push(dialog.type()); await (acceptDiscard ? dialog.accept() : dialog.dismiss()) })
    let release, heldRequest
    try {
      await page.goto(`${origin}/editorial/admin`)
      await page.getByRole('link', { name: 'Enquetes', exact: true }).waitFor()
      const token = await page.evaluate(() => { globalThis.task9HistoryDocument = crypto.randomUUID(); return globalThis.task9HistoryDocument })
      if (await page.locator('.nav-toggler:not(.nav-toggler--is-open)').count()) await page.locator('.nav-toggler:not(.nav-toggler--is-open)').first().click()
      await page.getByRole('link', { name: 'Enquetes', exact: true }).click()
      await page.getByRole('button', { name: 'Nova enquete', exact: true }).waitFor()
      if (direction === 'forward') {
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Nova enquete' && !button.disabled))
        await page.getByRole('link', { name: /^(News Articles|Publicações)$/ }).click()
        await page.waitForURL(url => url.pathname === '/editorial/admin/collections/news-articles')
        await page.getByRole('heading', { name: /^(News Articles|Publicações)$/ }).waitFor()
        await page.waitForLoadState('networkidle')
        await page.goBack()
        await page.getByRole('button', { name: 'Nova enquete', exact: true }).waitFor()
      }
      assert.equal(await page.evaluate(() => globalThis.task9HistoryDocument), token, 'setup must use the same native Next document')
      const title = `Task9 history ${direction} ${mode} ${Date.now()}`
      await page.getByRole('button', { name: 'Nova enquete', exact: true }).click()
      await page.getByLabel('Título', { exact: false }).fill(title)
      await page.getByLabel('Pergunta', { exact: false }).fill('Escolha uma opção')
      await page.getByRole('textbox', { name: 'Opção 1', exact: false }).fill('Primeira')
      await page.getByRole('textbox', { name: 'Opção 2', exact: false }).fill('Segunda')
      if (mode === 'clean') {
        await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
        await page.getByText('Rascunho salvo.', { exact: true }).waitFor()
      }
      if (mode === 'pending') {
        let started
        const gate = new Promise(resolve => { release = resolve }), requestStarted = new Promise(resolve => { started = resolve })
        await page.route('**/editorial/api/portal-polls', async route => {
          if (route.request().method() !== 'POST') return route.continue()
          // Real SQL commit occurs, but the browser has not received its ACK yet.
          const response = await route.fetch(); assert.equal(response.status(), 201)
          heldRequest = response; started(); await gate
          await route.fulfill({ response }).catch(error => { console.log('Held ACK lifecycle:', error.message.split('\n')[0]) })
        })
        await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click()
        await Promise.race([requestStarted, delay(12000).then(() => { throw new Error('Save did not reach real server within 12s') })])
        assert.equal(await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).isDisabled(), true)
      }
      await page.evaluate(() => {
        globalThis.task9HistoryEvents = []
        window.addEventListener('popstate', () => globalThis.task9HistoryEvents.push({ type: 'popstate', path: location.pathname }))
        window.navigation?.addEventListener('navigate', event => globalThis.task9HistoryEvents.push({ type: 'navigate', navigationType: event.navigationType,
          sameDocument: event.destination.sameDocument, cancelable: event.cancelable, prevented: event.defaultPrevented }))
      })
      const attempts = []
      const historyBefore = await page.evaluate(() => ({ key: navigation.currentEntry.key, index: navigation.currentEntry.index, entries: navigation.entries().map(entry => entry.key) }))
      async function attempt(expected) {
        const before = await page.evaluate(() => globalThis.task9HistoryEvents.length)
        const dialogsBefore = dialogs.length
        await traverse(context, page, direction, transport)
        await page.waitForFunction(({ before, expected, key }) => {
          const fresh = globalThis.task9HistoryEvents.slice(before).filter(event => event.type === 'navigate' && event.navigationType === 'traverse')
          return fresh.length >= (expected === 'retained' ? 2 : 1)
            && (expected !== 'retained' || navigation.currentEntry.key === key)
        }, { before, expected, key: historyBefore.key }, { timeout: 5000 })
        if (expected === 'retained') {
          await page.waitForURL(url => url.pathname === '/editorial/admin/polls')
          assert.equal(await page.getByLabel('Título', { exact: false }).inputValue(), title)
        } else {
          await page.waitForURL(url => url.pathname === (direction === 'back' ? '/editorial/admin' : '/editorial/admin/collections/news-articles'))
          if (direction === 'forward') await page.getByRole('heading', { name: /^(News Articles|Publicações)$/ }).waitFor()
          else await page.locator('.dashboard').waitFor()
        }
        const observed = await page.evaluate(before => ({ events: globalThis.task9HistoryEvents.slice(before), key: navigation.currentEntry.key,
          index: navigation.currentEntry.index, entries: navigation.entries().map(entry => entry.key), path: location.pathname }), before)
        assert.equal(dialogs.length - dialogsBefore, mode === 'dirty' ? 1 : 0)
        if (expected === 'retained') {
          assert.equal(observed.index, historyBefore.index)
          assert.deepEqual(observed.entries, historyBefore.entries, 'restore must preserve real history entries')
        }
        attempts.push({ invocation: attempts.length + 1, decision: mode === 'dirty' ? acceptDiscard ? 'discard' : 'stay' : expected === 'retained' ? 'blocked' : 'allow',
          result: expected, dialogs: dialogs.slice(dialogsBefore), ...observed })
      }
      await attempt(mode === 'clean' ? 'departed' : 'retained')
      await delay(750)
      const stay = page.getByRole('button', { name: /Permanecer|Continuar nesta|Ficar nesta/ })
      const nativeModal = await stay.isVisible()
      if (nativeModal) { await stay.click(); await delay(250) }
      const input = page.getByLabel('Título', { exact: false })
      const result = { transport, direction, mode, path: new URL(page.url()).pathname,
        retained: new URL(page.url()).pathname === '/editorial/admin/polls' && await input.count() === 1 && await input.inputValue() === title,
        sameDocument: await page.evaluate(token => globalThis.task9HistoryDocument === token, token), dialogs, nativeModal,
        scenarioId: `HISTORY-${transport}-${direction}-${mode}`, attempts,
        events: await page.evaluate(() => globalThis.task9HistoryEvents), pageErrors, realCommitAwaitingACK: !!heldRequest }
      if (mode === 'clean') {
        await page.waitForURL(url => url.pathname === (direction === 'back' ? '/editorial/admin' : '/editorial/admin/collections/news-articles'))
        assert.equal(dialogs.length, 0)
        result.acceptedDeparture = true
      }
      results.push(result); console.log('HISTORY EVIDENCE', JSON.stringify(result))
      await captureTask9Screenshot(signal, options => page.screenshot(options),
        path.join(directory, `history-${runId}-${transport}-${direction}-${mode}.png`))
      if (result.retained) {
        await attempt('retained')
        await delay(250)
        assert.equal(await input.inputValue(), title, 'repeated cancelled/blocked traversal retains the same form')
        assert.equal(new URL(page.url()).pathname, '/editorial/admin/polls')
      }
      if (release) {
        release()
        if (result.retained) await page.getByText('Rascunho salvo.', { exact: true }).waitFor()
      }
      if (result.retained) {
        await delay(250)
        assert.equal(new URL(page.url()).pathname, '/editorial/admin/polls', 'blocked traversals must not replay after ACK')
        assert.equal(await input.inputValue(), title)
        acceptDiscard = true
        await attempt('departed')
        await page.waitForURL(url => url.pathname === (direction === 'back' ? '/editorial/admin' : '/editorial/admin/collections/news-articles'))
        assert.equal(await page.evaluate(token => globalThis.task9HistoryDocument === token, token), true)
        assert.equal(dialogs.length, mode === 'dirty' ? 3 : 0, 'exactly one confirm per dirty attempt and none during/after save ACK')
        result.acceptedDeparture = true
      }
      result.events = await page.evaluate(() => globalThis.task9HistoryEvents)
      console.log('HISTORY FINAL', JSON.stringify(result))
    } catch (error) {
      if (signal?.aborted) throw error
      console.error('HISTORY FAILURE', JSON.stringify({ transport, direction, mode, url: page.url(), dialogs,
        browser: await page.evaluate(() => ({ events: globalThis.task9HistoryEvents,
          entries: window.navigation?.entries().map(entry => ({ url: entry.url, key: entry.key })), current: window.navigation?.currentEntry?.key })) }))
      throw error
    } finally {
      if (!signal?.aborted) { release?.(); await page.close() }
    }
  }
  await runTask9Operation(signal, 'writeFile', () => writeFile(path.join(directory, `history-${runId}-results.json`), JSON.stringify(results, null, 2)))
  assert.equal(results.length, 12)
  assert.ok(results.every(result => (result.mode === 'clean' || result.retained) && result.sameDocument && result.pageErrors.length === 0), 'native Back/Forward must retain dirty/pending forms when departure is cancelled/blocked')
  assert.ok(results.every(result => result.acceptedDeparture))
  console.log('PASS actual native Next Back AND Forward: repeated cancelled dirty forms and pending real-save ACK retain inputs; explicit discard/ACK permit departure')
}
