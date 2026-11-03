import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runFinalizer, getFinalizerFailureDiagnostic, formatFinalizerFailureDiagnostic,
  finalizerDiagnosticPhases, type FinalizerClient } from '../../scripts/finalize-news-protocol'
import { runManualRuntimeFinalizer } from '../integration/manual-runtime-finalizer'
import { manualFinalizerPhases, manualFinalizerReasons, ownDiagnosticString, serializeManualFinalizerDiagnostic,
  isManualFinalizerDiagnostic, extractManualFinalizerDiagnostic } from '../../../scripts/integration/payload-manual-diagnostics.mjs'

const privateCanary = 'PRIVATE_DIAGNOSTIC_CANARY_981c'
const env = { CMS_ADMIN_DATABASE_URL: `postgresql://cms_admin:${privateCanary}@127.0.0.1/ownerinc_cms`, CMS_PORTAL_DATABASE_NAME: 'portal' }
const summary = 'CMS news protocol diagnostic: phase=admin-connect reason=database_error sqlstate=08006'
const canonical = 'MANUAL_RUNTIME_FINALIZER_DIAGNOSTIC code=canonical_function_mismatch:owner_news_bootstrap_run:sig=true:sec=true:owner=true:config=true:source=false:return=true:strict=true:modes=true:names=true'
const cms = fileURLToPath(new URL('../../', import.meta.url))

function failedClient(at: 'connect' | 'begin' | 'lock' | 'identity' | 'migrations', error: unknown) {
  const calls: string[] = []
  const client: FinalizerClient = {
    connect: async () => { calls.push('CONNECT'); if (at === 'connect') throw error },
    end: async () => { calls.push('END') },
    query: async sql => {
      calls.push(sql)
      if (at === 'begin' && sql === 'BEGIN' || at === 'lock' && sql.includes('pg_advisory_xact_lock')
        || at === 'identity' && sql.includes('current_user AS role') || at === 'migrations' && sql.includes('SELECT name FROM public.payload_migrations')) throw error
      if (sql.includes('current_user AS role')) return { rows: [{ role: 'cms_admin', session_role: 'cms_admin', db: 'ownerinc_cms', superuser: false, read_only: 'off' }] }
      return { rows: [{ safe: true }] }
    },
  }
  return { client, calls }
}

test('consumer vocabulary exactly matches the existing production formatter, including its private reason set', async () => {
  assert.deepEqual(manualFinalizerPhases, finalizerDiagnosticPhases)
  const source = await readFile(new URL('../../scripts/finalize-news-protocol.ts', import.meta.url), 'utf8')
  const body = /const finalizerDiagnosticReasons = new Set\(\[([\s\S]*?)\]\)/u.exec(source)?.[1]
  assert.ok(body)
  const reasons = [...body.matchAll(/'([a-z0-9_]+)'/gu)].map(match => match[1])
  assert.deepEqual(manualFinalizerReasons, reasons)
  for (const phase of finalizerDiagnosticPhases) for (const reason of manualFinalizerReasons) {
    const line = formatFinalizerFailureDiagnostic({ phase, reason, sqlstate: '42501' })
    assert.equal(isManualFinalizerDiagnostic(line), true)
  }
})

for (const [at, phase] of [['connect', 'admin-connect'], ['begin', 'transaction-begin'], ['lock', 'transaction-lock'],
  ['identity', 'precondition-identity'], ['migrations', 'precondition-migrations']] as const) {
  test(`real runFinalizer maps ${at} failure; fixture serialization and extraction retain only phase/reason/SQLSTATE`, async () => {
    const raw = Object.assign(new Error(`${privateCanary} ${env.CMS_ADMIN_DATABASE_URL}`), {
      code: '08006', detail: privateCanary, hint: privateCanary, query: privateCanary, cause: new Error(privateCanary),
    })
    const { client, calls } = failedClient(at, raw)
    const output: string[] = []
    await assert.rejects(runManualRuntimeFinalizer(() => runFinalizer(env, client), line => { output.push(line) }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, 'manual_runtime_finalizer_failed')
      assert.equal(Object.hasOwn(error, 'cause'), false); assert.equal(error.stack?.includes(privateCanary), false)
      return true
    })
    assert.deepEqual(getFinalizerFailureDiagnostic(raw), { phase, reason: 'database_error', sqlstate: '08006' })
    const expected = `CMS news protocol diagnostic: phase=${phase} reason=database_error sqlstate=08006`
    assert.deepEqual(output, [expected]); assert.equal(extractManualFinalizerDiagnostic(`TAP version 13\n# ${expected}\nnot ok 1\n`, ''), expected)
    assert.equal(output.join('').includes(privateCanary), false); assert.equal(calls.at(-1), 'END')
    assert.equal(calls.includes('COMMIT'), false)
  })
}

test('real finalizer precondition reason remains finite and strips driver-supplied suffixes', async () => {
  const raw = Object.assign(new Error(privateCanary), { code: `native_column_inventory_mismatch:${privateCanary}` })
  const { client } = failedClient('identity', raw)
  await assert.rejects(runFinalizer(env, client))
  const line = serializeManualFinalizerDiagnostic(raw, getFinalizerFailureDiagnostic(raw), formatFinalizerFailureDiagnostic)
  assert.equal(line, 'CMS news protocol diagnostic: phase=precondition-identity reason=native_column_inventory_mismatch sqlstate=none')
  assert.equal(extractManualFinalizerDiagnostic('', line), line)
})

test('canonical function detail is retained and wins over the finite fallback in either stream', async () => {
  const raw = Object.assign(new Error(privateCanary), { code: canonical.slice('MANUAL_RUNTIME_FINALIZER_DIAGNOSTIC code='.length) })
  const { client } = failedClient('identity', raw)
  const output: string[] = []
  await assert.rejects(runManualRuntimeFinalizer(() => runFinalizer(env, client), line => { output.push(line) }), /manual_runtime_finalizer_failed/u)
  assert.deepEqual(output, [canonical])
  for (const [stdout, stderr] of [[`# ${summary}\n`, canonical], [`# ${canonical}\n`, summary], ['', `${summary}\n${canonical}`]]) {
    assert.equal(extractManualFinalizerDiagnostic(stdout, stderr), canonical)
  }
})

test('malicious function names fall back to the canonical summary; no arbitrary catalog identifier is printed', async () => {
  const raw = Object.assign(new Error(privateCanary), { code: `canonical_function_mismatch:${privateCanary}:source=false` })
  const { client } = failedClient('identity', raw); await assert.rejects(runFinalizer(env, client))
  assert.equal(serializeManualFinalizerDiagnostic(raw, getFinalizerFailureDiagnostic(raw), formatFinalizerFailureDiagnostic),
    'CMS news protocol diagnostic: phase=precondition-identity reason=canonical_function_mismatch sqlstate=none')
})

test('no error, diagnostic, optional-detail or cause getter is evaluated', async () => {
  let reads = 0
  const getter = () => { reads++; throw new Error(privateCanary) }
  const raw = Object.defineProperties({}, Object.fromEntries(['message', 'stack', 'code', 'cause', 'detail'].map(key => [key, { get: getter }])))
  const { client } = failedClient('connect', raw); await assert.rejects(runFinalizer(env, client))
  const diagnostic = getFinalizerFailureDiagnostic(raw)!
  Object.defineProperties(diagnostic, { operation: { get: getter }, triggerDetails: { get: getter } })
  assert.equal(serializeManualFinalizerDiagnostic(raw, diagnostic, formatFinalizerFailureDiagnostic), summary.replace('08006', 'none'))
  assert.equal(ownDiagnosticString(raw, 'message'), null)
  for (const key of ['phase', 'reason', 'sqlstate']) {
    const forged = Object.defineProperty({ phase: 'admin-connect', reason: 'database_error', sqlstate: null }, key, { get: getter })
    assert.equal(serializeManualFinalizerDiagnostic(raw, forged, formatFinalizerFailureDiagnostic), null)
  }
  assert.equal(serializeManualFinalizerDiagnostic(new Proxy({}, { getOwnPropertyDescriptor: getter }), null, formatFinalizerFailureDiagnostic), null)
  assert.equal(reads, 1, 'only the hostile Proxy descriptor trap runs; accessors never run')
})

for (const [label, forged] of [
  ['arbitrary phase', summary.replace('admin-connect', 'private-phase')],
  ['arbitrary reason', summary.replace('database_error', 'private_reason')],
  ['SQLSTATE suffix', `${summary}${privateCanary}`],
  ['SQLSTATE newline', summary.replace('08006', '08\n006')],
  ['SQLSTATE carriage return', summary.replace('08006', '0800\r6')],
  ['SQLSTATE lowercase', summary.replace('08006', '42p01')],
  ['field suffix', `${summary} detail=${privateCanary}`],
  ['message prefix', `${privateCanary}: ${summary}`],
  ['embedded marker', `Error: ${canonical}`],
  ['unknown function', canonical.replace('owner_news_bootstrap_run', 'unknown_private_function')],
  ['unknown boolean field', canonical.replace('source=false', 'private=false')],
  ['duplicate boolean field', `${canonical}:source=false`],
  ['trailing comma', `${canonical},`],
  ['ANSI prefix', `\x1b[31m${summary}`],
] as const) test(`consumer rejects forged ${label} instead of returning an allowed prefix`, () => {
  assert.equal(isManualFinalizerDiagnostic(forged), false)
  assert.equal(extractManualFinalizerDiagnostic(forged, ''), null)
  assert.equal(extractManualFinalizerDiagnostic('', `# ${forged}\n`), null)
})

test('serializer rejects malformed SQLSTATE data before the canonical formatter can normalize it', () => {
  for (const sqlstate of ['08006\n', `08006\n${privateCanary}`, '08\n006', '08006-private', undefined, { secret: privateCanary }]) {
    assert.equal(serializeManualFinalizerDiagnostic({}, { phase: 'admin-connect', reason: 'database_error', sqlstate }, formatFinalizerFailureDiagnostic), null)
  }
})
test('bounded extraction supports plain stderr, TAP stdout, nested TAP and CRLF without returning surrounding text', () => {
  for (const prefix of ['', '# ', '    # ']) {
    assert.equal(extractManualFinalizerDiagnostic(Buffer.from(`TAP version 13\r\n${prefix}${summary}\r\nnot ok 1\r\n${privateCanary}`), Buffer.alloc(0)), summary)
  }
  assert.equal(extractManualFinalizerDiagnostic(`${'x'.repeat(65536)}\n${summary}`, ''), null)
  assert.equal(extractManualFinalizerDiagnostic('', `${summary} ${'x'.repeat(2048)}`), null)
  assert.equal(isManualFinalizerDiagnostic(`${summary}\n`), false)
})

test('exact installed/ready/coverage assertion and safe sink failure preserve failure semantics', async () => {
  await runManualRuntimeFinalizer(async () => ({ installed: true, ready: false, coverageVersion: 0 }), () => assert.fail('success must not emit a failure'))
  for (const result of [undefined, { installed: false, ready: false, coverageVersion: 0 },
    { installed: true, ready: true, coverageVersion: 0 }, { installed: true, ready: false, coverageVersion: 1 },
    { installed: true, ready: false, coverageVersion: 0, privateCanary }]) {
    await assert.rejects(runManualRuntimeFinalizer(async () => result), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, 'manual_runtime_finalizer_failed')
      assert.equal(JSON.stringify(error).includes(privateCanary), false); return true
    })
  }
  const { client } = failedClient('connect', Object.assign(new Error(privateCanary), { code: '08006' }))
  await assert.rejects(runManualRuntimeFinalizer(() => runFinalizer(env, client), () => { throw new Error(privateCanary) }), /^Error: manual_runtime_finalizer_failed$/u)
})

test('actual fixture wrapper in a TAP child exits nonzero and never serializes the private driver canary', () => {
  const code = `import test from 'node:test';
    import { runFinalizer } from './scripts/finalize-news-protocol.ts';
    import { runManualRuntimeFinalizer } from './tests/integration/manual-runtime-finalizer.ts';
    const raw = Object.assign(new Error('${privateCanary}'), { code: '08006', detail: '${privateCanary}', cause: new Error('${privateCanary}') });
    test('offline failing finalizer', () => runManualRuntimeFinalizer(() => runFinalizer(${JSON.stringify(env)}, {
      connect: async () => { throw raw }, end: async () => {}, query: async () => ({ rows: [] })
    })));`
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--test-reporter=tap', '--input-type=module', '--eval', code], {
    cwd: cms, env: { NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(child.status, 1); assert.equal(child.signal, null)
  assert.equal(`${child.stdout}${child.stderr}`.includes(privateCanary), false)
  assert.match(child.stdout, /not ok 1/u); assert.match(child.stdout, /manual_runtime_finalizer_failed/u)
  assert.equal(extractManualFinalizerDiagnostic(child.stdout, child.stderr), summary)
})

test('malformed fixture URL exits nonzero without exposing URL parser input', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', 'tests/integration/manual-runtime-finalizer.ts'], {
    cwd: cms, env: { NODE_ENV: 'test', PAYLOAD_MANUAL_RUNTIME_MARKER: 'a'.repeat(32), CMS_ADMIN_DATABASE_URL: `not-a-url-${privateCanary}` },
    encoding: 'utf8', timeout: 30000,
  })
  assert.equal(child.status, 1); assert.equal(child.signal, null)
  assert.equal(`${child.stdout}${child.stderr}`.includes(privateCanary), false)
  assert.match(`${child.stdout}${child.stderr}`, /manual_runtime_finalizer_contract_invalid/u)
})

test('actual command consumer rejects failure with only the validated TAP diagnostic', async () => {
  const source = await readFile(new URL('../../../scripts/integration/payload-manual-runtime.mjs', import.meta.url), 'utf8')
  // Exercise the unchanged private process-wrapper body, with a harmless Node
  // child rather than exporting an operational command or starting the runner.
  const body = source.slice(source.indexOf('async function command('), source.indexOf('async function docker('))
  const command = new Function('spawn', 'root', 'cleanEnvironment', `${body}; return command`)(spawn, cms, () => ({}))
  for (const line of [summary, summary.replace('database_error', 'private_reason'), `${summary} detail=${privateCanary}`]) {
    await assert.rejects(command(process.execPath, ['--eval', `console.log(${JSON.stringify(`# ${line}`)}); console.error('${privateCanary}'); process.exitCode=1`],
      { env: {}, cwd: cms, timeout: 10000, extractDiagnostic: extractManualFinalizerDiagnostic }), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, line === summary ? summary : 'manual_runtime_process_failed')
      assert.equal(error.message.includes(privateCanary), false); return true
    })
  }
  const finalizerCall = source.slice(source.indexOf("step('protocol-finalizer')"), source.indexOf("step('protocol-baseline')"))
  assert.match(finalizerCall, /extractDiagnostic: extractManualFinalizerDiagnostic/u)
  assert.doesNotMatch(finalizerCall, /safeStderrPattern/u)
  assert.match(source, /const message = ownDiagnosticString\(error, 'message'\)/u)
  assert.match(source, /isManualFinalizerDiagnostic\(message\)/u)
  assert.doesNotMatch(source, /CMS news protocol diagnostic: phase=\[a-z/u)
})
