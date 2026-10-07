// Authorized isolated baseline + bounded Task9 overlay. Never reads private env.
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, symlink, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode')
const directory = await mkdtemp(path.join(base, 'ownerinc-task9-snapshot-'))
const checkout = path.join(directory, 'checkout'); await mkdir(checkout)
const sha = 'ba5acb6bbd9c22fb9ba74cbed7c6efa6d49a9cbf'
execFileSync('git', ['archive', '--format=tar', `--output=${path.join(directory, 'baseline.tar')}`, sha], { cwd: root, timeout: 30000 })
execFileSync('tar', ['-xf', path.join(directory, 'baseline.tar'), '-C', checkout], { timeout: 30000 })
const overlays = [
  'cms/src/admin/PollsWorkspace.tsx',
  'cms/src/admin/SessionWatch.tsx',
  'cms/tests/integration/run-task9.mjs', 'cms/tests/integration/task9-browser.mjs',
  'cms/tests/integration/task9-history.mjs',
]
const applied = []
function inject(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Snapshot injection anchor changed; inspect before rerunning')
  return source.replace(anchor, replacement)
}
for (const file of overlays) {
  await copyFile(path.join(root, file), path.join(checkout, file))
  if (file.endsWith('/PollsWorkspace.tsx')) {
    let source = await readFile(path.join(checkout, file), 'utf8')
    source = inject(source, "const labels =", "import { watchPollHistory } from './polls-history'\nconst labels =")
    source = inject(source, '  const valid = validPollDraft(draft)', '  const leaveState = useRef({ dirty, pending: busy }); leaveState.current = { dirty, pending: busy }\n  useEffect(() => watchPollHistory(() => ({ ...leaveState.current, pending: Boolean(pending.current) })), [])\n  const valid = validPollDraft(draft)')
    await writeFile(path.join(checkout, file), source)
  }
  if (file.endsWith('/SessionWatch.tsx')) {
    let source = await readFile(path.join(checkout, file), 'utf8')
    source = inject(source, "type State =", "import { initializePollHistory } from './polls-history'\nif (typeof window !== 'undefined') initializePollHistory()\ntype State =")
    await writeFile(path.join(checkout, file), source)
  }
  applied.push({ file, sha256: createHash('sha256').update(await readFile(path.join(checkout, file))).digest('hex') })
}
const fixture = 'cms/tests/integration/fixtures/polls-history-candidate.ts'
const candidate = 'cms/src/admin/polls-history.ts'
await copyFile(path.join(root, fixture), path.join(checkout, candidate))
applied.push({ file: candidate, sourceFixture: fixture, sha256: createHash('sha256').update(await readFile(path.join(checkout, candidate))).digest('hex') })
// Installed dependencies are used as read-only inputs, never installed/generated here.
for (const project of ['api', 'cms']) await symlink(path.join(root, project, 'node_modules'), path.join(checkout, project, 'node_modules'), 'junction')
const manifest = { baseline: sha, checkout, applied }
await writeFile(path.join(directory, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify(manifest, null, 2))
