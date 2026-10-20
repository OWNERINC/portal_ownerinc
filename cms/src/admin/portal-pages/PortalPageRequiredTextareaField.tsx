'use client'

import React, { useCallback, useEffect, useRef } from 'react'
import { TextareaField } from '@payloadcms/ui'
import type { TextareaFieldClientProps } from 'payload'
import { useEditorialFieldFocusTarget } from './editorial-focus'

/** Payload-native required textarea registered as the field's real focus target. */
export function PortalPageRequiredTextareaField(props: TextareaFieldClientProps): React.JSX.Element {
  const registerTarget = useEditorialFieldFocusTarget<HTMLTextAreaElement>(props.path)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node
    registerTarget(node?.querySelector('textarea') ?? null)
  }, [registerTarget])

  // Payload 3.90.2's native TextareaField does not forward inputRef to TextareaInput;
  // bind after the native field commits so validation focuses its actual textarea.
  useEffect(() => {
    registerTarget(rootRef.current?.querySelector('textarea') ?? null)
    return () => registerTarget(null)
  }, [registerTarget])

  return <div ref={setRootRef}><TextareaField {...props} /></div>
}
