import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEditorialFieldFocusRegistry, editorialFieldFocusRegistryFor } from '../../src/admin/portal-pages/editorial-focus-state'

test('focuses the first registered invalid path in Payload validation-state order', () => {
  const registry = createEditorialFieldFocusRegistry()
  const focused: string[] = []
  const fields = {
    title: { valid: false },
    slug: { valid: false },
    'body.0.text': { valid: false },
    'body.1.images.0.alt': { valid: false },
  }

  for (const path of Object.keys(fields)) registry.register(path, () => ({ focus: () => focused.push(path) }))

  assert.equal(registry.focusFirstInvalid(fields), 'title')
  assert.deepEqual(focused, ['title'])
})

test('skips an invalid field safely after its target unmounts and focuses the next registered path', () => {
  const registry = createEditorialFieldFocusRegistry()
  const focused: string[] = []
  const unregisterTitle = registry.register('title', () => ({ focus: () => focused.push('title') }))
  registry.register('slug', () => ({ focus: () => focused.push('slug') }))
  unregisterTitle()

  assert.equal(registry.focusFirstInvalid({ title: { valid: false }, slug: { valid: false } }), 'slug')
  assert.deepEqual(focused, ['slug'])
})

test('document forms do not share field focus registrations', () => {
  const firstForm = {}
  const secondForm = {}
  const firstRegistry = editorialFieldFocusRegistryFor(firstForm)
  const secondRegistry = editorialFieldFocusRegistryFor(secondForm)
  const focused: string[] = []
  firstRegistry.register('title', () => ({ focus: () => focused.push('first') }))

  assert.notEqual(firstRegistry, secondRegistry)
  assert.equal(secondRegistry.focusFirstInvalid({ title: { valid: false } }), null)
  assert.deepEqual(focused, [])
})
