import { expectedEditorialControlCases } from './portal-page-editorial-controls.mjs'
import { expectedEditorialUploadCases } from './portal-page-editorial-upload.mjs'

const VALID_STATUSES = new Set(['PASS', 'FAIL', 'NOT_EXECUTED', 'SKIP'])

export const expectedNativeAcceptanceCases = Object.freeze([
  'synthetic category and complete media records cover every native MIME role',
  'initial explicit create runs Portal author hooks and persists a native Version',
  'direct REST publish and historical restore requests remain denied',
  'explicit publication creates a matching published Version and main document',
  'native autosave keeps its mutable Version identity and invalidates an older CAS receipt',
  'explicit save copies the current autosave without changing the published main document',
  'concurrent publication of one explicit Version has exactly one winner',
  'old exact preview remains on its saved Version after a subsequent publication',
  'wrong MIME role and incomplete media are rejected before publication',
  'complete media MIME-role matrix accepts every supported native role',
  'fresh asset Range requests are denied after editor permission or session revocation',
  'fresh exact preview keeps its historical Version and private media authorization',
  'draft save followed by unpublish preserves published withdrawal and exact history',
  'a resolved commit failure cannot return a false mutation receipt',
  'receipt confirmation survives a later legitimate Version before independent readback',
])

export const expectedBrowserAcceptanceCases = Object.freeze([
  'browser fixture starts with an authenticated Portal Pages editor',
  'private dynamic exact preview stays on its immutable Version after a later save',
  ...expectedEditorialControlCases,
  'existing News controls smoke: preview, scheduling and legacy history render',
  ...expectedEditorialUploadCases,
])

/** Fail closed when expected cases are missing, duplicated, unexpected, or malformed. */
export function aggregateAcceptanceCases(expectedNames, actualCases) {
  const expected = Array.isArray(expectedNames) ? expectedNames : []
  const actual = Array.isArray(actualCases) ? actualCases : []
  const issues = []
  const expectedCounts = new Map()
  const actualByName = new Map()

  if (expected.length === 0) issues.push('expected_case_registry_empty')
  for (const name of expected) {
    if (typeof name !== 'string' || !name.trim()) issues.push('expected_case_name_invalid')
    else expectedCounts.set(name, (expectedCounts.get(name) || 0) + 1)
  }
  for (const [name, count] of expectedCounts) if (count > 1) issues.push(`expected_case_duplicate:${name}`)

  for (const item of actual) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim() ||
        !VALID_STATUSES.has(item.status)) {
      issues.push('actual_case_invalid')
      continue
    }
    const entries = actualByName.get(item.name) || []
    entries.push(item)
    actualByName.set(item.name, entries)
  }

  for (const [name, entries] of actualByName) {
    if (!expectedCounts.has(name)) issues.push(`unexpected_case:${name}`)
    if (entries.length > 1) issues.push(`duplicate_case:${name}`)
  }

  const cases = expected.map(name => {
    const entries = typeof name === 'string' ? actualByName.get(name) || [] : []
    if (entries.length === 0) {
      issues.push(`missing_case:${String(name)}`)
      return { name: String(name), status: 'NOT_EXECUTED', detail: 'required_acceptance_case_missing' }
    }
    if (entries.length > 1) return { name, status: 'FAIL', detail: 'duplicate_acceptance_case' }
    const item = entries[0]
    if (!VALID_STATUSES.has(item.status)) return { name, status: 'FAIL', detail: 'invalid_acceptance_case_status' }
    return { name, status: item.status, detail: typeof item.detail === 'string' ? item.detail : '' }
  })

  for (const [name, entries] of actualByName) {
    if (!expectedCounts.has(name)) cases.push({ name, status: 'FAIL', detail: 'unexpected_acceptance_case' })
  }
  if (issues.length) cases.push({ name: 'acceptance registry integrity', status: 'FAIL',
    detail: 'required_acceptance_case_registry_invalid' })

  const status = issues.length || cases.some(item => item.status === 'FAIL') ? 'FAIL'
    : cases.some(item => item.status === 'NOT_EXECUTED' || item.status === 'SKIP') ? 'NOT_EXECUTED' : 'PASS'
  return { status, cases }
}

export function notExecutedAcceptanceCases(expectedNames, detail) {
  return expectedNames.map(name => ({ name, status: 'NOT_EXECUTED', detail }))
}
