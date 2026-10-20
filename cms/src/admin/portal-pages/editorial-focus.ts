'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useDocumentForm, useField } from '@payloadcms/ui'
import { editorialFieldFocusRegistryFor } from './editorial-focus-state'
import type { EditorialFocusable } from './editorial-focus-state'

/**
 * Generic Task 4 wrapper contract: attach the returned callback ref to the
 * actual focusable native input/select/button for this Payload field. Every
 * custom wrapper for title/slug and required nested PortalPages fields (including
 * native block and gallery rows) should use this same contract.
 */
export function useEditorialFieldFocusTarget<T extends EditorialFocusable & object>(
  potentiallyStalePath?: string,
): (node: T | null) => void {
  const documentForm = useDocumentForm()
  const { path } = useField({ potentiallyStalePath })
  const registry = editorialFieldFocusRegistryFor(documentForm)
  const targetRef = useRef<T | null>(null)
  const unregisterRef = useRef<(() => void) | null>(null)

  const registerTarget = useCallback((node: T | null) => {
    unregisterRef.current?.()
    unregisterRef.current = null
    targetRef.current = node
    if (node) unregisterRef.current = registry.register(path, () => targetRef.current)
  }, [path, registry])

  useEffect(() => () => {
    unregisterRef.current?.()
    unregisterRef.current = null
    targetRef.current = null
  }, [])

  return registerTarget
}
