'use client'
import React from 'react'
import type { JSONFieldClientProps } from 'payload'
import { Button, TextareaInput, TextInput, useField } from '@payloadcms/ui'
import type { Options } from '@payloadcms/ui'
import { editEditorialValue, isEditorialValue, newEditorialValue, type EditorialKey } from './editorial-value'
import { EditorialKindSelect } from './EditorialKindSelect'
import { EditorialSourceDateInput } from './EditorialSourceDateInput'

/** One native JSON field; controls never materialize children of imported null. */
export function EditorialMetadata({ path, readOnly, validate, field: config }: JSONFieldClientProps) {
  const validateForForm: NonNullable<Options['validate']> = (value, options) => {
    if (!validate) return true
    const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null)
    // Match Payload's native JSONField adapter: preserve the useField context,
    // and add only JSON validator config. Client `admin` props are not validator
    // config (and contain client-only editorOptions typing).
    return validate(serialized, {
      ...options,
      name: config.name,
      type: 'json',
      jsonError: undefined,
      required: Boolean(config.required),
    })
  }
  const field = useField<unknown>({ path, validate: validateForForm })
  const locked = Boolean(readOnly || field.disabled || field.formInitializing || field.formProcessing)
  const value = field.value
  const change = (key: EditorialKey, text: string) => {
    if (!locked && isEditorialValue(value)) field.setValue(editEditorialValue(value, key, text))
  }
  return <fieldset disabled={locked}>
    <legend>Informações editoriais</legend>
    {value === null ? <>
      <p>Conteúdo legado sem metadados editoriais. Salvar outros campos preserva esse formato.</p>
      <Button type="button" disabled={locked} onClick={() => { if (!locked) field.setValue(newEditorialValue()) }}>Adicionar informações editoriais</Button>
    </> : isEditorialValue(value) ? <>
      <EditorialKindSelect value={value.kind} disabled={locked} onChange={kind => change('kind', kind)} />
      <TextareaInput path={`${path}-summary`} label="Resumo" value={value.summary} readOnly={locked}
        description="Até 1.000 caracteres. Obrigatório para publicar uma matéria." onChange={event => change('summary', event.target.value)} />
      <TextInput path={`${path}-author`} label="Autoria" value={value.author} readOnly={locked} onChange={(event: React.ChangeEvent<HTMLInputElement>) => change('author', event.target.value)} />
      <TextInput path={`${path}-source-label`} label="Fonte" value={value.source_label} readOnly={locked} onChange={(event: React.ChangeEvent<HTMLInputElement>) => change('source_label', event.target.value)} />
      <EditorialSourceDateInput path={path} value={value.source_date} readOnly={locked} onChange={text => change('source_date', text)} />
    </> : <p role="alert">Não foi possível interpretar os metadados. O valor original foi preservado; recarregue o documento antes de editar.</p>}
    {field.showError && <p role="alert">{field.errorMessage || 'Confira as informações editoriais.'}</p>}
  </fieldset>
}
