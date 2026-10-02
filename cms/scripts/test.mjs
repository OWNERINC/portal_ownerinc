import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))

async function discover(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await discover(filename))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(filename)
  }
  return files.sort()
}

const files = await discover(path.join(root, 'tests/unit'))
if (files.length === 0) throw new Error('No CMS unit tests found')
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
