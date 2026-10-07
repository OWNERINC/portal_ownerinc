import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { editEditorialValue, isEditorialValue, isValidEditorialSourceDate, newEditorialValue } from '../../src/admin/editorial-value'
import { EditorialSourceDateError, EditorialSourceDateInput, editorialSourceDateFeedback } from '../../src/admin/EditorialSourceDateInput'
import { normalizeEditorial, readEditorialFieldValue } from '../../src/news/validation'

test('editorial controls round-trip incomplete draft and exact civil date without changing storage', () => {
  const original = newEditorialValue()
  const next = editEditorialValue(editEditorialValue(original, 'source_date', '2024-02-29'), 'kind', 'edition')
  assert.deepEqual(normalizeEditorial(JSON.parse(JSON.stringify(next))), next)
  assert.equal(original.source_date, null)
  assert.equal(editEditorialValue(next, 'source_date', '').source_date, null)
  assert.equal(editEditorialValue(next, 'summary', '').summary, '')
  assert.throws(() => normalizeEditorial(editEditorialValue(next, 'source_date', '2023-02-29')))
  assert.throws(() => editEditorialValue(next, 'kind', 'other'))
})

test('legacy null is distinct from explicit conversion and invalid values are never silently rewritten', () => {
  assert.equal(normalizeEditorial(null), null)
  assert.equal(isEditorialValue(null), false)
  assert.equal(isEditorialValue({ ...newEditorialValue(), extra: true }), false)
  assert.equal(isEditorialValue(newEditorialValue()), true)
  assert.equal(isEditorialValue({ ...newEditorialValue(), kind: 'unknown-kind' }), false)
  assert.equal(isEditorialValue({ ...newEditorialValue(), source_date: 123 }), false)
  assert.equal(isEditorialValue({ ...newEditorialValue(), author: null }), false)
  assert.equal(isEditorialValue({ ...newEditorialValue(), kind: ['article'] }), false)
})

test('Payload JSONField validation accepts its serialized value and keeps parse failures invalid', () => {
  const value = newEditorialValue()
  assert.deepEqual(normalizeEditorial(readEditorialFieldValue(JSON.stringify(value))), value)
  assert.equal(readEditorialFieldValue(null), null)
  assert.throws(() => readEditorialFieldValue('{invalid json'))
  assert.throws(() => normalizeEditorial(readEditorialFieldValue('"not editorial metadata"')))
})

test('invalid civil dates get persistent accessible Portuguese field feedback without changing the server contract', () => {
  for (const value of [null, '', '0000-02-29', '2000-02-29', '2024-02-29']) {
    assert.equal(isValidEditorialSourceDate(value), true)
    if (value) {
      const normalized = normalizeEditorial({ ...newEditorialValue(), source_date: value })
      assert.ok(normalized)
      assert.equal(normalized.source_date, value)
    }
  }
  for (const value of ['2024-02-30', '1900-02-29', '2024-13-01', '24-02-29']) {
    assert.equal(isValidEditorialSourceDate(value), false)
    assert.throws(() => normalizeEditorial({ ...newEditorialValue(), source_date: value }))
  }

  assert.deepEqual(editorialSourceDateFeedback('date-one', '2024-02-30'), {
    invalid: true,
    descriptionId: 'date-one-description',
    errorId: 'date-one-error',
    describedBy: 'date-one-description date-one-error',
  })
  assert.deepEqual(editorialSourceDateFeedback('date-one', null), {
    invalid: false,
    descriptionId: 'date-one-description',
    errorId: 'date-one-error',
    describedBy: 'date-one-description',
  })
  const markup = renderToStaticMarkup(React.createElement(EditorialSourceDateError, { id: 'field-editorial-source-date-error' }))
  assert.match(markup, /<p id="field-editorial-source-date-error" role="alert">Data inválida\. Informe uma data real no formato AAAA-MM-DD\.<\/p>/)
})

test('two same-path source date inputs get unique hydration-safe IDs and local feedback associations', () => {
  const invalidDate = (onChange: (value: string) => void) => React.createElement(EditorialSourceDateInput, {
    path: 'editorial', value: '2024-02-30', readOnly: false, onChange,
  })
  const markup = renderToStaticMarkup(React.createElement('div', null,
    React.createElement('fieldset', null, invalidDate(() => {})),
    React.createElement('fieldset', null, invalidDate(() => {})),
  ))
  const inputMarkup = [...markup.matchAll(/<input\b([^>]*)>/gu)].map(match => match[1])
  const attribute = (input: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(input)?.[1] || ''
  const inputs = inputMarkup.map(input => ({
    id: attribute(input, 'id'), describedBy: attribute(input, 'aria-describedby').split(/\s+/u).filter(Boolean),
    invalid: attribute(input, 'aria-invalid'),
  }))
  const allIDs = new Set([...markup.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]))
  const allIDList = [...markup.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1])
  assert.equal(inputs.length, 2)
  assert.equal(allIDList.length, allIDs.size, 'all input/help/error IDs across both same-path fields are unique')
  assert.notEqual(inputs[0].id, inputs[1].id)
  for (const input of inputs) {
    assert.equal(input.invalid, 'true')
    assert.equal(input.describedBy.length, 2)
    assert.ok(input.describedBy.every(id => allIDs.has(id)), 'each describedby token must resolve to rendered help/error content')
    assert.ok(input.describedBy.includes(`${input.id}-description`))
    assert.ok(input.describedBy.includes(`${input.id}-error`))
    assert.match(markup, new RegExp(`<label class="field-label" for="${input.id}">Data da fonte`, 'u'))
    assert.match(markup, new RegExp(`<p id="${input.id}-error" role="alert">Data inválida\\. Informe uma data real no formato AAAA-MM-DD\\.<\\/p>`, 'u'))
  }
  assert.notEqual(inputs[0].describedBy[0], inputs[1].describedBy[0])
  assert.notEqual(inputs[0].describedBy[1], inputs[1].describedBy[1])

  const validMarkup = renderToStaticMarkup(React.createElement(EditorialSourceDateInput, {
    path: 'editorial', value: '2024-02-29', readOnly: false, onChange: () => {},
  }))
  const validInput = /<input\b([^>]*)>/u.exec(validMarkup)?.[1] || ''
  assert.equal(attribute(validInput, 'aria-invalid'), '')
  assert.equal(attribute(validInput, 'aria-describedby').split(/\s+/u).length, 1)
  assert.doesNotMatch(validMarkup, /role="alert"/u)
})
