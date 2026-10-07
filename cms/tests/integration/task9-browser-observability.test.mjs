import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { mkdtemp, readFile, readdir, rm, writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  captureOuterBrowserFailure,
  captureWithTemporaryDOMMask,
  captureTask9Screenshot,
  attachBrowserDiagnostics,
  createTask9RunGuard,
  installWindowErrorCapture,
  hasAmbiguousTask9Outcome,
  task9AmbiguousOutcomeWarning,
  redactMessage,
  readRawEditorialNavigation,
  readSanitizedEditorialNavigation,
  runBoundedTask9Cleanup,
  runWithFailureCapture,
  runTask9Operation,
  safeEventMessage,
  safeBrowserPath,
  safeTask9PageErrorSource,
  safeTask9ReaderResourcePath,
  safeEditorialDestination,
  safePublicAccessibleName,
  task9BrowserErrorCategory,
  task9PageErrorName,
  task9ResponseContentType,
  readTask9ReaderBootstrapState,
  sanitizeTask9WindowErrorCapture,
  snapshotTask9InFlightOperations,
  shouldAbortTask9Request,
  writeTask9ScreenshotArtifact,
} from './task9-browser-observability.mjs'
import { TASK9_TIME_BUDGETS, task9ChildWorkBudget, task9ParentSpawnBudget } from './task9-time-budget.mjs'
import {
  destinationIsActionable,
  captureTask9ReaderBootstrap,
  clickNativeMenuControl,
  createEditorialRequestAudit,
  readDestinationObservation,
  readNativeSidebarPublicState,
  reenterPayloadFromFreshEntry,
  waitForDestinationReadiness,
} from './task9-destination-acceptance.mjs'

const destinationExpected = {
  origin: 'http://127.0.0.1:19091',
  path: '/cms.html',
  label: 'Voltar à central editorial',
}

test('parent spawn budget includes child startup, actual work, capture, bounded cleanup, settle, and kill margin', () => {
  for (const mode of ['--destinations', '--metadata', '--entry-probe', '--nav-probe', '--http', '--browser']) {
    const parent = task9ParentSpawnBudget(mode)
    const childDeadline = task9ChildWorkBudget(mode)
    assert.equal(parent, TASK9_TIME_BUDGETS.parentStartupMs + childDeadline + TASK9_TIME_BUDGETS.captureMs
      + TASK9_TIME_BUDGETS.cleanupMs + TASK9_TIME_BUDGETS.settleMs + TASK9_TIME_BUDGETS.parentKillGraceMs)
    assert.ok(TASK9_TIME_BUDGETS.cleanupWorkMs < TASK9_TIME_BUDGETS.cleanupMs, 'outer cleanup envelope has room for the cleanup helper to return')
    assert.ok(parent > childDeadline + TASK9_TIME_BUDGETS.captureMs + TASK9_TIME_BUDGETS.cleanupMs + TASK9_TIME_BUDGETS.settleMs)
  }
  assert.equal(task9ChildWorkBudget('--destinations'), 180000)
  assert.equal(task9ParentSpawnBudget('--destinations'), 243000)
  assert.equal(task9ParentSpawnBudget('--http'), 263000)
})

test('abort route fence is inactive before deadline and blocks new matched requests afterward', () => {
  const signal = { aborted: false }
  assert.equal(shouldAbortTask9Request(signal), false)
  signal.aborted = true
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
    assert.equal(shouldAbortTask9Request(signal, method), true, `abort matched ${method} request`)
  }
})

test('cleanup phases consume one finite shared deadline and report later skipped phases', async () => {
  const calls = []
  const failures = await runBoundedTask9Cleanup([
    { name: 'stuck-first', run: async () => { calls.push('stuck-first'); await new Promise(() => {}) } },
    { name: 'must-not-run-late', run: async () => { calls.push('must-not-run-late') } },
  ], 10)
  assert.deepEqual(calls, ['stuck-first'])
  assert.equal(failures.length, 2)
  assert.ok(failures.every(error => error.name === 'TimeoutError'))
})

test('same-label concurrent operations retain accurate pending count and ambiguity through cleanup and settle', async () => {
  for (const firstResult of ['fulfilled', 'rejected']) {
    const controllerSignal = { current: null }
    let releaseFirst
    let rejectFirst
    let releaseSecond
    let followOnEffects = 0
    let capturedDeadline
    let primaryError
    const firstOperation = new Promise((resolve, reject) => { releaseFirst = resolve; rejectFirst = reject })
    const secondOperation = new Promise(resolve => { releaseSecond = resolve })
    const firstDone = () => firstResult === 'fulfilled' ? releaseFirst('first-result') : rejectFirst(new Error('first-operation-failed'))

    try {
      await runWithFailureCapture(async signal => {
        controllerSignal.current = signal
        const first = runTask9Operation(signal, 'context.request.fetch', () => firstOperation)
        const second = runTask9Operation(signal, 'context.request.fetch', () => secondOperation)
        firstDone()
        if (firstResult === 'rejected') await first.catch(() => {})
        else await first
        const pendingSnapshot = snapshotTask9InFlightOperations(signal)
        assert.equal(pendingSnapshot.count, 1)
        assert.deepEqual(pendingSnapshot.operations, [{ label: 'context.request.fetch', count: 1 }])

        const results = await Promise.allSettled([first, second])
        assert.equal(results[0].status, firstResult)
        assert.equal(results[1].status, 'rejected', 'post-deadline settlement must not continue as success')
        if (!signal.aborted) followOnEffects++
      }, {
        timeoutMs: 25,
        captureTimeoutMs: 100,
        cleanupTimeoutMs: 100,
        settleTimeoutMs: 100,
        capture: async error => {
          capturedDeadline = {
            count: error.task9InFlightOperationCount,
            operations: error.task9InFlightOperations,
            ambiguous: hasAmbiguousTask9Outcome(error),
          }
        },
        cleanup: async () => { releaseSecond('late-second-result') },
      })
    } catch (error) { primaryError = error }

    assert.equal(primaryError?.name, 'TimeoutError')
    assert.equal(capturedDeadline?.count, 1)
    assert.deepEqual(capturedDeadline?.operations, [{ label: 'context.request.fetch', count: 1 }])
    assert.equal(capturedDeadline?.ambiguous, true)
    assert.equal(primaryError.task9InFlightOperationCount, 1, 'settlement after cleanup must not erase the abort-time snapshot')
    assert.equal(hasAmbiguousTask9Outcome(primaryError), true, 'ambiguity warning survives the full cleanup/settle lifecycle')
    assert.deepEqual(snapshotTask9InFlightOperations(controllerSignal.current), { count: 0, operations: [] })
    assert.equal(followOnEffects, 0)
  }
})

test('ordinary Promise.all rejection snapshots and aborts its pending same-label sibling before capture', async () => {
  let rejectFirst
  let releaseSecond
  let notifyStarted
  let startedCount = 0
  const bothStarted = new Promise(resolve => { notifyStarted = resolve })
  const firstRequest = new Promise((_, reject) => { rejectFirst = reject })
  const secondRequest = new Promise(resolve => { releaseSecond = resolve })
  const originalError = new Error('first concurrent request failed')
  const originalStack = originalError.stack
  let runSignal
  let captured
  let navigationEffects = 0
  let artifactWrites = 0

  const execution = runWithFailureCapture(signal => {
    runSignal = signal
    const first = runTask9Operation(signal, 'context.request.fetch', () => {
      if (++startedCount === 2) notifyStarted()
      return firstRequest
    })
    const second = runTask9Operation(signal, 'context.request.fetch', () => {
      if (++startedCount === 2) notifyStarted()
      return secondRequest
    })
    return Promise.all([first, second]).then(() => {
      navigationEffects++
      artifactWrites++
    })
  }, {
    timeoutMs: 500,
    captureTimeoutMs: 100,
    cleanupTimeoutMs: 100,
    settleTimeoutMs: 100,
    capture: async error => {
      captured = {
        samePrimaryObject: error === originalError,
        count: error.task9InFlightOperationCount,
        operations: error.task9InFlightOperations,
        warning: task9AmbiguousOutcomeWarning(error),
        signalAborted: runSignal.aborted,
        signalReasonIsPrimary: runSignal.reason === originalError,
      }
    },
    cleanup: async () => { releaseSecond('late response') },
  }).catch(error => error)

  await bothStarted
  rejectFirst(originalError)
  const finalError = await execution

  assert.equal(finalError, originalError, 'the original rejection object remains the terminal error')
  assert.equal(finalError.stack, originalStack, 'primary stack identity/content is preserved')
  assert.deepEqual(captured, {
    samePrimaryObject: true,
    count: 1,
    operations: [{ label: 'context.request.fetch', count: 1 }],
    warning: 'AMBIGUOUS — an already-dispatched operation may have completed; no automatic retry; external effects cannot be undone by this harness',
    signalAborted: true,
    signalReasonIsPrimary: true,
  })
  assert.equal(hasAmbiguousTask9Outcome(finalError), true, 'ordinary rejection ambiguity survives cleanup and settle')
  assert.equal(task9AmbiguousOutcomeWarning(finalError), captured.warning, 'serialized failure artifact warning survives cleanup/settle unchanged')
  assert.deepEqual(snapshotTask9InFlightOperations(runSignal), { count: 0, operations: [] })
  assert.equal(navigationEffects, 0, 'Promise.all rejection cannot advance to a follow-on navigation')
  assert.equal(artifactWrites, 0, 'Promise.all rejection cannot write a later artifact')
})

test('failure context preserves primitive and frozen primary rejections in the actual outer artifact', async () => {
  const cases = [
    { label: 'string', value: 'untrusted original rejection text' },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'symbol', value: Symbol('not serialized') },
    { label: 'frozen-error', value: Object.freeze(new Error('frozen original error')) },
  ]
  for (const { label, value } of cases) {
    const directory = await mkdtemp(path.join(tmpdir(), 'task9-failure-context-'))
    let rejectFirst
    let releaseSecond
    let notifyStarted
    let startedCount = 0
    let runSignal
    let receivedContext
    let navigationEffects = 0
    let artifactWrites = 0
    const bothStarted = new Promise(resolve => { notifyStarted = resolve })
    const firstMutation = new Promise((_, reject) => { rejectFirst = reject })
    const secondMutation = new Promise(resolve => { releaseSecond = resolve })

    const execution = runWithFailureCapture(signal => {
      runSignal = signal
      const first = runTask9Operation(signal, 'context.request.post', () => {
        if (++startedCount === 2) notifyStarted()
        return firstMutation
      })
      const second = runTask9Operation(signal, 'context.request.post', () => {
        if (++startedCount === 2) notifyStarted()
        return secondMutation
      })
      return Promise.all([first, second]).then(() => {
        navigationEffects++
        artifactWrites++
      })
    }, {
      timeoutMs: 1000,
      captureTimeoutMs: 1000,
      cleanupTimeoutMs: 1000,
      settleTimeoutMs: 1000,
      capture: async (primary, captureSignal, failureContext) => {
        assert.equal(Object.is(primary, value), true, `${label}: capture receives the exact rejection value`)
        receivedContext = failureContext
        await captureOuterBrowserFailure({
          browser: { contexts: () => [] }, directory, allowedOrigins: [], events: {},
          error: primary, signal: captureSignal, failureContext,
        })
      },
      cleanup: async () => { releaseSecond('late mutation response') },
    }).then(
      result => ({ fulfilled: true, result }),
      reason => ({ fulfilled: false, reason }),
    )

    try {
      await bothStarted
      rejectFirst(value)
      const result = await execution
      assert.equal(result.fulfilled, false, `${label}: rejected work remains rejected`)
      assert.equal(Object.is(result.reason, value), true, `${label}: final rejection preserves original value`)
      assert.equal(runSignal.aborted, true)
      if (value !== undefined) assert.equal(runSignal.reason, value, `${label}: signal keeps the original abort reason`)
      assert.equal(Object.isFrozen(receivedContext), true)
      assert.equal(receivedContext.terminalKind, 'ordinary-work-rejection')
      assert.deepEqual(receivedContext.inFlightOperations, [{ label: 'context.request.post', count: 1 }])
      assert.equal(receivedContext.inFlightOperationCount, 1)
      assert.deepEqual(snapshotTask9InFlightOperations(runSignal), { count: 0, operations: [] })
      assert.equal(navigationEffects, 0)
      assert.equal(artifactWrites, 0)

      const artifact = JSON.parse(await readFile(path.join(directory, 'outer-browser-failure.json'), 'utf8'))
      assert.equal(artifact.outcome, 'failure')
      assert.equal(artifact.failure.terminalKind, 'ordinary-work-rejection')
      assert.equal(artifact.failure.inFlightOperationCountAtFailure, 1)
      assert.deepEqual(artifact.failure.inFlightOperationsAtDeadline, [{ label: 'context.request.post', count: 1 }])
      assert.match(artifact.failure.dataOutcome, /^AMBIGUOUS/u)
      assert.equal(JSON.stringify(artifact).includes('untrusted original rejection text'), false)
      assert.equal(JSON.stringify(artifact).includes('not serialized'), false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

function destinationFixture({ open = false, opacity = 0, hit = 'overlap', animate = true, hydrated = true, duplicateShell = false } = {}) {
  const shellClasses = new Set([
    ...(open ? ['template-default--nav-open'] : []),
    ...(hydrated ? ['template-default--nav-hydrated'] : []),
    ...(animate ? ['template-default--nav-animate'] : []),
  ])
  const navClasses = new Set([
    ...(open ? ['nav--nav-open'] : []),
    ...(animate ? ['nav--nav-animate'] : []),
  ])
  const classList = values => ({ contains: value => values.has(value) })
  const rect = { x: 80, y: 100, left: 80, top: 100, width: 220, height: 42 }
  const child = { tagName: 'SPAN' }
  let link
  const overlap = { tagName: 'LABEL', textContent: 'Category' }
  link = {
    tagName: 'A',
    href: `${destinationExpected.origin}${destinationExpected.path}`,
    textContent: destinationExpected.label,
    classList: classList(new Set()),
    getBoundingClientRect: () => rect,
    contains: element => element === child,
  }
  const nav = {
    classList: classList(navClasses),
    children: [],
    matches: selector => selector === 'aside.nav',
    querySelectorAll: selector => selector === '.portal-navigation a' ? [link] : [],
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 275, height: 900 }),
  }
  const shell = {
    classList: classList(shellClasses),
    children: [nav],
  }
  const context = {
    document: {
      querySelectorAll: selector => selector === '.template-default' ? (duplicateShell ? [shell, shell] : [shell]) : [],
      elementFromPoint: () => hit === 'link' ? link : hit === 'descendant' ? child : overlap,
    },
    getComputedStyle: element => element === nav
      ? { opacity: String(opacity), visibility: 'visible', display: 'block', pointerEvents: 'auto',
        transitionProperty: 'opacity', transitionDuration: '0.15s', transitionDelay: '0s' }
      : { opacity: '1', visibility: 'visible', display: 'block' },
    innerWidth: 1440,
    innerHeight: 900,
    performance: { now: () => 123.45 },
    window: {},
  }
  return context
}

function evaluateInDestinationFixture(fn, expected, context) {
  return vm.runInNewContext(`(${fn.toString()})(expected)`, { ...context, expected, URL })
}

test('outer timeout capture happens before guaranteed cleanup and cannot replace the original error', async () => {
  const primary = new Error('navigation timeout')
  const order = []
  let thrown

  try {
    await runWithFailureCapture(
      async () => { order.push('work'); throw primary },
      {
        capture: async error => {
          assert.equal(error, primary)
          order.push('capture')
          throw new Error('screenshot capture failed')
        },
        onCaptureFailure: () => order.push('capture-error-recorded'),
        cleanup: async () => { order.push('cleanup'); throw new Error('cleanup failed') },
      },
    )
  } catch (error) { thrown = error }

  assert.equal(thrown, primary, 'capture failure must not mask the original navigation timeout')
  assert.deepEqual(order, ['work', 'capture', 'capture-error-recorded', 'cleanup'])
})

test('runner deadline captures the original timeout before cleanup and aborts outstanding work', async () => {
  const order = []
  let thrown
  try {
    await runWithFailureCapture(
      signal => new Promise((_, reject) => signal.addEventListener('abort', () => {
        order.push('work-aborted')
        reject(signal.reason)
      }, { once: true })),
      {
        timeoutMs: 10,
        captureTimeoutMs: 100,
        capture: async error => { order.push('capture'); assert.equal(error.name, 'TimeoutError'); assert.match(error.message, /deadline exceeded/u) },
        cleanup: async () => { order.push('cleanup') },
      },
    )
  } catch (error) { thrown = error }
  assert.equal(thrown?.name, 'TimeoutError')
  assert.match(thrown.message, /deadline exceeded/u)
  assert.deepEqual(order, ['work-aborted', 'capture', 'cleanup'])
})

test('runner deadline bounds a hung capture, cleans up, and preserves the timeout', async () => {
  const order = []
  let thrown
  try {
    await runWithFailureCapture(
      () => new Promise(() => {}),
      {
        timeoutMs: 10,
        captureTimeoutMs: 10,
        settleTimeoutMs: 10,
        capture: async () => { order.push('capture-start'); await new Promise(() => {}) },
        onCaptureFailure: error => order.push(`capture-failed:${error.name}`),
        onWorkUnsettled: error => order.push(`work-unsettled:${error.name}`),
        cleanup: async () => { order.push('cleanup') },
      },
    )
  } catch (error) { thrown = error }
  assert.equal(thrown?.name, 'TimeoutError')
  assert.deepEqual(order, ['capture-start', 'capture-failed:TimeoutError', 'cleanup', 'work-unsettled:TimeoutError'])
})

test('actual guarded browser and artifact stages do not dispatch follow-on effects after deadline cleanup', async () => {
  for (const delayedStage of ['entry-navigation', 'fixture-fetch', 'artifact-setup']) {
    const events = []
    let releaseDeferred
    const deferred = new Promise(resolve => { releaseDeferred = resolve })
    const operation = (stage, immediate) => {
      if (delayedStage === stage) return deferred
      return Promise.resolve(immediate)
    }
    const rawPage = {
      goto: url => { events.push(`goto:${url}`); return operation('entry-navigation', undefined) },
      request: {
        get: url => { events.push(`fetch:GET:${url}`); return operation('fixture-fetch', { status: 200 }) },
        post: url => { events.push(`fetch:POST:${url}`); return Promise.resolve({ status: 201 }) },
      },
    }
    let primary
    const secondary = []
    let inFlightAtDeadline = []
    try {
      await runWithFailureCapture(async signal => {
        const guard = createTask9RunGuard(signal)
        const page = guard.wrap(rawPage)
        await page.goto('/editorial-entry.html')
        await page.request.get('/fixture/read')
        await page.request.post('/fixture/mutation')
        await page.goto('/editorial/admin')
        await runTask9Operation(signal, 'artifact.prepare', () => operation('artifact-setup', true))
        await runTask9Operation(signal, 'artifact.writeFile', async () => { events.push('artifact:write') })
      }, {
        timeoutMs: 10,
        captureTimeoutMs: 100,
        cleanupTimeoutMs: 100,
        settleTimeoutMs: 100,
        capture: async error => {
          assert.equal(error.name, 'TimeoutError')
          inFlightAtDeadline = error.task9InFlightOperations || []
          throw new Error('collector failure')
        },
        onCaptureFailure: error => secondary.push(error.message),
        onCleanupFailure: error => secondary.push(error.message),
        cleanup: async () => {
          events.push('cleanup')
          releaseDeferred()
          throw new Error('cleanup failure')
        },
      })
    } catch (error) { primary = error }
    assert.equal(primary?.name, 'TimeoutError', `${delayedStage}: preserve the original deadline failure`)
    assert.match(primary.message, /deadline exceeded/u)
    assert.deepEqual(secondary, ['collector failure', 'cleanup failure'])
    assert.ok(events.indexOf('cleanup') > -1)
    if (delayedStage === 'entry-navigation') assert.ok(inFlightAtDeadline.some(item => item.label.endsWith('.goto')))
    if (delayedStage === 'fixture-fetch') assert.ok(inFlightAtDeadline.some(item => item.label.endsWith('.get')))
    assert.equal(events.includes('fetch:POST:/fixture/mutation'), delayedStage === 'artifact-setup')
    assert.equal(events.includes('goto:/editorial/admin'), delayedStage === 'artifact-setup')
    assert.equal(events.includes('artifact:write'), false, `${delayedStage}: no late artifact write`)
    if (delayedStage === 'entry-navigation') assert.deepEqual(events, ['goto:/editorial-entry.html', 'cleanup'])
    if (delayedStage === 'fixture-fetch') assert.deepEqual(events, [
      'goto:/editorial-entry.html', 'fetch:GET:/fixture/read', 'cleanup',
    ])
    if (delayedStage === 'artifact-setup') assert.deepEqual(events, [
      'goto:/editorial-entry.html', 'fetch:GET:/fixture/read', 'fetch:POST:/fixture/mutation',
      'goto:/editorial/admin', 'cleanup',
    ])
  }
})

test('capture timeout aborts its own signal so delayed capture setup cannot write after cleanup', async () => {
  const primary = new Error('original browser failure')
  let releaseSetup
  let artifactWrites = 0
  let captureSettled
  const captureDone = new Promise(resolve => { captureSettled = resolve })
  let thrown
  try {
    await runWithFailureCapture(
      async () => { throw primary },
      {
        captureTimeoutMs: 10,
        cleanupTimeoutMs: 100,
        settleTimeoutMs: 50,
        capture: async (_error, captureSignal) => {
          try {
            await runTask9Operation(captureSignal, 'artifact.prepare', () => new Promise(resolve => { releaseSetup = resolve }))
            await runTask9Operation(captureSignal, 'writeFile', async () => { artifactWrites++ })
          } finally { captureSettled() }
        },
        onCaptureFailure: () => {},
        cleanup: async () => { releaseSetup?.() },
      },
    )
  } catch (error) { thrown = error }
  await captureDone
  assert.equal(thrown, primary, 'capture timeout must not replace the original failure')
  assert.equal(artifactWrites, 0, 'post-cleanup capture continuation must not create an artifact')
})

test('screenshot finishing after its capture deadline never writes an artifact after cleanup', async () => {
  let releaseScreenshot
  let writes = 0
  let captureSettled
  const settled = new Promise(resolve => { captureSettled = resolve })
  let primary
  try {
    await runWithFailureCapture(async () => { throw new Error('force failure capture') }, {
      captureTimeoutMs: 10,
      cleanupTimeoutMs: 100,
      settleTimeoutMs: 50,
      capture: async (_error, signal) => {
        try {
          await captureTask9Screenshot(signal, () => new Promise(resolve => { releaseScreenshot = resolve }), 'unused.png', {}, async () => { writes++ })
        } finally { captureSettled() }
      },
      onCaptureFailure: () => {},
      cleanup: async () => { releaseScreenshot?.(Buffer.from('png')) },
    })
  } catch (error) { primary = error }
  await settled
  assert.equal(primary?.message, 'force failure capture')
  assert.equal(writes, 0)
})

test('guarded screenshot Buffer retains identity and writes complete bytes through the production artifact helper', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'task9-screenshot-buffer-'))
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 17])
  const signal = new AbortController().signal
  try {
    const guarded = createTask9RunGuard(signal).wrap({ screenshot: async () => image })
    const captured = await guarded.screenshot()
    assert.equal(Buffer.isBuffer(captured), true)
    assert.equal(captured, image)
    const artifact = path.join(directory, 'capture.png')
    await captureTask9Screenshot(signal, async () => captured, artifact)
    assert.deepEqual(await readFile(artifact), image)
    assert.ok((await readFile(artifact)).length > 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('screenshot artifact writer preserves supported Uint8Array bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'task9-screenshot-typed-'))
  const image = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
  try {
    const artifact = path.join(directory, 'capture.png')
    await captureTask9Screenshot(undefined, async () => image, artifact)
    assert.deepEqual(await readFile(artifact), Buffer.from(image))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('screenshot artifact collision returns EEXIST without replacing the existing final bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'task9-screenshot-collision-'))
  const artifact = path.join(directory, 'capture.png')
  const original = Buffer.from('pre-existing evidence')
  try {
    await fsWriteFile(artifact, original, { mode: 0o600, flag: 'wx' })
    await assert.rejects(captureTask9Screenshot(undefined, async () => Buffer.from([137, 80]), artifact), error => error.code === 'EEXIST')
    assert.deepEqual(await readFile(artifact), original)
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.incomplete')).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('pending screenshot publication is tracked and abort prevents a successful artifact result', async () => {
  const controller = new AbortController()
  const primary = new Error('original capture failure')
  let releasePublication
  let notifyPublicationStarted
  const publicationStarted = new Promise(resolve => { notifyPublicationStarted = resolve })
  let returnedSuccessfully = false
  const capture = writeTask9ScreenshotArtifact(controller.signal, Buffer.from([137, 80]), 'unused.png', {
    write: async () => {},
    publish: () => {
      notifyPublicationStarted()
      return new Promise(resolve => { releasePublication = resolve })
    },
    remove: async () => {},
  }).then(
    () => { returnedSuccessfully = true; return null },
    error => error,
  )

  await publicationStarted
  assert.deepEqual(snapshotTask9InFlightOperations(controller.signal), {
    count: 1,
    operations: [{ label: 'publish', count: 1 }],
  })
  controller.abort(primary)
  assert.equal(controller.signal.reason, primary, 'abort keeps the original primary error as its reason')
  releasePublication()
  assert.equal(await capture, primary, 'the post-publication checkpoint rejects with the original abort reason')
  assert.equal(returnedSuccessfully, false, 'aborted publication cannot report a successful artifact result')
  assert.deepEqual(snapshotTask9InFlightOperations(controller.signal), { count: 0, operations: [] })
})

test('mid-write failure preserves the primary error and leaves only an explicitly incomplete artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'task9-screenshot-write-failure-'))
  const artifact = path.join(directory, 'capture.png')
  const primary = new Error('injected staging write failure')
  try {
    await assert.rejects(captureTask9Screenshot(undefined, async () => Buffer.from([137, 80, 78, 71]), artifact, {}, async (stagingPath, bytes, options) => {
      await fsWriteFile(stagingPath, bytes.subarray(0, 2), options)
      throw primary
    }), error => error === primary)
    const entries = await readdir(directory)
    assert.equal(entries.length, 1)
    assert.match(entries[0], /\.incomplete$/u)
    assert.deepEqual(await readFile(path.join(directory, entries[0])), Buffer.from([137, 80]))
    await assert.rejects(readFile(artifact), error => error.code === 'ENOENT')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('numeric screenshot payload is rejected before any artifact is created', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'task9-screenshot-invalid-'))
  const artifact = path.join(directory, 'capture.png')
  try {
    await assert.rejects(captureTask9Screenshot(undefined, async () => 137, artifact), /Screenshot must be Buffer/u)
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('window error collector installation failure is explicit and fails closed', async () => {
  const events = {}
  const page = { addInitScript: async () => { throw new Error('install failed') } }
  await assert.rejects(installWindowErrorCapture(page, events), /install failed/u)
  assert.equal(events.windowErrorCapture, 'installation-failed-before-navigation')
  assert.notEqual(events.windowErrorCapture, 'installed-before-navigation')
})

test('window error collector keeps total and unknown counts after the 30-sample cap', async () => {
  let initScript
  const events = {}
  await installWindowErrorCapture({ addInitScript: async callback => { initScript = callback } }, events)
  const listeners = new Map()
  const context = vm.createContext({ window: { addEventListener: (name, callback) => listeners.set(name, callback) } })
  vm.runInContext(`(${initScript.toString()})()`, context)
  for (let index = 0; index < 20; index++) {
    const error = vm.runInContext(`new TypeError('Failed to fetch https://private.invalid/?token=secret-${index}')`, context)
    listeners.get('error')({ error, message: error.message })
  }
  for (let index = 0; index < 17; index++) {
    const reason = vm.runInContext(`new Error('unclassified private value ${index}')`, context)
    listeners.get('unhandledrejection')({ reason })
  }
  const rawCapture = vm.runInContext(`({
    samples: window.__task9OuterWindowErrors,
    counts: window.__task9OuterWindowErrorCounts,
  })`, context)
  assert.equal(rawCapture.samples.length, 30, 'stored browser sample stays bounded')
  assert.deepEqual(JSON.parse(JSON.stringify(rawCapture.counts)), { count: 37, unknownCount: 17 })
  const safe = sanitizeTask9WindowErrorCapture(rawCapture, ['http://127.0.0.1:19091'])
  assert.equal(safe.windowErrors.length, 30)
  assert.equal(safe.windowErrorCount, 37)
  assert.equal(safe.windowErrorUnknownCount, 17, 'unknown events beyond the sample cap are included')
  assert.deepEqual(Array.from(safe.windowErrors.slice(0, 20), item => item.category), Array(20).fill('network'))
  assert.deepEqual(Array.from(safe.windowErrors.slice(20), item => item.category), Array(10).fill('other'))
  for (const value of ['private.invalid', 'token=secret', 'unclassified private value']) {
    assert.equal(JSON.stringify(safe).includes(value), false)
  }
})

test('ordinary menu click is scoped to the exact visible main-template toggler despite a same-name header control', async () => {
  const calls = []
  const scopedButton = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => calls.push('main-template-button-clicked'),
  }
  const page = {
    locator: selector => {
      calls.push(`scope:${selector}`)
      return { getByRole: (role, options) => {
        calls.push(`role:${role}:${options.name}:${options.exact}`)
        return scopedButton
      } }
    },
    getByRole: () => { throw new Error('unscoped role lookup is forbidden') },
  }
  await clickNativeMenuControl(page, 'Abrir Cardápio')
  assert.deepEqual(calls, [
    'scope:.template-default__nav-toggler-wrapper',
    'role:button:Abrir Cardápio:true',
    'main-template-button-clicked',
  ])
})

test('mutation audit detects a late article PATCH after bounded benign request samples fill', () => {
  const origin = 'http://127.0.0.1:19091'
  const audit = createEditorialRequestAudit(origin, 180, 3)
  for (let index = 0; index < 250; index++) {
    audit.onRequest({ url: () => `${origin}/_next/static/chunks/${index}.js`, method: () => 'GET' })
  }
  const mutation = {
    url: () => `${origin}/editorial/api/news-articles/338c5db2-f620-413e-a5b3-8a7e622377ee?token=private`,
    method: () => 'PATCH',
  }
  audit.onRequest(mutation)
  const snapshot = audit.snapshot()
  assert.equal(snapshot.requestLog.length, 180, 'diagnostic sample stays bounded')
  assert.equal(snapshot.articleMutationCount, 1, 'safety detection continues after diagnostics cap')
  assert.equal(snapshot.articleMutationViolation, true)
  assert.deepEqual(snapshot.articleMutationEvidence, [{ method: 'PATCH', path: '/editorial/api/news-articles/[id]' }])
  assert.equal(JSON.stringify(snapshot).includes('token=private'), false)
})

test('Server Action response safety counters remain complete when diagnostic status samples are capped', () => {
  const origin = 'http://127.0.0.1:19091'
  const audit = createEditorialRequestAudit(origin, 0, 3)
  const requests = Array.from({ length: 25 }, () => ({
    url: () => `${origin}/editorial/admin/collections/news-articles/338c5db2-f620-413e-a5b3-8a7e622377ee`,
    method: () => 'POST',
  }))
  for (const request of requests) audit.onRequest(request)
  for (const request of requests) {
    audit.onResponse({
      url: request.url,
      request: () => request,
      status: () => 500,
    })
  }
  const snapshot = audit.snapshot()
  assert.equal(snapshot.serverActionRequestCount, 25)
  assert.equal(snapshot.serverActionResponseCount, 25)
  assert.equal(snapshot.serverActionNon200ResponseCount, 25, 'bad responses beyond the evidence sample still fail acceptance')
  assert.equal(snapshot.serverActionResponseStatuses.length, 3, 'stored response samples stay bounded')
})

test('outer diagnostics redact URL queries, IDs, tokens and unallowlisted routes', () => {
  assert.equal(
    safeBrowserPath('http://127.0.0.1:19091/editorial/admin/collections/news-articles/50a892b3-4746-4237-aa1d-104acedc53fd?token=private', ['http://127.0.0.1:19091']),
    '/editorial/admin/collections/news-articles/[id]',
  )
  assert.equal(safeBrowserPath('http://127.0.0.1:19091/private?token=private', ['http://127.0.0.1:19091']), '[unlisted-local-path]')
  assert.equal(safeBrowserPath('http://127.0.0.1:19091/cms.html?token=private', ['http://127.0.0.1:19091']), '/cms.html')
  assert.equal(redactMessage('Bearer abc.def, https://example.test/path?token=x'), 'Bearer [redacted], [url]')
  assert.equal(safeEventMessage('Unexpected editorial value: confidential draft text'), '[redacted]')
})

test('serialized navigation capture crosses into the browser realm and sanitizes only exact same-origin destinations', async () => {
  const origin = 'http://127.0.0.1:19091'
  const rawLinks = [
    { label: 'Voltar à central editorial', href: `${origin}/cms.html?token=secret#private` },
    { label: 'Ler Owner News', href: `${origin}/announcements.html?cookie=private` },
    { label: 'spoof', href: `https://attacker.invalid/cms.html?token=external-secret` },
    { label: 'userinfo', href: `${origin.replace('://', '://user:pass@')}/cms.html?token=credential-secret` },
    { label: 'script', href: 'javascript:alert(1)' },
    { label: 'data', href: 'data:text/html,private' },
  ]
  const page = {
    async evaluate(callback) {
      // Run the exact function sent to Playwright without any Node lexical scope.
      return vm.runInNewContext(`(${callback.toString()})()`, {
        document: { querySelectorAll: () => rawLinks.map(link => ({ ...link, textContent: link.label })) },
      })
    },
  }
  const safe = JSON.parse(JSON.stringify(await readSanitizedEditorialNavigation(page, [origin])))
  assert.deepEqual(safe, [
    { label: 'Voltar à central editorial', path: '/cms.html' },
    { label: 'Ler Owner News', path: '/announcements.html' },
    { label: '[unlisted-link]', path: '[external-url]' },
    { label: '[unlisted-link]', path: '[external-url]' },
    { label: '[unlisted-link]', path: '[external-url]' },
    { label: '[unlisted-link]', path: '[external-url]' },
  ])
  assert.equal(JSON.stringify(safe).includes('secret'), false)
  assert.equal(JSON.stringify(safe).includes('private'), false)
  assert.equal(safeEditorialDestination(`${origin}/cms.html.evil`, [origin]), '[unlisted-destination]')
  assert.equal(safeEditorialDestination('not a url', [origin]), '[invalid-url]')
  assert.equal(readRawEditorialNavigation.toString().includes('safeEditorialDestination'), false)
})

test('serialized reader bootstrap observation reports hidden pending main and public auth category only', () => {
  const heading = { textContent: 'Owner News', getBoundingClientRect: () => ({ width: 640, height: 48 }) }
  const main = {
    hasAttribute: name => name === 'data-route-pending',
    querySelector: selector => selector === 'h1' ? heading : null,
    getBoundingClientRect: () => ({ width: 900, height: 500 }),
  }
  const root = { dataset: { authState: 'pending' } }
  const visible = { display: 'block', visibility: 'visible', opacity: '1' }
  const hidden = { display: 'block', visibility: 'hidden', opacity: '1' }
  const state = vm.runInNewContext(`(${readTask9ReaderBootstrapState.toString()})()`, {
    document: { readyState: 'interactive', documentElement: root, getElementById: id => id === 'main-content' ? main : null },
    window: { getComputedStyle: node => node === main ? hidden : visible },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    documentReadyState: 'interactive', mainExists: true, mainRoutePending: true,
    mainDisplay: 'block', mainVisibility: 'hidden', mainVisible: false, mainRectPositive: true,
    headingExists: true, headingTextMatchesOwnerNews: true, headingDisplay: 'block',
    headingVisibility: 'visible', headingVisible: true, headingRectPositive: true,
    authStatus: 'loading', routeBootstrapState: 'not-exposed',
  })
})

test('serialized reader bootstrap observation handles missing main and only recognizes public signed-out enum', () => {
  const state = vm.runInNewContext(`(${readTask9ReaderBootstrapState.toString()})()`, {
    document: { readyState: 'complete', documentElement: { dataset: { authState: 'signed-out' } }, getElementById: () => null },
    window: { getComputedStyle: () => ({ display: 'none', visibility: 'hidden', opacity: '0' }) },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    documentReadyState: 'complete', mainExists: false, mainRoutePending: false,
    mainDisplay: 'other', mainVisibility: 'other', mainVisible: false, mainRectPositive: false,
    headingExists: false, headingTextMatchesOwnerNews: false, headingDisplay: 'other',
    headingVisibility: 'other', headingVisible: false, headingRectPositive: false,
    authStatus: 'signed-out', routeBootstrapState: 'not-exposed',
  })
})

test('reader bootstrap observation is secondary and cannot replace the original navigation failure', async () => {
  const original = new Error('original heading timeout')
  const observed = await captureTask9ReaderBootstrap({ evaluate: async () => { throw new Error('private diagnostic failure') } })
  assert.deepEqual(observed, { available: false })
  let caught
  try { throw original } catch (error) { await captureTask9ReaderBootstrap({ evaluate: async () => { throw new Error('private diagnostic failure') } }); caught = error }
  assert.equal(caught, original)
})

test('reader resource and error diagnostics strictly allowlist paths/types and persist no message values', () => {
  const origin = 'http://127.0.0.1:19091'
  assert.equal(safeTask9ReaderResourcePath(`${origin}/js/router.js?token=private`, [origin]), '/js/router.js')
  assert.equal(safeTask9ReaderResourcePath(`${origin}/api/announcements/338c5db2-f620-413e-a5b3-8a7e622377ee?token=private`, [origin]), '/api/announcements/[id]')
  assert.equal(safeTask9ReaderResourcePath(`${origin}/private.html?token=private`, [origin]), null)
  assert.equal(safeTask9ReaderResourcePath(`${origin.replace('://', '://user:pass@')}/js/auth.js`, [origin]), null)
  assert.equal(safeTask9ReaderResourcePath('https://attacker.invalid/js/router.js', [origin]), null)
  assert.deepEqual(['text/html; charset=utf-8', 'application/javascript', 'application/problem+json', 'text/css', ''].map(task9ResponseContentType),
    ['text/html', 'js', 'json', 'other', 'other'])
  assert.equal(task9BrowserErrorCategory('The requested module https://private.invalid/x does not provide an export named token=secret'), 'undefined-export')
  assert.equal(task9BrowserErrorCategory('Strict MIME type check failed at https://private.invalid/?token=secret'), 'mime')
  assert.equal(task9BrowserErrorCategory('Refused to load because Content Security Policy blocked https://private.invalid'), 'csp')
  assert.equal(task9BrowserErrorCategory('Firebase auth initialization failed for user secret'), 'auth-initialization')
  assert.equal(task9BrowserErrorCategory('Failed to fetch https://private.invalid/?token=secret'), 'network')
  assert.equal(task9BrowserErrorCategory('private draft leaked at https://private.invalid'), 'other')
  assert.equal(task9PageErrorName('TypeError'), 'TypeError')
  assert.equal(task9PageErrorName('PrivateErrorClass'), 'OtherError')
  assert.deepEqual(safeTask9PageErrorSource(`at run (${origin}/js/router.js?token=secret:12:4)`, [origin]),
    { path: '/js/router.js', line: 12, column: 4 })
  assert.equal(safeTask9PageErrorSource('at run (https://attacker.invalid/private.js:2:3)', [origin]), null)
})

test('browser event diagnostics retain fixed categories/counts but no raw console, failure, or pageerror content', () => {
  const handlers = new Map()
  const page = { on: (name, handler) => handlers.set(name, handler) }
  const origin = 'http://127.0.0.1:19091'
  const events = attachBrowserDiagnostics(page, [origin])
  handlers.get('console')({ type: () => 'error', text: () => 'Strict MIME check failed for https://private.invalid/?token=secret' })
  handlers.get('console')({ type: () => 'error', text: () => 'private draft text https://private.invalid/?token=secret' })
  const pageError = new TypeError('Failed to fetch secret https://private.invalid/?token=secret')
  pageError.stack = `TypeError: private\n at run (${origin}/js/router.js?token=secret:12:4)`
  handlers.get('pageerror')(pageError)
  handlers.get('requestfailed')({ method: () => 'GET', url: () => `${origin}/js/router.js?token=secret`, failure: () => ({ errorText: 'net::ERR_FAILED secret https://private.invalid' }) })
  handlers.get('requestfailed')({ method: () => 'GET', url: () => `${origin}/js/auth.js`, failure: () => ({ errorText: 'private unknown failure' }) })
  const request = { method: () => 'GET' }
  handlers.get('response')({
    request: () => request,
    url: () => `${origin}/announcements.html?token=secret`,
    status: () => 200,
    headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
  })
  const serialized = JSON.stringify(events)
  assert.equal(events.consoleErrorCount, 2)
  assert.equal(events.consoleErrorUnknownCount, 1)
  assert.deepEqual(events.console.map(item => item.category), ['mime', 'other'])
  assert.equal(events.pageErrorCount, 1)
  assert.deepEqual(events.pageErrors[0], {
    elapsedMs: events.pageErrors[0].elapsedMs, name: 'TypeError', category: 'network',
    source: { path: '/js/router.js', line: 12, column: 4 },
  })
  assert.equal(events.requestFailedCount, 2)
  assert.equal(events.requestFailedUnknownCount, 1)
  assert.deepEqual(events.requestFailed.map(item => item.category), ['network', 'other'])
  assert.deepEqual(events.readerResponses.map(({ method, path, status, contentType }) => ({ method, path, status, contentType })), [
    { method: 'GET', path: '/announcements.html', status: 200, contentType: 'text/html' },
  ])
  for (const value of ['private.invalid', 'token=secret', 'draft text', 'ERR_FAILED']) assert.equal(serialized.includes(value), false)
})

test('destination audit records only same-origin allowlisted reader status and MIME without queries or headers', () => {
  const origin = 'http://127.0.0.1:19091'
  const audit = createEditorialRequestAudit(origin)
  const request = { method: () => 'GET' }
  audit.onResponse({
    url: () => `${origin}/js/router-bootstrap.js?token=private`, request: () => request,
    status: () => 200, headers: () => ({ 'content-type': 'text/javascript; charset=utf-8', authorization: 'secret' }),
  })
  audit.onResponse({
    url: () => `${origin}/private.js?token=private`, request: () => request,
    status: () => 500, headers: () => ({ 'content-type': 'application/json', authorization: 'secret' }),
  })
  audit.onResponse({
    url: () => `https://attacker.invalid/js/router.js?token=private`, request: () => request,
    status: () => 500, headers: () => ({ 'content-type': 'application/json', authorization: 'secret' }),
  })
  const snapshot = audit.snapshot()
  assert.deepEqual(snapshot.readerResponseLog, [{ method: 'GET', path: '/js/router-bootstrap.js', status: 200, contentType: 'js' }])
  assert.equal(JSON.stringify(snapshot).includes('private'), false)
  assert.equal(JSON.stringify(snapshot).includes('secret'), false)
})

test('temporary screenshot mask removes its style and restores DOM markers while preserving capture failure', async () => {
  const element = {
    value: 'preexisting',
    getAttribute() { return this.value },
    setAttribute(_name, value) { this.value = value },
    removeAttribute() { this.value = null },
  }
  const browserGlobals = { window: {}, element, document: { element } }
  let styleRemoved = false
  let captureCalls = 0
  const primary = new Error('screenshot failure')
  const page = {
    async evaluate(callback) {
      return vm.runInNewContext(`(${callback.toString()})()`, browserGlobals)
    },
    async addStyleTag() {
      return { evaluate: async callback => { callback({ remove() { styleRemoved = true } }) } }
    },
  }
  await assert.rejects(captureWithTemporaryDOMMask({
    page,
    prepare: () => {
      window.__original = element.getAttribute('data-task9-observable')
      element.setAttribute('data-task9-observable', 'allow')
    },
    capture: async () => { captureCalls++; throw primary },
    restore: () => {
      if (window.__original === null) element.removeAttribute('data-task9-observable')
      else element.setAttribute('data-task9-observable', window.__original)
      delete window.__original
    },
  }), error => error === primary)
  assert.equal(captureCalls, 1)
  assert.equal(styleRemoved, true)
  assert.equal(element.value, 'preexisting')
  assert.equal(browserGlobals.window.__original, undefined)
})

test('temporary screenshot mask skips an empty allowlist instead of writing a blank screenshot', async () => {
  let styleCalls = 0, captureCalls = 0, restoreCalls = 0
  const page = {
    evaluate: async callback => callback(),
    addStyleTag: async () => { styleCalls++; return { evaluate: async () => {} } },
  }
  const captured = await captureWithTemporaryDOMMask({
    page,
    prepare: () => false,
    capture: async () => { captureCalls++; },
    restore: () => { restoreCalls++ },
  })
  assert.equal(captured, false)
  assert.equal(styleCalls, 0)
  assert.equal(captureCalls, 0)
  assert.equal(restoreCalls, 1)
})

test('native Payload menu state is read from translated button label and public DOM classes', () => {
  const buttonClasses = new Set()
  const navClasses = new Set()
  const shellClasses = new Set()
  const button = {
    getAttribute: name => name === 'aria-label' ? 'Abrir Cardápio' : null,
    classList: { contains: value => buttonClasses.has(value) },
    getClientRects: () => [{ width: 30, height: 30 }],
  }
  const hiddenHeaderToggler = {
    getAttribute: name => name === 'aria-label' ? 'Abrir Cardápio' : null,
    classList: { contains: () => false },
    getClientRects: () => [],
  }
  const nav = { classList: { contains: value => navClasses.has(value) }, matches: value => value === 'aside.nav' }
  const shell = { classList: { contains: value => shellClasses.has(value) }, children: [nav] }
  const context = {
    document: { querySelector: () => null,
      querySelectorAll: selector => selector === '.template-default' ? [shell]
        : selector === '.template-default__nav-toggler-wrapper button.nav-toggler' ? [button]
          : selector === 'button.nav-toggler' ? [button, hiddenHeaderToggler] : [] },
    getComputedStyle: element => element === button
      ? { visibility: 'visible', display: 'block' }
      : { opacity: navClasses.has('nav--nav-open') ? '1' : '0', visibility: 'visible', pointerEvents: 'auto' },
    performance: { now: () => 10 },
  }
  const read = () => JSON.parse(JSON.stringify(vm.runInNewContext(`(${readNativeSidebarPublicState.toString()})()`, context)))
  assert.deepEqual(read(), {
    button: { label: 'Abrir Cardápio', ariaExpanded: null, classOpen: false, visible: true, count: 1, sampledAtMs: 10 },
    state: { isOpen: false, navClassOpen: false, shellClassOpen: false, shellHydrated: false, shellAnimate: false,
      navAnimate: false, shellCount: 1, navCount: 1, sampledAtMs: 10,
      navOpacity: '0', navVisibility: 'visible', navPointerEvents: 'auto' },
  })
  button.getAttribute = name => name === 'aria-label' ? 'Fechar Cardápio' : null
  buttonClasses.add('nav-toggler--is-open')
  navClasses.add('nav--nav-open')
  shellClasses.add('template-default--nav-open')
  assert.equal(read().button.ariaExpanded, null, 'record absent aria-expanded rather than inferring it')
  assert.equal(read().state.isOpen, true, 'open state is confirmed by the public nav/shell classes')
})

test('destination readiness waits for open layout, visible opacity, and a link-or-descendant center hit', async () => {
  const states = [
    destinationFixture({ open: false, opacity: 0 }),
    destinationFixture({ open: true, opacity: 0 }),
    destinationFixture({ open: true, opacity: 0.54 }),
    destinationFixture({ open: true, opacity: 1, hit: 'descendant' }),
    destinationFixture({ open: true, opacity: 1, hydrated: false, hit: 'descendant' }),
    destinationFixture({ open: true, opacity: 1, duplicateShell: true, hit: 'descendant' }),
  ]
  const observations = states.map(context => evaluateInDestinationFixture(readDestinationObservation, destinationExpected, context))
  assert.deepEqual(observations.map(value => value.ready), [false, false, false, true, false, false])
  assert.equal(observations[1].navOpen, true)
  assert.equal(observations[1].navOpacity, 0)
  assert.equal(observations[2].navOpacity, 0.54)
  assert.equal(observations[3].hitTag, 'span')
  assert.equal(observations[3].centerHitInsideLink, true)
  assert.equal(observations[4].responsiveLayout, false, '1440px requires Payload’s public hydrated class')
  assert.equal(observations[5].shellCount, 2, 'ambiguous duplicate Payload shells must not be actionable')
  assert.deepEqual(states.map(context => evaluateInDestinationFixture(destinationIsActionable, destinationExpected, context)),
    [false, false, false, true, false, false])

  let sample = 0
  let optionsSeen
  let activeContext = states[0]
  const browserWindow = {}
  for (const context of states) context.window = browserWindow
  const page = {
    async evaluate(callback, argument) {
      return vm.runInNewContext(`(${callback.toString()})(argument)`, { ...activeContext, argument, URL })
    },
    async waitForFunction(predicate, expected, options) {
      optionsSeen = options
      for (const context of states) {
        activeContext = context
        sample++
        if (evaluateInDestinationFixture(predicate, expected, context)) return
      }
      throw new Error('readiness predicate never became true')
    },
  }
  const readiness = await waitForDestinationReadiness(page, destinationExpected)
  assert.equal(sample, 4)
  assert.equal(readiness.captured, true)
  assert.equal(readiness.samples.length, 4)
  assert.equal(readiness.samples.at(-1).centerHitInsideLink, true)
  assert.equal(Object.hasOwn(browserWindow, '__task9DestinationReadinessTimeline'), false, 'temporary browser timeline is removed')
  assert.deepEqual(optionsSeen, { timeout: 6000, polling: 'raf' })
})

test('persistent center overlap times out bounded readiness instead of authorizing a click', async () => {
  const overlapping = destinationFixture({ open: true, opacity: 1, hit: 'overlap' })
  let polls = 0
  let optionsSeen
  let ordinaryClickCount = 0
  let failure
  const browserWindow = {}
  overlapping.window = browserWindow
  const page = {
    async evaluate(callback, argument) {
      return vm.runInNewContext(`(${callback.toString()})(argument)`, { ...overlapping, argument, URL })
    },
    async waitForFunction(predicate, expected, options) {
      optionsSeen = options
      while (polls++ < 5) assert.equal(evaluateInDestinationFixture(predicate, expected, overlapping), false)
      const timeout = new Error('bounded Playwright readiness timeout')
      timeout.name = 'TimeoutError'
      throw timeout
    },
  }
  // The caller's ordinary locator.click() is sequenced after this await and is never reached on timeout.
  try {
    await waitForDestinationReadiness(page, destinationExpected)
    ordinaryClickCount++
  } catch (error) { failure = error; assert.equal(error.name, 'TimeoutError') }
  assert.equal(polls, 6)
  assert.equal(ordinaryClickCount, 0)
  assert.equal(failure.readiness.captured, true)
  assert.equal(failure.readiness.samples.length, 5)
  assert.ok(failure.readiness.samples.every(sample => sample.navOpacity === 1 && !sample.centerHitInsideLink))
  assert.equal(Object.hasOwn(browserWindow, '__task9DestinationReadinessTimeline'), false, 'timeout also removes temporary browser timeline')
  assert.deepEqual(optionsSeen, { timeout: 6000, polling: 'raf' })
})

test('public accessible-name diagnostics retain short labels and redact arbitrary attribute content', () => {
  assert.equal(safePublicAccessibleName('Abrir Cardápio'), 'Abrir Cardápio')
  assert.equal(safePublicAccessibleName('Fechar Cardápio'), 'Fechar Cardápio')
  assert.equal(safePublicAccessibleName('https://outside.invalid/?token=private'), '[unlisted-accessible-name]')
  assert.equal(safePublicAccessibleName('token=private'), '[unlisted-accessible-name]')
})

test('missing CMS return link uses fresh normal entry and only direct setup of the approved existing editor', async () => {
  const calls = []
  const page = {
    async goto(url) { calls.push(['goto', url]) },
    getByRole(role, options) {
      calls.push(['getByRole', role, options.name])
      return {
        async click() { calls.push(['click', role, options.name]) },
        async waitFor(waitOptions) { calls.push(['waitFor', role, options.name, waitOptions.state]) },
      }
    },
    async waitForURL(url, options) { calls.push(['waitForURL', url, options.timeout]) },
  }
  const method = await reenterPayloadFromFreshEntry(page, destinationExpected.origin, '338c5db2-f620-413e-a5b3-8a7e622377ee')

  assert.equal(method, 'fresh-normal-entry; direct-existing-editor-setup')
  assert.deepEqual(calls.filter(call => call[0] === 'goto').map(call => call[1]), [
    `${destinationExpected.origin}/editorial-entry.html`,
    `${destinationExpected.origin}/editorial/admin/collections/news-articles/338c5db2-f620-413e-a5b3-8a7e622377ee`,
  ])
  assert.deepEqual(calls, [
    ['goto', `${destinationExpected.origin}/editorial-entry.html`],
    ['getByRole', 'button', 'Abrir no Payload'],
    ['click', 'button', 'Abrir no Payload'],
    ['waitForURL', `${destinationExpected.origin}/editorial/admin`, 30000],
    ['getByRole', 'link', 'Enquetes'],
    ['waitFor', 'link', 'Enquetes', 'visible'],
    ['goto', `${destinationExpected.origin}/editorial/admin/collections/news-articles/338c5db2-f620-413e-a5b3-8a7e622377ee`],
  ])
  assert.ok(!calls.some(call => call[0] === 'goto' && ['/cms.html', '/announcements.html'].some(path => call[1].endsWith(path))))
})
