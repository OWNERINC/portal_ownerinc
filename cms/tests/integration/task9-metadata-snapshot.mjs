// Baseline ba5acb6 + only the Task9-owned metadata/navigation UI under acceptance.
// It consumes existing read-only dependencies and private runner state; no reset.
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, symlink, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const base = path.join(process.env.LOCALAPPDATA, 'Temp/opencode')

const editorialFieldBinding = "admin: { components: { Field: '/admin/EditorialMetadata#EditorialMetadata' } },"

function bindEditorialMetadataField(source) {
  const original = "{ name: 'editorial', type: 'json', defaultValue:"
  const updated = `{ name: 'editorial', type: 'json', ${editorialFieldBinding} defaultValue:`
  if (source.split(original).length !== 2) throw new Error('expected exactly one baseline editorial JSON field')
  return source.replace(original, updated)
}

function addSaveDraftOption(source) {
  const previous = 'versions: { maxPerDoc: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } },'
  const updated = 'versions: { maxPerDoc: 0, drafts: { autosave: { interval: 2000, showSaveDraftButton: true }, schedulePublish: false } },'
  if (source.split(previous).length !== 2) throw new Error('expected exactly one baseline NewsArticles autosave config')
  return source.replace(previous, updated)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function validateSnapshot(checkout, baselineCheckout, baselineOverrides = null) {
  const baselineFields = baselineOverrides?.fields ?? await readFile(path.join(baselineCheckout, 'cms/src/news/fields.ts'), 'utf8')
  const baselineValidation = baselineOverrides?.validation ?? await readFile(path.join(baselineCheckout, 'cms/src/news/validation.ts'), 'utf8')
  const baselineCollection = baselineOverrides?.collection ?? await readFile(path.join(baselineCheckout, 'cms/src/collections/NewsArticles.ts'), 'utf8')
  const expectedFields = bindEditorialMetadataField(baselineFields)
  const expectedCollection = addSaveDraftOption(baselineCollection)
  const actualFields = await readFile(path.join(checkout, 'cms/src/news/fields.ts'), 'utf8')
  const actualValidation = await readFile(path.join(checkout, 'cms/src/news/validation.ts'), 'utf8')
  const actualCollection = await readFile(path.join(checkout, 'cms/src/collections/NewsArticles.ts'), 'utf8')
  const importMapPath = path.join(checkout, 'cms/src/app/(payload)/editorial/admin/importMap.js')
  const importMap = await readFile(importMapPath, 'utf8')
  const metadataPath = path.join(checkout, 'cms/src/admin/EditorialMetadata.tsx')
  const dateInputPath = path.join(checkout, 'cms/src/admin/EditorialSourceDateInput.tsx')
  const kindSelectPath = path.join(checkout, 'cms/src/admin/EditorialKindSelect.tsx')
  const valuePath = path.join(checkout, 'cms/src/admin/editorial-value.ts')
  const metadata = await readFile(metadataPath, 'utf8')
  const dateInput = await readFile(dateInputPath, 'utf8')
  const kindSelect = await readFile(kindSelectPath, 'utf8')
  const value = await readFile(valuePath, 'utf8')

  if (actualFields !== expectedFields) throw new Error('news/fields.ts differs from baseline by more than the single EditorialMetadata admin Field binding')
  if (actualValidation !== baselineValidation) throw new Error('news/validation.ts is not byte-identical to baseline')
  if (actualCollection !== expectedCollection) throw new Error('NewsArticles differs from baseline by more than the approved showSaveDraftButton option')
  if (!actualFields.includes(`name: 'editorial', type: 'json', ${editorialFieldBinding}`)) throw new Error('editorial JSON field is missing its exact public Field binding')
  const componentImport = /import \{ EditorialMetadata as (EditorialMetadata_[A-Za-z0-9_]+) \} from '\.\.\/\.\.\/\.\.\/\.\.\/admin\/EditorialMetadata'/u.exec(importMap)
  if (!componentImport || !importMap.includes(`"/admin/EditorialMetadata#EditorialMetadata": ${componentImport[1]}`)) throw new Error('import map module import and configured component key do not resolve to the same export')
  if (!metadata.includes("from './EditorialSourceDateInput'") || !metadata.includes("from './EditorialKindSelect'") || !metadata.includes("from './editorial-value'") || !metadata.includes('export function EditorialMetadata')) throw new Error('EditorialMetadata relative import closure is incomplete')
  if (!dateInput.includes("import React, { useId } from 'react'") || !dateInput.includes("from './editorial-value'") || !dateInput.includes('export function EditorialSourceDateInput') || !dateInput.includes('export function EditorialSourceDateError')) throw new Error('source-date input/error component closure is incomplete')
  if (!value.includes('export function isValidEditorialSourceDate')) throw new Error('source-date input validation helper is missing')
  if (!kindSelect.includes('export function EditorialKindSelect')) throw new Error('native publication-kind select component is missing')

  return {
    baseline: {
      fieldsSha256: sha256(baselineFields), validationSha256: sha256(baselineValidation),
      newsArticlesSha256: sha256(baselineCollection),
    },
    actual: {
      fieldsSha256: sha256(actualFields), validationSha256: sha256(actualValidation),
      newsArticlesSha256: sha256(actualCollection), importMapSha256: sha256(importMap),
      editorialMetadataSha256: sha256(metadata), editorialSourceDateInputSha256: sha256(dateInput),
      editorialKindSelectSha256: sha256(kindSelect), editorialValueSha256: sha256(value),
    },
    checks: {
      exactlyOneEditorialAdminFieldBinding: true,
      backendValidationByteIdenticalToBaseline: true,
      newsArticlesOnlyAddsApprovedSaveDraftOption: true,
      importMapContainsConfiguredComponentKeyAndModule: true,
      staticEditorialMetadataToDateInputToErrorClosurePresent: true,
      useIdAndCivilDateHelperPresent: true,
      nativeKindSelectPresent: true,
    },
  }
}

if (process.argv[2] === '--preflight') {
  const checkout = path.resolve(process.argv[3] || '')
  const baselineCheckout = path.resolve(process.argv[4] || '')
  if (!process.argv[3] || !process.argv[4]) throw new Error('usage: task9-metadata-snapshot.mjs --preflight <checkout> <baseline-checkout>')
  const result = await validateSnapshot(checkout, baselineCheckout)
  console.log(JSON.stringify({ preflight: 'PASS', checkout, baselineCheckout, ...result }, null, 2))
  process.exit(0)
}

const directory = await mkdtemp(path.join(base, 'ownerinc-task9-metadata-'))
const checkout = path.join(directory, 'checkout'); await mkdir(checkout)
const baseline = 'ba5acb6bbd9c22fb9ba74cbed7c6efa6d49a9cbf'
execFileSync('git', ['archive', '--format=tar', `--output=${path.join(directory, 'baseline.tar')}`, baseline], { cwd: root, timeout: 30000 })
execFileSync('tar', ['-xf', path.join(directory, 'baseline.tar'), '-C', checkout], { timeout: 30000 })
const overlays = [
  'cms/src/admin/EditorialMetadata.tsx',
  'cms/src/admin/EditorialSourceDateInput.tsx',
  'cms/src/admin/EditorialKindSelect.tsx',
  'cms/src/admin/editorial-value.ts',
  'cms/src/admin/PortalNavigation.tsx',
  'cms/src/admin/SessionWatch.tsx',
  'cms/src/collections/NewsArticles.ts',
  'cms/tests/integration/run-task9.mjs',
  'cms/tests/integration/task9-browser.mjs',
  'cms/tests/integration/task9-proxy-headers.mjs',
  'cms/tests/integration/task9-native-metadata.mjs',
]
const applied = []
const baselineFields = await readFile(path.join(checkout, 'cms/src/news/fields.ts'), 'utf8')
const baselineValidation = await readFile(path.join(checkout, 'cms/src/news/validation.ts'), 'utf8')
const baselineCollection = await readFile(path.join(checkout, 'cms/src/collections/NewsArticles.ts'), 'utf8')
const boundFields = bindEditorialMetadataField(baselineFields)
await writeFile(path.join(checkout, 'cms/src/news/fields.ts'), boundFields)
for (const file of overlays) {
  const target = path.join(checkout, file)
  await mkdir(path.dirname(target), { recursive: true })
  if (file === 'cms/src/collections/NewsArticles.ts') {
    await writeFile(target, addSaveDraftOption(baselineCollection))
  } else {
    await copyFile(path.join(root, file), target)
  }
  applied.push({ file, sha256: createHash('sha256').update(await readFile(target)).digest('hex') })
}
// The editorial field gets only its admin UI Field binding; JSON shape, defaults,
// validation and backend hooks remain baseline. NewsArticles gets the separate
// explicit Save Draft option only. No history or staged-import code is copied.
const scratchDeps = path.join(base, 'payload-deps-thread6-RRoANG', 'node_modules')
await symlink(scratchDeps, path.join(checkout, 'cms/node_modules'), 'junction')
await symlink(path.join(root, 'api/node_modules'), path.join(checkout, 'api/node_modules'), 'junction')
const validation = await validateSnapshot(checkout, checkout, {
  fields: baselineFields, validation: baselineValidation, collection: baselineCollection,
})
// The checked-in baseline import map already contains the component key; this
// preflight verifies the key and file closure without running an import-map generator.
await writeFile(path.join(directory, 'snapshot-manifest.json'), JSON.stringify({
  baseline, checkout, scratchDeps, baselineFiles: {
    fieldsSha256: sha256(baselineFields), validationSha256: sha256(baselineValidation),
    newsArticlesSha256: sha256(baselineCollection),
  }, editorialAdminBinding: { key: '/admin/EditorialMetadata#EditorialMetadata', outputFieldsSha256: sha256(boundFields) },
  applied, validation,
  boundary: 'Baseline editorial field/backend validation preserved byte-for-byte except one admin Field component binding; NewsArticles differs only by autosave.showSaveDraftButton. No import-map generator, backend/schema overlay, LegacyHistory or staged-import overlay.',
}, null, 2))
console.log(JSON.stringify({ baseline, checkout, validation, applied }, null, 2))
