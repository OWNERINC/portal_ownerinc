'use client'
import React, { useId } from 'react'
import { isValidEditorialSourceDate } from './editorial-value'

export const editorialSourceDateErrorMessage = 'Data inválida. Informe uma data real no formato AAAA-MM-DD.'

export function editorialSourceDateFeedback(inputId: string, value: string | null) {
  const descriptionId = `${inputId}-description`
  const errorId = `${inputId}-error`
  const invalid = !isValidEditorialSourceDate(value)
  return {
    invalid,
    descriptionId,
    errorId,
    describedBy: invalid ? `${descriptionId} ${errorId}` : descriptionId,
  }
}

export function EditorialSourceDateError({ id }: { id: string }) {
  return <p id={id} role="alert">{editorialSourceDateErrorMessage}</p>
}

/** Native text input preserves exact civil-date text and has instance-unique accessible IDs. */
export function EditorialSourceDateInput({ path, value, readOnly, onChange }: {
  path: string
  value: string | null
  readOnly: boolean
  onChange: (value: string) => void
}) {
  const inputId = `editorial-source-date-${useId()}`
  const inputPath = `${path}-source-date`
  const { invalid, descriptionId, errorId, describedBy } = editorialSourceDateFeedback(inputId, value)

  return <div className={`field-type text${invalid ? ' error' : ''}${readOnly ? ' read-only' : ''}`}>
    <label className="field-label" htmlFor={inputId}>Data da fonte (AAAA-MM-DD)</label>
    <div className="field-type__wrap">
      <input id={inputId} name={inputPath} type="text" value={value || ''} disabled={readOnly}
        aria-invalid={invalid || undefined} aria-describedby={describedBy}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)} />
      {invalid && <EditorialSourceDateError id={errorId} />}
    </div>
    <div id={descriptionId} className={`field-description field-description-${inputPath}`}>
      Data civil, sem conversão de fuso. Deixe em branco quando desconhecida.
    </div>
  </div>
}
