import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describeProcessResult } from '../integration/process-result.mjs'

test('native runner distinguishes assertion exit from timeout, signal and spawn failure', () => {
  assert.equal(describeProcessResult({ status: 0 }), 'exit 0')
  assert.equal(describeProcessResult({ status: 1 }), 'exit 1')
  assert.equal(describeProcessResult({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }), 'timeout (ETIMEDOUT)')
  assert.equal(describeProcessResult({ status: null, error: { code: 'ENOENT' } }), 'spawn-error (ENOENT)')
  assert.equal(describeProcessResult({ status: null, signal: 'SIGTERM' }), 'signal SIGTERM')
})

test('Node test-force-exit terminates referenced handles but does NOT mask failed tests', async () => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir()
  const directory = await mkdtemp(path.join(base, 'task5-exit-'))
  try {
    for (const shouldFail of [false, true]) {
      const filename = path.join(directory, `${shouldFail ? 'fail' : 'pass'}.mjs`)
      await writeFile(filename, `import test from 'node:test';\nsetInterval(() => {}, 1000);\ntest('synthetic exit assertion', () => { ${shouldFail ? "throw new Error('intentional_task5_failure')" : ''} });\n`)
      // This is an independent CLI, not another child of the surrounding unit runner.
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-force-exit', filename], { env, encoding: 'utf8', timeout: 10000 })
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.equal(result.status, shouldFail ? 1 : 0, `${result.stdout}\n${result.stderr}`)
      if (shouldFail) assert.match(result.stdout, /intentional_task5_failure/u)
      assert.equal(describeProcessResult(result), `exit ${shouldFail ? 1 : 0}`)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
