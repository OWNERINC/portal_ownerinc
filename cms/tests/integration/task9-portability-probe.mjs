// Public-history ambiguity proof, NOT a passing fallback/browser support test.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
const { chromium } = createRequire(path.join(process.env.LOCALAPPDATA, 'Temp/opencode/package.json'))('playwright')
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const deadline = setTimeout(() => { void browser.close().finally(() => process.exit(1)) }, 30000)
try {
  const outcomes = []
  for (const operation of ['replace', 'branch-push']) {
    const page = await browser.newPage()
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<p>Public history fixture</p>' }))
    await page.goto('http://task9-portability.test/A')
    const result = await page.evaluate(async operation => {
      Object.defineProperty(window, 'navigation', { value: undefined }) // simulated absence only
      history.replaceState({ ownerinc: { index: 0, key: 'A' } }, '', '/A')
      history.pushState({ ownerinc: { index: 1, key: 'B' } }, '', '/B')
      history.pushState({ ownerinc: { index: 2, key: 'C' } }, '', '/C')
      await new Promise(resolve => { addEventListener('popstate', resolve, { once: true }); history.back() })
      const before = { path: location.pathname, state: history.state, length: history.length }
      // Both are legal public router actions preserving user-owned state.
      if (operation === 'replace') history.replaceState({ ...history.state }, '', '/D')
      else history.pushState({ ...history.state }, '', '/D')
      const hookObservation = { path: location.pathname, state: history.state, length: history.length }
      await new Promise(resolve => { addEventListener('popstate', resolve, { once: true }); history.back() })
      return { before, hookObservation, backDestination: location.pathname }
    }, operation)
    outcomes.push(result); console.log(JSON.stringify({ operation, ...result })); await page.close()
  }
  assert.deepEqual(outcomes[0].before, outcomes[1].before)
  assert.deepEqual(outcomes[0].hookObservation, outcomes[1].hookObservation)
  assert.equal(outcomes[0].backDestination, '/A')
  assert.equal(outcomes[1].backDestination, '/B')
  console.log(`AMBIGUITY CONFIRMED ${browser.version()}: identical public hook observations, different physical entry positions. Navigation absence simulated; no fallback accepted.`)
} finally { clearTimeout(deadline); await browser.close() }
