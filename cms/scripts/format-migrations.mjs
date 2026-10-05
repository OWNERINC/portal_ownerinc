import { readdir, readFile, writeFile } from 'node:fs/promises'

// Payload 3.90.2 emits SQL with space-before-tab indents and whitespace-only
// lines. Normalize only that generated formatting, never statements or snapshots.
const directory = new URL('../src/migrations/', import.meta.url)
for (const name of await readdir(directory)) {
  if (!/^\d{8}_\d{6}_.+\.ts$/u.test(name)) continue
  const file = new URL(name, directory)
  const source = await readFile(file, 'utf8')
  const formatted = source.replace(/^[ \t]+\t(?=")/gmu, '    ').replace(/^[ \t]+$/gmu, '')
  if (formatted !== source) await writeFile(file, formatted, 'utf8')
}
