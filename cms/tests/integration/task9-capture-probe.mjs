// Standalone browser proof. No services, database, framework or private state.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
const ts = createRequire(new URL('../../package.json', import.meta.url))('typescript')
const coordinator = ts.transpileModule((await readFile(new URL('./fixtures/polls-history-candidate.ts', import.meta.url), 'utf8')).replaceAll('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const require = createRequire(path.join(process.env.LOCALAPPDATA, 'Temp/opencode/package.json'))
const { chromium } = require('playwright')
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const deadline = setTimeout(() => { void browser.close().finally(() => process.exit(1)) }, 60000)
let passed = 0
try {
  console.log('Browser', browser.version())
  for (const transport of ['toolbar', 'history-api']) for (const direction of ['back', 'forward']) for (const mode of ['dirty', 'pending', 'clean']) {
    const page = await browser.newPage(); page.setDefaultTimeout(5000)
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<input value="retained"><button id="go">Traverse</button><p id="render">B</p>' }))
    await page.goto('http://task9-capture.test/A')
    await page.addScriptTag({ content: coordinator })
    await page.evaluate(async ({ direction, mode }) => {
      history.pushState({ route: 'B' }, '', '/B'); history.pushState({ route: 'C' }, '', '/C')
      await new Promise(resolve => { window.addEventListener('popstate', resolve, { once: true }); history.back() })
      const origin = navigation.currentEntry.index
      window.proof = { attempts: [], mode, allow: false, origin, renders: 0 }
      document.querySelector('#go').onclick = () => history[direction]()
      window.addEventListener('popstate', event => {
        const state = window.proof, attempt = state.attempts.at(-1), index = navigation.currentEntry.index
        attempt.events.push({ index })
        if (index === origin && !state.allow) attempt.result = 'retained'
      }, true)
      window.confirm = () => { window.proof.attempts.at(-1).decision = window.proof.allow ? 'discard' : 'stay'; return window.proof.allow }
      window.watchPollHistory(() => ({ dirty: window.proof.mode === 'dirty', pending: window.proof.mode === 'pending' }))
      history.replaceState({ route: 'B', native: true }, '', '/B')
      window.addEventListener('popstate', () => { window.proof.renders++; window.proof.attempts.at(-1).result = 'departed'; document.querySelector('#render').textContent = location.pathname })
    }, { direction, mode })
    for (let invocation = 1; invocation <= (mode === 'clean' ? 1 : 3); invocation++) {
      await page.evaluate(({ invocation, mode }) => {
        window.proof.attempts.push({ invocation, events: [], result: null })
        if (invocation === 3) { window.proof.allow = true; if (mode === 'pending') window.proof.mode = 'clean' }
      }, { invocation, mode })
      if (transport === 'history-api') await page.locator('#go').click()
      else {
        const driver = await page.context().newCDPSession(page)
        try { const { currentIndex, entries } = await driver.send('Page.getNavigationHistory'); await driver.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex + (direction === 'back' ? -1 : 1)].id }) } finally { await driver.detach() }
      }
      await page.waitForFunction(() => window.proof.attempts.at(-1).result !== null)
      const result = await page.evaluate(() => ({ ...window.proof, path: location.pathname, value: document.querySelector('input').value }))
      const departure = mode === 'clean' || invocation === 3
      assert.equal(result.attempts.at(-1).result, departure ? 'departed' : 'retained')
      assert.equal(result.path, departure ? direction === 'back' ? '/A' : '/C' : '/B')
      assert.equal(result.renders, departure ? 1 : 0)
      assert.equal(result.value, 'retained')
      assert.ok(result.attempts.at(-1).events.length >= (departure ? 1 : 2))
      console.log(JSON.stringify({ transport, direction, mode, ...result.attempts.at(-1), path: result.path, renders: result.renders }))
    }
    passed++; await page.close()
  }
  console.log(`PASS ${passed}/12 standalone capture/restore scenarios`)
} finally { clearTimeout(deadline); await browser.close() }
