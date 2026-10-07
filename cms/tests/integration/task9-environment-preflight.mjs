import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createTask9ChildEnvironment, parseTask9EnvironmentSnapshot, validateTask9Environment } from './task9-environment.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/** Prove the final env after Windows/Node spawn normalization using only the pure guard. */
export function validateTask9EnvironmentAtChildBoundary(environment, cwd = path.join(root, 'cms')) {
  const helperURL = new URL('./task9-environment.mjs', import.meta.url).href
  const source = `import { validateTask9Environment } from ${JSON.stringify(helperURL)}; const result = validateTask9Environment(process.env); process.stdout.write(JSON.stringify({ valid: result.valid, reasonCodes: result.reasonCodes }));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 16 * 1024,
  })
  if (child.error || child.status !== 0 || child.signal || child.stderr) {
    return { valid: false, reasonCodes: ['TASK9_CHILD_BOUNDARY_CHECK_FAILED'] }
  }
  try {
    const result = JSON.parse(child.stdout)
    if (typeof result.valid !== 'boolean' || !Array.isArray(result.reasonCodes)
      || result.reasonCodes.some(reason => typeof reason !== 'string')) {
      return { valid: false, reasonCodes: ['TASK9_CHILD_BOUNDARY_CHECK_FAILED'] }
    }
    return { valid: result.valid, reasonCodes: result.reasonCodes }
  } catch {
    return { valid: false, reasonCodes: ['TASK9_CHILD_BOUNDARY_CHECK_FAILED'] }
  }
}

/** Read-only check of a saved Task9 snapshot using the production child-env builder. */
export async function preflightTask9EnvironmentSnapshot({ directory, parentEnvironment = process.env, webpack = false }) {
  const parsedSnapshot = parseTask9EnvironmentSnapshot(await readFile(path.join(directory, 'env.json'), 'utf8'))
  const snapshotEnvironment = parsedSnapshot.snapshotEnvironment
  const priorValidation = validateTask9Environment(snapshotEnvironment)
  const { environment, validation } = createTask9ChildEnvironment({
    parentEnvironment,
    snapshotEnvironment,
    directory,
    webpack,
  })
  const childBoundary = validateTask9EnvironmentAtChildBoundary(environment, path.join(root, 'cms'))
  const parentLocalAppData = Object.keys(parentEnvironment).find(key => key.toLowerCase() === 'localappdata')
  const childLocalAppData = Object.keys(environment).find(key => key.toLowerCase() === 'localappdata')
  const reasonCodes = [...new Set([...parsedSnapshot.reasonCodes, ...validation.reasonCodes, ...childBoundary.reasonCodes])]
  return {
    valid: parsedSnapshot.valid && validation.valid && childBoundary.valid,
    reasonCodes,
    checks: {
      ...validation.checks,
      childProcessEnvironmentValidated: true,
      childProcessEnvironmentValid: childBoundary.valid,
      preparedDirectoryMatchesChild: environment.TASK9_PRIVATE_DIR === directory,
      canonicalLocalAppDataFromParent: Boolean(parentLocalAppData && childLocalAppData
        && environment[childLocalAppData] === parentEnvironment[parentLocalAppData]),
      staleSnapshotWouldFailPrivateRoot: priorValidation.reasonCodes.includes('PRIVATE_DIR_PARENT_MISMATCH'),
      savedSnapshotUntouched: true,
    },
  }
}

async function runCLI() {
  const directory = path.resolve(process.argv[2] || '')
  const webpack = process.argv.includes('--webpack')
  if (!process.env.LOCALAPPDATA || !directory) {
    process.stderr.write('Usage: node task9-environment-preflight.mjs <private-task9-directory> [--webpack]\n')
    process.exitCode = 2
    return
  }
  const result = await preflightTask9EnvironmentSnapshot({ directory, parentEnvironment: process.env, webpack })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.valid) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runCLI()
}
