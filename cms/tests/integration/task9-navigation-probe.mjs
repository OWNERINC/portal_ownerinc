import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { captureTask9Screenshot, captureWithTemporaryDOMMask, runTask9Operation, safeBrowserPath } from './task9-browser-observability.mjs'

const targetLabels = new Set(['Voltar à central editorial', 'Ler Owner News'])
const allowedClasses = new Set([
  'portal-navigation', 'nav', 'nav__wrap', 'template-default', 'template-default__wrap',
  'field-label', 'field-type', 'field-type__wrap', 'form', 'collection-edit', 'doc-controls',
])

/** Read only: no clicks, keyboard activation, form edits, requests or database access. */
export async function probeEditorialDestinationHitTest({ page, origin, directory, documentId, signal }) {
  assert.match(documentId, /^[0-9a-f-]{36}$/iu, 'probe requires the already-owned synthetic R9 draft ID')
  const evidencePath = path.join(directory, 'r9-navigation-readonly-probe.json')
  const screenshotPath = path.join(directory, 'r9-navigation-readonly-probe.png')
  const unexpectedWrites = []
  const requests = []
  const responses = []
  const onRequest = request => {
    const url = new URL(request.url())
    if (url.origin !== origin) return
    const path = safeBrowserPath(request.url(), [origin])
    const relevant = path === '/editorial/api/news-articles/[id]' || path === '/editorial/admin/collections/news-articles/[id]'
      || path === '/editorial/api/portal-editors/me'
    if (relevant && requests.length < 80) requests.push({ method: request.method(), path })
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())
      && (path === '/editorial/api/news-articles/[id]' || path === '/editorial/api/news-articles')) {
      unexpectedWrites.push({ method: request.method(), path })
    }
  }
  const onResponse = response => {
    if (responses.length >= 50) return
    const url = new URL(response.url())
    if (url.origin === origin && (url.pathname.startsWith('/editorial/api/news-articles')
      || url.pathname.startsWith('/editorial/admin/collections/news-articles'))) {
      responses.push({ method: response.request().method(), path: safeBrowserPath(response.url(), [origin]), status: response.status() })
    }
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${origin}/editorial/admin/collections/news-articles/${documentId}`)
    await page.getByLabel('Data da fonte (AAAA-MM-DD)', { exact: true }).waitFor({ state: 'visible', timeout: 20000 })
    const initial = await measure(page, origin)

    // R9 took a scoped fieldset screenshot immediately before the failed click;
    // reproduce its scroll-to-editor effect without taking an unmasked capture.
    await page.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'Informações editoriais' }) }).scrollIntoViewIfNeeded()
    const afterEditorScroll = await measure(page, origin)

    let screenshotError = null
    try {
      await captureWithTemporaryDOMMask({
        page,
        signal,
        prepare: () => {
          const originals = []
          const mark = element => {
            originals.push([element, element.getAttribute('data-task9-observable')])
            element.setAttribute('data-task9-observable', 'allow')
          }
          for (const link of document.querySelectorAll('.portal-navigation a')) {
            if (['Voltar à central editorial', 'Ler Owner News'].includes(link.textContent?.trim() || '')) mark(link)
          }
          for (const label of document.querySelectorAll('label')) if (label.textContent?.trim() === 'Category') mark(label)
          Object.defineProperty(window, '__task9NavProbeMaskOriginals', { configurable: true, value: originals })
        },
        capture: () => captureTask9Screenshot(signal, options => page.screenshot(options), screenshotPath,
          { fullPage: false, animations: 'disabled', timeout: 5000 }),
        restore: () => {
          for (const [element, previous] of window.__task9NavProbeMaskOriginals || []) {
            if (previous === null) element.removeAttribute('data-task9-observable')
            else element.setAttribute('data-task9-observable', previous)
          }
          delete window.__task9NavProbeMaskOriginals
        },
      })
    } catch (error) { screenshotError = error?.name || 'capture-error' }

    const evidence = {
      probe: 'R9 navigation hit-test read-only; not destination acceptance',
      documentId: '[existing-synthetic-draft]',
      documentPath: safeBrowserPath(page.url(), [origin]),
      viewport: { width: 1440, height: 900 },
      stages: { initial, afterEditorScroll },
      network: { observedRequests: requests, articleResponses: responses, unexpectedWriteMethodsObserved: unexpectedWrites },
      actions: { clicked: false, keyboardActivated: false, formEdited: false, published: false, destinationNavigation: false },
      screenshot: screenshotError ? null : path.basename(screenshotPath),
      screenshotError,
      conclusion: classify(afterEditorScroll),
    }
    await runTask9Operation(signal, 'writeFile', () => writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 }))
    return { evidence: evidencePath, screenshot: screenshotError ? null : screenshotPath, result: evidence }
  } finally {
    if (!signal?.aborted) {
      page.off('request', onRequest)
      page.off('response', onResponse)
    }
  }
}

async function measure(page, origin) {
  return page.evaluate(({ origin: expectedOrigin, targets, classAllowlist }) => {
    const targetSet = new Set(targets)
    const classes = new Set(classAllowlist)
    const rect = element => {
      if (!element) return null
      const value = element.getBoundingClientRect()
      return Object.fromEntries(['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height'].map(key => [key, Math.round(value[key] * 100) / 100]))
    }
    const describe = element => {
      if (!element) return null
      const style = getComputedStyle(element)
      const text = element.tagName === 'LABEL' && element.textContent?.trim() === 'Category'
        ? 'Category'
        : element.tagName === 'A' && targetSet.has(element.textContent?.trim() || '') ? element.textContent.trim() : ''
      const url = element.tagName === 'A' ? new URL(element.href, location.href) : null
      const safePath = url?.origin === expectedOrigin && ['/cms.html', '/announcements.html'].includes(url.pathname) ? url.pathname : null
      return {
        tag: element.tagName.toLowerCase(),
        classes: [...element.classList].filter(name => classes.has(name)).sort(),
        label: text,
        destination: safePath,
        rect: rect(element),
        computed: {
          display: style.display, position: style.position, zIndex: style.zIndex,
          pointerEvents: style.pointerEvents, visibility: style.visibility, opacity: style.opacity,
          overflowX: style.overflowX, overflowY: style.overflowY, transform: style.transform,
          contain: style.contain, isolation: style.isolation, clipPath: style.clipPath,
        },
      }
    }
    const chain = (element, limit = 10) => {
      const result = []
      for (let current = element; current && result.length < limit; current = current.parentElement) result.push(describe(current))
      return result
    }
    const links = [...document.querySelectorAll('.portal-navigation a')].filter(anchor => targetSet.has(anchor.textContent?.trim() || ''))
    const nav = document.querySelector('.portal-navigation')
    const category = [...document.querySelectorAll('label')].find(label => label.textContent?.trim() === 'Category')
    const editor = document.querySelector('.template-default__wrap')
    const linkResults = links.map(link => {
      const bounds = link.getBoundingClientRect()
      const inViewport = bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0
        && bounds.left < innerWidth && bounds.top < innerHeight
      const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2
      const hit = inViewport ? document.elementFromPoint(x, y) : null
      return {
        element: describe(link), clientRects: [...link.getClientRects()].map(item => ({ x: item.x, y: item.y, width: item.width, height: item.height })),
        centerHit: inViewport ? describe(hit) : { result: 'outside-viewport' },
        centerHitInsideLink: Boolean(hit && (hit === link || link.contains(hit))),
        ancestorChain: chain(link),
      }
    })
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      scroll: { x: scrollX, y: scrollY, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight },
      links: linkResults,
      category: describe(category), categoryAncestorChain: chain(category),
      editorWrapper: describe(editor), editorAncestorChain: chain(editor),
      navigation: describe(nav), navigationAncestorChain: chain(nav),
    }
  }, {
    origin,
    targets: ['Voltar à central editorial', 'Ler Owner News'],
    classAllowlist: [...allowedClasses],
  })
}

function classify(stage) {
  const link = stage.links.find(item => item.element.label === 'Voltar à central editorial')
  if (!link) return 'unknown: approved CMS destination link not found in measured DOM'
  if (link.centerHit?.tag === 'label' && link.centerHit?.label === 'Category' && !link.centerHitInsideLink) {
    return 'confirmed: Category label receives elementFromPoint at CMS link center'
  }
  if (link.centerHitInsideLink) return 'not-reproduced: CMS link is topmost at its center in this measured state'
  return 'unknown: different or unclassified element receives hit-test'
}
