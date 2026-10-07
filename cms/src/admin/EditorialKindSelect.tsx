'use client'

import React, { useId } from 'react'
import type { EditorialValue } from './editorial-value'

type Props = {
  value: EditorialValue['kind']
  disabled: boolean
  onChange: (value: EditorialValue['kind']) => void
}

export function applyEditorialKindSelection(
  next: string,
  onChange: (value: EditorialValue['kind']) => void,
) {
  if (next === 'article' || next === 'edition') onChange(next)
}

/** Native select keeps the Payload field label programmatically associated. */
export function EditorialKindSelect({ value, disabled, onChange }: Props) {
  const id = `editorial-kind-${useId()}`

  return <div className="field-type select">
    <label className="field-label" htmlFor={id}>Tipo de publicação</label>
    <div className="field-type__wrap">
      <select
        id={id}
        name="editorial-kind"
        value={value}
        disabled={disabled}
        onChange={event => {
          applyEditorialKindSelection(event.currentTarget.value, onChange)
        }}
        style={{
          width: '100%',
          minHeight: '2rem',
          padding: '0.4rem 0.75rem',
          border: '1px solid var(--theme-elevation-150)',
          borderRadius: 'var(--style-radius-s)',
          backgroundColor: disabled ? 'var(--theme-elevation-100)' : 'var(--theme-input-bg)',
          color: disabled ? 'var(--theme-elevation-400)' : 'var(--theme-elevation-800)',
          fontFamily: 'var(--font-body)',
          fontSize: '1rem',
          lineHeight: '1rem',
        }}
      >
        <option value="article">Matéria</option>
        <option value="edition">Edição em PDF</option>
      </select>
    </div>
  </div>
}
