import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { applyEditorialKindSelection, EditorialKindSelect } from '../../src/admin/EditorialKindSelect'

test('editorial kind renders a labelled native combobox with controlled options and disabled state', () => {
  const html = renderToStaticMarkup(React.createElement('div', null,
    React.createElement(EditorialKindSelect, { value: 'edition', disabled: false, onChange: () => {} }),
    React.createElement(EditorialKindSelect, { value: 'article', disabled: true, onChange: () => {} }),
  ))
  const pairs = [...html.matchAll(/<label class="field-label" for="([^"]+)">Tipo de publicação<\/label>[\s\S]*?<select\s+id="([^"]+)"([\s\S]*?)>/g)]

  assert.equal(pairs.length, 2)
  assert.equal(pairs[0][1], pairs[0][2], 'the first visible label targets its select id')
  assert.equal(pairs[1][1], pairs[1][2], 'the second visible label targets its select id')
  assert.notEqual(pairs[0][2], pairs[1][2], 'each control instance receives a distinct id')
  assert.match(html, /<option value="article">Matéria<\/option><option value="edition" selected="">Edição em PDF<\/option>/)
  assert.match(pairs[1][3], /disabled=""/)
  assert.match(html, /<option value="article" selected="">Matéria<\/option><option value="edition">Edição em PDF<\/option>/)
})

test('native kind selection commits exact known values and leaves unknown values untouched', () => {
  const selected: string[] = []
  const onChange = (value: 'article' | 'edition') => selected.push(value)

  applyEditorialKindSelection('edition', onChange)
  applyEditorialKindSelection('article', onChange)
  applyEditorialKindSelection('unknown-kind', onChange)

  assert.deepEqual(selected, ['edition', 'article'])
})
